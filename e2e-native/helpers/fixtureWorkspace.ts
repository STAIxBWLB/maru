// D-09: every native-e2e spec seeds a fresh temp directory and points the
// launched app at it through the two isolation env vars paths.rs resolves
// (`MARU_NATIVE_E2E_HOME`, `MARU_NATIVE_E2E_CONFIG_DIR`). Mirrors the
// mkdtemp / spawn-with-one-added-env-key idiom in
// scripts/e2e-mcp-smoke.mjs: one root, every write derived from it by
// path.join, never from a caller-supplied absolute path (T-06-02).
//
// No credentials are seeded here, and the updater / provider IO paths are
// left unconfigured (D-11). The fixture registers one local workspace and
// a skill source backed by a disposable local Git remote.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const FIXTURE_SKILL_SOURCE = "native-local-git";
export const FIXTURE_SKILL_TITLE = "Native synced skill";

// Plan 08-27 saturation fixtures: two disposable Git repos with modified
// tracked files, a 2000-file Markdown tree for the real scan workload, and
// three additional cloned skill sources with local bare remotes and pending
// commits. Every path lives under the one mkdtemp root; nothing here touches
// a live workspace, credential, or public remote.
export const FIXTURE_GIT_REPO_A = "git-repo-a";
export const FIXTURE_GIT_REPO_B = "git-repo-b";
export const FIXTURE_VAULT_TREE = "vault-tree";
export const FIXTURE_VAULT_TREE_FILES = 2000;
export const FIXTURE_SYNC_SOURCE_A = "native-sync-a";
export const FIXTURE_SYNC_SOURCE_B = "native-sync-b";
export const FIXTURE_FAIL_SOURCE = "native-fail-git";
export const FIXTURE_SKILL_TITLE_A = "Native Saturation Skill A";
export const FIXTURE_SKILL_TITLE_B = "Native Saturation Skill B";
/** Marker the pending commit adds to the updated SKILL.md: the discarded-sync
 *  assertions check for this exact description so a startup catalog refresh
 *  (the app's production behavior of rescanning an empty catalog) persisting
 *  the OLD checkout content cannot be mistaken for the discarded sync's
 *  write-back. */
export const FIXTURE_PENDING_DESCRIPTION = "Native local Git fixture updated";

