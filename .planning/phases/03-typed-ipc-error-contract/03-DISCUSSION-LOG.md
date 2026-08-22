# Phase 3: Typed IPC Error Contract - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-23
**Phase:** 3-typed-ipc-error-contract
**Areas discussed:** Wire format, ERR-02 sync mechanism, Contract scope, Toast compat

---

## Wire format

| Option | Description | Selected |
|--------|-------------|----------|
| Keep string wire | 'code: message' 문자열 유지 + types.ts union + 공유 파서. diff 최소, toast 무변경. wire 자체는 여전히 stringly | |
| Struct over IPC | 해당 커맨드만 Result<T, IpcError>로 변경, IpcError{code,message} Serialize. CONCERNS.md가 명시한 방향 | ✓ |
| JSON string hybrid | Err에 JSON 문자열. 파싱 실패 리스크만 늘고 이점 불명확 | |

**User's choice:** Struct over IPC
**Notes:** CONCERNS.md의 prescribed fix approach를 따름.

---

## ERR-02 sync mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Rust test + TS satisfies | Rust unit test가 code 목록 assert + TS exhaustive satisfies/union 미러. codegen 없이 양쪽 빌드 실패, diff 최소 | ✓ |
| Codegen to TS | Rust가 ipcErrorCodes.generated.ts 생성, make verify가 drift 검사. 더 강력하지만 생성물 인프라 추가 | |

**User's choice:** Rust test + TS satisfies
**Notes:** roadmap 노트의 "pick the one with the smaller diff"에 부합.

---

## Contract scope

| Option | Description | Selected |
|--------|-------------|----------|
| Frontend branch-on만 | 4개 코드만 (evidence_binder_revision_conflict, document_conflict, today_conflict, task_conflict). ERR-04 미니멀리즘 | ✓ |
| Rust-internal family 포함 | unknown_source/install_target_exists/terminal_kill_failed도 포함. 범위 확대 | |

**User's choice:** Frontend branch-on만
**Notes:** grep 검증으로 prefix family는 frontend branch 대상이 아님을 확인 (web_actions.rs 내부 사용만). roadmap 노트의 가정을 실측으로 교정.

---

## Toast compat

| Option | Description | Selected |
|--------|-------------|----------|
| Facade normalizes | api.ts wrapper가 IpcError object를 code 부착 Error로 rethrow. 기존 catch 지점 무변경, errorStore 무변경 | ✓ |
| Callers handle raw object | 각 caller가 raw object를 직접 처리. blast radius 큼 | |

**User's choice:** Facade normalizes
**Notes:** roadmap의 "readable toast without special-casing at every call site" 제약을 만족하는 최소 변경.

---

## Claude's Discretion

- IpcError의 Rust 모듈 위치와 serde 필드 명명
- TS 미러의 정확한 형태 (union vs const array + satisfies)
- Rust 측 code-list assertion 테스트의 형태

## Deferred Ideas

- Rust-internal prefix family의 타입화 — frontend consumer가 생기면 재검토
- Native Tauri E2E runner — v2 ledger 유지, D-09 round-trip 테스트가 이 마일스톤의 대체 완화책
