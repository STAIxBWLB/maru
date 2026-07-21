// Maru Today — capture lane. Builds CaptureCandidate rows from LOCAL pending
// inbox artifacts only (no provider refresh/fan-out — external collection
// stays with io-* / inbox-intake). Pure mapping + decision→mutation helpers;
// the only I/O lives behind the injectable `CaptureSource`.
//
// Decision persistence mapping (IMPORTANT): the TodaySnapshot schema has no
// capture-decision field and the Rust side must not change, so only
// `addToToday` is persisted — as a reversible `{ kind: "capture" }` plan item
// applied via the existing `setPlan` mutation (undo/remove = another setPlan).
// `keep` / `edit` / `defer` / `dismiss` return no mutation; the Today UI
// tracks them as session-local capture state until a snapshot field exists.

import { readDocument, scanInboxEntries } from "./api";
import { isInboxSourceChannel, INBOX_SOURCE_CHANNELS } from "./inboxSources";
import type { InboxEntry } from "./types";
import {
  sha256Hex,
  type CaptureCandidate,
  type CaptureConfidence,
  type CaptureDecision,
  type DailyPlanItem,
  type DailyPlanV1,
  type TodayMutation,
} from "./today";

export const DEFAULT_PROVISIONAL_ESTIMATE_MINUTES = 30;

/** Channels scanned for capture candidates (provider-backed inbox sources). */
export const CAPTURE_CHANNELS: readonly string[] = INBOX_SOURCE_CHANNELS;

// --- Manifest parsing ------------------------------------------------------

/** Scalar fields extracted from an `inbox-item/v1` manifest. Nested `source:`
 *  and `metadata:` maps are flattened one level deep (scalars only). */
export interface InboxManifestFields {
  id: string | null;
  status: string | null;
  channel: string | null;
  provider: string | null;
  kind: string | null;
  receivedAt: string | null;
  dedupeKey: string | null;
  source: Record<string, string>;
  metadata: Record<string, string>;
}

/** Tolerant line-based extractor for machine-written inbox manifests. These
 *  manifests are flat YAML with at most one nesting level (`source:`,
 *  `metadata:`); scalar keys are read, lists/comments/complex values ignored.
 *  This is NOT a general YAML parser — it only covers the shape Maru's own
 *  skills emit, which is all the capture lane needs. */
export function parseManifestFields(manifestText: string): InboxManifestFields {
  const fields: InboxManifestFields = {
    id: null,
    status: null,
    channel: null,
    provider: null,
    kind: null,
    receivedAt: null,
    dedupeKey: null,
    source: {},
    metadata: {},
  };
  let nested: "source" | "metadata" | null = null;
  for (const line of manifestText.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, indent, key, rawValue] = match;
    const value = parseYamlScalar(rawValue);
    if (indent.length === 0) {
      nested = value === null && (key === "source" || key === "metadata") ? key : null;
      switch (key) {
        case "id": fields.id = value; break;
        case "status": fields.status = value; break;
        case "channel": fields.channel = value; break;
        case "provider": fields.provider = value; break;
        case "kind": fields.kind = value; break;
        case "received_at": fields.receivedAt = value; break;
        case "dedupe_key": fields.dedupeKey = value; break;
        default: break;
      }
    } else if (nested && value !== null) {
      fields[nested][key] = value;
    }
  }
  return fields;
}

function parseYamlScalar(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null" || trimmed === "~") return null;
  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith("|") || trimmed.startsWith(">")) {
    return null;
  }
  const quoted = trimmed.match(/^(?:"([^"]*)"|'([^']*)')$/);
  const value = quoted ? (quoted[1] ?? quoted[2] ?? "") : trimmed;
  return value === "" ? null : value;
}

// --- Fingerprint -----------------------------------------------------------

/** Normalization for fingerprint components: lowercase, trim, collapse
 *  internal whitespace to single spaces. */
