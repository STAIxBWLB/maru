import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function step(workflow: string, name: string) {
  const source = readFileSync(resolve(process.cwd(), `.github/workflows/${workflow}.yml`), "utf8");
  const block = source.split(`      - name: ${name}\n`)[1]?.split(/^      - name: /m)[0];
  if (!block) throw new Error(`Missing ${name}; inspect ${workflow}.yml and restore its credential step`);
  return block;
}

function shell(block: string) {
  const lines = block.split("        run: |\n")[1]?.split("\n") ?? [];
  const script: string[] = [];
  for (const line of lines) {
    if (line && !line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  if (!script.length) throw new Error("Missing credential shell body; restore the workflow run step");
  return script.join("\n");
}

const material = "fixture-notary-material\n";

describe.skipIf(process.platform === "win32")("notarization credential lifecycle (POSIX runner)", () => {
  it.each([
    { exitCode: 0, cleanupFails: false },
    { exitCode: 1, cleanupFails: false },
    { exitCode: 0, cleanupFails: true },
  ])("handles notarytool exit $exitCode and cleanup failure $cleanupFails without exposing the key", ({ exitCode, cleanupFails }) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "maru-notary-probe-"));
    try {
      writeFileSync(resolve(fixture, "xcrun"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const key = args[args.indexOf("--key") + 1];
if (fs.readFileSync(key, "utf8") !== process.env.APPLE_API_PRIVATE_KEY) process.exit(90);
if ((fs.statSync(key).mode & 0o777) !== 0o600) process.exit(91);
fs.writeFileSync(process.env.CAPTURE, JSON.stringify(args));
if (${exitCode}) console.error("fixture authentication failure");
process.exit(${exitCode});
`, { mode: 0o755 });
      if (cleanupFails) {
        writeFileSync(resolve(fixture, "rm"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
      }
      const result = spawnSync("/bin/bash", ["-c", shell(step("release-preflight", "Validate notarization API credentials without submitting an app"))], {
        encoding: "utf8", timeout: 5000,
        env: {
          PATH: `${fixture}:/usr/bin:/bin`, HOME: fixture, RUNNER_TEMP: fixture,
          APPLE_API_PRIVATE_KEY: material, APPLE_API_KEY_ID: "fixture-id",
          APPLE_API_ISSUER_ID: "fixture-issuer", CAPTURE: resolve(fixture, "args.json"),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(cleanupFails ? 1 : exitCode);
      expect(JSON.parse(readFileSync(resolve(fixture, "args.json"), "utf8"))).toEqual([
        "notarytool", "history", "--key", resolve(fixture, "maru-notary-probe.p8"),
        "--key-id", "fixture-id", "--issuer", "fixture-issuer",
      ]);
      expect(existsSync(resolve(fixture, "maru-notary-probe.p8"))).toBe(cleanupFails);
      expect(result.stdout + result.stderr).not.toContain(material.trim());
      if (exitCode) expect(result.stdout).toContain("retry Release Preflight");
      if (cleanupFails) expect(result.stdout).toContain("before retrying Release Preflight");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("refuses missing credentials before creating a key or calling Apple", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "maru-notary-missing-"));
    try {
      const result = spawnSync("/bin/bash", ["-c", shell(step("release-preflight", "Validate notarization API credentials without submitting an app"))], {
        encoding: "utf8", timeout: 5000,
        env: { PATH: "/usr/bin:/bin", HOME: fixture, RUNNER_TEMP: fixture,
          APPLE_API_PRIVATE_KEY: "", APPLE_API_KEY_ID: "fixture-id", APPLE_API_ISSUER_ID: "fixture-issuer" },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("credentials are incomplete");
      expect(result.stdout).toContain("retry Release Preflight");
      expect(existsSync(resolve(fixture, "maru-notary-probe.p8"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("stages only a restricted key path for release consumers and cleans it after failure", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "maru-notary-release-"));
    try {
      const env = { PATH: "/usr/bin:/bin", HOME: fixture, RUNNER_TEMP: fixture,
        APPLE_API_PRIVATE_KEY: material, GITHUB_ENV: resolve(fixture, "github-env") };
      const staged = spawnSync("/bin/bash", ["-c", shell(step("release-bundles", "Prepare App Store Connect API key"))], {
        env, encoding: "utf8", timeout: 5000,
      });
      expect(staged.status).toBe(0);
      const key = resolve(fixture, "maru-notary-auth.p8");
      expect(readFileSync(key, "utf8")).toBe(material);
      expect(statSync(key).mode & 0o777).toBe(0o600);
      expect(readFileSync(env.GITHUB_ENV, "utf8")).toBe(`APPLE_API_KEY_PATH=${key}\n`);
      expect(staged.stdout + staged.stderr).not.toContain(material.trim());
      expect(step("release-bundles", "Remove temporary App Store Connect API key"))
        .toContain("if: always() && matrix.platform == 'macos-26'");
      // Simulate a failing release consumer, then execute the always cleanup.
      expect(spawnSync("/bin/bash", ["-c", "exit 1"], { env }).status).toBe(1);
      const cleaned = spawnSync("/bin/bash", ["-c", shell(step("release-bundles", "Remove temporary App Store Connect API key"))], {
        env, encoding: "utf8", timeout: 5000,
      });
      expect(cleaned.status).toBe(0);
      expect(existsSync(key)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
