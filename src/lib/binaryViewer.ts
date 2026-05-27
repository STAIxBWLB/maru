import { convertFileSrc } from "@tauri-apps/api/core";
import type { WorkspaceFileEntry } from "./types";

function hasTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { convertFileSrc?: unknown };
  };
  return Boolean(w.__TAURI_INTERNALS__?.convertFileSrc);
}

export type ViewerCategory =
  | "image"
  | "svg"
  | "pdf"
  | "docx"
  | "xlsx"
  | "hwpx"
  | "audio"
  | "video"
  | "text"
  | "archive"
  | "unsupported";

const EXT_MAP: Record<string, ViewerCategory> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  tiff: "image",
  tif: "image",
  heic: "image",
  heif: "image",
  avif: "image",
  svg: "svg",
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  xls: "xlsx",
  xlsm: "xlsx",
  hwpx: "hwpx",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  flac: "audio",
  m4a: "audio",
  aac: "audio",
  opus: "audio",
  mp4: "video",
  mov: "video",
  mkv: "video",
  avi: "video",
  webm: "video",
  m4v: "video",
  txt: "text",
  log: "text",
  srt: "text",
  csv: "text",
  tsv: "text",
  json: "text",
  xml: "text",
  yaml: "text",
  yml: "text",
  toml: "text",
  ini: "text",
  conf: "text",
  cfg: "text",
  env: "text",
  css: "text",
  scss: "text",
  sass: "text",
  less: "text",
  js: "text",
  mjs: "text",
  cjs: "text",
  ts: "text",
  tsx: "text",
  jsx: "text",
  py: "text",
  rs: "text",
  go: "text",
  java: "text",
  kt: "text",
  swift: "text",
  c: "text",
  cc: "text",
  cpp: "text",
  h: "text",
  hpp: "text",
  sql: "text",
  sh: "text",
  bash: "text",
  zsh: "text",
  fish: "text",
  rb: "text",
  php: "text",
  lua: "text",
  vim: "text",
  dockerfile: "text",
  gradle: "text",
  properties: "text",
  zip: "archive",
  jar: "archive",
  war: "archive",
  apk: "archive",
  epub: "archive",
  ipa: "archive",
};

const OPENABLE_DOCUMENT_EXT = new Set(["md", "markdown"]);

export const INLINE_DOCX_MAX_BYTES = 20 * 1024 * 1024;
export const INLINE_XLSX_MAX_BYTES = 10 * 1024 * 1024;
export const XLSX_MAX_SHEETS = 20;
export const XLSX_MAX_ROWS = 200;
export const XLSX_MAX_COLS = 50;

export function getViewerCategory(entry: WorkspaceFileEntry): ViewerCategory {
  const ext = (entry.fileKind ?? "").toLowerCase();
  if (OPENABLE_DOCUMENT_EXT.has(ext)) {
    return "text";
  }
  return EXT_MAP[ext] ?? "unsupported";
}

export function isViewableInApp(entry: WorkspaceFileEntry): boolean {
  return getViewerCategory(entry) !== "unsupported";
}

export function usesAssetProtocol(category: ViewerCategory): boolean {
  return (
    category === "image" ||
    category === "svg" ||
    category === "pdf" ||
    category === "docx" ||
    category === "xlsx" ||
    category === "audio" ||
    category === "video"
  );
}

export function assetUrlForPath(path: string): string {
  if (!hasTauriRuntime()) {
    // Browser-mock mode: hand back a stable string so the viewer can still
    // render an error/loading state without throwing on convertFileSrc.
    return `mock-asset://${encodeURI(path)}`;
  }
  return convertFileSrc(path);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const fixed = unit === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[unit]}`;
}
