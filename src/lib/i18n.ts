// Anchor i18n — ko-KR and en-US are equal first-class locales.
//
// Rules:
// - Every UI string lives here. Never hard-code Korean or English in
//   components.
// - When adding/changing a key, update BOTH `ko` and `en` simultaneously.
//   The lint script (scripts/lint-i18n.ts, Phase 0) fails CI if any key
//   is missing in either locale.
// - Use `useTranslation()` in React components, or `t(locale, key)` in
//   plain TS. Variable interpolation: `{name}` placeholders.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "ko" | "en";

export const LOCALES: Locale[] = ["ko", "en"];

const STORAGE_KEY = "anchor:locale:v1";

const ko: Record<string, string> = {
  "app.title": "Anchor",
  "app.subtitle.work": "AI workspace",
  "app.subtitle.note": "파일 원천 · 깨지지 않는 frontmatter · 다중 workspace",
  "app.locale.ko": "KO",
  "app.locale.en": "EN",
  "app.locale.label": "언어",
  "app.refresh": "Workspace 다시 읽기",
  "app.confirmUnsaved": "저장하지 않은 변경이 있습니다. 다른 문서를 열까요?",
  "app.errorClose": "닫기",
  "mode.pkm": "문서",
  "mode.inbox": "인박스",
  "mode.system": "설정",
  "activity.label": "앱 영역",
  "layout.hideDocumentTypes": "문서 타입 패널 숨기기",
  "layout.showDocumentTypes": "문서 타입 패널 보이기",
  "layout.hideDocuments": "문서 패널 숨기기",
  "layout.showDocuments": "문서 패널 보이기",
  "layout.resizeDocuments": "문서 패널 크기 조절",
  "layout.resizeOutline": "오른쪽 패널 크기 조절",

  "workspace.current": "현재 Workspace",
  "workspace.add": "Workspace 추가",
  "workspace.addPublic": "Public workspace 추가",
  "workspace.addPublic.short": "Public 추가",
  "workspace.remove": "Workspace 제거",
  "workspace.remove.label": "{label} workspace 제거",
  "workspace.remove.confirm": "이 workspace를 목록에서 제거할까요?",
  "workspace.choose": "선택",
  "workspace.useSample": "샘플 workspace 열기",
  "workspace.switcher.empty": "Workspace 선택",
  "workspace.switcher.none": "등록된 workspace가 없습니다",
  "workspace.switcher.publicNone": "등록된 public workspace가 없습니다",
  "workspace.tabs.label": "Workspace 범위",
  "workspace.visibility.private": "Private",
  "workspace.visibility.public": "Public",
  "workspace.public.optional": "선택 사항",
  "workspace.path.missing": "경로 없음",
  "workspace.error.noneActive": "활성 workspace가 없습니다. 먼저 workspace를 열거나 추가하세요.",
  "workspace.dialog.title": "Workspace 추가",
  "workspace.dialog.description":
    "마크다운 파일이 포함된 폴더를 선택해 AI workspace에서 열 수 있도록 등록합니다.",
  "workspace.dialog.visibility": "범위",
  "workspace.dialog.label": "표시 이름",
  "workspace.dialog.path": "폴더 경로",
  "workspace.dialog.pickPath": "폴더 선택...",
  "workspace.dialog.externalWriter": "쓰기 위임 (선택)",
  "workspace.dialog.externalWriter.help":
    "외부 앱이 이 폴더를 관리하는 경우 표시. Anchor는 읽기만 합니다.",
  "workspace.dialog.externalWriter.none": "없음 (Anchor가 직접 쓰기)",
  "workspace.dialog.externalWriter.obsidian": "Obsidian (MCP 위임)",
  "workspace.dialog.provider": "Provider",
  "workspace.dialog.provider.help":
    "Public workspace는 provider가 관리하는 공유 루트로 등록합니다.",
  "workspace.dialog.writePolicy": "쓰기 정책",
  "workspace.dialog.writePolicy.help":
    "Direct는 Anchor 직접 쓰기, Delegated는 외부 writer 위임, Read-only는 읽기 전용입니다.",
  "workspace.dialog.providerId": "Provider ID",
  "workspace.dialog.providerId.help": "비밀이 아닌 식별자만 입력합니다.",
  "workspace.dialog.providerId.placeholder": "shared-drive-id, site-id",
  "workspace.dialog.role": "Provider role",
  "workspace.dialog.role.help":
    "예: contentManager, Can edit, Can view, Nextcloud 권한 bitmask",
  "workspace.dialog.role.placeholder": "contentManager",
  "workspace.writePolicy.direct": "Direct",
  "workspace.writePolicy.delegated": "Delegated",
  "workspace.writePolicy.readOnly": "Read-only",
  "workspace.writeStatus.writable": "쓰기 가능",
  "workspace.writeStatus.limited": "제한적 쓰기",
  "workspace.writeStatus.readOnly": "읽기 전용",
  "workspace.refreshCapabilities": "Capability 새로고침",
  "workspace.refreshCapabilities.label": "{label} capability 새로고침",
  "workspace.dialog.cancel": "취소",
  "workspace.dialog.confirm": "추가",
  "workspace.dialog.error.label": "이름을 입력하세요.",
  "workspace.dialog.error.path": "경로를 선택하세요.",
  "workspace.writeDelegated":
    "이 workspace의 쓰기는 {writer}에 위임되어 있어 Anchor가 직접 쓰지 않습니다.",
  "workspace.writeBlocked":
    "이 workspace는 {reason} 때문에 Anchor가 직접 쓰지 않습니다.",

  "sidebar.commandPalette": "명령 팔레트",
  "sidebar.types": "문서 타입",
  "sidebar.types.all": "전체",
  "sidebar.types.untyped": "타입 없음",
  "sidebar.recent": "최근 문서",
  "sidebar.recent.empty": "아직 열어본 문서가 없습니다.",

  "list.title": "문서",
  "list.searchPlaceholder": "제목, 본문 검색",
  "list.loading": "문서 목록 로딩",
  "list.empty.title": "표시할 문서가 없습니다",
  "list.empty.description": "샘플 workspace를 열거나 새 문서를 만들어 시작하세요.",
  "list.meta.words": "{count} 단어",
  "list.meta.versions": "{count} 버전",
  "list.meta.count": "{count} 건",
  "list.group.today": "오늘",
  "list.group.thisWeek": "이번 주",
  "list.group.earlier": "이전",
  "list.viewMode": "문서 보기 방식",
  "list.view.list": "목록",
  "list.view.tree": "트리",
  "list.tree.actions": "트리 전체 조작",
  "list.tree.collapseAll": "모두 접기",
  "list.tree.expandAll": "모두 펴기",
  "explorer.mode.label": "Explorer 모드",
  "explorer.mode.documents": "Documents",
  "explorer.mode.files": "Files",
  "files.title": "파일",
  "files.searchPlaceholder": "파일명, 경로 검색",
  "files.loading": "파일 목록 로딩",
  "files.empty.title": "표시할 파일이 없습니다",
  "files.empty.description": "필터를 바꾸거나 workspace를 다시 읽어보세요.",
  "files.filter.label": "파일 필터",
  "files.filter.all": "전체",
  "files.filter.tracked": "Git tracked",
  "files.filter.binary": "Binary",
  "files.tree.actions": "파일 트리 전체 조작",
  "files.queue": "오른쪽 Files에 추가",
  "files.queueSelected": "선택 파일 추가",
  "files.openUnsupported": "이 파일 형식은 편집기로 열 수 없습니다.",
  "files.openUnavailable": "문서 인덱스에 없는 파일입니다.",
  "context.openFile": "파일 열기",
  "context.revealInFinder": "Finder에서 보기",
  "context.copyPath": "경로 복사",
  "context.copyRelativePath": "상대 경로 복사",

  "editor.empty.title": "문서를 선택하세요",
  "editor.empty.description":
    "왼쪽 목록에서 문서를 열면 편집과 미리보기가 같은 화면에 배치됩니다.",
  "editor.dirty": "저장 필요",
  "editor.saved": "저장됨",
  "editor.save": "저장",
  "editor.saving": "저장 중",
  "editor.snapshot": "스냅샷",
  "editor.readOnly": "읽기 전용",
  "editor.tab.edit": "원문",
  "editor.tab.rich": "리치",
  "editor.tab.source": "원문",
  "editor.tab.preview": "미리보기",
  "editor.tabs.label": "열린 문서",
  "editor.tabs.close": "탭 닫기",
  "editor.tabs.closeAll": "깨끗한 문서탭 모두 닫기",
  "editor.tabs.closeAll.dirtyKept": "저장 안 된 탭 {count}개는 남겨두었습니다.",
  "editor.splitRight": "오른쪽으로 분할",
  "editor.status.lines": "{count} 줄",
  "editor.status.words": "{count} 단어",
  "editor.status.chars": "{count} 자",

  "outline.title": "문서 개요",
  "outline.open": "개요 열기",
  "outline.close": "개요 닫기",
  "outline.empty": "이 문서에는 제목(#) 헤딩이 없습니다.",
  "outline.empty.noDocument": "문서를 선택하면 개요가 표시됩니다.",
  "outline.meta.created": "생성",
  "outline.meta.updated": "수정",

  "rightPane.title": "오른쪽 패널",
  "rightPane.tabs": "오른쪽 패널 탭",
  "rightPane.tab.outline": "개요",
  "rightPane.tab.files": "파일",
  "rightPane.tab.memo": "메모",
  "rightPane.tab.info": "정보",
  "rightPane.files.pick": "파일 추가",
  "rightPane.files.copy": "복사",
  "rightPane.files.move": "이동",
  "rightPane.files.dropTitle": "파일 임시 보관",
  "rightPane.files.dropDescription": "파일을 드롭하거나 버튼으로 추가합니다.",
  "rightPane.files.queueTitle": "파일 작업 큐",
  "rightPane.files.queueDescription": "Explorer에서 선택하거나 드롭한 파일을 여기에서 적용합니다.",
  "rightPane.files.emptyQueue": "대기 중인 파일 작업이 없습니다.",
  "rightPane.files.destination": "대상",
  "rightPane.files.chooseDestination": "대상 폴더 선택",
  "rightPane.files.applyQueue": "Apply",
  "rightPane.files.clearQueue": "Clear",
  "rightPane.files.done": "완료",
  "rightPane.files.store": ".anchor에 저장",
  "rightPane.files.saveAs": "Save As",
  "rightPane.memo.new": "새 메모",
  "rightPane.memo.refresh": "목록",
  "rightPane.memo.list": "메모 목록",
  "rightPane.memo.loading": "메모 로딩 중",
  "rightPane.memo.empty": "저장된 메모가 없습니다.",
  "rightPane.memo.noPreview": "미리보기 없음",
  "rightPane.memo.name": "파일명",
  "rightPane.memo.placeholder": "메모 작성",
  "rightPane.memo.save": ".anchor에 저장",
  "rightPane.memo.saveAs": "Save As",
  "rightPane.memo.delete": "삭제",
  "rightPane.memo.deleteConfirm": "이 메모를 삭제할까요?",
  "rightPane.memo.autoSaveIdle": "자동 저장",
  "rightPane.memo.autoSaving": "저장 중",
  "rightPane.memo.autoSaved": "저장됨",
  "rightPane.memo.autoSaveError": "저장 실패",

  "inspector.title": "프론트매터",
  "inspector.empty": "값 없음",

  "wikilink.notFound": "workspace에 없음: [[{target}]]",

  "neighborhood.title": "주변",
  "neighborhood.upward": "프로젝트 / 상위",
  "neighborhood.mentions": "본문 언급",
  "neighborhood.peers": "같은 타입",

  "inbox.title": "오늘의 인박스",
  "inbox.subtitle.combined": "파일 {files}건 · 메일 {gmail}건 처리 대기",
  "inbox.refresh": "인박스 새로고침",
  "inbox.loading": "파일 인박스 로딩",
  "inbox.empty.title": "처리할 파일이 없습니다",
  "inbox.empty.description": "inbox/downloads 폴더에 들어온 파일이 여기에 표시됩니다.",
  "inbox.section.files": "파일",
  "inbox.section.gmail": "Gmail",
  "inbox.gmail.loading": "Gmail 동기화 중",
  "inbox.gmail.empty.title": "읽지 않은 메일이 없습니다",
  "inbox.gmail.empty.description": "gws CLI 동기화 후 미수신 메일이 여기에 표시됩니다.",
  "inbox.gmail.noSubject": "(제목 없음)",
  "inbox.accept": "수락",
  "inbox.reject": "거절",
  "inbox.classify": "분류",
  "inbox.notClassified": "아직 분류되지 않았습니다.",
  "inbox.decision.pending": "대기",
  "inbox.decision.accepted": "수락됨",
  "inbox.decision.rejected": "거절됨",
  "inbox.filter.all": "전체",
  "inbox.filter.label": "소스 필터",
  "inbox.settings.open": "인박스 설정",
  "inbox.settings.title": "인박스 설정",
  "inbox.settings.description": "이 Workspace의 인박스 위치, 인식할 소스, 그리고 Gmail용 gws CLI 경로를 지정합니다.",
  "inbox.settings.root.label": "인박스 루트 (Workspace 상대 경로)",
  "inbox.settings.root.placeholder": "예: inbox/downloads",
  "inbox.settings.sources.label": "소스 폴더 (쉼표로 구분)",
  "inbox.settings.sources.placeholder": "예: outlook, sharepoint, gmail",
  "inbox.settings.sources.hint": "비워두면 모든 하위 폴더를 인식합니다.",
  "inbox.settings.gws.label": "gws CLI 절대 경로 (선택)",
  "inbox.settings.gws.placeholder": "예: /opt/homebrew/bin/gws",
  "inbox.settings.gws.hint": "비워두면 PATH 와 일반적인 설치 위치(/opt/homebrew/bin, ~/go/bin 등)를 자동 검색합니다.",
  "inbox.settings.save": "저장",
  "inbox.settings.cancel": "취소",

  "commit.title": "변경사항 커밋",
  "commit.summary": "{staged} staged · {modified} 수정 · {untracked} 새 파일 (총 {total})",
  "commit.selected": "{selected}/{total} 파일 선택됨",
  "commit.file.include": "{path} 커밋 포함",
  "commit.message.label": "커밋 메시지",
  "commit.message.placeholder": "예) feat(meeting): 4월 주간회의 기록 추가",
  "commit.submit": "커밋",
  "commit.submitting": "커밋 중...",
  "commit.error.emptyMessage": "메시지를 입력해주세요.",
  "commit.error.emptySelection": "커밋할 파일을 하나 이상 선택해주세요.",
  "dialog.cancel": "취소",
  "dialog.close": "닫기",

  "cmdk.placeholder": "문서 또는 명령 검색...",
  "cmdk.empty": "결과가 없습니다.",
  "cmdk.openHint": "⌘K 로 명령 팔레트를 엽니다",
  "cmdk.section.commands": "명령",
  "cmdk.section.documents": "문서",
  "cmdk.action.newDocument": "새 문서 만들기",
  "cmdk.action.save": "현재 문서 저장",
  "cmdk.action.snapshot": "버전 스냅샷 만들기",
  "cmdk.action.splitRight": "오른쪽으로 분할",
  "cmdk.action.closeAllTabs": "깨끗한 문서탭 모두 닫기",
  "cmdk.action.togglePreview": "미리보기 토글",
  "cmdk.action.toggleOutline": "개요 패널 토글",
  "cmdk.action.toggleLocale": "한국어/English 전환",
  "cmdk.action.refresh": "Workspace 다시 읽기",
  "cmdk.action.openInbox": "인박스 열기",
  "cmdk.action.openDocs": "문서 열기",
  "cmdk.action.openSettings": "설정 열기",
  "cmdk.action.checkUpdates": "업데이트 확인",
  "cmdk.action.addWorkspace": "Workspace 추가",

  "newDoc.button": "새 문서",
  "newDoc.dialog.title": "새 Anchor 문서",
  "newDoc.dialog.description":
    "표준 frontmatter (type, status, created_at, updated_at, id) 가 포함된 마크다운 문서를 workspace 루트에 만듭니다.",
  "newDoc.field.title": "제목",
  "newDoc.field.title.placeholder": "예: 2분기 운영위원회 보고",
  "newDoc.field.type": "타입",
  "newDoc.field.type.placeholder": "예: meeting, project, reference",
  "newDoc.field.path": "파일 경로",
  "newDoc.field.path.placeholder": "예: meetings/주간 회의",
  "newDoc.field.path.helper": "비워두면 제목에서 파일명을 자동 생성합니다. .md는 생략할 수 있습니다.",
  "newDoc.field.body": "초기 본문",
  "newDoc.field.body.helper": "비워두면 제목만 포함된 문서가 생성됩니다.",
  "newDoc.cancel": "취소",
  "newDoc.create": "생성",
  "newDoc.creating": "생성 중",
  "newDoc.error.title": "제목을 입력하세요.",
  "newDoc.error.type": "타입을 입력하세요.",

  "snapshot.summary": "사용자 요청으로 생성한 편집 스냅샷",
  "snapshot.success": "스냅샷 저장됨: {path}",

  "toast.discardedEdit": "{title} 의 저장하지 않은 변경 사항이 임시 보관되었습니다.",
  "toast.restore": "되돌리기",
  "updates.checking": "업데이트 확인 중...",
  "updates.available": "새 버전 {version}이 있습니다.",
  "updates.none": "사용 가능한 업데이트가 없습니다.",
  "updates.downloading": "업데이트 다운로드/설치 중: {progress}",
  "updates.ready": "업데이트 설치 완료. 앱을 다시 시작합니다.",
  "updates.install": "설치 후 재시작",
  "updates.error": "업데이트 실패: {message}",
  "updates.desktopOnly": "업데이트 확인은 데스크톱 앱에서만 사용할 수 있습니다.",

  "footer.tagline": "로컬 우선 · 파일 원천 · ko/en",

  // === Workspace registration ===
  "workspace.detected": "Workspace 설정 감지됨",
  "workspace.owner": "소유자",
  "workspace.detect.hint":
    "workspace.config.yaml 이 감지되었습니다. private workspace와 선택적 public workspace를 한 번에 등록합니다.",
  "workspace.detect.register": "Workspace 등록",
  "workspace.detect.useStandalone": "단일 폴더로 등록",

  // === System mode ===
  "system.title": "시스템",
  "system.subtitle": ".anchor 운영 데이터 (rules, templates, MCP, projects, skills)",
  "system.empty": "설정을 저장할 private workspace가 없습니다.",
  "system.tab.rules": "Rules",
  "system.tab.templates": "Templates",
  "system.tab.preferences": "Preferences",
  "system.tab.ai": "AI",
  "system.tab.terminal": "Terminal",
  "system.tab.inboxChannels": "Inbox Channels",
  "system.tab.connectors": "Connectors",
  "system.tab.mcp": "MCP",
  "system.tab.projects": "Projects",
  "system.tab.skills": "Skills",
  "system.tab.import": "Import",
  "system.rules.empty": "등록된 규칙이 없습니다. Import 탭에서 _sys/rules 를 가져오거나 새로 만들 수 있습니다.",
  "system.rules.new": "새 규칙",
  "system.rules.delete": "삭제",
  "system.rules.delete.confirm": "이 규칙을 .anchor 에서 삭제할까요?",
  "system.rules.save": "저장",
  "system.rules.saved": "저장됨",
  "system.rules.dirty": "저장 필요",
  "system.templates.empty": "등록된 템플릿이 없습니다.",
  "system.templates.new": "새 템플릿",
  "system.mcp.empty": ".anchor/mcp.json 이 비어 있습니다.",
  "system.mcp.invalidJson": "유효한 JSON 이 아닙니다.",
  "system.mcp.save": "저장",
  "system.projects.empty": ".anchor/projects.json 이 비어 있습니다. Import 탭에서 project-registry.yaml 을 가져오세요.",
  "system.skills.empty": "스킬 카탈로그가 비어 있습니다. Import 탭에서 _sys/skills 를 가져오세요.",
  "system.skills.runtime": "런타임",
  "system.skills.source": "원본",
  "system.skills.category": "카테고리",
  "system.preferences.explorerPane": "Explorer 기본 모드",
  "system.preferences.documentBrowser": "문서 브라우저 기본 보기",
  "system.preferences.documentLabel": "문서 이름 표시",
  "system.preferences.documentLabel.title": "문서 제목",
  "system.preferences.documentLabel.filename": "파일명",
  "system.preferences.filesFilter": "파일 기본 필터",
  "system.preferences.binaryIncludePatterns": "Binary 포함 패턴",
  "system.preferences.binaryIncludePatterns.help":
    "Binary 필터에서 표시할 파일 패턴입니다. 한 줄에 하나씩 입력하며 대소문자는 구분하지 않습니다.",
  "system.preferences.fileQueueOperation": "파일 큐 기본 작업",
  "system.preferences.terminalDefaultOpen": "터미널 패널 기본 열기",
  "system.preferences.themeMode": "테마",
  "system.preferences.theme.system": "시스템",
  "system.preferences.theme.light": "라이트",
  "system.preferences.theme.dark": "다크",
  "system.preferences.accentColor": "강조 색상",
  "system.preferences.terminalAutoLaunch": "터미널 자동 실행",
  "system.preferences.terminalAutoLaunch.none": "자동 실행 안 함",
  "system.ai.title": "AI 설정",
  "system.terminal.title": "터미널 런처 설정",
  "system.inboxChannels.title": "인박스 채널 설정",
  "system.connectors.title": "커넥터 설정",
  "system.import.title": "_sys/ 로부터 가져오기",
  "system.import.subtitle":
    "사용자의 _sys/ 디렉터리를 anchor 의 .anchor/ 로 복사합니다. 같은 항목을 다시 가져오면 sha256 비교로 변경 여부를 알려줍니다.",
  "system.import.empty": "이 work 폴더에 _sys/ 가 없습니다. 가져올 항목이 없습니다.",
  "system.import.section.rules": "Rules",
  "system.import.section.templates": "Templates",
  "system.import.section.mcp": "MCP",
  "system.import.section.projects": "Projects",
  "system.import.section.skills": "Skills",
  "system.import.status.new": "신규",
  "system.import.status.update": "업데이트",
  "system.import.status.unchanged": "변경 없음",
  "system.import.selectAll": "전체 선택",
  "system.import.selectChanges": "변경된 항목만",
  "system.import.apply": "선택 항목 가져오기",
  "system.import.applying": "가져오는 중...",
  "system.import.applied": "가져옴: {count} 건",

  // === Sidebar Projects ===
  "sidebar.projects": "프로젝트",
  "sidebar.projects.empty": "프로젝트가 없습니다. Import 탭에서 project-registry.yaml 을 가져오세요.",
  "sidebar.projects.all": "전체",

  // === Integrated terminal ===
  "terminal.title": "터미널",
  "terminal.launchers": "터미널 런처",
  "terminal.launcher.claude": "Claude",
  "terminal.launcher.codex": "Codex",
  "terminal.launcher.shell": "Shell",
  "terminal.tabs": "터미널 탭",
  "terminal.tab.close": "탭 닫기",
  "terminal.maximize": "터미널 최대화",
  "terminal.restore": "터미널 원래 크기로",
  "terminal.empty": "터미널 없음",
  "terminal.empty.detail": "Claude, Codex, Shell 버튼으로 새 터미널을 시작하세요.",
  "terminal.cwd.none": "실행 폴더 없음",
  "terminal.tauriRequired": "통합 터미널은 Tauri 앱에서만 사용할 수 있습니다.",
};

