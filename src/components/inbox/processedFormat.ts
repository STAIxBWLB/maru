import type { InboxProcessedStatus } from "../../lib/types";

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function statusLabel(status: InboxProcessedStatus | "all" | string): string {
  switch (status) {
    case "all":
      return "All";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "duplicate":
      return "Duplicate";
    default:
      return status;
  }
}

export function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
