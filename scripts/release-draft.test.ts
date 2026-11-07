import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareDraft, finalizeDraft, parseDryRun, planTauriUploads, uploadTauriArtifacts, main } from "./release-draft.mjs";
import { verifyReleaseWorkflowsForSha } from "./check-release-workflows.mjs";
import { findRelease, getRelease, releaseMetadata, uploadDraftAsset } from "./lib/releaseApi.mjs";
import { buildUpdaterManifest, requiredReleaseAssetNames } from "./lib/updaterManifest.mjs";
import { downloadUpdaterSignatures, publishUpdaterManifest } from "./publish-updater-manifest.mjs";

const tag = "v1.2.3", sha = "a".repeat(40), repo = "fixture/maru", id = 77;
const windowsArtifacts = ["Maru_1.2.3_x64_en-US.msi", "Maru_1.2.3_x64_en-US.msi.sig", "Maru_1.2.3_x64-setup.exe", "Maru_1.2.3_x64-setup.exe.sig"];
const windowsNames = ["Maru_1.2.3_windows_x64_msi.msi", "Maru_1.2.3_windows_x64_msi.msi.sig", "Maru_1.2.3_windows_x64_nsis.exe", "Maru_1.2.3_windows_x64_nsis.exe.sig"];

function completedWindowsBuild(folder: string) {
  return windowsArtifacts.map((name) => {
    const file = resolve(folder, name);
    writeFileSync(file, `fixture:${name}`);
    return file;
  });
}

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