const en: Record<string, string> = {
  "app.title": "Anchor",
  "app.subtitle.work": "AI workspace",
  "app.subtitle.note": "Files-as-truth · resilient frontmatter · multi-workspace",
  "app.locale.ko": "KO",
  "app.locale.en": "EN",
  "app.locale.label": "Language",
  "app.refresh": "Reload workspace",
  "app.confirmUnsaved": "You have unsaved changes. Open a different document?",
  "app.errorClose": "Close",
  "mode.pkm": "Docs",
  "mode.inbox": "Inbox",
  "mode.system": "Settings",
  "activity.label": "App areas",
  "layout.hideDocumentTypes": "Hide document types panel",
  "layout.showDocumentTypes": "Show document types panel",
  "layout.hideDocuments": "Hide documents panel",
  "layout.showDocuments": "Show documents panel",
  "layout.resizeDocuments": "Resize documents panel",
  "layout.resizeOutline": "Resize right panel",

  "workspace.current": "Current workspace",
  "workspace.add": "Add workspace",
  "workspace.addPublic": "Add public workspace",
  "workspace.addPublic.short": "Add public",
  "workspace.remove": "Remove workspace",
  "workspace.remove.label": "Remove {label} workspace",
  "workspace.remove.confirm": "Remove this workspace from the list?",
  "workspace.choose": "Choose",
  "workspace.useSample": "Open sample workspace",
  "workspace.switcher.empty": "Choose workspace",
  "workspace.switcher.none": "No workspaces registered",
  "workspace.switcher.publicNone": "No public workspaces registered",
  "workspace.tabs.label": "Workspace scope",
  "workspace.visibility.private": "Private",
  "workspace.visibility.public": "Public",
  "workspace.public.optional": "optional",
  "workspace.path.missing": "path not found",
  "workspace.error.noneActive": "No active workspace. Open or add one first.",
  "workspace.dialog.title": "Add workspace",
  "workspace.dialog.description":
    "Register a folder containing markdown files so AI workspace can open it.",
  "workspace.dialog.visibility": "Scope",
  "workspace.dialog.label": "Display name",
  "workspace.dialog.path": "Folder path",
  "workspace.dialog.pickPath": "Pick folder...",
  "workspace.dialog.externalWriter": "Write delegation (optional)",
  "workspace.dialog.externalWriter.help":
    "Set if another app owns this folder. Anchor will read but not write.",
  "workspace.dialog.externalWriter.none": "None (Anchor writes directly)",
  "workspace.dialog.externalWriter.obsidian": "Obsidian (MCP delegation)",
  "workspace.dialog.provider": "Provider",
  "workspace.dialog.provider.help":
    "A public workspace is a provider-managed shared root.",
  "workspace.dialog.writePolicy": "Write policy",
  "workspace.dialog.writePolicy.help":
    "Direct lets Anchor write, delegated uses an external writer, and read-only blocks writes.",
  "workspace.dialog.providerId": "Provider ID",
  "workspace.dialog.providerId.help": "Only store non-secret opaque identifiers.",
  "workspace.dialog.providerId.placeholder": "shared-drive-id, site-id",
  "workspace.dialog.role": "Provider role",
  "workspace.dialog.role.help":
    "Examples: contentManager, Can edit, Can view, Nextcloud permission bitmask",
  "workspace.dialog.role.placeholder": "contentManager",
  "workspace.writePolicy.direct": "Direct",
  "workspace.writePolicy.delegated": "Delegated",
  "workspace.writePolicy.readOnly": "Read-only",
  "workspace.writeStatus.writable": "Writable",
  "workspace.writeStatus.limited": "Limited write",
  "workspace.writeStatus.readOnly": "Read-only",
  "workspace.refreshCapabilities": "Refresh capabilities",
  "workspace.refreshCapabilities.label": "Refresh {label} capabilities",
  "workspace.dialog.cancel": "Cancel",
  "workspace.dialog.confirm": "Add",
  "workspace.dialog.error.label": "Display name is required.",
  "workspace.dialog.error.path": "Folder path is required.",
  "workspace.writeDelegated":
    "Writes for this workspace are delegated to {writer}; Anchor will not write directly.",
  "workspace.writeBlocked":
    "Anchor will not write directly to this workspace because of {reason}.",

  "sidebar.commandPalette": "Command palette",
  "sidebar.types": "Document types",
  "sidebar.types.all": "All documents",
  "sidebar.types.untyped": "Untyped",
  "sidebar.recent": "Recent",
  "sidebar.recent.empty": "No recently opened documents.",

  "list.title": "Documents",
  "list.searchPlaceholder": "Search titles or contents",
  "list.loading": "Loading documents",
  "list.empty.title": "No documents to show",
  "list.empty.description": "Open the sample workspace or create a new document to get started.",
  "list.meta.words": "{count} words",
  "list.meta.versions": "{count} versions",
  "list.meta.count": "{count} items",
  "list.group.today": "Today",
  "list.group.thisWeek": "This week",
  "list.group.earlier": "Earlier",
  "list.viewMode": "Document view mode",
  "list.view.list": "List",
  "list.view.tree": "Tree",
  "list.tree.actions": "Tree bulk actions",
  "list.tree.collapseAll": "Collapse all",
  "list.tree.expandAll": "Expand all",
  "explorer.mode.label": "Explorer mode",
  "explorer.mode.documents": "Documents",
  "explorer.mode.files": "Files",
  "files.title": "Files",
  "files.searchPlaceholder": "Search file name or path",
  "files.loading": "Loading files",
  "files.empty.title": "No files to show",
  "files.empty.description": "Change the filter or refresh the workspace.",
  "files.filter.label": "File filter",
  "files.filter.all": "All",
  "files.filter.tracked": "Git tracked",
  "files.filter.binary": "Binary",
  "files.tree.actions": "File tree actions",
  "files.queue": "Add to right Files",
  "files.queueSelected": "Add selected",
  "files.openUnsupported": "This file type cannot be opened in the editor.",
  "files.openUnavailable": "This file is not in the document index.",
  "context.openFile": "Open file",
  "context.revealInFinder": "Reveal in Finder",
  "context.copyPath": "Copy path",
  "context.copyRelativePath": "Copy relative path",

  "editor.empty.title": "Select a document",
  "editor.empty.description":
    "Open a note from the list to view and edit it side-by-side with a preview.",
  "editor.dirty": "Unsaved",
  "editor.saved": "Saved",
  "editor.save": "Save",
  "editor.saving": "Saving",
  "editor.snapshot": "Snapshot",
  "editor.readOnly": "Read-only",
  "editor.tab.edit": "Source",
  "editor.tab.rich": "Rich",
  "editor.tab.source": "Source",
  "editor.tab.preview": "Preview",
  "editor.tabs.label": "Open documents",
  "editor.tabs.close": "Close tab",
  "editor.tabs.closeAll": "Close all saved document tabs",
  "editor.tabs.closeAll.dirtyKept": "Kept {count} unsaved tabs open.",
  "editor.splitRight": "Split right",
  "editor.status.lines": "{count} lines",
  "editor.status.words": "{count} words",
  "editor.status.chars": "{count} chars",

  "outline.title": "Outline",
  "outline.open": "Show outline",
  "outline.close": "Hide outline",
  "outline.empty": "This document has no headings yet.",
  "outline.empty.noDocument": "Open a document to see its outline.",
  "outline.meta.created": "created",
  "outline.meta.updated": "updated",

  "rightPane.title": "Right pane",
  "rightPane.tabs": "Right pane tabs",
  "rightPane.tab.outline": "Outline",
  "rightPane.tab.files": "Files",
  "rightPane.tab.memo": "Memo",
  "rightPane.tab.info": "Info",
  "rightPane.files.pick": "Add files",
  "rightPane.files.copy": "Copy",
  "rightPane.files.move": "Move",
  "rightPane.files.dropTitle": "Temporary file shelf",
  "rightPane.files.dropDescription": "Drop files here or add them with the button.",
  "rightPane.files.queueTitle": "File operation queue",
  "rightPane.files.queueDescription": "Apply files selected in Explorer or dropped here.",
  "rightPane.files.emptyQueue": "No queued file operations.",
  "rightPane.files.destination": "Destination",
  "rightPane.files.chooseDestination": "Choose destination folder",
  "rightPane.files.applyQueue": "Apply",
  "rightPane.files.clearQueue": "Clear",
  "rightPane.files.done": "Done",
  "rightPane.files.store": "Store in .anchor",
  "rightPane.files.saveAs": "Save As",
  "rightPane.memo.new": "New memo",
  "rightPane.memo.refresh": "List",
  "rightPane.memo.list": "Memo list",
  "rightPane.memo.loading": "Loading memos",
  "rightPane.memo.empty": "No saved memos.",
  "rightPane.memo.noPreview": "No preview",
  "rightPane.memo.name": "File name",
  "rightPane.memo.placeholder": "Write memo",
  "rightPane.memo.save": "Store in .anchor",
  "rightPane.memo.saveAs": "Save As",
  "rightPane.memo.delete": "Delete",
  "rightPane.memo.deleteConfirm": "Delete this memo?",
  "rightPane.memo.autoSaveIdle": "Auto save",
  "rightPane.memo.autoSaving": "Saving",
  "rightPane.memo.autoSaved": "Saved",
  "rightPane.memo.autoSaveError": "Save failed",

  "inspector.title": "Frontmatter",
  "inspector.empty": "—",

  "wikilink.notFound": "Not in workspace: [[{target}]]",

  "neighborhood.title": "Neighborhood",
  "neighborhood.upward": "Project / up",
  "neighborhood.mentions": "Mentions",
  "neighborhood.peers": "Same type",

  "inbox.title": "Today's inbox",
  "inbox.subtitle.combined": "{files} files · {gmail} mails pending",
  "inbox.refresh": "Refresh inbox",
  "inbox.loading": "Loading file inbox",
  "inbox.empty.title": "No file items",
  "inbox.empty.description": "Files under inbox/downloads will appear here.",
  "inbox.section.files": "Files",
  "inbox.section.gmail": "Gmail",
  "inbox.gmail.loading": "Syncing Gmail",
  "inbox.gmail.empty.title": "No unread mail",
  "inbox.gmail.empty.description": "Unread Gmail surfaces here once gws CLI syncs.",
  "inbox.gmail.noSubject": "(no subject)",
  "inbox.accept": "Accept",
  "inbox.reject": "Reject",
  "inbox.classify": "Classify",
  "inbox.notClassified": "Not classified yet.",
  "inbox.decision.pending": "Pending",
  "inbox.decision.accepted": "Accepted",
  "inbox.decision.rejected": "Rejected",
  "inbox.filter.all": "All",
  "inbox.filter.label": "Source filter",
  "inbox.settings.open": "Inbox settings",
  "inbox.settings.title": "Inbox settings",
  "inbox.settings.description": "Set the inbox root, recognized sources, and the gws CLI path for this workspace.",
  "inbox.settings.root.label": "Inbox root (workspace-relative)",
  "inbox.settings.root.placeholder": "e.g. inbox/downloads",
  "inbox.settings.sources.label": "Source folders (comma separated)",
  "inbox.settings.sources.placeholder": "e.g. outlook, sharepoint, gmail",
  "inbox.settings.sources.hint": "Leave empty to accept every subfolder.",
  "inbox.settings.gws.label": "gws CLI absolute path (optional)",
  "inbox.settings.gws.placeholder": "e.g. /opt/homebrew/bin/gws",
  "inbox.settings.gws.hint": "Leave empty to auto-discover via PATH and common install locations (/opt/homebrew/bin, ~/go/bin).",
  "inbox.settings.save": "Save",
  "inbox.settings.cancel": "Cancel",

  "commit.title": "Commit changes",
  "commit.summary": "{staged} staged · {modified} modified · {untracked} new ({total} total)",
  "commit.selected": "{selected}/{total} files selected",
  "commit.file.include": "Include {path} in commit",
  "commit.message.label": "Commit message",
  "commit.message.placeholder": "e.g. feat(meeting): add weekly notes for week 4",
  "commit.submit": "Commit",
  "commit.submitting": "Committing…",
  "commit.error.emptyMessage": "Message is required.",
  "commit.error.emptySelection": "Select at least one file to commit.",
  "dialog.cancel": "Cancel",
  "dialog.close": "Close",

  "cmdk.placeholder": "Search documents or commands…",
  "cmdk.empty": "No results.",
  "cmdk.openHint": "⌘K opens the command palette",
  "cmdk.section.commands": "Commands",
  "cmdk.section.documents": "Documents",
  "cmdk.action.newDocument": "Create new document",
  "cmdk.action.save": "Save current document",
  "cmdk.action.snapshot": "Create version snapshot",
  "cmdk.action.splitRight": "Split right",
  "cmdk.action.closeAllTabs": "Close all saved document tabs",
  "cmdk.action.togglePreview": "Toggle preview",
  "cmdk.action.toggleOutline": "Toggle outline panel",
  "cmdk.action.toggleLocale": "Switch ko / en",
  "cmdk.action.refresh": "Reload workspace",
  "cmdk.action.openInbox": "Open inbox",
  "cmdk.action.openDocs": "Open docs",
  "cmdk.action.openSettings": "Open settings",
  "cmdk.action.checkUpdates": "Check for updates",
  "cmdk.action.addWorkspace": "Add workspace",

  "newDoc.button": "New document",
  "newDoc.dialog.title": "New Anchor document",
  "newDoc.dialog.description":
    "Creates a markdown file at the workspace root with standard frontmatter (type, status, created_at, updated_at, id).",
  "newDoc.field.title": "Title",
  "newDoc.field.title.placeholder": "e.g. 2026 Q2 ops review",
  "newDoc.field.type": "Type",
  "newDoc.field.type.placeholder": "e.g. meeting, project, reference",
  "newDoc.field.path": "File path",
  "newDoc.field.path.placeholder": "e.g. meetings/weekly review",
  "newDoc.field.path.helper": "Leave blank to generate a filename from the title. .md is optional.",
  "newDoc.field.body": "Initial body",
  "newDoc.field.body.helper": "Leave empty to create a title-only document.",
  "newDoc.cancel": "Cancel",
  "newDoc.create": "Create",
  "newDoc.creating": "Creating",
  "newDoc.error.title": "Title is required.",
  "newDoc.error.type": "Type is required.",

  "snapshot.summary": "User-requested editing snapshot",
  "snapshot.success": "Snapshot saved: {path}",

  "toast.discardedEdit": "Unsaved edits to {title} have been stashed.",
  "toast.restore": "Restore",
  "updates.checking": "Checking for updates…",
  "updates.available": "Version {version} is available.",
  "updates.none": "No updates available.",
  "updates.downloading": "Downloading/installing update: {progress}",
  "updates.ready": "Update installed. Relaunching Anchor.",
  "updates.install": "Install & restart",
  "updates.error": "Update failed: {message}",
  "updates.desktopOnly": "Update checks are only available in the desktop app.",

  "footer.tagline": "Local-first · files-as-truth · ko/en",

  // === Workspace registration ===
  "workspace.detected": "Workspace config detected",
  "workspace.owner": "Owner",
  "workspace.detect.hint":
    "Found workspace.config.yaml. Anchor will register the private workspace and optional public workspace in one step.",
  "workspace.detect.register": "Register workspace",
  "workspace.detect.useStandalone": "Register as single folder",

  // === System mode ===
  "system.title": "System",
  "system.subtitle": ".anchor operational data (rules, templates, MCP, projects, skills)",
  "system.empty": "No private workspace is available for settings storage.",
  "system.tab.rules": "Rules",
  "system.tab.templates": "Templates",
  "system.tab.preferences": "Preferences",
  "system.tab.ai": "AI",
  "system.tab.terminal": "Terminal",
  "system.tab.inboxChannels": "Inbox Channels",
  "system.tab.connectors": "Connectors",
  "system.tab.mcp": "MCP",
  "system.tab.projects": "Projects",
  "system.tab.skills": "Skills",
  "system.tab.import": "Import",
  "system.rules.empty":
    "No rules yet. Import _sys/rules from the Import tab or create a new one.",
  "system.rules.new": "New rule",
  "system.rules.delete": "Delete",
  "system.rules.delete.confirm": "Delete this rule from .anchor?",
  "system.rules.save": "Save",
  "system.rules.saved": "Saved",
  "system.rules.dirty": "Unsaved",
  "system.templates.empty": "No templates yet.",
  "system.templates.new": "New template",
  "system.mcp.empty": ".anchor/mcp.json is empty.",
  "system.mcp.invalidJson": "Invalid JSON.",
  "system.mcp.save": "Save",
  "system.projects.empty":
    ".anchor/projects.json is empty. Import project-registry.yaml from the Import tab.",
  "system.skills.empty":
    "Skills catalog is empty. Import _sys/skills from the Import tab.",
  "system.skills.runtime": "Runtime",
  "system.skills.source": "Source",
  "system.skills.category": "Category",
  "system.preferences.explorerPane": "Default Explorer mode",
  "system.preferences.documentBrowser": "Default document browser view",
  "system.preferences.documentLabel": "Document name display",
  "system.preferences.documentLabel.title": "Document title",
  "system.preferences.documentLabel.filename": "File name",
  "system.preferences.filesFilter": "Default file filter",
  "system.preferences.binaryIncludePatterns": "Binary include patterns",
  "system.preferences.binaryIncludePatterns.help":
    "Files shown by the Binary filter. Enter one case-insensitive pattern per line.",
  "system.preferences.fileQueueOperation": "Default file queue operation",
  "system.preferences.terminalDefaultOpen": "Open terminal panel by default",
  "system.preferences.themeMode": "Theme",
  "system.preferences.theme.system": "System",
  "system.preferences.theme.light": "Light",
  "system.preferences.theme.dark": "Dark",
  "system.preferences.accentColor": "Accent color",
  "system.preferences.terminalAutoLaunch": "Terminal auto-launch",
  "system.preferences.terminalAutoLaunch.none": "Do not auto-launch",
  "system.ai.title": "AI settings",
  "system.terminal.title": "Terminal launcher settings",
  "system.inboxChannels.title": "Inbox channel settings",
  "system.connectors.title": "Connector settings",
  "system.import.title": "Import from _sys/",
  "system.import.subtitle":
    "Copy from your _sys/ tree into anchor's .anchor/. Re-importing compares sha256 to surface changes.",
  "system.import.empty": "No _sys/ directory in this work folder. Nothing to import.",
  "system.import.section.rules": "Rules",
  "system.import.section.templates": "Templates",
  "system.import.section.mcp": "MCP",
  "system.import.section.projects": "Projects",
  "system.import.section.skills": "Skills",
  "system.import.status.new": "new",
  "system.import.status.update": "update",
  "system.import.status.unchanged": "unchanged",
  "system.import.selectAll": "Select all",
  "system.import.selectChanges": "Changed only",
  "system.import.apply": "Import selected",
  "system.import.applying": "Importing…",
  "system.import.applied": "Imported {count} items",

  // === Sidebar Projects ===
  "sidebar.projects": "Projects",
  "sidebar.projects.empty":
    "No projects. Import project-registry.yaml from the Import tab.",
  "sidebar.projects.all": "All",

  // === Integrated terminal ===
  "terminal.title": "Terminal",
  "terminal.launchers": "Terminal launchers",
  "terminal.launcher.claude": "Claude",
  "terminal.launcher.codex": "Codex",
  "terminal.launcher.shell": "Shell",
  "terminal.tabs": "Terminal tabs",
  "terminal.tab.close": "Close tab",
  "terminal.maximize": "Maximize terminal",
  "terminal.restore": "Restore terminal",
  "terminal.empty": "No terminals",
  "terminal.empty.detail": "Start a terminal with the Claude, Codex, or Shell button.",
  "terminal.cwd.none": "No working folder",
  "terminal.tauriRequired": "Integrated terminal is only available in the Tauri app.",
};

