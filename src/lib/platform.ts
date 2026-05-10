export function isMacPlatform(platform: string | null | undefined): boolean {
  return typeof platform === "string" && platform.toLowerCase().includes("mac");
}

export function currentPlatform(): string {
  return globalThis.navigator?.platform ?? "";
}
