// Ship-isolation guard for the native-e2e runner (D-10, T-06-01). Declaring
// the intent and checking the output are different acts: a stray build flag
// or a cargo feature arriving through a dependency is exactly what the
// source declaration cannot catch, so both halves of this guard read a
// PRODUCED artifact.
//
// What runs where, and why:
//
// - Bundle half (every run): scans dist/assets/*.js for the debug bridge
//   namespace. Chained into `build:frontend` after check-bundle-budget.mjs,
//   so `make verify` carries it against a freshly produced production bundle
//   with no new entry in verify's prerequisite list. It is deliberately NOT
//   chained into `build:frontend:native-e2e` — that build is supposed to
//   contain the bridge, so the guard would fail by design there.
//
// - Manifest assertions (every run): `cargo metadata --no-deps` re-reads the
//   declaration plan 06-01 made. Cheap early warning only — `--no-deps`
//   structurally cannot see a feature that arrives through another crate's
//   dependency table, so on its own this does not satisfy D-10.
//
// - Binary half (`--binary <path>` only): scans the built executable for the
//   plugin crate's own name, which Rust embeds in symbol names and in the
//   panic-location paths compiled into the binary. Wired into the Makefile's
//   `release-checks` recipe between the debug no-bundle Tauri build and the
//   artifact prune (a binary must exist, and the check must run before
//   `clean:tauri-debug` deletes it); `release-preflight` inherits it through
//   `release-preflight-core`. Not on the `build:frontend` path because no
//   binary exists there and the build cost is only paid where one does.
//   The scan targets the UNSTRIPPED debug no-bundle build deliberately:
//   symbol stripping would let a release binary pass vacuously, while the
//   debug build is resolved with the same default feature set the release
//   build uses, so the feature-propagated-through-a-dependency case is
//   exactly what it catches (T-06-13).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Identifiers that must stay in sync with their sources -----------------
// The browser global declared by src/lib/nativeE2eBridge.ts (plan 06-02). If
// that module renames the namespace, update this string in the same change.
const BRIDGE_NAMESPACE = "__MARU_NATIVE_E2E__";
// The embedded WebDriver plugin crate (registry: tauri-plugin-wdio-webdriver
// 1.3.0, optional dependency in src-tauri/Cargo.toml). Rust embeds both name
// forms in the binary: the hyphenated registry form in panic-location paths
// and the underscored lib form in symbol names (src-tauri/src/lib.rs calls
// tauri_plugin_wdio_webdriver::init()). If the crate is renamed or replaced,
// update both strings in the same change.
const PLUGIN_CRATE_HYPHENATED = "tauri-plugin-wdio-webdriver";
const PLUGIN_CRATE_UNDERSCORED = "tauri_plugin_wdio_webdriver";

const violations = [];

