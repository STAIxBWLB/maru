//! Per-run usage receipts (maru#431).
//!
//! A [`UsageReceipt`] is one provider call's normalized usage, recorded as a
//! `usage.recorded` run event and keyed by `receiptId`. The read model in
//! [`summarize_usage`] deduplicates by `receiptId`, so replaying the same
//! receipt (a duplicated log line, a re-append after restart) is counted once.
//!
//! Only the Claude CLI yields a parsed receipt, from its machine-readable
//! result object: printed once for `--output-format json` (the synchronous
//! adapter) or as the terminal event of `--output-format stream-json` (the
//! background dispatcher). Every other provider, and any Claude output that
//! does not match the expected shape, records `pricingStatus: "unavailable"`
//! with no counters, never a fabricated zero.
//!
//! A receipt carries counters, model ids and money only. It never stores
//! prompts, response content, environment, credential paths or tokens.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashSet;
use uuid::Uuid;

use crate::agent_host::contracts::AgentRunEvent;

pub const USAGE_RECEIPT_SCHEMA_VERSION: &str = "maru_usage_receipt_v1";
pub const USAGE_RECORDED_EVENT: &str = "usage.recorded";
/// Receipts that could not be persisted; payload `{"pending": n}` only.
pub const USAGE_INCOMPLETE_EVENT: &str = "usage.incomplete";
/// Source parser version for the Claude CLI's JSON result object, which both
/// output modes carry (`json`, and the terminal event of `stream-json`).
pub const CLAUDE_JSON_SOURCE: &str = "claude-cli-json-v1";

/// How the money on a receipt is to be read. Each state stays distinct:
/// a missing price is never shown as zero and an estimate never counts as
/// billed spend.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PricingStatus {
    /// The provider reported an actual billed amount.
    Billed,
    /// The provider explicitly reported zero cost.
    Zero,
    /// Covered by a subscription; no per-run charge.
    SubscriptionIncluded,
    /// Advisory estimate (e.g. list price); excluded from confirmed totals.
    Estimate,
    /// Usage was reported but no price.
    Unpriced,
    /// No machine-readable usage for this provider or output shape.
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_read: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageReceipt {
    pub schema_version: String,
    pub receipt_id: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    pub source: String,
    pub pricing_status: PricingStatus,
    #[serde(default)]
    pub tokens: UsageTokens,
    /// Confirmed amount in millionths of `currency`; set only for `billed`/`zero`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billed_micros: Option<i64>,
    /// Advisory amount in millionths of `currency`; set only for `estimate`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate_micros: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    /// `ok` or `failed`: failed calls keep their usage.
    pub outcome: String,
}

impl UsageReceipt {
    /// Amount fields must match the pricing status. A receipt that claims a
    /// price without amount and currency is not trusted as priced.
    pub fn amounts_consistent(&self) -> bool {
        let currency = self.currency.as_deref() == Some("USD");
        match self.pricing_status {
            PricingStatus::Billed => {
                currency
                    && self.billed_micros.is_some_and(|m| m > 0)
                    && self.estimate_micros.is_none()
            }
            PricingStatus::Zero => {
                currency && self.billed_micros == Some(0) && self.estimate_micros.is_none()
            }
            PricingStatus::Estimate => {
                currency
                    && self.estimate_micros.is_some_and(|m| m >= 0)
                    && self.billed_micros.is_none()
            }
            _ => self.billed_micros.is_none() && self.estimate_micros.is_none(),
        }
    }

    pub fn unavailable(provider: &str, outcome: &str) -> Self {
        Self {
            schema_version: USAGE_RECEIPT_SCHEMA_VERSION.to_string(),
            receipt_id: new_receipt_id(),
            provider: provider.to_string(),
            models: Vec::new(),
            source: "none".to_string(),
            pricing_status: PricingStatus::Unavailable,
            tokens: UsageTokens::default(),
            billed_micros: None,
            estimate_micros: None,
            currency: None,
            outcome: outcome.to_string(),
        }
    }
}