const dictionaries: Record<Locale, Record<string, string>> = { ko, en };

/** Translate `key` for the given locale, with optional `{var}` interpolation.
 *  Returns the key itself if missing — useful as a development signal that a
 *  translation has not been authored yet. */
export function t(
  locale: Locale,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const dict = dictionaries[locale] ?? dictionaries.en;
  let template = dict[key];
  if (template === undefined) {
    // eslint-disable-next-line no-console
    console.warn(`[i18n] missing key "${key}" for locale "${locale}"`);
    return key;
  }
  for (const [name, value] of Object.entries(vars)) {
    template = template.replace(new RegExp(`\\{${name}\\}`, "g"), String(value));
  }
  return template;
}

/** Detect missing keys at module load — fail loudly if ko/en drift. */
export function assertParityOrThrow(): void {
  const koKeys = new Set(Object.keys(ko));
  const enKeys = new Set(Object.keys(en));
  const missingInEn = [...koKeys].filter((k) => !enKeys.has(k));
  const missingInKo = [...enKeys].filter((k) => !koKeys.has(k));
  if (missingInEn.length > 0 || missingInKo.length > 0) {
    throw new Error(
      `[i18n] locale parity broken — missing in en: ${missingInEn.join(", ")}; missing in ko: ${missingInKo.join(", ")}`,
    );
  }
}