function gitEnv() {
  return { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0" };
}

function runGit(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface SeededSkillSource {
  id: string;
  checkout: string;
  remote: string;
  /** Checkout HEAD at seed time: a pull moves this forward, and the restore
   *  helper resets back to it so later specs keep their pending commits. */
  head: string;
}

/** Seeds one disposable cloned skill source (bare remote + author clone with
 *  a pending commit + app checkout one commit behind) and returns its paths.
 *  The checkout lives under the fixture skills root in the same nested shape
 *  seedSkillSource established, so the public-tier placement rule holds. */
async function seedClonedSkillSource(root: string, id: string, title: string): Promise<SeededSkillSource> {
  const { homeDir } = fixturePaths(root);
  const skillsRoot = path.join(homeDir, ".maru", "skills");
  const remote = path.join(root, `skills-remote-${id}.git`);
  const author = path.join(root, `skills-author-${id}`);
  const checkout = path.join(skillsRoot, "_sources", id, "_sources", "skills-public");
  await fs.mkdir(skillsRoot, { recursive: true });
  runGit(["init", "--bare", remote]);
  runGit(["clone", remote, author]);
  await fs.mkdir(path.join(author, "skills", id), { recursive: true });
  const skillFile = path.join(author, "skills", id, "SKILL.md");
  await fs.writeFile(skillFile, `---\nname: ${title}\ndescription: Native local Git fixture\n---\n# Initial\n`);
  runGit(["-C", author, "add", "."]);
  runGit(["-C", author, "-c", "user.name=Native Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Seed local source"]);
  runGit(["-C", author, "push", "origin", "HEAD"]);
  await fs.mkdir(path.dirname(checkout), { recursive: true });
  runGit(["clone", remote, checkout]);
  await fs.writeFile(skillFile, `---\nname: ${title}\ndescription: ${FIXTURE_PENDING_DESCRIPTION}\n---\n# Synced\n`);
  runGit(["-C", author, "add", "."]);
  runGit(["-C", author, "-c", "user.name=Native Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Update local source"]);
  runGit(["-C", author, "push", "origin", "HEAD"]);
  const head = runGit(["-C", checkout, "rev-parse", "HEAD"]).trim();
  return { id, checkout, remote, head };
}

async function seedSkillSource(root: string): Promise<SeededSkillSource> {
  return seedClonedSkillSource(root, FIXTURE_SKILL_SOURCE, FIXTURE_SKILL_TITLE);
}

/** Two disposable Git repos whose single tracked file is modified after the
 *  seed commit, so git_status must report a nonempty dirty state. */
async function seedGitRepos(root: string): Promise<void> {
  for (const name of [FIXTURE_GIT_REPO_A, FIXTURE_GIT_REPO_B]) {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    runGit(["-C", dir, "init", "-b", "main"]);
    await fs.writeFile(path.join(dir, "note.md"), `# ${name}\n\nseeded\n`);
    runGit(["-C", dir, "add", "."]);
    runGit(["-C", dir, "-c", "user.name=Native Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Seed repo"]);
    await fs.writeFile(path.join(dir, "note.md"), `# ${name}\n\nseeded, then modified for the saturation window\n`);
  }
}

/** A real 2000-file Markdown tree: the scan_vault workload must return at
 *  least this many entries for a no-op wrapper to be unable to pass. */
async function seedVaultTree(root: string): Promise<void> {
  const tree = path.join(root, FIXTURE_VAULT_TREE);
  const batchCount = 20;
  const perBatch = FIXTURE_VAULT_TREE_FILES / batchCount;
  for (let batch = 0; batch < batchCount; batch += 1) {
    const dir = path.join(tree, `batch-${String(batch).padStart(2, "0")}`);
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: perBatch }, (_, index) => {
        const number = batch * perBatch + index;
        return fs.writeFile(
          path.join(dir, `note-${String(number).padStart(5, "0")}.md`),
          `---\ntitle: Saturation note ${number}\n---\n\n# Note ${number}\n\nSeeded by the native saturation harness.\n`,
        );
      }),
    );
  }
}

export async function readFixtureSkillRegistry(): Promise<{ sources: { id: string; path?: string; skillsSubdir?: string; lastSyncedAt?: string }[]; skills: { sourceId: string; title: string; description?: string; valid: boolean; absPath: string }[]; removedSourceIds?: string[] }> {
  return JSON.parse(await fs.readFile(path.join(fixturePaths(requireFixtureRoot()).homeDir, ".maru", "skills", "registry.json"), "utf8"));
}

const SEEDED_REGISTRY_BACKUP = "seeded-registry.json";
const FIXTURE_METADATA_FILE = "fixture-metadata.json";

export interface FixtureMetadata {
  sources: SeededSkillSource[];
  gitRepos: string[];
  vaultTree: string;
  vaultTreeFiles: number;
}

/** Absolute path of the disposable fixture root in this (worker) process. */
export function fixtureRootDir(): string {
  return requireFixtureRoot();
}

/** The app's global settings file under the fixture home (holds ui.activeAppMode). */
export function fixtureGlobalSettingsFile(): string {
  return path.join(fixturePaths(requireFixtureRoot()).homeDir, ".maru", "settings.json");
}

/** Paths the saturation spec passes to the app through the debug bridge. */
export function saturationFixturePaths(): { repoA: string; repoB: string; tree: string } {
  const root = requireFixtureRoot();
  return {
    repoA: path.join(root, FIXTURE_GIT_REPO_A),
    repoB: path.join(root, FIXTURE_GIT_REPO_B),
    tree: path.join(root, FIXTURE_VAULT_TREE),
  };
}

