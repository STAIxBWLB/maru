import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const material = "-----BEGIN PRIVATE KEY-----\nfixture-notary-material\n-----END PRIVATE KEY-----\n";
const encoded = Buffer.from(material).toString("base64");
const formats = [
  { format: "raw PEM", secret: material },
  { format: "base64 PEM", secret: encoded },
  { format: "wrapped base64 PEM", secret: encoded.match(/.{1,32}/g)!.join("\r\n") },
];

function prepareHelper(fixture: string) {
  const folder = resolve(fixture, ".release-tools/scripts/lib");
  mkdirSync(folder, { recursive: true });
  writeFileSync(resolve(folder, "notary-key.sh"), readFileSync(resolve(process.cwd(), "scripts/lib/notary-key.sh")));
}

describe.skipIf(process.platform === "win32")("notarization credential lifecycle (POSIX runner)", () => {
  it.each([
    { workflow: "release-preflight", name: "Validate notarization API credentials without submitting an app", secret: "%%%fixture-garbage%%%" },
    { workflow: "release-preflight", name: "Validate notarization API credentials without submitting an app", secret: Buffer.from("not a PEM key").toString("base64") },
    { workflow: "release-bundles", name: "Prepare App Store Connect API key", secret: "%%%fixture-garbage%%%" },
    { workflow: "release-bundles", name: "Prepare App Store Connect API key", secret: Buffer.from("not a PEM key").toString("base64") },
  ])("rejects invalid encoding or a missing PRIVATE KEY header in $workflow", ({ workflow, name, secret }) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "maru-notary-format-"));
    try {
      prepareHelper(fixture);
      writeFileSync(resolve(fixture, "xcrun"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.CAPTURE, "unexpected call");\nprocess.exit(99);\n`, { mode: 0o755 });
      const result = spawnSync("/bin/bash", ["-c", shell(step(workflow, name))], {
        cwd: fixture, encoding: "utf8", timeout: 5000,
        env: { PATH: `${fixture}:/usr/bin:/bin`, HOME: fixture, RUNNER_TEMP: fixture,
          APPLE_API_PRIVATE_KEY: secret, APPLE_API_KEY_ID: "fixture-id", APPLE_API_ISSUER_ID: "fixture-issuer",
          GITHUB_ENV: resolve(fixture, "github-env"), CAPTURE: resolve(fixture, "called") },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("APPLE_API_KEY is neither PEM nor base64 PEM");
      expect(result.stdout).toContain("gh secret set APPLE_API_KEY < AuthKey_<id>.p8");
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(existsSync(resolve(fixture, "maru-notary-auth.p8"))).toBe(false);
      expect(existsSync(resolve(fixture, "maru-notary-probe.p8"))).toBe(false);
      expect(existsSync(resolve(fixture, "github-env"))).toBe(false);
      expect(existsSync(resolve(fixture, "called"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each([
    ...formats.map((input) => ({ ...input, exitCode: 0, cleanupFails: false })),
    { ...formats[0], exitCode: 1, cleanupFails: false },
    { ...formats[0], exitCode: 0, cleanupFails: true },
  ])("handles $format, notarytool exit $exitCode and cleanup failure $cleanupFails without exposing the key", ({ secret, exitCode, cleanupFails }) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "maru-notary-probe-"));
    try {
      prepareHelper(fixture);
      writeFileSync(resolve(fixture, "xcrun"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const key = args[args.indexOf("--key") + 1];
if (fs.readFileSync(key, "utf8") !== process.env.EXPECTED_KEY) process.exit(90);
if ((fs.statSync(key).mode & 0o777) !== 0o600) process.exit(91);
fs.writeFileSync(process.env.CAPTURE, JSON.stringify(args));
if (${exitCode}) console.error("fixture authentication failure");
process.exit(${exitCode});
`, { mode: 0o755 });
      if (cleanupFails) {
        writeFileSync(resolve(fixture, "rm"), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
      }
      const result = spawnSync("/bin/bash", ["-c", shell(step("release-preflight", "Validate notarization API credentials without submitting an app"))], {
        cwd: fixture, encoding: "utf8", timeout: 5000,
        env: {
          PATH: `${fixture}:/usr/bin:/bin`, HOME: fixture, RUNNER_TEMP: fixture,
          APPLE_API_PRIVATE_KEY: secret, EXPECTED_KEY: material, APPLE_API_KEY_ID: "fixture-id",
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
      expect(result.stdout + result.stderr).not.toContain(secret.trim());
      if (exitCode) expect(result.stdout).toContain("retry Release Preflight");
      if (cleanupFails) expect(result.stdout).toContain("before retrying Release Preflight");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("refuses missing credentials before creating a key or calling Apple", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "maru-notary-missing-"));
    try {
      prepareHelper(fixture);
      const result = spawnSync("/bin/bash", ["-c", shell(step("release-preflight", "Validate notarization API credentials without submitting an app"))], {
        cwd: fixture, encoding: "utf8", timeout: 5000,
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

  it.each(formats)("stages $format for release consumers and cleans it after failure", ({ secret }) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "maru-notary-release-"));
    try {
      prepareHelper(fixture);
      const env = { PATH: "/usr/bin:/bin", HOME: fixture, RUNNER_TEMP: fixture,
        APPLE_API_PRIVATE_KEY: secret, GITHUB_ENV: resolve(fixture, "github-env") };
      const staged = spawnSync("/bin/bash", ["-c", shell(step("release-bundles", "Prepare App Store Connect API key"))], {
        env, cwd: fixture, encoding: "utf8", timeout: 5000,
      });
      expect(staged.status).toBe(0);
      const key = resolve(fixture, "maru-notary-auth.p8");
      expect(readFileSync(key, "utf8")).toBe(material);
      expect(statSync(key).mode & 0o777).toBe(0o600);
      expect(readFileSync(env.GITHUB_ENV, "utf8")).toBe(`APPLE_API_KEY_PATH=${key}\n`);
      expect(staged.stdout + staged.stderr).not.toContain(material.trim());
      expect(staged.stdout + staged.stderr).not.toContain(secret.trim());
      expect(step("release-bundles", "Remove temporary App Store Connect API key"))
        .toContain("if: always() && matrix.platform == 'macos-26'");
      // Simulate a failing release consumer, then execute the always cleanup.
      expect(spawnSync("/bin/bash", ["-c", "exit 1"], { env }).status).toBe(1);
      const cleaned = spawnSync("/bin/bash", ["-c", shell(step("release-bundles", "Remove temporary App Store Connect API key"))], {
        env, cwd: fixture, encoding: "utf8", timeout: 5000,
      });
      expect(cleaned.status).toBe(0);
      expect(existsSync(key)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
