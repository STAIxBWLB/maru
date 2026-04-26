use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDraft {
    pub provider: String,
    pub mode: String,
    pub summary: String,
    pub content: String,
}

#[tauri::command]
pub fn generate_ai_draft(
    mode: String,
    instruction: String,
    content: String,
) -> Result<AiDraft, String> {
    let mode = normalize_mode(&mode);
    let instruction = instruction.trim();
    if instruction.is_empty() {
        return Err("Instruction is required".to_string());
    }
    let clean = strip_frontmatter(&content);
    let title = first_heading(&clean).unwrap_or_else(|| "Anchor 문서".to_string());
    let body = match mode.as_str() {
        "minutes" => minutes_draft(&title, instruction, &clean),
        "report" => report_draft(&title, instruction, &clean),
        "kpi" => kpi_draft(&title, instruction, &clean),
        "budget" => budget_draft(&title, instruction, &clean),
        "summary" => summary_draft(&title, instruction, &clean),
        _ => edit_draft(&title, instruction, &clean),
    };
    let now = Utc::now().to_rfc3339();
    let content = format!(
        "---\ntype: Document\nstatus: draft\nsource: anchor-local-draft\nupdated_at: {now}\n---\n{body}"
    );

    Ok(AiDraft {
        provider: "local-anchor-draft".to_string(),
        mode,
        summary: format!("'{instruction}' 요청을 기준으로 로컬 초안을 생성함"),
        content,
    })
}

fn normalize_mode(mode: &str) -> String {
    match mode {
        "minutes" | "report" | "kpi" | "budget" | "summary" => mode.to_string(),
        _ => "edit".to_string(),
    }
}

fn strip_frontmatter(content: &str) -> String {
    if !content.starts_with("---\n") {
        return content.to_string();
    }
    let Some(end) = content[4..].find("\n---") else {
        return content.to_string();
    };
    content[(end + 8)..].trim_start().to_string()
}

fn first_heading(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        line.strip_prefix("# ")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

fn excerpt(content: &str) -> String {
    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("\n")
}

fn edit_draft(title: &str, instruction: &str, content: &str) -> String {
    format!(
        "# {title}\n\n## 수정 방향\n○ 요청사항: {instruction}\n- 제주한라대학교와 RISE Project 표기를 유지함\n- 개조식 문체와 실행 과제 중심으로 재정리함\n- 원문 맥락은 보존하고 중복 표현은 축약함\n\n## 재작성 초안\n{}\n\n## 검토 체크\n- 고유명사 표기 확인\n- 담당 부서와 일정 보강\n- 예산/성과 수치 근거 확인\n",
        excerpt(content)
    )
}

fn summary_draft(title: &str, instruction: &str, content: &str) -> String {
    format!(
        "# {title} 요약\n\n## 핵심 요약\n○ {instruction}\n- 사업 목표와 추진 체계를 한 문단으로 압축\n- 실행 일정, 담당 주체, 산출물을 분리해 확인 가능하도록 정리\n- 후속 검토가 필요한 수치와 고유명사를 별도 표시\n\n## 근거 발췌\n{}\n",
        excerpt(content)
    )
}

fn report_draft(title: &str, instruction: &str, content: &str) -> String {
    format!(
        "# {title} 보고서\n\n## 추진 개요\n○ 작성 기준: {instruction}\n- 사업명: RISE Project / Anchor Project\n- 기관명: 제주한라대학교(Cheju Halla University)\n- 작성 형식: 개조식 보고서\n\n## 주요 추진 실적\n○ 실행 내용\n- 핵심 과업을 본부별로 분리 정리\n- 산출물, 일정, 담당자를 확인 가능한 표현으로 보강\n\n## 향후 계획\n○ 다음 조치\n- 미확정 일정과 수치 검증\n- 운영위원회 보고용 표준 표현 정리\n\n## 참고 원문\n{}\n",
        excerpt(content)
    )
}

fn minutes_draft(title: &str, instruction: &str, content: &str) -> String {
    format!(
        "# {title} 회의록\n\n| 항목 | 내용 |\n|---|---|\n| 일시 | YYYY. MM. DD. HH:MM |\n| 장소 | 미정 |\n| 주관 | Anchor Project |\n| 참석자 | 확인 필요 |\n| 작성 기준 | {instruction} |\n\n## 안건\n1. 추진 현황 공유\n2. 쟁점 및 후속 조치 확인\n\n## 논의 내용\n○ 주요 논의\n- 원문 근거를 기반으로 결정 사항과 보류 사항을 분리함\n\n## 결정사항\n| 번호 | 결정 내용 | 비고 |\n|---:|---|---|\n| 1 | 확인 필요 | 담당자 지정 필요 |\n\n## 후속 과제\n| 번호 | 과제 | 담당자 | 기한 | 상태 |\n|---:|---|---|---|---|\n| 1 | 수치와 일정 검증 | 미정 | YYYY. MM. DD. | 진행 중 |\n\n## 참고 원문\n{}\n",
        excerpt(content)
    )
}

fn kpi_draft(title: &str, instruction: &str, content: &str) -> String {
    format!(
        "# {title} KPI 정리\n\n## 정량 지표\n| 코드 | 지표명 | 단위 | 목표 | 현재 | 비고 |\n|---|---|---:|---:|---:|---|\n| Q-11-01 | AI 융합전공 이수 학생 수 | 명 | 300 | 확인 필요 | {instruction} |\n| Q-21-01 | 런케이션 프로그램 참여자 수 | 명 | 500 | 확인 필요 | 근거 보강 |\n\n## 정성 지표\n○ 검토 항목\n- 산업체 연계 품질\n- 외국인 유학생 지원 체계\n- 지역상생 프로그램 지속성\n\n## 참고 원문\n{}\n",
        excerpt(content)
    )
}

fn budget_draft(title: &str, instruction: &str, content: &str) -> String {
    format!(
        "# {title} 예산 검토\n\n## 집행 현황\n| 과목 코드 | 과목명 | 배정액 | 집행액 | 집행률 | 비고 |\n|---:|---|---:|---:|---:|---|\n| 310 | 국내출장비 | 확인 필요 | 확인 필요 | - | {instruction} |\n| 330 | 인쇄·홍보비 | 확인 필요 | 확인 필요 | - | 증빙 확인 |\n\n## 검토 의견\n○ 집행률 기준\n- 2분기 말 목표 집행률 50% 이상\n- 연말 90% 미달 시 차년도 배정 영향 가능\n\n## 참고 원문\n{}\n",
        excerpt(content)
    )
}
