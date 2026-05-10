use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSourceManifest {
    pub schema_version: String,
    pub source_id: String,
    pub name: String,
    pub version: String,
    pub skills_subdir: String,
    pub signed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceValidationReport {
    pub valid: bool,
    #[serde(default)]
    pub errors: Vec<String>,
}

#[tauri::command]
pub fn agent_validate_marketplace_manifest(
    manifest: MarketplaceSourceManifest,
) -> Result<MarketplaceValidationReport, String> {
    Ok(validate_marketplace_manifest(&manifest))
}

pub fn validate_marketplace_manifest(
    manifest: &MarketplaceSourceManifest,
) -> MarketplaceValidationReport {
    let mut errors = Vec::new();
    if manifest.schema_version != "anchor_marketplace_source_v1" {
        errors.push(format!("unsupported_schema: {}", manifest.schema_version));
    }
    if manifest.source_id.trim().is_empty() {
        errors.push("source_id_required".to_string());
    }
    if manifest.source_id.contains('/') || manifest.source_id.contains('\\') {
        errors.push("source_id_invalid".to_string());
    }
    if manifest.version.trim().is_empty() {
        errors.push("version_required".to_string());
    }
    if manifest.skills_subdir.trim().is_empty() {
        errors.push("skills_subdir_required".to_string());
    }
    if manifest.signed
        && manifest
            .signature
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        errors.push("signature_required".to_string());
    }
    if !manifest.signed {
        errors.push("unsigned_source_rejected".to_string());
    }
    MarketplaceValidationReport {
        valid: errors.is_empty(),
        errors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marketplace_manifest_requires_signed_metadata() {
        let report = validate_marketplace_manifest(&MarketplaceSourceManifest {
            schema_version: "anchor_marketplace_source_v1".to_string(),
            source_id: "demo".to_string(),
            name: "Demo".to_string(),
            version: "1.0.0".to_string(),
            skills_subdir: "skills".to_string(),
            signed: false,
            signature: None,
            repo_url: None,
        });
        assert!(!report.valid);
        assert!(report
            .errors
            .contains(&"unsigned_source_rejected".to_string()));
    }
}
