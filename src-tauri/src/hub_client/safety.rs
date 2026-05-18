// Hub pre-flight safety check.
// Spec: ~/workspace/work/_sys/rules/hub-sync.md §9

use super::HubSubmitGateRequest;

const FORBIDDEN_KEYS: &[&str] = &[
    "body",
    "content",
    "markdown",
    "html",
    "raw",
    "evidence_blob",
    "binary_payload",
];

const REAL_NAME_PATTERNS: &[&str] = &[
    "RISE", "KOICA", "TIU", "CHU", "제주한라",
];

/// `Ok(())` on safe to send. `Err(reason)` when blocked.
pub fn check_submit_gate(req: &HubSubmitGateRequest) -> Result<(), String> {
    // 1. Forbidden keys in frontmatter_snapshot
    if let Some(obj) = req.frontmatter_snapshot.as_object() {
        for forbidden in FORBIDDEN_KEYS {
            if obj.contains_key(*forbidden) {
                return Err(format!("forbidden_key:{}", forbidden));
            }
        }
    }

    // 2. document_uri 본문 자체가 아니어야 함 (경로만, 1KB 이내)
    if req.document_uri.len() > 1024 {
        return Err("document_uri_too_large".to_string());
    }
    if looks_like_body(&req.document_uri) {
        return Err("document_uri_looks_like_body".to_string());
    }

    // 3. notes 길이 제한 (1KB) + PII 정규식
    if let Some(notes) = &req.notes {
        if notes.len() > 1024 {
            return Err("notes_too_large".to_string());
        }
        if contains_pii(notes) {
            return Err("notes_contains_pii".to_string());
        }
    }

    // 4. evidence_sha256_list 형식 (hex 64자)
    for sha in &req.evidence_sha256_list {
        if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("invalid_sha256:{}", &sha[..sha.len().min(12)]));
        }
    }

    Ok(())
}

fn looks_like_body(s: &str) -> bool {
    // markdown 헤더, HTML 태그, 줄바꿈 다수
    s.contains("\n#") || s.contains("<html") || s.lines().count() > 10
}

fn contains_pii(s: &str) -> bool {
    // 매우 간단한 정규식 — 정확도보다 보수적 차단 우선
    // 이메일
    if s.contains('@') && s.contains('.') {
        return true;
    }
    // 전화번호 (010-xxxx-xxxx)
    if s.contains("010-") || s.contains("010 ") {
        return true;
    }
    // 계좌번호 패턴 (8자리 이상 연속 숫자 + 하이픈)
    let digits_only: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits_only.len() >= 10 {
        return true;
    }
    false
}

/// Public deployment에서 real-name 매칭 검사.
#[allow(dead_code)]
pub fn check_public_safe(s: &str) -> Result<(), String> {
    for pattern in REAL_NAME_PATTERNS {
        if s.contains(pattern) {
            return Err(format!("real_name_in_public:{}", pattern));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> HubSubmitGateRequest {
        HubSubmitGateRequest {
            workspace_root: "/tmp".to_string(),
            program_id: "prg_01HZ8FX9TESTPROGRAM00000001".to_string(),
            business_unit_id: "bu_01HZ8FX9TESTBU0000000000001".to_string(),
            document_uri: "projects/x/doc.md".to_string(),
            document_type: "change-request".to_string(),
            document_sha256: "a".repeat(64),
            submission_kind: "external-dispatch".to_string(),
            target_org: "Demo Org".to_string(),
            deadline: None,
            evidence_sha256_list: vec![],
            frontmatter_snapshot: serde_json::json!({"title": "X"}),
            notes: None,
        }
    }

    #[test]
    fn ok_baseline() {
        assert!(check_submit_gate(&req()).is_ok());
    }

    #[test]
    fn block_body_key() {
        let mut r = req();
        r.frontmatter_snapshot = serde_json::json!({"title": "X", "body": "..."});
        assert!(check_submit_gate(&r).is_err());
    }

    #[test]
    fn block_email_in_notes() {
        let mut r = req();
        r.notes = Some("contact me at user@example.com".to_string());
        assert!(check_submit_gate(&r).is_err());
    }

    #[test]
    fn block_phone_in_notes() {
        let mut r = req();
        r.notes = Some("call 010-1234-5678".to_string());
        assert!(check_submit_gate(&r).is_err());
    }

    #[test]
    fn block_invalid_sha() {
        let mut r = req();
        r.evidence_sha256_list = vec!["not_hex".to_string()];
        assert!(check_submit_gate(&r).is_err());
    }
}