export function normalizeFingerprintComponent(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** Content fingerprint: sha256 of the normalized `channel|from|subject|date`
 *  tuple. Used as the dedupe fallback when no provider item id exists. */
export async function captureFingerprint(fields: {
  channel: string | null;
  from: string | null;
  subject: string | null;
  date: string | null;
}): Promise<string> {
  const normalized = [
    fields.channel,
    fields.from,
    fields.subject,
    fields.date,
  ].map(normalizeFingerprintComponent).join("|");
  return sha256Hex(normalized);
}

// --- Confidence ------------------------------------------------------------

export interface ConfidenceSignals {
  /** Manifest was readable and yielded structured fields. */
  hasManifest: boolean;
  /** Manifest carries a stable item id. */
  hasId: boolean;
  /** Channel is a known provider-backed inbox source (gws/mso/telegram/kakao). */
  knownChannel: boolean;
  /** Structured actionable signal (see `hasActionableSignal`). */
  actionable: boolean;
  hasSender: boolean;
  hasTitle: boolean;
}

/** Classification/kind values treated as "this item asks for action". */
const ACTIONABLE_CLASSIFICATIONS = new Set(["action", "task", "request", "schedule"]);
const ACTIONABLE_KINDS = new Set(["action", "task", "request"]);

/** Structured actionable signal: metadata flags or a classification/kind
 *  that marks the item as requesting action. */
export function hasActionableSignal(manifest: InboxManifestFields): boolean {
  const metadata = manifest.metadata;
  const flag = (metadata.actionable ?? metadata.requires_action ?? "").toLowerCase();
  if (flag === "true" || flag === "yes" || flag === "1") return true;
  const classification = (metadata.classification ?? metadata.category ?? "").toLowerCase();
  if (ACTIONABLE_CLASSIFICATIONS.has(classification)) return true;
  return ACTIONABLE_KINDS.has((manifest.kind ?? "").toLowerCase());
}

/** high = structured + actionable + clear title/sender + known provider
 *  schema; medium = structured but no actionable signal; low = legacy /
 *  unstructured / missing fields. */
export function classifyConfidence(signals: ConfidenceSignals): CaptureConfidence {
  if (signals.actionable && signals.hasTitle && signals.hasSender && signals.knownChannel) {
    return "high";
  }
  if (signals.hasManifest && signals.hasId && signals.knownChannel) return "medium";
  return "low";
}

// --- Candidate building ----------------------------------------------------

/** I/O seam for candidate building. Production uses the Tauri wrappers;
 *  tests inject fixtures. `readText` returns null when a file is missing or
 *  unreadable — candidates still build from the scan entry alone. */
export interface CaptureSource {
  scanPendingEntries(workPath: string): Promise<InboxEntry[]>;
  readText(workPath: string, path: string): Promise<string | null>;
}

export function defaultCaptureSource(): CaptureSource {
  return {
    scanPendingEntries: async (workPath) => {
      const entries = await scanInboxEntries(workPath);
      return entries.filter((entry) => entry.kind === "pendingItem");
    },
    readText: async (workPath, path) => {
      try {
        const doc = await readDocument(workPath, path);
        return doc.content;
      } catch {
        return null;
      }
    },
  };
}

/** First non-empty paragraph of a markdown text (blank-line separated). */
export function firstParagraph(text: string): string {
  for (const block of text.split(/\n\s*\n/)) {
    const paragraph = block.trim().replace(/\s+/g, " ");
    if (paragraph && !paragraph.startsWith("#")) return paragraph;
  }
  return "";
}

function metadataValue(manifest: InboxManifestFields, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = manifest.metadata[key];
    if (value) return value;
  }
  return null;
}

function sourceValue(manifest: InboxManifestFields, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = manifest.source[key];
    if (value) return value;
  }
  return null;
}

function parseEstimateMinutes(raw: string | null): number | null {
  if (!raw) return null;
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : null;
}

