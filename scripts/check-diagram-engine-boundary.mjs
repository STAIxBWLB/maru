// Independent SDK boundary: this check belongs to the host, never the extracted SDK.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
export function dependencyViolations(packages, root) {
  const failures = [];
  for (const pkg of packages) {
    for (const dependency of pkg.dependencies) {
      const outside = dependency.path && relative(root, dependency.path).startsWith("..");
      if (["maru", "maru-cli", "maru_lib"].includes(dependency.name) || outside)
        failures.push(`${pkg.name} depends on the host application/outside SDK: ${dependency.name}`);
      if (pkg.name === "maru-diagram-engine" && dependency.name.startsWith("tauri"))
        failures.push("the pure engine depends on Tauri");
    }
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) failures.push(`${pkg.name} lacks a versioned API package`);
  }
  return failures;
}
export function verifySdk(root) {
  const failures = [];
  const metadata = spawnSync("cargo", ["metadata", "--manifest-path", join(root, "Cargo.toml"), "--format-version", "1", "--no-deps"], { encoding: "utf8" });
  if (metadata.status !== 0) throw new Error(`SDK dependency metadata failed: ${metadata.stderr.trim()}; run cargo metadata for the SDK and repair its manifest.`);
  const data = JSON.parse(metadata.stdout);
  failures.push(...dependencyViolations(data.packages, root));
  for (const pkg of data.packages) {
    const directory = resolve(pkg.manifest_path, "..");
    for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) if (!existsSync(join(directory, name))) failures.push(`${pkg.name} lacks ${name}`);
  }
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["target", ".git"].includes(entry.name)) continue;
      const filename = join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.name.endsWith(".rs")) {
        const text = readFileSync(filename, "utf8");
        // Internal crate:: references are allowed; app inclusion and external source paths are not.
        const imports = [...text.matchAll(/(?:include(?:_str|_bytes)?!|#\[path)\s*\(?\s*(?:=\s*)?"([^"\n]+)"/g)];
        if (imports.some((match) => relative(root, resolve(dirname(filename), match[1])).startsWith(".."))
            || /(?:use|extern crate)\s+maru(?:_lib)?\b/.test(text)) failures.push(`${relative(root, filename)} imports application/outside source`);
      }
    }
  };
  // Test corpus include_str! paths inside each crate are valid; only source imports cross a boundary.
  walk(root);
  if (failures.length) throw new Error(`Diagram SDK separation failed: ${failures.join("; ")}; remove app dependencies/imports before retrying.`);
  return data.packages.map((pkg) => pkg.name);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? "src-tauri/crates");
  console.log(`Diagram SDK boundary PASS: ${verifySdk(root).join(", ")}`);
}