export async function readFixtureMetadata(): Promise<FixtureMetadata> {
  return JSON.parse(await fs.readFile(path.join(requireFixtureRoot(), FIXTURE_METADATA_FILE), "utf8"));
}

const BROKEN_REMOTE_SUFFIX = ".broken";

/** D-05 fault injection: rename the disposable bare remote away so the real
 *  git pull fails with an actionable reason. */
export async function breakFailSourceRemote(): Promise<void> {
  const meta = await readFixtureMetadata();
  const remote = meta.sources.find((source) => source.id === FIXTURE_FAIL_SOURCE)?.remote;
  if (!remote) throw new Error("native-fail-git remote missing from fixture metadata");
  await fs.rename(remote, remote + BROKEN_REMOTE_SUFFIX);
}

export async function restoreFailSourceRemote(): Promise<void> {
  const meta = await readFixtureMetadata();
  const remote = meta.sources.find((source) => source.id === FIXTURE_FAIL_SOURCE)?.remote;
  if (!remote) throw new Error("native-fail-git remote missing from fixture metadata");
  await fs.rename(remote + BROKEN_REMOTE_SUFFIX, remote).catch(() => {});
}

/** Restores the skill fixtures to their seeded state after the destructive
 *  D-case tests: registry.json from the seeded backup, and every checkout
 *  reset in place to its seed HEAD (never deleting directories, so an app
 *  filesystem watcher on the skills root survives) so each source keeps a
 *  pending commit for the specs that run after this file. */
export async function restoreSkillFixtures(): Promise<void> {
  const root = requireFixtureRoot();
  const meta = await readFixtureMetadata();
  for (const source of meta.sources) {
    runGit(["-C", source.checkout, "reset", "--hard", source.head]);
  }
  const skillsRoot = path.join(fixturePaths(root).homeDir, ".maru", "skills");
  const backup = path.join(root, SEEDED_REGISTRY_BACKUP);
  const tmp = path.join(skillsRoot, `.registry-restore-${process.pid}.tmp`);
  await fs.copyFile(backup, tmp);
  await fs.rename(tmp, path.join(skillsRoot, "registry.json"));
}

/** Stem of the one seeded markdown document, exported so specs assert
 * against the same literal rather than duplicating it. */
export const FIXTURE_DOC_NAME = "Welcome";

/** The `.hwpx` the editor spec opens: a byte-for-byte copy of the template
 *  the hwped Rust fixtures already use, seeded into the workspace so the
 *  app's first catalog scan sees it and nothing depends on a network or a
 *  build step. */
export const FIXTURE_HWPX_NAME = "hwp-cli-plan-template.hwpx";

/** The repository's own copy, read by the spec so the untouched-on-disk check
 *  compares against that source rather than a copy the spec wrote itself. */
export function fixtureHwpxSource(): URL {
  return new URL("../../src-tauri/testdata/hwp-cli-plan-template.hwpx", import.meta.url);
}

/** The seeded copy inside this worker's fixture workspace. */
export function fixtureHwpxPath(): string {
  return path.join(fixturePaths(requireFixtureRoot()).workspaceDir, FIXTURE_HWPX_NAME);
}

export const FIXTURE_DOC_CONTENT = [
  "# Welcome",
  "",
  "Seeded by e2e-native/helpers/fixtureWorkspace.ts for the native-e2e runner.",
  "",
].join("\n");

const REGISTRY_LABEL = "Native E2E Fixture";
const APP_CONFIG_DIR = "com.maru.app";
const WORKSPACE_REGISTRY_FILE = "workspaces.json";

let fixtureRoot: string | null = null;
/** Per-worker latch: the first beforeTest sees the just-seeded state (the
 *  app launched after onPrepare), so only later tests need a real reset. */
const previousGitEnv = new Map<string, string | undefined>();
const previousCompletionEnv = new Map<string, string | undefined>();

/** Launcher-only, per-spec synthetic providers. Neither script forwards an
 * argument to an ambient CLI or reads credentials. The production provider
 * resolver discovers them through the PATH inherited before app launch. */
