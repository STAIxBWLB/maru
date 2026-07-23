// Maru Today — Playwright fixture harness.
//
// The e2e webServer runs plain Vite (no Tauri backend), so every Today
// command wrapper (src/lib/today.ts, plus the api.ts browser fallbacks for
// scan_task_notes / scan_inbox_entries / read_document / save_document)
// resolves through per-command handlers registered here on
// `window.__MARU_E2E_INVOKE__` (see src/lib/e2eInvoke.ts). This module owns
// the deterministic fake: a serializable seed (logical day 2026-07-21, plan,
// yesterday items, captures, task events, outbox records) plus an in-page
// mini "today store" that applies mutations and records every invoke in
// `window.__MARU_E2E_CALLS__` for assertions.
//
// The whole page-side store lives inside the single addInitScript callback
// below — Playwright serializes that function, so it must stay self-contained
// (no imports, JSON-serializable seed only).

import type { Page } from "@playwright/test";

export const FIXTURE_DAY = "2026-07-21";
export const FIXTURE_PREV_DAY = "2026-07-20";
export const FIXTURE_WORK_PATH = "mock://maru-sample-workspace";
// Workspace-scoped marker key (mirrors todayAutoOpenKey in todayRouting.ts).
export const TODAY_LAST_AUTO_OPEN_KEY = `maru:today:lastAutoOpenDay:v1:${FIXTURE_WORK_PATH}`;

export const TASK_A = "tasks/active/260720-plan-draft.md";
export const TASK_B = "tasks/active/260720-budget-review.md";
export const TASK_C = "tasks/active/260720-research-contract.md";
export const TASK_D = "tasks/active/260720-external-invite.md";
export const TASK_DONE = "tasks/archive/260719-weekly-report.md";

export const TASK_A_TITLE = "사업계획서 핵심안 확정";
export const TASK_B_TITLE = "공유대학 예산안 검토";
export const TASK_C_TITLE = "연구계약서 회신";
export const TASK_DONE_TITLE = "주간 보고 정리";

export interface TodaySeedOverrides {
  /** Value for the auto-open marker; null = marker absent (first launch). */
  markerDay?: string | null;
  /** Persisted ui.activeAppMode in the settings fallback (default "pkm"). */
  persistedMode?: string;
  locale?: string;
  themeMode?: string;
  dayState?: string;
  route?: string;
  autoOpen?: boolean;
  notificationsEnabled?: boolean;
  autoPlan?: boolean;
  plan?: unknown;
  yesterday?: unknown[];
  events?: unknown[];
  outbox?: unknown[];
  commitments?: unknown[];
  taskRows?: unknown[];
  inboxEntries?: unknown[];
  documents?: Record<string, { content: string; revision?: string }>;
  brainDump?: string;
  rolloverFailures?: number;
}

export interface TodayInvokeCall {
  command: string;
  args: Record<string, unknown>;
}

function planItem(
  itemRef: unknown,
  lane: string,
  order: number,
  estimateMinutes: number | null,
  extra: Record<string, unknown> = {},
) {
  return {
    itemRef,
    lane,
    order,
    outcome: null,
    estimateMinutes,
    estimateProvisional: estimateMinutes === null,
    pinned: false,
    proposedBlock: null,
    calendarSync: { status: "none" },
    ...extra,
  };
}

function taskRow(
  relPath: string,
  title: string,
  status: string,
  frontmatterExtra: Record<string, unknown> = {},
  bucket = "active",
) {
  return {
    path: `${FIXTURE_WORK_PATH}/${relPath}`,
    relPath,
    fileName: relPath.split("/").pop(),
    bucket,
    sizeBytes: 320,
    updatedAt: "2026-07-20T18:00:00+09:00",
    frontmatter: { title, status, priority: "medium", project: "Maru", ...frontmatterExtra },
  };
}

function captureManifest(input: {
  id: string;
  channel: string;
  from: string;
  subject: string;
  receivedAt: string;
  estimate: number;
  description: string;
}) {
  return [
    `id: ${input.id}`,
    "status: pending",
    `channel: ${input.channel}`,
    `provider: ${input.channel}`,
    "kind: message",
    `received_at: ${input.receivedAt}`,
    "source:",
    `  from: ${input.from}`,
    `  subject: ${input.subject}`,
    "metadata:",
    "  classification: action",
    `  estimate_minutes: ${input.estimate}`,
    `  description: ${input.description}`,
    "",
  ].join("\n");
}

