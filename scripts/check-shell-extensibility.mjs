import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const appPath = "src/App.tsx";
const documentListPath = "src/components/DocumentList.tsx";
const settingsPath = "src/lib/settings.ts";
const registryPath = "src/lib/modeRegistry.tsx";
const registryTestPath = "src/lib/modeRegistry.test.ts";
const drillAdapterPath = "src/lib/modeAdapters/Phase5DrillModeAdapter.tsx";

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function replaceOnce(source, anchor, replacement, label) {
  if (!source.includes(anchor)) throw new Error(`drill anchor missing: ${label}`);
  return source.replace(anchor, replacement);
}

function run(command, args) {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`drill command failed: ${command} ${args.join(" ")}`);
}

async function withRestoration(paths, operation) {
  const originals = new Map(await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")])));
  const appBefore = digest(originals.get(appPath));
  try {
    await operation();
    const appAfter = digest(await readFile(appPath, "utf8"));
    if (appAfter !== appBefore) throw new Error("drill changed src/App.tsx");
  } finally {
    await Promise.all([...originals].map(([path, source]) => writeFile(path, source)));
    await rm(drillAdapterPath, { force: true });
    const restoredApp = digest(await readFile(appPath, "utf8"));
    if (restoredApp !== appBefore) throw new Error("drill restoration changed src/App.tsx");
  }
}

async function runAddStateDrill() {
  await withRestoration([appPath, documentListPath], async () => {
    const source = await readFile(documentListPath, "utf8");
    const next = replaceOnce(
      source,
      '  recordShellSurfaceRender("DocumentList");',
      '  recordShellSurfaceRender("DocumentList");\n  const [phase5DrillLocalState] = useState(false);\n  void phase5DrillLocalState;',
      "DocumentList local state insertion",
    );
    await writeFile(documentListPath, next);
    run("pnpm", ["test", "--", "src/lib/shellDecomposition.test.ts"]);
  });
}

async function runAddModeDrill() {
  await withRestoration([appPath, settingsPath, registryPath, registryTestPath], async () => {
    const settings = await readFile(settingsPath, "utf8");
    await writeFile(settingsPath, replaceOnce(
      settings,
      '  | "agents";',
      '  | "agents"\n  | "phase5-drill";',
      "MaruAppMode insertion",
    ));

    let registry = await readFile(registryPath, "utf8");
    registry = replaceOnce(
      registry,
      '  "catalog", "studio", "e2e", "diagram", "sites", "graph", "drafts", "gap", "agents",\n] as const',
      '  "catalog", "studio", "e2e", "diagram", "sites", "graph", "drafts", "gap", "agents", "phase5-drill",\n] as const',
      "registered mode insertion",
    );
    registry = replaceOnce(
      registry,
      '};\n\nconst lazyAdapters:',
      '  "phase5-drill": {\n    id: "phase5-drill",\n    load: () => import("./modeAdapters/Phase5DrillModeAdapter").then((module) => ({ default: module.Phase5DrillModeAdapter })),\n    placements: ["primary"],\n    isAvailable: () => true,\n    fallback: "mode-loading",\n  },\n};\n\nconst lazyAdapters:',
      "descriptor insertion",
    );
    registry = replaceOnce(
      registry,
      '  catalog: lazy(modeRegistry.catalog.load),\n};',
      '  catalog: lazy(modeRegistry.catalog.load),\n  "phase5-drill": lazy(modeRegistry["phase5-drill"].load),\n};',
      "lazy adapter insertion",
    );
    await writeFile(registryPath, registry);
    const registryTest = await readFile(registryTestPath, "utf8");
    await writeFile(registryTestPath, replaceOnce(
      registryTest,
      '      "catalog", "studio", "e2e", "diagram", "sites", "graph", "drafts", "gap", "agents",\n    ]);',
      '      "catalog", "studio", "e2e", "diagram", "sites", "graph", "drafts", "gap", "agents", "phase5-drill",\n    ]);',
      "registry expectation insertion",
    ));
    await writeFile(
      drillAdapterPath,
      'import type { ModeAdapterProps } from "../modeRegistry";\n\nexport function Phase5DrillModeAdapter(_: ModeAdapterProps) {\n  return null;\n}\n',
    );

    run("pnpm", ["typecheck"]);
    run("pnpm", ["test", "--", "src/lib/shellDecomposition.test.ts", "src/lib/modeRegistry.test.ts"]);
    run("pnpm", ["build"]);
    run("pnpm", ["check:bundle-budget"]);
  });
}

await runAddStateDrill();
await runAddModeDrill();
process.stdout.write("\nshell extensibility drills passed and restored every source file\n");
