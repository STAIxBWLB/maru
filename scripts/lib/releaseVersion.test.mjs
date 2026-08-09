import { describe, expect, it } from "vitest";
import {
  parseCargoPackage,
  parseReleaseVersionArgs,
  validateReleaseVersions,
} from "./releaseVersion.mjs";

const VERSION = "0.4.47";

function surfaces(overrides = {}) {
  return {
    packageJson: { version: VERSION },
    tauriConfig: { version: VERSION },
    rootCargoPackage: { name: "maru", version: VERSION },
    maruCliCargoPackage: { name: "maru-cli", version: VERSION },
    cargoMetadata: {
      packages: [
        { name: "maru", version: VERSION },
        { name: "maru-cli", version: VERSION },
      ],
    },
    ...overrides,
  };
}

describe("parseCargoPackage", () => {
  it("extracts only the package section from a Cargo manifest", () => {
    expect(
      parseCargoPackage(`
[package]
name = "maru"
version = "${VERSION}"

[lib]
name = "maru_lib"
`),
    ).toEqual({ name: "maru", version: VERSION });
  });
});

describe("validateReleaseVersions", () => {
  it("accepts synchronized structured release surfaces", () => {
    const result = validateReleaseVersions(surfaces());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.version).toBe(VERSION);
  });

  it("accepts an exact vX.Y.Z release tag", () => {
    const result = validateReleaseVersions(surfaces(), { tag: `v${VERSION}` });
    expect(result.ok).toBe(true);
    expect(result.tagVersion).toBe(VERSION);
    expect(result.successes.join(" ")).toContain(`release tag v${VERSION} matches`);
  });

  it.each([
    ["package.json", { packageJson: { version: "0.4.46" } }],
    ["Tauri config", { tauriConfig: { version: "0.4.46" } }],
    ["root Cargo package", { rootCargoPackage: { name: "maru", version: "0.4.46" } }],
    ["CLI Cargo package", { maruCliCargoPackage: { name: "maru-cli", version: "0.4.46" } }],
    [
      "cargo metadata",
      {
        cargoMetadata: {
          packages: [
            { name: "maru", version: "0.4.46" },
            { name: "maru-cli", version: VERSION },
          ],
        },
      },
    ],
  ])("rejects a %s version mismatch", (_surface, override) => {
    const result = validateReleaseVersions(surfaces(override));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("release versions do not match");
  });

  it("rejects a tag that does not match the synchronized version", () => {
    const result = validateReleaseVersions(surfaces(), { tag: "v0.4.46" });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("does not match version 0.4.47");
  });

  it.each(["0.4.47", "v0.4", "v0.4.47-beta.1", "V0.4.47", "v0.4.47\n"]) (
    "rejects malformed release tag %s",
    (tag) => {
      const result = validateReleaseVersions(surfaces(), { tag });
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain("release tag must match vX.Y.Z");
    },
  );

  it("rejects missing and duplicate Cargo metadata packages", () => {
    const missing = validateReleaseVersions(
      surfaces({ cargoMetadata: { packages: [{ name: "maru", version: VERSION }] } }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(" ")).toContain("missing package maru-cli");

    const duplicate = validateReleaseVersions(
      surfaces({
        cargoMetadata: {
          packages: [
            { name: "maru", version: VERSION },
            { name: "maru", version: VERSION },
            { name: "maru-cli", version: VERSION },
          ],
        },
      }),
    );
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors.join(" ")).toContain("duplicate packages named maru");
  });

  it("rejects wrong Cargo package names and missing surfaces", () => {
    const result = validateReleaseVersions(
      surfaces({
        rootCargoPackage: { name: "not-maru", version: VERSION },
        maruCliCargoPackage: null,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("expected maru");
    expect(result.errors.join(" ")).toContain("maru-cli Cargo package is missing");
  });
});

describe("parseReleaseVersionArgs", () => {
  it("accepts no tag or one well-formed tag", () => {
    expect(parseReleaseVersionArgs()).toEqual({ ok: true, tag: null, errors: [] });
    expect(parseReleaseVersionArgs(["--tag", `v${VERSION}`])).toEqual({
      ok: true,
      tag: `v${VERSION}`,
      errors: [],
    });
  });

  it.each([
    [["--unknown"], "unknown option"],
    [["--tag"], "requires a value"],
    [["--tag", "--other"], "requires a value"],
    [["--tag", `v${VERSION}`, "extra"], "unknown argument"],
    [["--tag", "0.4.47"], "must match vX.Y.Z"],
  ])("rejects invalid argument list %j", (argv, message) => {
    const result = parseReleaseVersionArgs(argv);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain(message);
  });
});