function inboxEntry(input: {
  id: string;
  channel: string;
  title: string;
  receivedAt: string;
}) {
  const manifestPath = `inbox/items/pending/${input.id}/manifest.yaml`;
  return {
    id: input.id,
    kind: "pendingItem",
    path: `${FIXTURE_WORK_PATH}/${manifestPath}`,
    relPath: manifestPath,
    title: input.title,
    channel: input.channel,
    sourceKind: "message",
    dropPath: null,
    configuredRoot: "inbox",
    itemId: input.id,
    status: "pending",
    manifestPath,
    summaryPath: null,
    routePath: null,
    sizeBytes: 640,
    receivedAt: input.receivedAt,
  };
}

const CAPTURES = [
  {
    id: "2026-07-21-gws-budget",
    channel: "gws",
    from: "이수진 <soojin.lee@univ.ac.kr>",
    subject: "공유대학 예산안 검토 요청",
    receivedAt: "2026-07-20T21:14:00+09:00",
    estimate: 45,
    description: "예산안 초안을 검토하고 의견을 회신해 주세요.",
  },
  {
    id: "2026-07-21-gws-plan",
    channel: "gws",
    from: "김태훈 <taehoon.kim@partners.co.kr>",
    subject: "사업계획서 핵심안 초안 확인 부탁드립니다",
    receivedAt: "2026-07-20T17:42:00+09:00",
    estimate: 30,
    description: "핵심안 초안 검토 후 확정 여부를 알려주세요.",
  },
  {
    id: "2026-07-21-telegram-contract",
    channel: "telegram",
    from: "연구협력팀",
    subject: "연구계약서 3차 검토 의견 반영",
    receivedAt: "2026-07-20T15:08:00+09:00",
    estimate: 60,
    description: "3차 검토 의견을 반영한 계약서를 회신해 주세요.",
  },
  {
    id: "2026-07-21-kakao-hr",
    channel: "kakao",
    from: "카카오톡 채팅",
    subject: "인사팀 근무제도 변경 안내 확인 부탁",
    receivedAt: "2026-07-20T12:38:00+09:00",
    estimate: 20,
    description: "변경 안내문을 확인하고 팀에 공유해 주세요.",
  },
  {
    id: "2026-07-21-mso-followup",
    channel: "mso",
    from: "Outlook",
    subject: "주간 사업 점검 회의 후속: 지표 업데이트",
    receivedAt: "2026-07-20T10:10:00+09:00",
    estimate: 25,
    description: "회의에서 합의한 지표 업데이트를 반영해 주세요.",
  },
];

function defaultDocuments(): Record<string, { content: string; revision?: string }> {
  const documents: Record<string, { content: string; revision?: string }> = {};
  for (const capture of CAPTURES) {
    documents[`inbox/items/pending/${capture.id}/manifest.yaml`] = {
      content: captureManifest(capture),
    };
  }
  for (const [relPath, title] of [
    [TASK_A, TASK_A_TITLE],
    [TASK_B, TASK_B_TITLE],
    [TASK_C, TASK_C_TITLE],
    [TASK_D, "외부 위원 초청 일정 확정"],
    [TASK_DONE, TASK_DONE_TITLE],
  ] as const) {
    documents[relPath] = {
      content: `---\ntitle: ${title}\nstatus: active\n---\n# ${title}\n`,
    };
  }
  documents[`tasks/daily/${FIXTURE_DAY}.md`] = {
    content: [
      "---",
      "type: journal",
      "---",
      `# ${FIXTURE_DAY}`,
      "",
      "<!-- maru:today -->",
      "",
      "## Reflection",
      "",
      "",
    ].join("\n"),
  };
  return documents;
}

function defaultTaskRows() {
  return [
    taskRow(TASK_A, TASK_A_TITLE, "active", { priority: "high", due: FIXTURE_DAY }),
    taskRow(TASK_B, TASK_B_TITLE, "active", { priority: "high" }),
    taskRow(TASK_C, TASK_C_TITLE, "active"),
    taskRow(TASK_D, "외부 위원 초청 일정 확정", "active"),
    taskRow(
      TASK_DONE,
      TASK_DONE_TITLE,
      "done",
      { done: FIXTURE_DAY, completedAt: "2026-07-21T09:05:00+09:00" },
      "archive",
    ),
  ];
}

