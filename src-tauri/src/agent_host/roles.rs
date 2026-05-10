use serde::{Deserialize, Serialize};

use crate::agent_host::contracts::{
    CompletionRequest, COMPLETION_REQUEST_SCHEMA_VERSION, SKILL_PROPOSAL_SCHEMA_VERSION,
};
use crate::agent_host::proposal::{parse_skill_proposal, SkillProposal};
use crate::agent_host::provider::ProviderAdapter;

pub const LEAD_PROMPT: &str = "You are Anchor lead. Convert user intent into a bounded directive.";
pub const PLANNER_PROMPT: &str =
    "You are Anchor planner. Produce a minimal plan that preserves local-first safety.";
pub const WORKER_PROMPT: &str =
    "You are Anchor worker. Produce proposal-only output using anchor_skill_proposal_v1.";
pub const REVIEWER_PROMPT: &str =
    "You are Anchor reviewer. Return JSON {\"passed\": boolean, \"findings\": string[]}.";
pub const ADVISOR_PROMPT: &str =
    "You are Anchor advisor. Resolve ambiguity and high-risk constraints before planning.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FiveRoleLoopInput {
    pub directive: String,
    pub cwd: String,
    #[serde(default)]
    pub high_risk: bool,
    #[serde(default)]
    pub ambiguous: bool,
    #[serde(default = "default_max_rework")]
    pub max_rework: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FiveRoleLoopResult {
    pub status: String,
    pub iterations: usize,
    #[serde(default)]
    pub advisor_called: bool,
    #[serde(default)]
    pub role_outputs: Vec<RoleOutput>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<SkillProposal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<ReviewResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoleOutput {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewResult {
    pub passed: bool,
    #[serde(default)]
    pub findings: Vec<String>,
}

fn default_max_rework() -> usize {
    1
}

pub fn run_five_role_loop<A: ProviderAdapter>(
    provider: &mut A,
    input: FiveRoleLoopInput,
) -> Result<FiveRoleLoopResult, String> {
    if input.directive.trim().is_empty() {
        return Err("five_role_directive_required".to_string());
    }
    let mut outputs = Vec::new();
    let mut advisor_called = false;
    if input.high_risk || input.ambiguous {
        let advisor = complete_role(
            provider,
            "advisor",
            ADVISOR_PROMPT,
            &input.directive,
            &input.cwd,
        )?;
        advisor_called = true;
        outputs.push(advisor);
    }

    let lead = complete_role(provider, "lead", LEAD_PROMPT, &input.directive, &input.cwd)?;
    let lead_content = lead.content.clone();
    outputs.push(lead);
    let planner = complete_role(
        provider,
        "planner",
        PLANNER_PROMPT,
        &lead_content,
        &input.cwd,
    )?;
    let mut plan_content = planner.content.clone();
    outputs.push(planner);

    let mut iterations = 0;
    loop {
        iterations += 1;
        let worker_prompt = format!(
            "{WORKER_PROMPT}\n\nReturn JSON with schemaVersion \"{SKILL_PROPOSAL_SCHEMA_VERSION}\".\n\nPlan:\n{plan_content}"
        );
        let worker = complete_role(
            provider,
            "worker",
            &worker_prompt,
            &input.directive,
            &input.cwd,
        )?;
        let proposal = parse_skill_proposal(&worker.content)?;
        outputs.push(worker);

        let reviewer_prompt = format!(
            "{REVIEWER_PROMPT}\n\nReview this proposal for safety and completeness:\n{}",
            serde_json::to_string(&proposal).unwrap_or_default()
        );
        let reviewer = complete_role(
            provider,
            "reviewer",
            &reviewer_prompt,
            &input.directive,
            &input.cwd,
        )?;
        let review = parse_review_result(&reviewer.content)?;
        outputs.push(reviewer);
        if review.passed {
            return Ok(FiveRoleLoopResult {
                status: "passed".to_string(),
                iterations,
                advisor_called,
                role_outputs: outputs,
                proposal: Some(proposal),
                review: Some(review),
            });
        }
        if iterations > input.max_rework {
            return Ok(FiveRoleLoopResult {
                status: "failed".to_string(),
                iterations,
                advisor_called,
                role_outputs: outputs,
                proposal: Some(proposal),
                review: Some(review),
            });
        }
        plan_content = format!(
            "Previous plan:\n{plan_content}\n\nReviewer findings:\n{}",
            review.findings.join("\n")
        );
    }
}

fn complete_role<A: ProviderAdapter>(
    provider: &mut A,
    role: &str,
    system_prompt: &str,
    input: &str,
    cwd: &str,
) -> Result<RoleOutput, String> {
    let response = provider.complete(CompletionRequest {
        schema_version: COMPLETION_REQUEST_SCHEMA_VERSION.to_string(),
        provider: provider.id().to_string(),
        prompt: format!("<role>{role}</role>\n{system_prompt}\n\n<input>\n{input}\n</input>"),
        cwd: cwd.to_string(),
        mode: "autonomous-loop".to_string(),
        metadata: Some(serde_json::json!({ "role": role })),
    })?;
    response.validate()?;
    Ok(RoleOutput {
        role: role.to_string(),
        content: response.content,
    })
}

fn parse_review_result(raw: &str) -> Result<ReviewResult, String> {
    let trimmed = raw.trim();
    if let Ok(review) = serde_json::from_str::<ReviewResult>(trimmed) {
        return Ok(review);
    }
    let start = trimmed
        .find('{')
        .ok_or_else(|| "review_result_json_missing".to_string())?;
    let end = trimmed
        .rfind('}')
        .ok_or_else(|| "review_result_json_missing".to_string())?;
    serde_json::from_str(&trimmed[start..=end])
        .map_err(|err| format!("review_result_json_invalid: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_host::provider::MockProviderAdapter;

    fn proposal(summary: &str) -> String {
        format!(
            "{{\"summary\":\"{}\",\"files\":[],\"commands\":[],\"risks\":[],\"requiresApproval\":true,\"schemaVersion\":\"{}\"}}",
            summary, SKILL_PROPOSAL_SCHEMA_VERSION
        )
    }

    #[test]
    fn five_role_loop_allows_one_bounded_rework() {
        let mut provider = MockProviderAdapter::new(vec![
            "lead directive".to_string(),
            "plan".to_string(),
            proposal("first"),
            "{\"passed\":false,\"findings\":[\"missing check\"]}".to_string(),
            proposal("second"),
            "{\"passed\":true,\"findings\":[]}".to_string(),
        ]);
        let result = run_five_role_loop(
            &mut provider,
            FiveRoleLoopInput {
                directive: "do work".to_string(),
                cwd: "/tmp".to_string(),
                high_risk: false,
                ambiguous: false,
                max_rework: 1,
            },
        )
        .unwrap();
        assert_eq!(result.status, "passed");
        assert_eq!(result.iterations, 2);
        assert_eq!(provider.calls(), 6);
    }

    #[test]
    fn five_role_loop_calls_advisor_for_risk() {
        let mut provider = MockProviderAdapter::new(vec![
            "advisor".to_string(),
            "lead directive".to_string(),
            "plan".to_string(),
            proposal("first"),
            "{\"passed\":true,\"findings\":[]}".to_string(),
        ]);
        let result = run_five_role_loop(
            &mut provider,
            FiveRoleLoopInput {
                directive: "do risky work".to_string(),
                cwd: "/tmp".to_string(),
                high_risk: true,
                ambiguous: false,
                max_rework: 1,
            },
        )
        .unwrap();
        assert!(result.advisor_called);
        assert_eq!(result.status, "passed");
    }
}
