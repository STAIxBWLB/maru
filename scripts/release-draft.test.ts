import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareDraft, finalizeDraft, parseDryRun } from "./release-draft.mjs";
import { verifyReleaseWorkflowsForSha } from "./check-release-workflows.mjs";
import { findRelease, getRelease, releaseMetadata, uploadDraftAsset } from "./lib/releaseApi.mjs";
import { buildUpdaterManifest, requiredReleaseAssetNames } from "./lib/updaterManifest.mjs";
import { downloadUpdaterSignatures, publishUpdaterManifest } from "./publish-updater-manifest.mjs";

const tag = "v1.2.3", sha = "a".repeat(40), repo = "fixture/maru", id = 77;

function fixture() {
  const contents = new Map<number, string>();
  const assets = requiredReleaseAssetNames(tag).map((name: string, index: number) => {
    const text = name.endsWith(".sig") ? `signature:${name}` : `payload:${name}`;
    contents.set(index + 1, text);
    return { id: index + 1, name, size: Buffer.byteLength(text), state: "uploaded",
      digest: `sha256:${createHash("sha256").update(text).digest("hex")}` };
  });
  const state = { release: { id, tag_name: tag, target_commitish: sha, draft: true, prerelease: false,
    created_at: "2026-11-07T00:00:00Z", published_at: null, body: "Release notes", assets }, tagSha: undefined as string | undefined };
  const calls: Array<{ method: string; route: string }> = [];
  let nextId = 100;
  const runGh = (args: string[], options?: { input?: string }) => {
    const method = args[2], route = args[3];
    calls.push({ method, route });
    if (route.endsWith("/releases?per_page=100")) return JSON.stringify([{ id, tag_name: tag }]);
    if (route === `repos/${repo}/commits`) {
      if (args.includes(`sha=refs/tags/${tag}`)) {
        if (!state.tagSha) throw Object.assign(new Error("fixture tag absent"), { httpStatus: 404 });
        return JSON.stringify([{ sha: state.tagSha }]);
      }
      return JSON.stringify([{ sha }]);
    }
    if (route === `repos/${repo}/releases/${id}`) {
      if (method === "PATCH") {
        expect(JSON.parse(options?.input ?? "{}")).toEqual({ draft: false, make_latest: "true", tag_name: tag, target_commitish: sha });
        state.release.draft = false;
        state.tagSha = sha;
      }
      return JSON.stringify(state.release);
    }
    const assetId = route.match(/\/releases\/assets\/(\d+)$/)?.[1];
    if (assetId) {
      if (method === "DELETE") {
        state.release.assets = state.release.assets.filter((asset) => asset.id !== Number(assetId));
        contents.delete(Number(assetId));
        return "";
      }
      const text = contents.get(Number(assetId));
      if (text === undefined) throw new Error("fixture asset absent");
      return text;
    }
    if (method === "POST" && route.startsWith("https://uploads.github.com/")) {
      const name = new URL(route).searchParams.get("name")!;
      const text = readFileSync(args[args.indexOf("--input") + 1], "utf8");
      const asset = { id: nextId++, name, size: Buffer.byteLength(text), state: "uploaded",
        digest: `sha256:${createHash("sha256").update(text).digest("hex")}` };
      state.release.assets.push(asset);
      contents.set(asset.id, text);
      return JSON.stringify(asset);
    }
    throw new Error(`unexpected fixture request ${method} ${route}`);
  };
  const signatures = downloadUpdaterSignatures({ tag, repo, metadata: state.release, runGh });
  const manifest = buildUpdaterManifest({ tag, repo, release: releaseMetadata(state.release), signatures });
  const text = JSON.stringify(manifest);
  state.release.assets.push({ id: 21, name: "latest.json", size: Buffer.byteLength(text), state: "uploaded",
    digest: `sha256:${createHash("sha256").update(text).digest("hex")}` });
  contents.set(21, text);
  calls.length = 0;
  return { state, runGh, calls, contents, manifest };
}

