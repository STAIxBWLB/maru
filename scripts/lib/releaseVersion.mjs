/**
 * Pure validation for the version surfaces used by a Maru release.
 *
 * The live checker is responsible for reading files and running Cargo. This
 * module only receives structured values so version drift, tag handling, and
 * Cargo package cardinality can be covered without a network or a checkout.
 */

export const RELEASE_PACKAGES = Object.freeze({
  root: "maru",
  cli: "maru-cli",
});

// The negative lookahead is an absolute end-of-input check. JavaScript's `$`
// also matches immediately before a trailing newline, which is not part of a
// release tag.
export const RELEASE_TAG_PATTERN = /^v(\d+\.\d+\.\d+)(?![\s\S])/;

function hasValue(value) {
  return typeof value === "string" && value.length > 0;
}

function versionOf(surface) {
  if (typeof surface === "string") return surface;
  if (surface && typeof surface === "object") return surface.version;
  return undefined;
}

function nameOf(surface) {
  if (surface && typeof surface === "object") return surface.name;
  return undefined;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function cargoSurfaceFrom(surfaces, keys, fallbackName, fallbackVersion) {
  const nested = surfaces.cargo ?? surfaces.cargoPackages;
  const direct = firstDefined(
    ...keys.map((key) => surfaces[key]),
    nested && typeof nested === "object" ? nested[fallbackName] : undefined,
    fallbackVersion === undefined ? undefined : { name: fallbackName, version: fallbackVersion },
  );

  if (typeof direct === "string") return { name: fallbackName, version: direct };
  return direct;
}

function checkVersionSurface(surface, label, errors) {
  const version = versionOf(surface);
  if (!hasValue(version)) {
    errors.push(`${label} version is missing`);
    return undefined;
  }
  return version;
}

function checkCargoSurface(surface, label, expectedName, errors) {
  let packageSurface = surface;
  if (Array.isArray(packageSurface)) {
    if (packageSurface.length === 0) {
      errors.push(`${label} package is missing`);
      return undefined;
    }
    if (packageSurface.length > 1) {
      errors.push(`${label} has duplicate packages named ${expectedName}`);
      return undefined;
    }
    packageSurface = packageSurface[0];
  }

  if (!packageSurface || typeof packageSurface !== "object") {
    errors.push(`${label} package is missing`);
    return undefined;
  }

  const packageName = nameOf(packageSurface);
  if (!hasValue(packageName)) {
    errors.push(`${label} package name is missing; expected ${expectedName}`);
  } else if (packageName !== expectedName) {
    errors.push(`${label} package is ${packageName}; expected ${expectedName}`);
  }

  return checkVersionSurface(packageSurface, label, errors);
}

function checkMetadataPackages(metadata, errors) {
  if (!metadata || typeof metadata !== "object" || !Array.isArray(metadata.packages)) {
    errors.push("cargo metadata packages are missing");
    return new Map();
  }

  const packages = new Map();
  metadata.packages.forEach((packageSurface, index) => {
    const packageName = nameOf(packageSurface);
    if (!hasValue(packageName)) {
      errors.push(`cargo metadata package at index ${index} has no name`);
      return;
    }
    const entries = packages.get(packageName) ?? [];
    entries.push(packageSurface);
    packages.set(packageName, entries);
  });

  for (const expectedName of Object.values(RELEASE_PACKAGES)) {
    const entries = packages.get(expectedName) ?? [];
    if (entries.length === 0) {
      errors.push(`cargo metadata is missing package ${expectedName}`);
    } else if (entries.length > 1) {
      errors.push(`cargo metadata has duplicate packages named ${expectedName}`);
    }
  }

  return packages;
}

function metadataVersion(packages, packageName, errors) {
  const entries = packages.get(packageName) ?? [];
  if (entries.length !== 1) return undefined;
  return checkVersionSurface(entries[0], `cargo metadata package ${packageName}`, errors);
}

/**
 * Parse the small `[package]` subset needed from a Cargo manifest.
 *
 * This intentionally is not a general TOML parser. Cargo metadata remains the
 * authoritative structural check; this helper keeps the root and CLI manifest
 * version surfaces independently visible to the pure validator.
 */
export function parseCargoPackage(cargoToml) {
  if (typeof cargoToml !== "string") return null;

  let inPackage = false;
  let name;
  let version;
  for (const line of cargoToml.split(/\r?\n/)) {
    if (/^\s*\[package\]\s*$/.test(line)) {
      inPackage = true;
      continue;
    }
    if (inPackage && /^\s*\[[^\]]+\]\s*$/.test(line)) break;
    if (!inPackage) continue;

    const nameMatch = line.match(/^\s*name\s*=\s*["']([^"']+)["']/);
    if (nameMatch) name = nameMatch[1];
    const versionMatch = line.match(/^\s*version\s*=\s*["']([^"']+)["']/);
    if (versionMatch) version = versionMatch[1];
  }

  return { name, version };
}

