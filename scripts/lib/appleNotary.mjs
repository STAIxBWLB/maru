/**
 * Resolution of App Store Connect notary credentials from the local secrets
 * directory. Shared by the full local notarized build and the opt-in
 * browser-passkey build, which signs with the operator's own keychain identity
 * and only needs the notary API key.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const DEFAULT_APPLE_SECRETS_DIR = resolve(homedir(), "workspace/work/.maru/secrets/apple");

export function appleSecretsDir() {
  return resolve(process.env.MARU_APPLE_SECRETS_DIR ?? DEFAULT_APPLE_SECRETS_DIR);
}

export function readSecretFrom(secretsDir, names) {
  for (const name of names) {
    const path = join(secretsDir, name);
    if (existsSync(path)) {
      return readFileSync(path, "utf8").trim();
    }
  }
  return null;
}

export function firstApiKeyPath(secretsDir) {
  if (process.env.APPLE_API_KEY_PATH && existsSync(process.env.APPLE_API_KEY_PATH)) {
    return process.env.APPLE_API_KEY_PATH;
  }
  if (!existsSync(secretsDir)) {
    return null;
  }
  const matches = readdirSync(secretsDir)
    .filter((name) => /^AuthKey_[A-Z0-9]+\.p8$/.test(name))
    .sort();
  return matches.length > 0 ? join(secretsDir, matches[0]) : null;
}

export function apiKeyIdFromPath(path) {
  return basename(path).match(/^AuthKey_([A-Z0-9]+)\.p8$/)?.[1] ?? null;
}

/**
 * Resolve the notary API key triple. Returns `{ missing: [...] }` when any part
 * is absent so the caller can fail closed with a full list.
 */
export function resolveNotaryCredentials(secretsDir = appleSecretsDir()) {
  const missing = [];
  const apiKeyPath = firstApiKeyPath(secretsDir);
  if (!apiKeyPath) {
    missing.push("AuthKey_<APPLE_API_KEY_ID>.p8");
  }
  const apiIssuerId = readSecretFrom(secretsDir, ["api-issuer-id", "APPLE_API_ISSUER_ID"]);
  if (!apiIssuerId) {
    missing.push("api-issuer-id");
  }
  const apiKeyId =
    readSecretFrom(secretsDir, ["api-key-id", "APPLE_API_KEY_ID"]) ??
    (apiKeyPath ? apiKeyIdFromPath(apiKeyPath) : null);
  if (!apiKeyId) {
    missing.push("api-key-id");
  }
  return { secretsDir, apiKeyPath, apiIssuerId, apiKeyId, missing };
}
