#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCargoPackage,
  parseReleaseVersionArgs,
  validateReleaseVersions,
} from "./lib/releaseVersion.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "usage: node scripts/check-release-version.mjs [--tag vX.Y.Z]";

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8"));
  } catch (error) {
    throw new Error(`${relativePath} is not readable JSON: ${error.message}`);
  }
}

function readCargoPackage(relativePath) {
  let contents;
  try {
    contents = readFileSync(resolve(repoRoot, relativePath), "utf8");
  } catch (error) {
    throw new Error(`${relativePath} is not readable: ${error.message}`);
  }
  return parseCargoPackage(contents);
}

function readCargoMetadata() {
  try {
    const output = execFileSync(
      "cargo",
      [
        "metadata",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--locked",
        "--no-deps",
        "--format-version",
        "1",
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(output);
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    const detail = stderr || error.message;
    throw new Error(`cargo metadata failed: ${detail}`);
  }
}

function main() {
  const parsedArgs = parseReleaseVersionArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    for (const error of parsedArgs.errors) console.error(`error: ${error}`);
    console.error(usage);
    return 2;
  }

  let surfaces;
  try {
    surfaces = {
      packageJson: readJson("package.json"),
      tauriConfig: readJson("src-tauri/tauri.conf.json"),
      rootCargoPackage: readCargoPackage("src-tauri/Cargo.toml"),
      maruCliCargoPackage: readCargoPackage("src-tauri/maru-cli/Cargo.toml"),
      cargoMetadata: readCargoMetadata(),
    };
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }

  const result = validateReleaseVersions(surfaces, { tag: parsedArgs.tag });
  for (const success of result.successes) console.log(`ok: ${success}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    return 1;
  }

  return 0;
}

process.exitCode = main();
