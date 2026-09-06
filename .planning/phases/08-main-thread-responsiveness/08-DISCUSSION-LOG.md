# Phase 8: Main-Thread Responsiveness - Discussion Log

> Audit trail only. Do not use as input to planning, research or execution. Decisions are captured in 08-CONTEXT.md.

**Date:** 2026-09-05
**Phase:** 8 - Main-Thread Responsiveness
**Areas discussed:** 동기화 중 수정·삭제, 화면 이동 중 작업 유지, 느린 작업·실패 안내

The user selected all three discussion areas with "모두 논의하라". Each of the five subsequent decisions was confirmed by the user replying "1". No answers were auto-selected.

## 동기화 중 수정·삭제

### 동기화 중 소스 설정을 바꿨다면 이전 결과를 버린 뒤 어떻게 이어갈까요?

| Option | Description | Selected |
|---|---|---|
| 1 | 안내 후 수동 재실행 | Yes |
| 2 | 변경된 설정으로 한 번 자동 재시도 |  |

**User response:** `1`
**Decision:** 변경 사실을 짧게 알리고 사용자가 다시 동기화

### 동일 소스의 동기화가 진행 중일 때 중복 요청은 어떻게 처리할까요?

| Option | Description | Selected |
|---|---|---|
| 1 | 진행 중 안내, 중복 실행 안 함 | Yes |
| 2 | 완료 뒤 한 번 추가 실행 예약 |  |

**User response:** `1`
**Decision:** 진행 중임을 알리고 중복 요청은 실행하지 않음

### 일부 소스가 동기화 중일 때 전체 동기화는 어떻게 할까요?

| Option | Description | Selected |
|---|---|---|
| 1 | 진행 중 소스 건너뛰고 나머지 처리 | Yes |
| 2 | 진행 중 작업 완료 뒤 전체 시작 |  |

**User response:** `1`
**Decision:** 진행 중인 소스는 건너뛰었다고 표시하고 나머지는 동기화

## 화면 이동 중 작업 유지

### 사용자가 시작한 동기화나 파일 처리 중 다른 화면으로 이동하면 어떻게 할까요?

| Option | Description | Selected |
|---|---|---|
| 1 | 백그라운드에서 계속하고 기존 알림 사용 | Yes |
| 2 | 작업 완료까지 화면 이동을 기다리도록 안내 |  |

**User response:** `1`
**Decision:** 작업은 계속하고 완료·실패를 기존 알림으로 안내

## 느린 작업·실패 안내

### 네트워크 오류 등으로 동기화가 실패하면 어떻게 할까요?

| Option | Description | Selected |
|---|---|---|
| 1 | 실패 이유 안내 후 수동 재실행 | Yes |
| 2 | 일시적 네트워크 오류만 한 번 자동 재시도 후 실패 안내 |  |

**User response:** `1`
**Decision:** 실패 이유를 알리고 사용자가 다시 실행

## Inherited Constraints and Clarifications

- Deleted-source protection, full blocking-command re-inventory and native concurrency proof were carried forward from the roadmap and requirements, not re-decided.
- Existing progress indication and preservation of successful per-source results were stated in the final question and retained with the selected manual-retry behavior.
- Workspace ownership, stale-result rejection and avoiding forced navigation were stated as existing safety constraints. They were not presented as an additional user-selected option.
- The implementation mechanism and numeric latency thresholds were left for research and planning; no user delegation answer was fabricated.

## Deferred Ideas

No new ideas. The existing Phase 7 Inbox/right-panel overlap remains outside this phase.
