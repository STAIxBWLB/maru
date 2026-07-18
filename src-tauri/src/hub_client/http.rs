// HTTP client for the Maru Hub. Read-only `GET /api/v1/<resource>`.
//
// Uses reqwest blocking client (we're called from Tauri commands that run on
// a thread pool already). Honors ETag — if the cached etag is present we send
// `If-None-Match`; on `304 Not Modified` we hit the local cache.
//
// Spec: ~/workspace/work/_sys/rules/hub-sync.md §4, §5

use std::collections::HashMap;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, IF_NONE_MATCH};
use reqwest::StatusCode;

use super::{cache, HubConfig, HubFetchResponse};

#[derive(Debug)]
pub(crate) enum HubFetchError {
    Network(String),
    Status { status: u16, body: String },
    Encoding(String),
}

impl std::fmt::Display for HubFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HubFetchError::Network(e) => write!(f, "network: {e}"),
            HubFetchError::Status { status, body } => {
                write!(f, "status {status}: {}", truncate(body, 200))
            }
            HubFetchError::Encoding(e) => write!(f, "encoding: {e}"),
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

pub(crate) fn build_client(cfg: &HubConfig) -> Result<Client, HubFetchError> {
    let mut headers = HeaderMap::new();
    if let Some(token) = &cfg.api_token {
        let value = HeaderValue::from_str(&format!("Bearer {}", token))
            .map_err(|e| HubFetchError::Encoding(e.to_string()))?;
        headers.insert(AUTHORIZATION, value);
    }
    Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_millis(cfg.timeout_ms))
        .build()
        .map_err(|e| HubFetchError::Network(e.to_string()))
}

/// `GET /api/v1/<resource>?<params>`. If the cached etag exists, send
/// `If-None-Match`. Returns:
///   - Some((body, etag))  on 200
///   - None                on 304 (caller falls back to cache)
pub(crate) fn fetch_resource(
    client: &Client,
    cfg: &HubConfig,
    resource: &str,
    params: &HashMap<String, String>,
    etag: Option<String>,
) -> Result<Option<(String, Option<String>)>, HubFetchError> {
    let url = build_url(&cfg.endpoint, resource);
    let mut req = client.get(&url);
    for (k, v) in params {
        req = req.query(&[(k.as_str(), v.as_str())]);
    }
    if let Some(tag) = &etag {
        req = req.header(IF_NONE_MATCH, tag);
    }
    let resp = req
        .send()
        .map_err(|e| HubFetchError::Network(e.to_string()))?;

    let status = resp.status();
    if status == StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(HubFetchError::Status {
            status: status.as_u16(),
            body,
        });
    }
    let etag_out = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = resp
        .text()
        .map_err(|e| HubFetchError::Encoding(e.to_string()))?;
    Ok(Some((body, etag_out)))
}

/// `POST /api/v1/<resource>` with a JSON body. Returns the response body.
/// Only the approval-gated submit/drain flows use this write path.
pub(crate) fn post_resource(
    client: &Client,
    cfg: &HubConfig,
    resource: &str,
    body_json: &str,
) -> Result<String, HubFetchError> {
    let url = build_url(&cfg.endpoint, resource);
    let resp = client
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body_json.to_string())
        .send()
        .map_err(|e| HubFetchError::Network(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(HubFetchError::Status {
            status: status.as_u16(),
            body,
        });
    }
    resp.text()
        .map_err(|e| HubFetchError::Encoding(e.to_string()))
}

fn build_url(endpoint: &str, resource: &str) -> String {
    // resource는 `templates`, `guidelines`, `templates/<id>` 등 path-like.
    // hub-sync.md §4 path 매핑:
    //   templates → /templates
    //   guidelines → /guidelines
    //   glossary → /glossary
    //   business_units → /business-units
    //   document_types → /document-types
    //   context_packs → /context-packs
    //   evidence_index → /evidence-index
    //   kpi_status → /kpi-status
    //   submission_gates → /submission-gates
    let path = match resource {
        "business_units" => "business-units".to_string(),
        "document_types" => "document-types".to_string(),
        "context_packs" => "context-packs".to_string(),
        "evidence_index" => "evidence-index".to_string(),
        "kpi_status" => "kpi-status".to_string(),
        "submission_gates" => "submission-gates".to_string(),
        other if other.starts_with('/') => other.trim_start_matches('/').to_string(),
        other => other.to_string(),
    };
    if endpoint.ends_with('/') {
        format!("{}{}", endpoint, path)
    } else {
        format!("{}/{}", endpoint, path)
    }
}

/// 캐시 우선 fetch with revalidation. Cache miss → 신규 GET. Cache hit + revalidate
/// → If-None-Match 동반 GET → 304면 캐시 그대로 반환.
pub(crate) fn fetch_with_cache(
    cfg: &HubConfig,
    resource: &str,
    params: &HashMap<String, String>,
    revalidate: bool,
) -> Result<HubFetchResponse, HubFetchError> {
    let cached = cache::load_cached_resource(&cfg.cache_root, resource, params).ok();
    let etag = cached.as_ref().and_then(|c| c.etag.clone());

    let client = build_client(cfg)?;
    let send_etag = if revalidate { etag.clone() } else { None };
    let result = fetch_resource(&client, cfg, resource, params, send_etag)?;

    match result {
        None => {
            // 304 — 캐시 그대로
            cached.ok_or_else(|| {
                HubFetchError::Encoding(format!("304 received but no cache for {}", resource))
            })
        }
        Some((body, new_etag)) => {
            let ttl = cfg.cache_ttl_seconds();
            if let Err(e) = cache::save_resource(
                &cfg.cache_root,
                resource,
                params,
                &body,
                new_etag.clone(),
                ttl,
            ) {
                eprintln!("[hub_client] cache save failed: {}", e);
            }
            Ok(HubFetchResponse {
                from_cache: false,
                etag: new_etag,
                body_json: body,
                fetched_at: chrono::Utc::now().to_rfc3339(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_url_kebab_cases() {
        let cases = [
            (
                "https://h/api/v1",
                "business_units",
                "https://h/api/v1/business-units",
            ),
            (
                "https://h/api/v1/",
                "templates",
                "https://h/api/v1/templates",
            ),
            (
                "https://h/api/v1",
                "templates/abc/render-spec",
                "https://h/api/v1/templates/abc/render-spec",
            ),
            (
                "https://h/api/v1",
                "evidence_index",
                "https://h/api/v1/evidence-index",
            ),
        ];
        for (endpoint, res, expected) in cases {
            assert_eq!(build_url(endpoint, res), expected, "res={res}");
        }
    }
}