function defaultYesterday() {
  const done = [1, 2, 3, 4, 5, 6].map((index) => ({
    taskId: `yd-${index}`,
    title: [
      "공유대학 TF 정기 회의 및 결정사항 정리",
      "파트너사 미팅 및 제안 범위 확정",
      "주간 KPI 보고서 송부",
      "실습실 장비 점검 요청",
      "강의 평가 결과 검토",
      "예산 집행률 취합",
    ][index - 1],
    status: "done",
    progress: null,
    resolution: null,
    deferDate: null,
  }));
  return [
    ...done,
    {
      taskId: "yp-1",
      title: "사업계획서 초안 작성",
      status: "in-progress",
      progress: 70,
      resolution: null,
      deferDate: null,
    },
    {
      taskId: "yp-2",
      title: "연구성과 지표 수집 및 정리",
      status: "in-progress",
      progress: 40,
      resolution: null,
      deferDate: null,
    },
    {
      taskId: "yc-1",
      title: "외부 위원 초청 일정 확정",
      status: "active",
      progress: 0,
      resolution: null,
      deferDate: null,
    },
    {
      taskId: "yc-2",
      title: "하계 인턴 모집 공고 게시",
      status: "active",
      progress: 0,
      resolution: null,
      deferDate: null,
    },
    {
      taskId: "yc-3",
      title: "서버 증설 견적 비교",
      status: "active",
      progress: 0,
      resolution: null,
      deferDate: null,
    },
  ];
}

function defaultPlan() {
  return {
    logicalDay: FIXTURE_DAY,
    inputRevision: "rev-1",
    top: [
      planItem({ kind: "task", taskId: TASK_A }, "top", 0, 45),
      planItem({ kind: "task", taskId: TASK_B }, "top", 1, 30),
      planItem({ kind: "task", taskId: TASK_C }, "top", 2, 60),
    ],
    flexible: [],
    overflow: [],
    reasons: [],
    warnings: [],
  };
}

function defaultEvents() {
  return [
    {
      ts: "2026-07-21T09:41:00+09:00",
      kind: "task_completed",
      taskId: TASK_B,
      payload: { taskPath: TASK_B },
    },
    {
      ts: "2026-07-21T08:55:00+09:00",
      kind: "task_deferred",
      taskId: TASK_D,
      payload: { deferDate: "2026-07-22", taskPath: TASK_D },
    },
  ];
}

function defaultOutbox() {
  return [
    {
      id: "obx-1",
      op: "complete",
      taskPath: TASK_DONE,
      googleTaskId: "gt-1",
      googleTaskListId: null,
      status: "retryNeeded",
      attempts: 2,
      nextRetryAt: null,
      lastError: "mock HTTP 401 unauthorized",
      createdAt: "2026-07-21T09:00:00+09:00",
      updatedAt: "2026-07-21T09:05:00+09:00",
    },
  ];
}

function defaultCommitments() {
  return [
    {
      title: "주간 사업 점검 회의",
      startIso: "2026-07-21T10:00:00+09:00",
      endIso: "2026-07-21T11:30:00+09:00",
      source: "local",
    },
    {
      title: "온라인 협의",
      startIso: "2026-07-21T14:00:00+09:00",
      endIso: "2026-07-21T15:00:00+09:00",
      source: "local",
    },
  ];
}