export function assertNoLegacyVaultWording(): void {
  const offenders: string[] = [];
  for (const [locale, dict] of Object.entries(dictionaries)) {
    for (const [key, value] of Object.entries(dict)) {
      if (/\bvault\b/i.test(value) || value.includes("볼트")) {
        offenders.push(`${locale}.${key}`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`[i18n] legacy vault wording remains in: ${offenders.join(", ")}`);
  }
}

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

export const LocaleContext = createContext<LocaleContextValue | null>(null);

function detectInitialLocale(): Locale {
  if (typeof window === "undefined") return "ko";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "ko" || stored === "en") return stored;
  const browser = window.navigator.language.toLowerCase();
  if (browser.startsWith("ko")) return "ko";
  // Fall back to ko since the primary user is Korean — env detection
  // will still respect explicit en preference once the user toggles.
  return "ko";
}

export function useLocaleState() {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale === "ko" ? "ko-KR" : "en-US";
  }, [locale]);
  const setLocale = useCallback((next: Locale) => setLocaleState(next), []);
  const translate = useCallback(
    (key: string, vars?: Record<string, string | number>) => t(locale, key, vars),
    [locale],
  );
  return useMemo(
    () => ({ locale, setLocale, t: translate }),
    [locale, setLocale, translate],
  );
}

export function useTranslation(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useTranslation must be used inside <LocaleContext.Provider>");
  }
  return ctx;
}
