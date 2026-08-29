// D-09: every native-e2e run seeds a fresh temp directory and points the
// launched app at it through the two isolation env vars paths.rs resolves
// (`MARU_NATIVE_E2E_HOME`, `MARU_NATIVE_E2E_CONFIG_DIR`). Mirrors the
// mkdtemp / spawn-with-one-added-env-key idiom in
// scripts/e2e-mcp-smoke.mjs: one root, every write derived from it by
// path.join, never from a caller-supplied absolute path (T-06-02).
//
// No credentials are seeded here, and the updater / provider IO paths are
// left unconfigured (D-11) - the fixture registers exactly one local
// workspace with one markdown document, nothing else.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  await fs.writeFile(
    path.join(registryDir, WORKSPACE_REGISTRY_FILE),
    JSON.stringify(registry, null, 2),
    "utf8",
  );
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
  const resolved = fixturePaths(root);
  process.env.MARU_NATIVE_E2E_HOME = resolved.homeDir;
  process.env.MARU_NATIVE_E2E_CONFIG_DIR = resolved.configDir;
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
  for (const dir of [workspaceDir, configDir]) {
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
  await fs.rm(root, { recursive: true, force: true });
}