/** Build the JSON-serializable seed for the in-page fake Today backend. */
export function buildTodaySeed(overrides: TodaySeedOverrides = {}) {
  const snapshot = {
    logicalDay: FIXTURE_DAY,
    generatedAt: "2026-07-21T03:30:00+09:00",
    revision: "rev-1",
    dayState: overrides.dayState ?? "preparing",
    route: overrides.route ?? "prepare",
    stage: "prepare",
    timezone: "Asia/Seoul",
    dayStart: "03:30",
    sleepStart: "21:30",
    brainDump: overrides.brainDump ?? "",
    plan: overrides.plan === undefined ? defaultPlan() : overrides.plan,
    yesterday: overrides.yesterday ?? defaultYesterday(),
    capacity: null,
    carryovers: [],
    sources: [],
    unconfirmedContent: false,
  };
  return {
    workPath: FIXTURE_WORK_PATH,
    logicalDay: FIXTURE_DAY,
    previousLogicalDay: FIXTURE_PREV_DAY,
    markerKey: TODAY_LAST_AUTO_OPEN_KEY,
    markerDay: overrides.markerDay === undefined ? FIXTURE_DAY : overrides.markerDay,
    locale: overrides.locale ?? "ko",
    settings: {
      ui: {
        activeAppMode: overrides.persistedMode ?? "pkm",
        themeMode: overrides.themeMode ?? "light",
        // The reference shell has no right pane. The app auto-closes it on
        // mode *change* into tasks, but a straight boot into tasks keeps it.
        // Seed it closed to match the reference layout.
        layout: { outlineOpen: false },
      },
      tasks: {
        today: {
          enabled: true,
          dayStart: "03:30",
          sleepStart: "21:30",
          notificationEnabled: overrides.notificationsEnabled ?? true,
          autoOpenFirstDailyLaunch: overrides.autoOpen ?? true,
          // Deterministic tests drive plan changes explicitly; the debounced
          // auto-planner would add timing-dependent setPlan mutations.
          autoPlan: overrides.autoPlan ?? false,
        },
      },
    },
    snapshot,
    events: overrides.events ?? defaultEvents(),
    outbox: overrides.outbox ?? defaultOutbox(),
    commitments: overrides.commitments ?? defaultCommitments(),
    rolloverFailures: overrides.rolloverFailures ?? 0,
    taskRows: overrides.taskRows ?? defaultTaskRows(),
    inboxEntries:
      overrides.inboxEntries ??
      CAPTURES.map((capture) =>
        inboxEntry({
          id: capture.id,
          channel: capture.channel,
          title: capture.subject,
          receivedAt: capture.receivedAt,
        }),
      ),
    documents: overrides.documents ?? defaultDocuments(),
  };
}

export type TodaySeed = ReturnType<typeof buildTodaySeed>;

/**
 * Register the fake Today backend on every load of `page`. Also seeds
 * localStorage (locale, settings fallback, auto-open marker) before any app
 * code runs.
 */