function parseArgs(argv) {
  const args = { binary: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--binary") {
      const path = argv[i + 1];
      if (!path) {
        console.error("native-e2e-isolation: --binary requires a path argument");
        process.exit(1);
      }
      args.binary = path;
      i += 1;
    } else {
      console.error(`native-e2e-isolation: unknown argument ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}

// --- Bundle half: the built JS must not carry the debug bridge -------------
function checkBundle() {
  const assetsDir = join(repoRoot, "dist", "assets");
  if (!existsSync(assetsDir)) {
    console.error(
      "native-e2e-isolation: dist/assets/ does not exist — run `pnpm build:frontend` first",
    );
    process.exit(1);
  }
  const offenders = readdirSync(assetsDir)
    .filter((file) => file.endsWith(".js"))
    .filter((file) =>
      readFileSync(join(assetsDir, file), "utf8").includes(BRIDGE_NAMESPACE),
    );
  if (offenders.length > 0) {
    violations.push(
      `production bundle carries the native-e2e debug bridge (${BRIDGE_NAMESPACE}):\n` +
        `  ${offenders.map((f) => `dist/assets/${f}`).join("\n  ")}\n` +
        "  This dist/ was most likely produced by `make test-e2e-native` or " +
        "`pnpm build:frontend:native-e2e` — a correct failure on a build that " +
        "was never meant to ship. Re-run `pnpm build:frontend`.",
    );
  }
}

// --- Manifest assertions: cheap early warning over the declaration ---------
function checkManifest() {
  let metadata;
  try {
    metadata = JSON.parse(
      execFileSync(
        "cargo",
        [
          "metadata",
          "--offline",
          "--no-deps",
          "--format-version",
          "1",
          "--manifest-path",
          join(repoRoot, "src-tauri", "Cargo.toml"),
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      ),
    );
  } catch (error) {
    // An environmental cargo failure — cargo not installed, a cold registry
    // cache (`--offline` fails on a machine that has never run cargo), a
    // corrupted index — is NOT an isolation violation. Hard-failing here
    // would block `pnpm build:frontend` for frontend-only contributors and
    // misdiagnose an environment problem as a D-10 breach, training people
    // to bypass the gate. Warn and skip the manifest half instead: the
    // bundle half still guards the artifact that actually ships. Exit-1 is
    // reserved for a SUCCESSFULLY PARSED manifest that violates D-10 (and
    // for the parse-level assertions below, which only run when metadata
    // was produced).
    console.warn(
      "native-e2e-isolation: skipping Cargo manifest assertions — " +
        `cargo metadata failed for environmental reasons: ${error.message}`,
    );
    return;
  }
  const maru = metadata.packages.find((pkg) => pkg.name === "maru");
  if (!maru) {
    violations.push("cargo metadata output has no `maru` package");
    return;
  }
  const features = maru.features ?? {};
  const defaultFeatures = features.default ?? [];
  if (defaultFeatures.length !== 0) {
    violations.push(
      `Cargo.toml default features must stay empty (D-10); found: ${defaultFeatures.join(", ")}`,
    );
  }
  if (!("native-e2e" in features)) {
    violations.push(
      "Cargo.toml no longer declares a `native-e2e` feature — a rename silently disarms the whole isolation mechanism",
    );
  }
  const pluginDep = (maru.dependencies ?? []).find(
    (dep) => dep.name === PLUGIN_CRATE_HYPHENATED,
  );
  if (!pluginDep) {
    violations.push(`Cargo.toml no longer depends on ${PLUGIN_CRATE_HYPHENATED}`);
  } else if (pluginDep.optional !== true) {
    violations.push(
      `${PLUGIN_CRATE_HYPHENATED} lost its \`optional = true\` — it would compile into every build`,
    );
  }
  // Nothing reachable from `default` may enable the plugin. default is
  // asserted empty above; this walks the feature graph anyway so a future
  // non-empty default is checked rather than only reported.
  const seen = new Set();
  const queue = [...defaultFeatures];
  while (queue.length > 0) {
    const feature = queue.shift();
    if (seen.has(feature)) continue;
    seen.add(feature);
    for (const entry of features[feature] ?? []) {
      if (entry === `dep:${PLUGIN_CRATE_HYPHENATED}` || entry === PLUGIN_CRATE_HYPHENATED) {
        violations.push(`feature \`${feature}\` reachable from \`default\` enables ${PLUGIN_CRATE_HYPHENATED}`);
      } else if (entry in features) {
        queue.push(entry);
      }
    }
  }
}

// --- Binary half: the built executable must not carry the plugin -----------
function checkBinary(binaryPath) {
  if (!existsSync(binaryPath)) {
    console.error(
      `native-e2e-isolation: --binary path does not exist: ${binaryPath}`,
    );
    process.exit(1);
  }
  const bytes = readFileSync(binaryPath);
  for (const needle of [PLUGIN_CRATE_HYPHENATED, PLUGIN_CRATE_UNDERSCORED]) {
    if (bytes.indexOf(needle) !== -1) {
      violations.push(
        `${binaryPath} contains "${needle}" — the embedded WebDriver plugin ` +
          "compiled into a default-feature build (D-10, T-06-01b). A feature " +
          "arriving through a dependency or a stray build flag is exactly " +
          "what this scan exists to catch.",
      );
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.binary) {
  checkManifest();
  checkBinary(args.binary);
} else {
  checkBundle();
  checkManifest();
}

if (violations.length > 0) {
  console.error(
    `native-e2e-isolation: runner-only affordances must not reach a shippable build:\n  ${violations.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(
  args.binary
    ? `native-e2e-isolation: ${args.binary} and Cargo manifest carry no embedded WebDriver plugin`
    : "native-e2e-isolation: bundle and Cargo manifest carry no native-e2e affordances",
);