function parseDateLike(raw: string | null): string | null {
  return raw?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

export interface BuildCaptureCandidatesArgs {
  workPath: string;
  /** Channels to include; defaults to the provider-backed inbox sources. */
  channels?: readonly string[];
  /** Injectable I/O seam; defaults to the Tauri-backed source. */
  source?: CaptureSource;
}

/** Build capture candidates from local pending inbox items across the
 *  provider channels (gws/mso/telegram/kakao). Reads only local artifacts —
 *  no provider refresh/fan-out.
 *
 *  TODO(meetings): meeting-derived captures are skipped — there is no cheap
 *  local "unprocessed meeting items" reader yet; add one behind `source`
 *  when the meetings pipeline exposes it. */
export async function buildCaptureCandidates(
  args: BuildCaptureCandidatesArgs,
): Promise<CaptureCandidate[]> {
  const source = args.source ?? defaultCaptureSource();
  const channels = new Set(args.channels ?? CAPTURE_CHANNELS);
  const entries = await source.scanPendingEntries(args.workPath);
  const candidates: CaptureCandidate[] = [];
  for (const entry of entries) {
    if (!channels.has(entry.channel)) continue;
    const candidate = await buildCandidateFromEntry(args.workPath, entry, source);
    candidates.push(candidate);
  }
  return dedupeCandidates(candidates);
}

async function buildCandidateFromEntry(
  workPath: string,
  entry: InboxEntry,
  source: CaptureSource,
): Promise<CaptureCandidate> {
  const manifestText = entry.manifestPath
    ? await source.readText(workPath, entry.manifestPath)
    : null;
  const manifest = manifestText !== null ? parseManifestFields(manifestText) : null;

  const channel = manifest?.channel ?? entry.channel ?? "";
  const provider = manifest?.provider ?? channel;
  const from = manifest
    ? metadataValue(manifest, "from", "sender") ?? sourceValue(manifest, "from", "sender")
    : null;
  const subject = manifest
    ? metadataValue(manifest, "subject", "title") ?? sourceValue(manifest, "subject", "title")
    : null;
  const date = manifest
    ? metadataValue(manifest, "date", "received_at") ?? sourceValue(manifest, "date")
      ?? manifest.receivedAt
    : null;

  const fingerprint = await captureFingerprint({ channel, from, subject, date });
  const providerItemId = manifest
    ? metadataValue(manifest, "provider_item_id", "message_id", "item_id")
      ?? sourceValue(manifest, "message_id", "item_id")
      ?? manifest.dedupeKey
    : null;
  const captureId = providerItemId ? `${provider}:${providerItemId}` : `fp:${fingerprint}`;

  let summary = manifest ? metadataValue(manifest, "description", "summary") ?? "" : "";
  if (!summary && entry.summaryPath) {
    const summaryText = await source.readText(workPath, entry.summaryPath);
    if (summaryText) summary = firstParagraph(summaryText);
  }

  const actionable = manifest ? hasActionableSignal(manifest) : false;
  const confidence = classifyConfidence({
    hasManifest: manifest !== null,
    hasId: Boolean(manifest?.id ?? entry.itemId),
    knownChannel: isInboxSourceChannel(channel),
    actionable,
    hasSender: Boolean(from),
    hasTitle: Boolean(subject ?? entry.title),
  });

  const title = subject ?? entry.title ?? manifest?.id ?? "";
  const reason = manifest
    ? metadataValue(manifest, "reason", "signal") ?? (actionable ? "action_requested" : "inbox_pending")
    : "manifest_unreadable";

  return {
    captureId,
    provider,
    providerItemId,
    fingerprint,
    confidence,
    category:
      (manifest ? metadataValue(manifest, "classification", "category") : null)
      ?? manifest?.kind
      ?? entry.sourceKind
      ?? "unknown",
    title,
    summary,
    dueDate: manifest ? parseDateLike(metadataValue(manifest, "due", "due_date")) : null,
    estimateMinutes: manifest
      ? parseEstimateMinutes(metadataValue(manifest, "estimate_minutes", "estimateMinutes"))
      : null,
    project: manifest ? metadataValue(manifest, "project") : null,
    reason,
    receivedAt: manifest?.receivedAt ?? entry.receivedAt ?? "",
  };
}

// --- Dedupe / partition ----------------------------------------------------

/** Dedupe by `provider:providerItemId` first, fingerprint fallback. Keeps the
 *  candidate with the earliest receivedAt within each dupe group. */
export function dedupeCandidates(candidates: CaptureCandidate[]): CaptureCandidate[] {
  const byKey = new Map<string, CaptureCandidate>();
  for (const candidate of candidates) {
    const key = candidate.providerItemId
      ? `id:${candidate.provider}:${candidate.providerItemId}`
      : `fp:${candidate.fingerprint}`;
    const existing = byKey.get(key);
    if (!existing || compareReceivedAt(candidate.receivedAt, existing.receivedAt) < 0) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function compareReceivedAt(a: string, b: string): number {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return aTime - bTime;
  if (Number.isFinite(aTime)) return -1;
  if (Number.isFinite(bTime)) return 1;
  return a.localeCompare(b);
}

export interface PartitionedCandidates {
  /** High-confidence actionable items — the Capture rows. */
  capture: CaptureCandidate[];
  /** Medium/low-confidence items — shown as suggestions only. */
  suggestions: CaptureCandidate[];
}

export function partitionCandidates(candidates: CaptureCandidate[]): PartitionedCandidates {
  const capture: CaptureCandidate[] = [];
  const suggestions: CaptureCandidate[] = [];
  for (const candidate of candidates) {
    (candidate.confidence === "high" ? capture : suggestions).push(candidate);
  }
  return { capture, suggestions };
}

// --- Decisions ---------------------------------------------------------------

export interface CaptureDecisionOutcome {
  /** Replacement plan when the decision changed it (addToToday), else null. */
  plan: DailyPlanV1 | null;
  /** Mutation to dispatch via `todayMutate`, else null (nothing persisted). */
  mutation: TodayMutation | null;
}

export interface ApplyCaptureDecisionArgs {
  /** Current plan; required for addToToday (a plan to extend must exist). */
  plan: DailyPlanV1 | null;
  candidate: CaptureCandidate;
  decision: CaptureDecision;
  /** Target date for `defer`; carried by UI-local state only (see header). */
  deferDate?: string | null;
  provisionalEstimateMinutes?: number;
}

/** Map a capture decision to a plan edit + mutation. See the header comment
 *  for the persistence mapping — only addToToday produces a `setPlan`
 *  mutation; the other decisions are no-ops at the snapshot layer. */
export function applyCaptureDecision(args: ApplyCaptureDecisionArgs): CaptureDecisionOutcome {
  if (args.decision !== "addToToday") {
    return { plan: null, mutation: null };
  }
  const plan = args.plan;
  if (!plan) return { plan: null, mutation: null };

  const alreadyPlanned = [...plan.top, ...plan.flexible, ...plan.overflow].some(
    (item) => item.itemRef.kind === "capture" && item.itemRef.captureId === args.candidate.captureId,
  );
  if (alreadyPlanned) return { plan: null, mutation: null };

  const provisional = args.provisionalEstimateMinutes ?? DEFAULT_PROVISIONAL_ESTIMATE_MINUTES;
  const estimate = args.candidate.estimateMinutes ?? null;
  const maxOrder = Math.max(-1, ...plan.flexible.map((item) => item.order));
  const item: DailyPlanItem = {
    itemRef: { kind: "capture", captureId: args.candidate.captureId },
    lane: "flexible",
    order: maxOrder + 1,
    outcome: null,
    estimateMinutes: estimate ?? provisional,
    estimateProvisional: estimate === null,
    pinned: false,
    proposedBlock: null,
    calendarSync: { status: "none" },
  };
  const next: DailyPlanV1 = { ...plan, flexible: [...plan.flexible, item] };
  return { plan: next, mutation: { type: "setPlan", plan: next } };
}