export async function enableTaskCompletionProviders(): Promise<void> {
  if (Number(process.env.MARU_NATIVE_E2E_LAUNCHER_PID) !== process.pid) {
    throw new Error("task completion providers must be seeded by the native launcher before app spawn");
  }
  if (previousCompletionEnv.size) throw new Error("task completion providers are already active for this fixture");
  const root = requireFixtureRoot();
  const bin = path.join(root, "task-completion-bin");
  const calls = path.join(root, "task-completion-provider-calls.jsonl");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const proposal = JSON.stringify({
    schemaVersion: "maru_skill_proposal_v1", summary: "Native fixture proposes one task artifact",
    files: [{ path: "scratchpad/memos/native-task-output.md", operation: "create", content: "# Native task output\n\nSynthetic provider lifecycle evidence.\n" }],
    commands: [], risks: [], requiresApproval: true,
  });
  const review = JSON.stringify({ passed: true, reason: "Native fixture verified the committed artifact" });
  const scripts: Record<string, string> = {
    codex: ["#!/bin/sh", "set -eu",
      'if test "$#" -eq 1 && test "$1" = --version; then printf "codex native-fixture\\n"; exit 0; fi',
      'if test "$#" -eq 2 && test "$1" = login && test "$2" = status; then printf "Logged in using ChatGPT\\n"; exit 0; fi',
      'test "$#" -gt 0 && test "$1" = exec || exit 97',
      "/bin/cat >/dev/null",
      `printf '%s\\n' '{"provider":"codex","operation":"creator"}' >> ${quote(calls)}`,
      `printf '%s\\n' ${quote(proposal)}`, ""].join("\n"),
    claude: ["#!/bin/sh", "set -eu",
      'if test "$#" -eq 1 && test "$1" = --version; then printf "claude native-fixture\\n"; exit 0; fi',
      'if test "$#" -ge 2 && test "$1" = auth && test "$2" = status; then printf \'{"loggedIn":true,"authMethod":"oauth"}\\n\'; exit 0; fi',
      'test "$#" -gt 1 && test "$1" = -p || exit 98',
      `printf '%s\\n' '{"provider":"claude","operation":"review"}' >> ${quote(calls)}`,
      `printf '%s\\n' ${quote(review)}`, ""].join("\n"),
    kimi: "#!/bin/sh\nexit 127\n",
    "kiro-cli": "#!/bin/sh\nexit 127\n",
    kiro: "#!/bin/sh\nexit 127\n",
  };
  await fs.mkdir(bin, { recursive: true });
  for (const [name, source] of Object.entries(scripts)) {
    const file = path.join(bin, name);
    const handle = await fs.open(file, "w", 0o600);
    try { await handle.writeFile(source); await handle.sync(); }
    finally { await handle.close(); }
    await fs.chmod(file, 0o700);
    if (name === "codex" || name === "claude") {
      execFileSync(file, ["--version"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] });
    }
  }
  const { homeDir, workspaceDir } = fixturePaths(root);
  await fs.mkdir(path.join(workspaceDir, "scratchpad/memos"), { recursive: true });
  const settingsFile = path.join(homeDir, ".maru/settings.json");
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(await fs.readFile(settingsFile, "utf8")) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  settings.ai = {
    ...(typeof settings.ai === "object" && settings.ai !== null ? settings.ai : {}),
    defaultRuntime: "codex", adaptivePolicy: { enabled: false, workload: "auto" },
    commandOverrides: { claude: null, codex: null, kimi: null, kiro: null },
  };
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2));
  for (const [key, value] of Object.entries({
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    MARU_NATIVE_E2E_TASK_COMPLETION_FIXTURE: "1",
  })) {
    previousCompletionEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
}