describe("draft release admission", () => {
  it("lists drafts, uses the selected ID and gates its immutable SHA without a tag", async () => {
    const f = fixture();
    const verify = vi.fn(async () => sha);
    await expect(prepareDraft(tag, { repo, runGh: f.runGh, verify, report: () => {} }))
      .resolves.toEqual({ tag, id, sha });
    expect(verify).toHaveBeenCalledWith(tag, repo, sha);
    expect(f.calls[0].route).toContain("/releases?per_page=100");
    expect(f.calls.some((call) => call.route.includes("/releases/tags/"))).toBe(false);
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects ambiguous listing, branch targets, public releases and conflicting tags before admission", async () => {
    const f = fixture();
    expect(() => findRelease(tag, repo, () => JSON.stringify([{ id, tag_name: tag }, { id: 88, tag_name: tag }])))
      .toThrow("unambiguous draft");
    const verify = vi.fn(async () => sha);
    f.state.release.target_commitish = "main";
    await expect(prepareDraft(tag, { repo, runGh: f.runGh, verify })).rejects.toThrow("immutable target SHA");
    f.state.release.target_commitish = sha;
    f.state.release.draft = false;
    await expect(prepareDraft(tag, { repo, runGh: f.runGh, verify })).rejects.toThrow("already public");
    f.state.release.draft = true;
    f.state.tagSha = "b".repeat(40);
    await expect(prepareDraft(tag, { repo, runGh: f.runGh, verify })).rejects.toThrow("admitted SHA");
    expect(verify).not.toHaveBeenCalled();
  });

  it("finds a pending tag on a later listing page", () => {
    const f = fixture();
    const runGh = (args: string[]) => args[3].includes("?per_page=")
      ? JSON.stringify([[{ id: 99, tag_name: "v9.9.9" }], [{ id, tag_name: tag }]]) : f.runGh(args);
    expect(findRelease(tag, repo, runGh).id).toBe(id);
  });

  it("refuses a retargeted draft after a successful workflow wait", async () => {
    const f = fixture();
    await expect(prepareDraft(tag, { repo, runGh: f.runGh, verify: async () => {
      f.state.release.target_commitish = "b".repeat(40);
      return sha;
    } })).rejects.toThrow("changed");
  });

  it.each(["success", "failure"])("keeps exact-SHA workflow admission for untagged drafts: %s", async (conclusion) => {
    const f = fixture();
    const readJson = vi.fn(async (route: string) => [{ workflow_runs: [{ id: 5, head_sha: sha,
      head_branch: "verification-branch", event: "workflow_dispatch", run_started_at: "2026-11-07T00:00:00Z",
      status: "completed", conclusion: route.includes("native-e2e") ? conclusion : "success" }] }]);
    const result = prepareDraft(tag, { repo, runGh: f.runGh, report: () => {},
      verify: (tag: string, repo: string, sha: string) => verifyReleaseWorkflowsForSha(tag, repo, sha, readJson, () => {}, { waitMs: 0 }) });
    if (conclusion === "success") await expect(result).resolves.toEqual({ tag, id, sha });
    else await expect(result).rejects.toThrow("native-e2e.yml: latest run concluded failure");
    expect(readJson.mock.calls.every(([route]) => route.includes("/actions/workflows/"))).toBe(true);
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
});

describe("draft finalization", () => {
  it("publishes only after fresh verification of 21 assets and their signed manifest", () => {
    const f = fixture();
    expect(finalizeDraft(tag, id, sha, { repo, runGh: f.runGh, report: () => {} })).toEqual({ published: true });
    const patch = f.calls.findIndex((call) => call.method === "PATCH");
    expect(patch).toBeGreaterThan(0);
    expect(f.calls.slice(0, patch).filter((call) => call.route.includes("/releases/assets/"))).toHaveLength(8);
    expect(f.state.tagSha).toBe(sha);
    expect(f.state.release.draft).toBe(false);
  });

  it("keeps a rehearsal draft private without any mutation", () => {
    const f = fixture();
    f.state.release.prerelease = true;
    expect(finalizeDraft(tag, id, sha, { repo, dryRun: true, runGh: f.runGh, report: () => {} })).toEqual({ published: false });
    expect(f.state.release.draft).toBe(true);
    expect(f.state.tagSha).toBeUndefined();
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    expect(() => parseDryRun("yes")).toThrow("true or false");
  });

  it("reports an unknown publication outcome without encouraging public-asset rebuilds", () => {
    const f = fixture();
    const runGh = (args: string[], options?: { input?: string }) => {
      if (args[2] === "PATCH") {
        f.state.release.draft = false;
        throw new Error("fixture response timeout");
      }
      return f.runGh(args, options);
    };
    expect(() => finalizeDraft(tag, id, sha, { repo, runGh })).toThrow("if public, use the documented tap-only recovery");
    expect(f.state.release.draft).toBe(false);
  });

  it.each(["missing", "empty", "manifest", "tag", "prerelease"])("refuses %s before publication", (failure) => {
    const f = fixture();
    if (failure === "missing") f.state.release.assets.shift();
    if (failure === "empty") f.state.release.assets[0].size = 0;
    if (failure === "manifest") f.contents.set(21, JSON.stringify({ version: "wrong" }));
    if (failure === "tag") f.state.tagSha = "b".repeat(40);
    if (failure === "prerelease") f.state.release.prerelease = true;
    expect(() => finalizeDraft(tag, id, sha, { repo, runGh: f.runGh })).toThrow();
    expect(f.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("replaces latest.json idempotently by ID while leaving payloads unchanged", () => {
    const f = fixture();
    const ids = f.state.release.assets.filter((asset) => asset.name !== "latest.json").map((asset) => asset.id);
    const options = { repo, releaseId: id, sha,
      runView: (_tag: string, _repo: string, selected: number) => releaseMetadata(getRelease(selected, repo, f.runGh)),
      runDownload: (options: { tag: string; repo: string; metadata: unknown }) => downloadUpdaterSignatures({ ...options, runGh: f.runGh }),
      runUpload: (_tag: string, _repo: string, file: string) => uploadDraftAsset(file, { tag, repo, id, sha, runGh: f.runGh }),
    };
    publishUpdaterManifest(tag, options);
    publishUpdaterManifest(tag, options);
    expect(f.state.release.assets).toHaveLength(21);
    expect(f.state.release.assets.filter((asset) => asset.name === "latest.json")).toHaveLength(1);
    expect(f.state.release.assets.filter((asset) => asset.name !== "latest.json").map((asset) => asset.id)).toEqual(ids);
    expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
    expect(f.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("uploads a rehearsal manifest to the private ID and then verifies without publishing", () => {
    const f = fixture();
    f.state.release.prerelease = true;
    publishUpdaterManifest(tag, { repo, releaseId: id, sha, rehearsal: true,
      runView: () => releaseMetadata(getRelease(id, repo, f.runGh)),
      runDownload: (options: { tag: string; repo: string; metadata: unknown }) => downloadUpdaterSignatures({ ...options, runGh: f.runGh }),
      runUpload: (_tag: string, _repo: string, file: string) => uploadDraftAsset(file, { tag, repo, id, sha, dryRun: true, runGh: f.runGh }),
    });
    expect(finalizeDraft(tag, id, sha, { repo, dryRun: true, runGh: f.runGh, report: () => {} })).toEqual({ published: false });
    expect(f.calls.some((call) => call.method === "POST")).toBe(true);
    expect(f.calls.some((call) => call.method === "PATCH")).toBe(false);
    expect(f.state.release.draft).toBe(true);
  });

  it("does not delete a prior asset when its replacement is missing", () => {
    const f = fixture();
    expect(() => uploadDraftAsset("/missing/latest.json", { repo, tag, id, sha, runGh: f.runGh })).toThrow("rebuild");
    expect(f.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("removes the published event and gates every tap step on successful publication", () => {
    const source = readFileSync(resolve(process.cwd(), ".github/workflows/release-bundles.yml"), "utf8");
    expect(source).not.toMatch(/^  release:$/m);
    expect(source).toContain('release-draft.mjs prepare "$RELEASE_TAG"');
    expect(source.match(/if: steps.publication.outputs.published == 'true'/g)).toHaveLength(3);
    expect(source.indexOf("id: publication")).toBeLessThan(source.indexOf("- name: Checkout Homebrew tap"));
  });

  it("keeps push-capable tokens for all private-draft readers", () => {
    const source = readFileSync(resolve(process.cwd(), ".github/workflows/release-bundles.yml"), "utf8");
    const globalWrite = /^permissions:\n  contents: write$/m.test(source.split("\njobs:")[0]);
    for (const job of ["prepare", "build", "finalize"]) {
      const block = source.match(new RegExp(`^  ${job}:\\n[\\s\\S]*?(?=^  [A-Za-z0-9_-]+:|$(?![\\s\\S]))`, "m"))?.[0];
      expect(block, job).toBeDefined();
      const permissions = block!.match(/^    permissions:\n((?:^      .*\n)+)/m)?.[1];
      if (permissions) expect(permissions, job).toMatch(/^      contents: write$/m);
      else expect(globalWrite, `${job} inherits workflow permission`).toBe(true);
      expect(block, job).toContain("GH_TOKEN: ${{ github.token }}");
      if (job === "prepare") expect(permissions).toMatch(/^      actions: read$/m);
    }
  });

  it("uses Bash environment expansion for every cross-platform release-draft call", () => {
    const source = readFileSync(resolve(process.cwd(), ".github/workflows/release-bundles.yml"), "utf8");
    const jobs = source.matchAll(/^  [A-Za-z0-9_-]+:\n[\s\S]*?(?=^  [A-Za-z0-9_-]+:|$(?![\s\S]))/gm);
    let checked = 0;
    for (const [job] of jobs) {
      const macJob = /^    runs-on: macos-[^\n]+$/m.test(job);
      for (const step of job.split(/^      - /m).slice(1)) {
        if (!step.includes("release-draft.mjs")) continue;
        const bash = /^        shell: bash$/m.test(step);
        const macStep = /^        if: matrix\.platform == 'macos-[^']+'$/m.test(step);
        expect(bash || macJob || macStep, step.split("\n")[0]).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe.skipIf(process.platform === "win32")("Homebrew release boundary (POSIX CLI fixture)", () => {
  it.each(["draft", "prerelease", "public"])("handles %s before modifying the tap, with idempotent public reruns", (mode) => {
    const folder = mkdtempSync(resolve(tmpdir(), "maru-draft-tap-"));
    try {
      const f = fixture();
      f.state.release.draft = mode === "draft";
      f.state.release.prerelease = mode === "prerelease";
      const tap = resolve(folder, "tap");
      mkdirSync(tap);
      writeFileSync(resolve(folder, "gh"), `#!${process.execPath}\nconst v=JSON.parse(process.env.FIXTURE_RELEASE); console.log(JSON.stringify(process.argv.includes("--paginate")?[{id:v.id,tag_name:v.tag_name}]:v));\n`, { mode: 0o755 });
      const env = { PATH: `${folder}:/usr/bin:/bin`, HOME: folder, MARU_RELEASE_REPO: repo,
        FIXTURE_RELEASE: JSON.stringify(f.state.release) };
      if (mode === "public") {
        for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"],
          ["config", "user.email", "fixture@example.invalid"], ["commit", "--allow-empty", "-m", "fixture"]]) {
          execFileSync("git", ["-C", tap, ...args], { env, stdio: "pipe" });
        }
      }
      const run = () => spawnSync(process.execPath, [resolve(process.cwd(), "scripts/update-homebrew-tap.mjs"), tag, tap, "--commit"], {
        env, encoding: "utf8", timeout: 10_000,
      });
      const first = run();
      if (mode !== "public") {
        expect(first.status).toBe(1);
        expect(first.stderr).toContain("Homebrew requires a published stable release");
        expect(readdirSync(tap)).toEqual([]);
      } else {
        expect(first.stderr).toBe("");
        expect(first.status).toBe(0);
        const head = execFileSync("git", ["-C", tap, "rev-parse", "HEAD"], { env, encoding: "utf8" });
        expect(run().status).toBe(0);
        expect(execFileSync("git", ["-C", tap, "rev-parse", "HEAD"], { env, encoding: "utf8" })).toBe(head);
        expect(existsSync(resolve(tap, "Casks/maru-workspace.rb"))).toBe(true);
      }
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
});