fn new_receipt_id() -> String {
    format!("usage-{}", Uuid::new_v4())
}

fn usd_to_micros(value: f64) -> Option<i64> {
    if !value.is_finite() || value < 0.0 || value > 1.0e9 {
        return None;
    }
    Some((value * 1_000_000.0).round() as i64)
}

/// Parse the Claude CLI's JSON result object: all of stdout under
/// `--output-format json`, the last line under `--output-format stream-json`.
///
/// Returns `None` when the input is not that shape (older CLI, a wrapper
/// script, schema drift). The caller then keeps raw stdout as content and
/// records an `unavailable` receipt.
pub fn parse_claude_json_result(stdout: &str, outcome: &str) -> Option<(String, UsageReceipt)> {
    let value: JsonValue = serde_json::from_str(stdout.trim()).ok()?;
    let object = value.as_object()?;
    if object.get("type").and_then(JsonValue::as_str) != Some("result") {
        return None;
    }
    // Error variants (error_max_turns, error_during_execution) carry usage but
    // no `result`: keep their usage and fall back to raw stdout as content.
    let content = object
        .get("result")
        .and_then(JsonValue::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| stdout.to_string());
    let usage = object.get("usage").and_then(JsonValue::as_object);
    let model_usage = object.get("modelUsage").and_then(JsonValue::as_object);
    // Top-level `usage` covers the main loop only; `modelUsage` also counts
    // subagents and compaction. Per field: sum when every model entry
    // reports it, top-level when none does, unknown when only some do.
    let count = |usage_key: &str, model_key: &str| {
        let per_model: Vec<Option<u64>> = model_usage
            .map(|m| {
                m.values()
                    .map(|v| v.get(model_key).and_then(JsonValue::as_u64))
                    .collect()
            })
            .unwrap_or_default();
        if per_model.iter().all(Option::is_none) {
            // No model entry has it (or no modelUsage): top-level usage.
            usage
                .and_then(|u| u.get(usage_key))
                .and_then(JsonValue::as_u64)
        } else {
            // Every entry must report it; a partial set is unknown, not a total.
            per_model
                .into_iter()
                .try_fold(0u64, |acc, value| acc.checked_add(value?))
        }
    };
    let tokens = UsageTokens {
        input: count("input_tokens", "inputTokens"),
        cached_read: count("cache_read_input_tokens", "cacheReadInputTokens"),
        cache_write: count("cache_creation_input_tokens", "cacheCreationInputTokens"),
        output: count("output_tokens", "outputTokens"),
    };
    let has_counters = tokens
        .input
        .or(tokens.cached_read)
        .or(tokens.cache_write)
        .or(tokens.output)
        .is_some();
    let mut models: Vec<String> = model_usage
        .map(|m| {
            m.keys()
                .take(8)
                .map(|k| k.chars().take(80).collect())
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    // Confirmed classes need every model entry to state the same basis; a
    // missing or mixed basis is not verified spend.
    let bases: Vec<Option<&str>> = model_usage
        .map(|m| {
            m.values()
                .map(|v| v.get("costBasis").and_then(JsonValue::as_str))
                .collect()
        })
        .unwrap_or_default();
    let basis = match bases.first() {
        Some(Some(first)) if bases.iter().all(|b| *b == Some(*first)) => Some(*first),
        _ => None,
    };
    let cost = object
        .get("total_cost_usd")
        .and_then(JsonValue::as_f64)
        .and_then(usd_to_micros);
    let (pricing_status, billed_micros, estimate_micros) = match (cost, basis) {
        (_, Some("subscription" | "included")) => (PricingStatus::SubscriptionIncluded, None, None),
        (Some(0), Some("billed" | "actual")) => (PricingStatus::Zero, Some(0), None),
        (Some(micros), Some("billed" | "actual")) => (PricingStatus::Billed, Some(micros), None),
        // `list` (and any unknown basis) is the CLI's own price computation, not
        // an invoice: advisory only.
        (Some(micros), _) => (PricingStatus::Estimate, None, Some(micros)),
        (None, _) if has_counters => (PricingStatus::Unpriced, None, None),
        (None, _) => (PricingStatus::Unavailable, None, None),
    };
    let currency =
        (billed_micros.is_some() || estimate_micros.is_some()).then(|| "USD".to_string());
    Some((
        content,
        UsageReceipt {
            schema_version: USAGE_RECEIPT_SCHEMA_VERSION.to_string(),
            receipt_id: new_receipt_id(),
            provider: "claude".to_string(),
            models,
            source: CLAUDE_JSON_SOURCE.to_string(),
            pricing_status,
            tokens,
            billed_micros,
            estimate_micros,
            currency,
            outcome: outcome.to_string(),
        },
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunUsageSummary {
    pub receipt_count: usize,
    pub priced_count: usize,
    pub unpriced_count: usize,
    pub estimate_count: usize,
    pub subscription_included_count: usize,
    pub unavailable_count: usize,
    pub failed_count: usize,
    pub input_tokens: u64,
    pub cached_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    /// Receipts that reported each counter. 0 means that counter is unknown,
    /// not a measured zero.
    pub input_counted: usize,
    pub cached_read_counted: usize,
    pub cache_write_counted: usize,
    pub output_counted: usize,
    /// Sum of `billed`/`zero` receipts only, in USD millionths.
    pub confirmed_micros: i64,
    /// Sum of advisory estimates, never mixed into `confirmed_micros`.
    pub estimate_micros: i64,
    /// Receipts the run could not persist (`usage.incomplete` events); when
    /// above 0 the totals are known to be incomplete.
    pub pending_count: u64,
}

/// Recompute the run's usage from its event log. Receipts are deduplicated by
/// `receiptId`; malformed or unknown-schema payloads count as unavailable.
pub fn summarize_usage(events: &[AgentRunEvent]) -> RunUsageSummary {
    let mut seen = HashSet::new();
    let mut summary = RunUsageSummary::default();
    for event in events
        .iter()
        .filter(|e| e.event_type == USAGE_RECORDED_EVENT)
    {
        let receipt = event
            .payload
            .get("receipt")
            .cloned()
            .and_then(|value| serde_json::from_value::<UsageReceipt>(value).ok())
            .filter(|r| r.schema_version == USAGE_RECEIPT_SCHEMA_VERSION && r.amounts_consistent());
        let Some(receipt) = receipt else {
            // Dedupe drifted payloads by event id so a replayed line is still one.
            if seen.insert(format!("event:{}", event.id)) {
                summary.receipt_count += 1;
                summary.unavailable_count += 1;
            }
            continue;
        };
        if !seen.insert(receipt.receipt_id.clone()) {
            continue;
        }
        let t = &receipt.tokens;
        let add = |total: u64, value: Option<u64>| total.checked_add(value.unwrap_or(0));
        let money = |total: i64, value: Option<i64>| total.checked_add(value.unwrap_or(0));
        let (confirmed, estimate) = match receipt.pricing_status {
            PricingStatus::Billed | PricingStatus::Zero => (
                money(summary.confirmed_micros, receipt.billed_micros),
                Some(summary.estimate_micros),
            ),
            PricingStatus::Estimate => (
                Some(summary.confirmed_micros),
                money(summary.estimate_micros, receipt.estimate_micros),
            ),
            _ => (
                Some(summary.confirmed_micros),
                Some(summary.estimate_micros),
            ),
        };
        let sums = (
            add(summary.input_tokens, t.input),
            add(summary.cached_read_tokens, t.cached_read),
            add(summary.cache_write_tokens, t.cache_write),
            add(summary.output_tokens, t.output),
            confirmed,
            estimate,
        );
        // A receipt that would overflow any total is not trusted: count it as
        // unavailable and leave every total unchanged.
        let (Some(input), Some(cached), Some(write), Some(output), Some(confirmed), Some(estimate)) =
            sums
        else {
            summary.receipt_count += 1;
            summary.unavailable_count += 1;
            continue;
        };
        summary.receipt_count += 1;
        if receipt.outcome != "ok" {
            summary.failed_count += 1;
        }
        summary.input_counted += usize::from(t.input.is_some());
        summary.cached_read_counted += usize::from(t.cached_read.is_some());
        summary.cache_write_counted += usize::from(t.cache_write.is_some());
        summary.output_counted += usize::from(t.output.is_some());
        summary.input_tokens = input;
        summary.cached_read_tokens = cached;
        summary.cache_write_tokens = write;
        summary.output_tokens = output;
        summary.confirmed_micros = confirmed;
        summary.estimate_micros = estimate;
        match receipt.pricing_status {
            PricingStatus::Billed | PricingStatus::Zero => summary.priced_count += 1,
            PricingStatus::SubscriptionIncluded => summary.subscription_included_count += 1,
            PricingStatus::Estimate => summary.estimate_count += 1,
            PricingStatus::Unpriced => summary.unpriced_count += 1,
            PricingStatus::Unavailable => summary.unavailable_count += 1,
        }
    }
    for event in events
        .iter()
        .filter(|e| e.event_type == USAGE_INCOMPLETE_EVENT)
    {
        if seen.insert(format!("event:{}", event.id)) {
            let pending = event.payload.get("pending").and_then(JsonValue::as_u64);
            summary.pending_count = summary.pending_count.saturating_add(pending.unwrap_or(1));
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_host::contracts::new_run_event;
    use serde_json::json;

    /// Captured from `claude -p ... --output-format json` (Claude Code CLI,
    /// 2026-11-08), trimmed to the fields Maru reads plus some it must ignore.
    /// Session id, uuid and credential expiry are replaced.
    const CLAUDE_FIXTURE: &str = r#"{"type":"result","subtype":"success","is_error":false,"result":"FIXTURE-ANSWER-7f3a","stop_reason":"end_turn","session_id":"00000000-0000-0000-0000-000000000000","total_cost_usd":0.4407342,"usage":{"input_tokens":2,"cache_creation_input_tokens":54611,"cache_read_input_tokens":11491,"output_tokens":77,"service_tier":"standard"},"modelUsage":{"claude-opus-5-5":{"inputTokens":2,"outputTokens":77,"cacheReadInputTokens":11491,"cacheCreationInputTokens":54611,"costUSD":0.4407342,"provider":"firstParty","costBasis":"list"}},"credential_expires_at":"2000-01-01T00:00:00Z"}"#;

    fn with_cost(cost: JsonValue, basis: &str) -> String {
        let mut v: JsonValue = serde_json::from_str(CLAUDE_FIXTURE).unwrap();
        match cost {
            JsonValue::Null => {
                v.as_object_mut().unwrap().remove("total_cost_usd");
            }
            other => v["total_cost_usd"] = other,
        }
        v["modelUsage"]["claude-opus-5-5"]["costBasis"] = json!(basis);
        v.to_string()
    }

    fn event(receipt: &UsageReceipt) -> AgentRunEvent {
        new_run_event(
            "run-1",
            USAGE_RECORDED_EVENT,
            "claude",
            json!({ "receipt": receipt }),
            None,
        )
    }

    #[test]
    fn claude_fixture_parses_content_and_distinct_counters() {
        let (content, r) = parse_claude_json_result(CLAUDE_FIXTURE, "ok").unwrap();
        assert_eq!(content, "FIXTURE-ANSWER-7f3a");
        assert_eq!(r.tokens.input, Some(2));
        assert_eq!(r.tokens.cached_read, Some(11491));
        assert_eq!(r.tokens.cache_write, Some(54611));
        assert_eq!(r.tokens.output, Some(77));
        assert_eq!(r.models, vec!["claude-opus-5-5"]);
        // List-price cost is advisory, never billed.
        assert_eq!(r.pricing_status, PricingStatus::Estimate);
        assert_eq!(r.estimate_micros, Some(440_734));
        assert_eq!(r.billed_micros, None);
    }

    #[test]
    fn ac1_missing_zero_and_included_stay_distinct() {
        let missing = parse_claude_json_result(&with_cost(JsonValue::Null, "list"), "ok")
            .unwrap()
            .1;
        let zero = parse_claude_json_result(&with_cost(json!(0), "billed"), "ok")
            .unwrap()
            .1;
        // A list-price computation of 0 is still an estimate, not confirmed zero.
        let list_zero = parse_claude_json_result(&with_cost(json!(0), "list"), "ok")
            .unwrap()
            .1;
        assert_eq!(list_zero.pricing_status, PricingStatus::Estimate);
        assert_eq!(list_zero.estimate_micros, Some(0));
        let included = parse_claude_json_result(&with_cost(json!(0.2), "subscription"), "ok")
            .unwrap()
            .1;
        let billed = parse_claude_json_result(&with_cost(json!(0.25), "billed"), "ok")
            .unwrap()
            .1;
        assert_eq!(missing.pricing_status, PricingStatus::Unpriced);
        assert_eq!(zero.pricing_status, PricingStatus::Zero);
        assert_eq!(zero.billed_micros, Some(0));
        assert_eq!(included.pricing_status, PricingStatus::SubscriptionIncluded);
        assert_eq!(billed.pricing_status, PricingStatus::Billed);
        assert_eq!(billed.billed_micros, Some(250_000));
    }

    #[test]
    fn ac2_replayed_receipt_counted_once_including_after_restart() {
        let r = parse_claude_json_result(&with_cost(json!(0.25), "billed"), "ok")
            .unwrap()
            .1;
        let line = serde_json::to_string(&event(&r)).unwrap();
        // "Restart": reparse the persisted line twice, as a re-append would.
        let replayed: Vec<AgentRunEvent> = (0..3)
            .map(|_| serde_json::from_str(&line).unwrap())
            .collect();
        let s = summarize_usage(&replayed);
        assert_eq!(s.receipt_count, 1);
        assert_eq!(s.confirmed_micros, 250_000);
        let mut drift = new_run_event(
            "run-1",
            USAGE_RECORDED_EVENT,
            "x",
            json!({"receipt": {"v": 9}}),
            None,
        );
        drift.id = "event-fixed".into();
        let s = summarize_usage(&[drift.clone(), drift]);
        assert_eq!((s.receipt_count, s.unavailable_count), (1, 1));
    }

    #[test]
    fn ac1_missing_or_mixed_model_basis_is_not_confirmed() {
        let base: JsonValue = serde_json::from_str(CLAUDE_FIXTURE).unwrap();
        let with_models = |models: JsonValue, cost: JsonValue| {
            let mut v = base.clone();
            v["modelUsage"] = models;
            if cost.is_null() {
                v.as_object_mut().unwrap().remove("total_cost_usd");
            } else {
                v["total_cost_usd"] = cost;
            }
            parse_claude_json_result(&v.to_string(), "ok").unwrap().1
        };
        let missing = with_models(json!({"a":{"costBasis":"actual"},"b":{}}), json!(1));
        assert_eq!(missing.pricing_status, PricingStatus::Estimate);
        assert_eq!(missing.billed_micros, None);
        let mixed = with_models(
            json!({"a":{"costBasis":"billed"},"b":{"costBasis":"subscription"}}),
            json!(1),
        );
        assert_eq!(mixed.pricing_status, PricingStatus::Estimate);
        let mixed_zero = with_models(json!({"a":{"costBasis":"billed"},"b":{}}), json!(0));
        assert_eq!(mixed_zero.pricing_status, PricingStatus::Estimate);
        let none = with_models(json!({"a":{"costBasis":"billed"},"b":{}}), JsonValue::Null);
        assert_eq!(none.pricing_status, PricingStatus::Unpriced);
        let all = with_models(
            json!({"a":{"costBasis":"billed"},"b":{"costBasis":"billed"}}),
            json!(1),
        );
        assert_eq!(all.pricing_status, PricingStatus::Billed);
    }

    #[test]
    fn model_usage_totals_include_subagents_over_top_level_usage() {
        let raw = r#"{"type":"result","result":"x","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30},"modelUsage":{"main":{"inputTokens":10,"outputTokens":20,"cacheReadInputTokens":30,"costBasis":"list"},"sub":{"inputTokens":5,"outputTokens":7,"cacheReadInputTokens":0,"costBasis":"list"}}}"#;
        let r = parse_claude_json_result(raw, "ok").unwrap().1;
        assert_eq!(r.tokens.input, Some(15));
        assert_eq!(r.tokens.output, Some(27));
        assert_eq!(r.tokens.cached_read, Some(30));
        // Neither source reported cache writes: still unknown.
        assert_eq!(r.tokens.cache_write, None);
    }

    #[test]
    fn non_usd_currency_is_unavailable() {
        let mut r = parse_claude_json_result(&with_cost(json!(0.25), "billed"), "ok")
            .unwrap()
            .1;
        r.currency = Some("EUR".into());
        assert!(!r.amounts_consistent());
        let s = summarize_usage(&[event(&r)]);
        assert_eq!((s.unavailable_count, s.priced_count), (1, 0));
    }

    #[test]
    fn incomplete_event_surfaces_pending_count_once() {
        let mut e = new_run_event(
            "run-1",
            USAGE_INCOMPLETE_EVENT,
            "m",
            json!({"pending": 2}),
            None,
        );
        e.id = "event-inc".into();
        let s = summarize_usage(&[e.clone(), e]);
        assert_eq!(s.pending_count, 2);
    }

    #[test]
    fn partial_model_usage_counter_is_unknown() {
        let raw = r#"{"type":"result","result":"x","usage":{"input_tokens":100,"output_tokens":50},"modelUsage":{"a":{"inputTokens":10,"outputTokens":20},"b":{"outputTokens":30}}}"#;
        let r = parse_claude_json_result(raw, "ok").unwrap().1;
        assert_eq!(r.tokens.input, None);
        assert_eq!(r.tokens.output, Some(50));
    }

    #[test]
    fn overflowing_receipt_is_unavailable_and_totals_unchanged() {
        let raw = r#"{"type":"result","result":"x","usage":{"input_tokens":18446744073709551615}}"#;
        let big = parse_claude_json_result(raw, "ok").unwrap().1;
        let small = parse_claude_json_result(
            r#"{"type":"result","result":"x","usage":{"input_tokens":1}}"#,
            "ok",
        )
        .unwrap()
        .1;
        let s = summarize_usage(&[event(&big), event(&small)]);
        assert_eq!(s.input_tokens, u64::MAX);
        assert_eq!(
            (s.receipt_count, s.unavailable_count, s.input_counted),
            (2, 1, 1)
        );
    }

    #[test]
    fn partial_counters_stay_unknown_per_field() {
        let raw = r#"{"type":"result","result":"x","usage":{"input_tokens":4,"output_tokens":5}}"#;
        let r = parse_claude_json_result(raw, "ok").unwrap().1;
        let s = summarize_usage(&[event(&r)]);
        assert_eq!((s.input_counted, s.output_counted), (1, 1));
        assert_eq!((s.cached_read_counted, s.cache_write_counted), (0, 0));
    }

    #[test]
    fn ac3_error_result_without_result_field_keeps_usage() {
        let raw = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0.2,"usage":{"input_tokens":5,"output_tokens":6},"modelUsage":{"m":{"costBasis":"list"}}}"#;
        let (content, r) = parse_claude_json_result(raw, "failed").unwrap();
        assert_eq!(content, raw);
        assert_eq!(r.tokens.input, Some(5));
        assert_eq!(r.pricing_status, PricingStatus::Estimate);
        assert_eq!(r.outcome, "failed");
    }

    #[test]
    fn ac5_receipts_with_inconsistent_amounts_are_unavailable() {
        let base = parse_claude_json_result(&with_cost(json!(0.25), "billed"), "ok")
            .unwrap()
            .1;
        assert!(base.amounts_consistent());
        let mut no_amount = base.clone();
        no_amount.billed_micros = None;
        let mut no_currency = base.clone();
        no_currency.currency = None;
        let mut estimate_no_amount = base.clone();
        estimate_no_amount.pricing_status = PricingStatus::Estimate;
        estimate_no_amount.billed_micros = None;
        let mut unpriced_with_amount = base.clone();
        unpriced_with_amount.pricing_status = PricingStatus::Unpriced;
        let events: Vec<_> = [
            no_amount,
            no_currency,
            estimate_no_amount,
            unpriced_with_amount,
        ]
        .into_iter()
        .map(|mut r| {
            r.receipt_id = new_receipt_id();
            event(&r)
        })
        .collect();
        let s = summarize_usage(&events);
        assert_eq!((s.receipt_count, s.unavailable_count), (4, 4));
        assert_eq!(
            (s.priced_count, s.confirmed_micros, s.estimate_count),
            (0, 0, 0)
        );
    }

    #[test]
    fn ac3_failed_usage_retained_with_distinct_counters() {
        let r = parse_claude_json_result(CLAUDE_FIXTURE, "failed")
            .unwrap()
            .1;
        let s = summarize_usage(&[event(&r)]);
        assert_eq!(s.failed_count, 1);
        assert_eq!(
            (
                s.input_tokens,
                s.cached_read_tokens,
                s.cache_write_tokens,
                s.output_tokens
            ),
            (2, 11491, 54611, 77)
        );
    }

    #[test]
    fn ac4_unknown_shape_is_unavailable_and_receipt_has_no_secrets() {
        assert!(parse_claude_json_result("plain text answer", "ok").is_none());
        assert!(parse_claude_json_result(r#"{"type":"assistant"}"#, "ok").is_none());
        let u = UsageReceipt::unavailable("kimi", "ok");
        assert_eq!(u.pricing_status, PricingStatus::Unavailable);
        assert_eq!(u.billed_micros, None);
        let s = summarize_usage(&[event(&u)]);
        assert_eq!(
            (s.unavailable_count, s.confirmed_micros, s.input_counted),
            (1, 0, 0)
        );
        let r = parse_claude_json_result(CLAUDE_FIXTURE, "ok").unwrap().1;
        let serialized = serde_json::to_string(&r).unwrap();
        for leaked in [
            "session_id",
            "credential",
            "00000000",
            "FIXTURE-ANSWER-7f3a",
        ] {
            assert!(!serialized.contains(leaked), "{leaked} in {serialized}");
        }
    }

    #[test]
    fn ac5_totals_and_coverage_recompute_from_receipts() {
        let receipts = [
            parse_claude_json_result(&with_cost(json!(0.25), "billed"), "ok")
                .unwrap()
                .1,
            parse_claude_json_result(&with_cost(json!(0), "billed"), "ok")
                .unwrap()
                .1,
            parse_claude_json_result(&with_cost(json!(1.5), "list"), "ok")
                .unwrap()
                .1,
            parse_claude_json_result(&with_cost(JsonValue::Null, "list"), "ok")
                .unwrap()
                .1,
            parse_claude_json_result(&with_cost(json!(0.1), "included"), "ok")
                .unwrap()
                .1,
            UsageReceipt::unavailable("codex", "failed"),
        ];
        let events: Vec<_> = receipts.iter().map(event).collect();
        let s = summarize_usage(&events);
        assert_eq!(s.receipt_count, 6);
        assert_eq!(s.priced_count, 2);
        assert_eq!(s.estimate_count, 1);
        assert_eq!(s.unpriced_count, 1);
        assert_eq!(s.subscription_included_count, 1);
        assert_eq!(s.unavailable_count, 1);
        assert_eq!(s.confirmed_micros, 250_000);
        assert_eq!(s.estimate_micros, 1_500_000);
    }
}