/** Launcher-owned boundaries; a failed stop never permits deleting a live root. */
export function createNativeFixtureLifecycle(actions: {
  seed: () => Promise<unknown>;
  stopOwnedApp: () => Promise<void>;
  cleanup: () => Promise<void>;
}) {
  let prepared = false;
  let worker: string | null = null;
  return {
    async prepare() {
      if (prepared) throw new Error("native fixture already prepared");
      prepared = true; // Keep partial seeds owned for failure-path teardown.
      await actions.seed();
    },
    async start(id: string) {
      if (worker !== null) throw new Error(`native fixture still owned by worker ${worker}`);
      if (!prepared) { prepared = true; await actions.seed(); }
      worker = id;
    },
    async end(id: string) {
      if (worker !== id) throw new Error(`native fixture worker mismatch: ${id}`);
      await actions.stopOwnedApp();
      await actions.cleanup();
      prepared = false;
      worker = null;
    },
    async complete() {
      if (!prepared) return;
      await actions.stopOwnedApp();
      await actions.cleanup();
      prepared = false;
      worker = null;
    },
  };
}

function fixturePaths(root: string) {
  return {
    homeDir: path.join(root, "home"),
    configDir: path.join(root, "config"),
    workspaceDir: path.join(root, "workspace"),
  };
}

function requireFixtureRoot(): string {
  if (!fixtureRoot) {
    // Worker-process path: seeding ran in the launcher (wdio.conf onPrepare),
    // so module state here is empty, but the launcher forked this worker with
    // the isolation env vars set. homeDir is <root>/home, so the root is its
    // parent. Only beforeTest's reset takes this path.
    const home = process.env.MARU_NATIVE_E2E_HOME;
    if (!home) {
      throw new Error(
        "fixtureWorkspace: no fixture root in this process and MARU_NATIVE_E2E_HOME is unset",
      );
    }
    fixtureRoot = path.dirname(home);
  }
  return fixtureRoot;
}