export async function installTodayMocks(page: Page, seed: TodaySeed): Promise<void> {
  await page.addInitScript((injected: TodaySeed) => {
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

    // --- localStorage seeds (locale, persisted settings, auto-open marker) --
    // Init scripts re-run on every navigation; seed only once per tab
    // (sessionStorage survives reloads) so mode switches the test performs
    // stay persisted — the same guard pattern as e2e/smoke.spec.ts.
    if (window.sessionStorage.getItem("maru:e2e:today-seeded") !== "true") {
      if (injected.locale) window.localStorage.setItem("maru:locale:v1", injected.locale);
      window.localStorage.setItem(
        `maru:settings:fallback:v1:${injected.workPath}`,
        JSON.stringify(injected.settings),
      );
      if (injected.markerDay) {
        window.localStorage.setItem(injected.markerKey, injected.markerDay);
      }
      window.sessionStorage.setItem("maru:e2e:today-seeded", "true");
    }

    // --- fake backend state --------------------------------------------------
    const state = {
      logicalDay: injected.logicalDay,
      previousLogicalDay: injected.previousLogicalDay,
      snapshot: clone(injected.snapshot),
      revisionCounter: 1,
      events: clone(injected.events),
      outbox: clone(injected.outbox),
      commitments: clone(injected.commitments),
      taskRows: clone(injected.taskRows),
      inboxEntries: clone(injected.inboxEntries),
      documents: clone(injected.documents) as Record<string, { content: string; revision?: string }>,
      transitionCounter: 0,
      rolloverFailures: injected.rolloverFailures,
    };

    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    (window as unknown as { __MARU_E2E_CALLS__: typeof calls }).__MARU_E2E_CALLS__ = calls;

    const bumpRevision = () => `rev-${(state.revisionCounter += 1)}`;

    const refKey = (ref: { kind: string; taskId?: string; captureId?: string }) =>
      ref.kind === "task" ? `task:${ref.taskId ?? ""}` : `capture:${ref.captureId ?? ""}`;

    const applyMutation = (mutation: {
      type: string;
      route?: string;
      brainDump?: string;
      plan?: unknown;
      taskId?: string;
      resolution?: string;
      deferDate?: string | null;
      itemRef?: { kind: string; taskId?: string; captureId?: string };
      selected?: boolean;
      destination?: string | null;
    }) => {
      const snap = state.snapshot as Record<string, unknown> & {
        yesterday: Array<Record<string, unknown>>;
        plan: {
          top: Array<Record<string, unknown>>;
          flexible: Array<Record<string, unknown>>;
          overflow: Array<Record<string, unknown>>;
        } | null;
      };
      switch (mutation.type) {
        case "setRoute":
          snap.route = mutation.route;
          break;
        case "setBrainDump":
          snap.brainDump = mutation.brainDump;
          break;
        case "confirmSetup":
          snap.dayState = "planned";
          break;
        case "quickSkip":
          snap.dayState = "skipped";
          break;
        case "setPlan":
          snap.plan = mutation.plan as typeof snap.plan;
          break;
        case "applyYesterdayDecision": {
          const item = snap.yesterday.find((entry) => entry.taskId === mutation.taskId);
          if (item) {
            item.resolution = mutation.resolution;
            item.deferDate = mutation.deferDate ?? null;
          }
          break;
        }
        case "setCalendarSync": {
          if (snap.plan && mutation.itemRef) {
            const key = refKey(mutation.itemRef);
            const items = [...snap.plan.top, ...snap.plan.flexible, ...snap.plan.overflow];
            const item = items.find(
              (entry) => refKey(entry.itemRef as never) === key,
            );
            if (item) {
              item.calendarSync = mutation.selected
                ? { status: "selected", destination: mutation.destination ?? null }
                : { status: "none" };
            }
          }
          break;
        }
        case "undo":
          // The real backend pops the undo stack; the fake keeps the current
          // snapshot (undo availability is asserted in unit tests).
          break;
        default:
          break;
      }
      snap.revision = bumpRevision();
    };

    const documentPayload = (path: string, content: string, revision?: string) => ({
      path: `${injected.workPath}/${path}`,
      relPath: path,
      title: path.split("/").pop() ?? path,
      content,
      body: content.replace(/^---[\s\S]*?---\n/, ""),
      revision: revision ?? "rev-doc-1",
    });

    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      today_logical_day: () => ({
        logicalDay: state.logicalDay,
        previousLogicalDay: state.previousLogicalDay,
        isNewDayBoundary: true,
      }),
      today_open: () => ({ ...clone(state.snapshot), logicalDay: state.logicalDay }),
      today_mutate: (args) => {
        // Mirror the Rust optimistic-concurrency guards (today_store.rs):
        // stale expectedRevision and stale setPlan inputRevision both reject
        // with the same today_conflict error shape.
        const snapRevision = String((state.snapshot as { revision?: unknown }).revision ?? "");
        const expected = String(args.expectedRevision ?? "");
        if (expected !== snapRevision) {
          throw new Error(
            `today_conflict: expected revision ${expected}, found ${snapRevision}`,
          );
        }
        const mutation = args.mutation as { type?: string; plan?: { inputRevision?: string } };
        if (mutation.type === "setPlan" && mutation.plan?.inputRevision !== snapRevision) {
          throw new Error(
            `today_conflict: expected revision ${mutation.plan?.inputRevision ?? ""}, found ${snapRevision}`,
          );
        }
        applyMutation(args.mutation as never);
        return clone(state.snapshot);
      },
      create_task_note: (args) => {
        const draft = args.draft as {
          title?: string;
          frontmatter?: Record<string, unknown>;
        };
        const title = String(draft.title ?? "새 작업");
        const relPath = `tasks/active/e2e-created-${(state.transitionCounter += 1)}.md`;
        return {
          path: `${injected.workPath}/${relPath}`,
          relPath,
          fileName: relPath.split("/").pop(),
          bucket: "active",
          sizeBytes: 128,
          updatedAt: "2026-07-21T09:00:00+09:00",
          frontmatter: { title, status: "active", ...(draft.frontmatter ?? {}) },
        };
      },
      today_rollover: () => {
        if (state.rolloverFailures > 0) {
          state.rolloverFailures -= 1;
          throw new Error("mock rollover failure");
        }
        return {
          closedDay: state.previousLogicalDay,
          newDay: state.logicalDay,
          seeded: 0,
        };
      },
      today_notify_new_day: () => ({ sent: true, permission: "granted" }),
      read_task_events: (args) => {
        const day = typeof args.day === "string" ? args.day : null;
        return clone(
          day ? state.events.filter((event) => String(event.ts).startsWith(day)) : state.events,
        );
      },
      task_transition: (args) => {
        const request = args.request as {
          taskId: string;
          taskPath: string;
          kind: string;
          nowIso?: string | null;
        };
        state.transitionCounter += 1;
        state.events.push({
          ts: request.nowIso ?? "2026-07-21T12:00:00+09:00",
          kind: request.kind === "complete" ? "task_completed" : `task_${request.kind}ed`,
          taskId: request.taskId,
          payload: { taskPath: request.taskPath },
        });
        return {
          taskId: request.taskId,
          newTaskHash: `mock-hash-${state.transitionCounter}`,
          bucket: request.kind === "complete" ? "done" : "active",
          syncStatus: "syncing",
        };
      },
      task_trash: (args) => ({ trashedPath: String(args.taskPath ?? "") }),
      task_integrations_drain: () => ({ drained: 0, failed: 0, blocked: 0 }),
      task_integrations_retry: () => ({ requeued: 0 }),
      read_task_integrations: () => clone(state.outbox),
      today_calendar_commitments: () => clone(state.commitments),
      task_calendar_set_sync: (args) => {
        applyMutation({
          type: "setCalendarSync",
          itemRef: args.itemRef as never,
          selected: Boolean(args.selected),
          destination: (args.destination as string | null) ?? null,
        });
        return clone(state.snapshot);
      },
      today_calendar_publish: () => ({
        published: 0,
        failed: 0,
        blocked: false,
        snapshot: clone(state.snapshot),
      }),
      today_build_plan_request: () => ({ prompt: "mock" }),
      today_apply_plan_result: () => clone(state.snapshot),
      scan_task_notes: () => clone(state.taskRows),
      scan_inbox_entries: () => clone(state.inboxEntries),
      read_document: (args) => {
        const path = String(args.documentPath ?? "");
        const doc = state.documents[path];
        // null = not part of the fixture; the api.ts browser fallback
        // (readMockDocument) takes over for the regular sample documents.
        return doc ? documentPayload(path, doc.content, doc.revision) : null;
      },
      save_document: (args) => {
        const path = String(args.documentPath ?? "");
        const content = String(args.content ?? "");
        if (!state.documents[path]) return null;
        state.documents[path] = { content, revision: `rev-doc-${(state.revisionCounter += 1)}` };
        return documentPayload(path, content, state.documents[path].revision);
      },
    };

    const invokeMap: Record<string, (args: Record<string, unknown>) => unknown> = {};
    for (const [command, handler] of Object.entries(handlers)) {
      invokeMap[command] = (args) => {
        calls.push({ command, args: clone(args ?? {}) });
        return handler(args ?? {});
      };
    }
    // Record EVERY invoked command, registered or not — "command never fired"
    // assertions must be able to fail. Unregistered commands record the call
    // and return null, which invokeE2EOverride treats as "no handler" so the
    // caller's normal browser fallback still runs.
    const recordingMap = new Proxy(invokeMap, {
      get(target, command) {
        if (typeof command !== "string") return undefined;
        if (command in target) return target[command];
        return (args: Record<string, unknown>) => {
          calls.push({ command, args: clone(args ?? {}) });
          return null;
        };
      },
    });
    (
      window as unknown as {
        __MARU_E2E_INVOKE__: Record<string, (args: Record<string, unknown>) => unknown>;
      }
    ).__MARU_E2E_INVOKE__ = recordingMap;

    // Test control handle (rollover driving, state inspection).
    (
      window as unknown as {
        __MARU_TODAY_MOCK__: {
          calls: typeof calls;
          setLogicalDay: (day: string) => void;
        };
      }
    ).__MARU_TODAY_MOCK__ = {
      calls,
      setLogicalDay: (day: string) => {
        state.previousLogicalDay = state.logicalDay;
        state.logicalDay = day;
      },
    };
  }, seed);
}

/** Read the recorded invoke log from the page. */
export async function readTodayCalls(page: Page): Promise<TodayInvokeCall[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __MARU_E2E_CALLS__?: Array<{ command: string; args: Record<string, unknown> }>;
        }
      ).__MARU_E2E_CALLS__ ?? [],
  );
}

/** Recorded mutations of one type, in order. */
export function mutationCalls(calls: TodayInvokeCall[], type: string) {
  return calls.filter(
    (call) =>
      call.command === "today_mutate" &&
      (call.args.mutation as { type?: string } | undefined)?.type === type,
  );
}