describe("checked Tauri bundle handoff", () => {
  it.each([
    { platform: "windows-latest", target: "", paths: windowsArtifacts.map((name) => `D:\\a\\bundle\\${name}`), names: windowsNames },
    { platform: "macos-26", target: "aarch64-apple-darwin", paths: ["/bundle/Maru.app", "/bundle/Maru.app.tar.gz", "/bundle/Maru.app.tar.gz.sig"],
      names: ["Maru_1.2.3_darwin_aarch64_app.app.tar.gz", "Maru_1.2.3_darwin_aarch64_app.app.tar.gz.sig"] },
    { platform: "macos-26", target: "x86_64-apple-darwin", paths: ["/bundle/Maru.app.tar.gz", "/bundle/Maru.app.tar.gz.sig"],
      names: ["Maru_1.2.3_darwin_x64_app.app.tar.gz", "Maru_1.2.3_darwin_x64_app.app.tar.gz.sig"] },
    { platform: "ubuntu-22.04", target: "", paths: ["/bundle/Maru_1.2.3_amd64.deb", "/bundle/Maru_1.2.3_amd64.deb.sig", "/bundle/Maru-1.2.3-1.x86_64.rpm", "/bundle/Maru-1.2.3-1.x86_64.rpm.sig", "/bundle/Maru_1.2.3_amd64.AppImage", "/bundle/Maru_1.2.3_amd64.AppImage.sig"],
      names: ["Maru_1.2.3_linux_amd64_deb.deb", "Maru_1.2.3_linux_amd64_deb.deb.sig", "Maru_1.2.3_linux_x86_64_rpm.rpm", "Maru_1.2.3_linux_x86_64_rpm.rpm.sig", "Maru_1.2.3_linux_amd64_appimage.AppImage", "Maru_1.2.3_linux_amd64_appimage.AppImage.sig"] },
  ])("preserves names for $platform $target", ({ platform, target, paths, names }) => {
    const planned = planTauriUploads(paths, { tag, platform, target, appVersion: "1.2.3" });
    expect(planned.map((item) => item.name)).toEqual(names);
    expect(planned.every((item) => paths.includes(item.file))).toBe(true);
  });

  it("rejects missing, duplicate, foreign-version and unsupported outputs", async () => {
    const context = { tag, platform: "windows-latest", target: "", appVersion: "1.2.3" };
    for (const paths of [[], windowsArtifacts.slice(0, 3), [...windowsArtifacts, windowsArtifacts[0]], windowsArtifacts.map((file) => file.replace("1.2.3", "1.2.2")), [...windowsArtifacts, "extra.zip"]]) {
      expect(() => planTauriUploads(paths, context)).toThrow();
    }
    expect(() => planTauriUploads(windowsArtifacts, { ...context, appVersion: "1.2.2" })).toThrow("version differs");
    expect(() => planTauriUploads(windowsArtifacts, { ...context, platform: "unknown" })).toThrow("unsupported");
    await expect(main(["upload", tag, String(id), sha, "--tauri-artifacts"], { GITHUB_REPOSITORY: repo, DRY_RUN: "true", TAURI_ARTIFACT_PATHS: "bad JSON" })).rejects.toThrow("artifactPaths output is not valid JSON");
    await expect(main(["upload", tag, String(id), sha, "--tauri-typo"], { GITHUB_REPOSITORY: repo, DRY_RUN: "true" })).rejects.toThrow("unknown draft upload option");
  });

  it("uploads nothing when the draft became public after build", () => {
    const folder = mkdtempSync(resolve(tmpdir(), "maru-built-public-"));
    try {
      const f = fixture();
      const completedBuild = completedWindowsBuild(folder);
      f.state.release.draft = false;
      expect(() => uploadTauriArtifacts(completedBuild, { tag, id, sha, repo, platform: "windows-latest", appVersion: "1.2.3", runGh: f.runGh })).toThrow("already public");
      expect(f.calls).toEqual([{ method: "GET", route: `repos/${repo}/releases/${id}` }]);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it.each(["missing", "empty", "directory"])("rejects a later %s file before any API call", (failure) => {
    const folder = mkdtempSync(resolve(tmpdir(), "maru-invalid-batch-"));
    try {
      const files = completedWindowsBuild(folder);
      // Planning succeeds: only the second file's actual filesystem state is bad.
      expect(planTauriUploads(files, { tag, platform: "windows-latest", appVersion: "1.2.3" })).toHaveLength(4);
      if (failure === "empty") writeFileSync(files[1], "");
      else { unlinkSync(files[1]); if (failure === "directory") mkdirSync(files[1]); }
      const f = fixture();
      expect(() => uploadTauriArtifacts(files, { tag, id, sha, repo, platform: "windows-latest", appVersion: "1.2.3", runGh: f.runGh })).toThrow(/rebuild.*retry Release Bundles/);
      expect(f.calls).toEqual([]);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("rejects a later unreadable file before any API call (POSIX permissions)", () => {
    const folder = mkdtempSync(resolve(tmpdir(), "maru-unreadable-batch-"));
    try {
      const files = completedWindowsBuild(folder);
      chmodSync(files[1], 0);
      const f = fixture();
      expect(() => uploadTauriArtifacts(files, { tag, id, sha, repo, platform: "windows-latest", appVersion: "1.2.3", runGh: f.runGh })).toThrow("is unreadable; rebuild");
      expect(f.calls).toEqual([]);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it("maps files without copying and reasserts before each write", () => {
    const folder = mkdtempSync(resolve(tmpdir(), "maru-checked-tauri-"));
    try {
      const files = completedWindowsBuild(folder);
      const f = fixture();
      const uploaded = uploadTauriArtifacts(files, { tag, id, sha, repo, platform: "windows-latest", appVersion: "1.2.3", runGh: f.runGh });
      expect(uploaded.map((item) => item.name)).toEqual(windowsNames);
      expect(f.calls.filter((call) => call.method === "POST").map((call) => new URL(call.route).searchParams.get("name"))).toEqual(windowsNames);
      expect(f.calls.filter((call) => call.route === `repos/${repo}/releases/${id}`)).toHaveLength(4);
      const changed = fixture();
      const runGh = (args: string[], options?: { input?: string }) => {
        const result = changed.runGh(args, options);
        if (args[2] === "POST") changed.state.release.draft = false;
        return result;
      };
      expect(() => uploadTauriArtifacts(files, { tag, id, sha, repo, platform: "windows-latest", appVersion: "1.2.3", runGh })).toThrow("already public");
      expect(changed.calls.filter((call) => call.method === "POST")).toHaveLength(1);
      expect(changed.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it("leaves the action build-only and sends its output to the checked CLI", () => {
    const source = readFileSync(resolve(process.cwd(), ".github/workflows/release-bundles.yml"), "utf8");
    const build = source.split("      - name: Build Tauri bundles\n")[1]?.split(/^      - /m)[0];
    expect(build).toContain("uses: tauri-apps/tauri-action@action-v0.6.2");
    expect(build).not.toMatch(/^\s*(releaseId|tagName|releaseName|GITHUB_TOKEN):/m);
    expect(build).toContain("includeUpdaterJson: false");
    const upload = source.split("      - name: Upload checked Tauri bundles\n")[1]?.split(/^      - /m)[0];
    expect(upload).toContain("shell: bash");
    expect(upload).toContain("TAURI_ARTIFACT_PATHS: ${{ steps.tauri_build.outputs.artifactPaths }}");
    expect(upload).toContain("TAURI_APP_VERSION: ${{ steps.tauri_build.outputs.appVersion }}");
    expect(upload).toContain('release-draft.mjs upload "$RELEASE_TAG" "$RELEASE_ID" "$RELEASE_SHA" --tauri-artifacts');
    expect(source.indexOf("- name: Build Tauri bundles")).toBeLessThan(source.indexOf("- name: Upload checked Tauri bundles"));
  });
});

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