/**
 * Validate all release version surfaces.
 *
 * Canonical input shape:
 * {
 *   packageJson: { version },
 *   tauriConfig: { version },
 *   rootCargoPackage: { name: "maru", version },
 *   maruCliCargoPackage: { name: "maru-cli", version },
 *   cargoMetadata: { packages: [{ name, version }, ...] },
 * }
 *
 * `rootCargo`, `cliCargo`, and `metadata` are accepted as concise aliases so
 * callers can pass structured fixtures without first reshaping their data.
 *
 * @param {Record<string, unknown>} [surfaces]
 * @param {{ tag?: string | null }} [options]
 */
export function validateReleaseVersions(surfaces = {}, { tag = null } = {}) {
  const input = surfaces && typeof surfaces === "object" ? surfaces : {};
  const errors = [];
  const successes = [];

  const packageJson = firstDefined(
    input.packageJson,
    input.packageJsonVersion === undefined ? undefined : { version: input.packageJsonVersion },
  );
  const tauriConfig = firstDefined(
    input.tauriConfig,
    input.tauriVersion === undefined ? undefined : { version: input.tauriVersion },
  );
  const rootCargoPackage = cargoSurfaceFrom(
    input,
    ["rootCargoPackage", "rootCargo", "cargoRootPackage", "cargoPackage"],
    RELEASE_PACKAGES.root,
    input.rootCargoVersion,
  );
  const maruCliCargoPackage = cargoSurfaceFrom(
    input,
    ["maruCliCargoPackage", "cliCargoPackage", "maruCliCargo", "cliCargo"],
    RELEASE_PACKAGES.cli,
    input.maruCliCargoVersion ?? input.cliCargoVersion,
  );
  const cargoMetadata = firstDefined(input.cargoMetadata, input.metadata);

  const versions = [
    ["package.json", checkVersionSurface(packageJson, "package.json", errors)],
    ["src-tauri/tauri.conf.json", checkVersionSurface(tauriConfig, "src-tauri/tauri.conf.json", errors)],
    ["src-tauri/Cargo.toml", checkCargoSurface(rootCargoPackage, "root Cargo", RELEASE_PACKAGES.root, errors)],
    [
      "src-tauri/maru-cli/Cargo.toml",
      checkCargoSurface(maruCliCargoPackage, "maru-cli Cargo", RELEASE_PACKAGES.cli, errors),
    ],
  ];

  const metadataPackages = checkMetadataPackages(cargoMetadata, errors);
  versions.push(
    [
      `cargo metadata package ${RELEASE_PACKAGES.root}`,
      metadataVersion(metadataPackages, RELEASE_PACKAGES.root, errors),
    ],
    [
      `cargo metadata package ${RELEASE_PACKAGES.cli}`,
      metadataVersion(metadataPackages, RELEASE_PACKAGES.cli, errors),
    ],
  );

  const presentVersions = versions.filter(([, version]) => hasValue(version));
  const uniqueVersions = new Set(presentVersions.map(([, version]) => version));
  if (uniqueVersions.size > 1) {
    errors.push(
      `release versions do not match: ${versions
        .map(([label, version]) => `${label}=${version ?? "missing"}`)
        .join(", ")}`,
    );
  } else if (uniqueVersions.size === 1) {
    const version = presentVersions[0][1];
    successes.push(`version surfaces are synced at ${version}`);
  }

  let tagVersion = null;
  if (tag !== null && tag !== undefined) {
    if (typeof tag !== "string" || !RELEASE_TAG_PATTERN.test(tag)) {
      errors.push(`release tag must match vX.Y.Z; received ${String(tag)}`);
    } else {
      tagVersion = tag.slice(1);
      const expectedVersion = presentVersions[0]?.[1];
      if (expectedVersion !== undefined && expectedVersion !== tagVersion) {
        errors.push(`release tag ${tag} does not match version ${expectedVersion}`);
      } else if (expectedVersion !== undefined) {
        successes.push(`release tag ${tag} matches version ${expectedVersion}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    successes,
    tag: tag ?? null,
    tagVersion,
    version: presentVersions[0]?.[1] ?? null,
  };
}

// Singular alias keeps the command's name and the public pure API easy to
// discover while retaining the plural name for callers validating many
// surfaces.
export const validateReleaseVersion = validateReleaseVersions;

/**
 * Parse the command-line contract without touching the filesystem.
 */
export function parseReleaseVersionArgs(argv = []) {
  const args = [...argv];
  if (args.length === 0) return { ok: true, tag: null, errors: [] };

  if (args[0] !== "--tag") {
    return { ok: false, tag: null, errors: [`unknown option: ${args[0] ?? ""}`] };
  }
  if (args.length === 1 || args[1].startsWith("-")) {
    return { ok: false, tag: null, errors: ["--tag requires a value"] };
  }
  if (args.length > 2) {
    return { ok: false, tag: null, errors: [`unknown argument(s): ${args.slice(2).join(", ")}`] };
  }
  if (!RELEASE_TAG_PATTERN.test(args[1])) {
    return { ok: false, tag: args[1], errors: [`release tag must match vX.Y.Z; received ${args[1]}`] };
  }

  return { ok: true, tag: args[1], errors: [] };
}