async function writeFixtureContent(root: string): Promise<void> {
  const { homeDir, configDir, workspaceDir } = fixturePaths(root);
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  const registryDir = path.join(configDir, APP_CONFIG_DIR);
  await fs.mkdir(registryDir, { recursive: true });

  await fs.writeFile(path.join(workspaceDir, `${FIXTURE_DOC_NAME}.md`), FIXTURE_DOC_CONTENT, "utf8");
  // Seeded here, not by the spec: the catalog scan that runs at launch is what
  // puts the row in front of the reader, and a file written afterwards needs a
  // reload the spec would otherwise have to drive.
  await fs.copyFile(fixtureHwpxSource(), path.join(workspaceDir, FIXTURE_HWPX_NAME));

  // Minimal valid src-tauri/src/vault_list.rs WorkspaceRegistry shape: one
  // private local workspace, registered and active, nothing else.
  const registry = {
    workspaces: [
      {
        label: REGISTRY_LABEL,
        path: workspaceDir,
        visibility: "private",
        provider: "local",
        writePolicy: "direct",
      },
    ],
    activeByVisibility: { private: workspaceDir },
    hiddenDefaults: [],
  };
  // Write the registry atomically (tmp file + rename, mirroring the app's
  // own write_atomic): a plain writeFile during a between-test reset lets an
  // app-side read land between delete and rewrite and observe a MISSING
  // registry — the zero-workspace state that makes the frontend first-run-
  // seed its Sample Workspace.
  const tmp = path.join(registryDir, `.${WORKSPACE_REGISTRY_FILE}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(registry, null, 2), "utf8");
  await fs.rename(tmp, path.join(registryDir, WORKSPACE_REGISTRY_FILE));
}

/**
 * Creates a fresh mkdtemp root, seeds it, and points this Node process's
 * own environment at it. Call from the config's `onPrepare` hook: it runs
 * in the launcher process before the tauri-service's own onPrepare spawns
 * the app (@wdio/cli runs config onPrepare first), and the service's
 * startEmbeddedDriver spreads process.env into the app spawn - so the two
 * vars reach the app. Workers forked afterwards inherit them too.
 * (RESEARCH Pitfall 8 said `tauri:options` has no env key; that is right,
 * but the service-level `env` option exists and process.env inheritance
 * covers this without it.)
 */
export async function seedFixtureWorkspace(): Promise<{
  homeDir: string;
  configDir: string;
  workspaceDir: string;
}> {
  if (fixtureRoot) throw new Error("fixtureWorkspace: previous root must be disposed before seeding");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maru-native-e2e-"));
  fixtureRoot = root;
  await writeFixtureContent(root);
  const sources = [
    await seedSkillSource(root),
    await seedClonedSkillSource(root, FIXTURE_SYNC_SOURCE_A, FIXTURE_SKILL_TITLE_A),
    await seedClonedSkillSource(root, FIXTURE_SYNC_SOURCE_B, FIXTURE_SKILL_TITLE_B),
    await seedClonedSkillSource(root, FIXTURE_FAIL_SOURCE, "Native Failing Skill"),
  ];
  await seedGitRepos(root);
  await seedVaultTree(root);
  const { homeDir } = fixturePaths(root);
  const skillsRoot = path.join(homeDir, ".maru", "skills");
  const registry = {
    version: 3,
    sources: sources.map((source) => ({
      id: source.id,
      kind: "cloned",
      ownershipClass: "owned-catalog",
      path: source.checkout,
      repoUrl: source.remote,
      skillsSubdir: "skills",
    })),
    skills: [],
    installs: [],
    removedSourceIds: [],
  };
  const seededRegistry = JSON.stringify(registry, null, 2);
  await fs.writeFile(path.join(skillsRoot, "registry.json"), seededRegistry, "utf8");
  await fs.writeFile(path.join(root, SEEDED_REGISTRY_BACKUP), seededRegistry, "utf8");
  const metadata: FixtureMetadata = {
    sources,
    gitRepos: [path.join(root, FIXTURE_GIT_REPO_A), path.join(root, FIXTURE_GIT_REPO_B)],
    vaultTree: path.join(root, FIXTURE_VAULT_TREE),
    vaultTreeFiles: FIXTURE_VAULT_TREE_FILES,
  };
  await fs.writeFile(path.join(root, FIXTURE_METADATA_FILE), JSON.stringify(metadata, null, 2), "utf8");
  const resolved = fixturePaths(root);
  process.env.MARU_NATIVE_E2E_HOME = resolved.homeDir;
  process.env.MARU_NATIVE_E2E_CONFIG_DIR = resolved.configDir;
  for (const [key, value] of Object.entries({ GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" })) {
    previousGitEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  return resolved;
}

/** Restore only the authored leaf. Never delete live app-owned state or the
 * registry: a new spec receives its own complete seed before app launch. */
export async function resetFixtureWorkspace(): Promise<void> {
  const root = requireFixtureRoot();
  const { workspaceDir } = fixturePaths(root);
  const welcome = path.join(workspaceDir, `${FIXTURE_DOC_NAME}.md`);
  try { if (await fs.readFile(welcome, "utf8") === FIXTURE_DOC_CONTENT) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = path.join(workspaceDir, `.welcome-restore-${process.pid}.tmp`);
  await fs.writeFile(temporary, FIXTURE_DOC_CONTENT, "utf8");
  await fs.rename(temporary, welcome);
}

/**
 * Removes the whole mkdtemp root and clears the isolation env vars. Call
 * from the launcher only after its app has exited, never from a worker.
 */
export async function cleanupFixtureWorkspace(): Promise<void> {
  if (!fixtureRoot) return;
  // lifecycle.end/complete already stopped the owned app. Restore the launcher
  // before another worker or application can inherit this fixture's providers.
  for (const [key, value] of previousCompletionEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousCompletionEnv.clear();
  const root = fixtureRoot;
  await fs.rm(root, { recursive: true, force: true });
  fixtureRoot = null;
  delete process.env.MARU_NATIVE_E2E_HOME;
  delete process.env.MARU_NATIVE_E2E_CONFIG_DIR;
  for (const [key, value] of previousGitEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousGitEnv.clear();
}
