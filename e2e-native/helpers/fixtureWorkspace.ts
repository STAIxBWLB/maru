// D-09: every native-e2e run seeds a fresh temp directory and points the
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

const FIXTURE_DOC_CONTENT = [
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
let fixtureDirty = false;
const previousGitEnv = new Map<string, string | undefined>();

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

/**
 * Restores the fixture workspace and registry to their seeded state
 * in-place, without touching the already-launched app's env (D-12: the
 * app is relaunched once per spec file, reset between the tests inside
 * it). Call from `beforeTest`.
 *
 * Two deliberate properties:
 *
 * - The FIRST call in a worker is a no-op. The app for this spec file was
 *   launched after onPrepare seeded the fixture, so its boot already read
 *   the fresh registry. Resetting at that moment races the boot read:
 *   deleting workspaces.json under a booting app makes
 *   listWorkspaceRoots() see zero workspaces, and the frontend then seeds
 *   its first-run Sample Workspace instead (observed: webview.spec's
 *   "Welcome" assertion failing with the sample workspace on screen
 *   whenever the reset landed mid-boot). Resets matter from the second
 *   test on.
 * - The reset removes the CONTENTS of each seeded directory, never the
 *   directories themselves: deleting a watched directory kills the running
 *   app's filesystem watcher on it, and the re-created directory is not
 *   re-watched, so the app never sees the re-seeded files.
 */
export async function resetFixtureWorkspace(): Promise<void> {
  const root = requireFixtureRoot();
  if (!fixtureDirty) {
    fixtureDirty = true;
    return;
  }
  const { workspaceDir, configDir } = fixturePaths(root);
  // Contents only, never the directories themselves — for BOTH the workspace
  // dir and the registry dir. Deleting configDir's com.maru.app entry
  // wholesale would break the same watcher-survival invariant the docstring
  // states for the workspace: the reset removes what is INSIDE
  // config/com.maru.app/, never the registry directory itself.
  const registryDir = path.join(configDir, APP_CONFIG_DIR);
  for (const dir of [workspaceDir, registryDir]) {
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    for (const entry of entries) {
      await fs.rm(path.join(dir, entry), { recursive: true, force: true });
    }
  }
  await writeFixtureContent(root);
}

/**
 * Removes the whole mkdtemp root and clears the isolation env vars. Call
 * from both the pass and the fail teardown path (`afterSession` and
 * `onComplete`) so a run never leaves a fixture root behind.
 */
export async function cleanupFixtureWorkspace(): Promise<void> {
  if (!fixtureRoot) return;
  const root = fixtureRoot;
  fixtureRoot = null;
  delete process.env.MARU_NATIVE_E2E_HOME;
  delete process.env.MARU_NATIVE_E2E_CONFIG_DIR;
  for (const [key, value] of previousGitEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousGitEnv.clear();
  await fs.rm(root, { recursive: true, force: true });
}
