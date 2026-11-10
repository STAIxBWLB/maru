//! Typed host boundary for immutable render history.

use crate::HostError;
use maru_diagram_engine::{
    geometry::PinSet,
    render::{ArtifactFormat, ArtifactReport, SvgTheme},
    EngineReceipt,
};
use serde::{Deserialize, Serialize};

fn default_theme() -> SvgTheme {
    SvgTheme::Light
}

fn default_pixel_ratio() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenderStoreRequest {
    spec_json: String,
    format: ArtifactFormat,
    #[serde(default = "default_theme")]
    theme: SvgTheme,
    #[serde(default = "default_pixel_ratio")]
    pixel_ratio: u32,
    #[serde(default)]
    pin_set: Option<PinSet>,
    #[serde(default)]
    text_mode: Option<String>,
}

pub(crate) fn prepare_render_store_request(input: &str) -> Result<String, crate::IpcError> {
    let mut request: RenderStoreRequest = serde_json::from_str(input).map_err(|cause| {
        crate::IpcError::new(
            "diagram_export_request_invalid",
            format!("render request cannot be decoded: {cause}"),
            "provide a valid source-spec render request and retry",
            Vec::new(),
        )
    })?;
    if matches!(request.format, ArtifactFormat::Svg) {
        if request.text_mode.as_deref() == Some("text") {
            return Err(crate::IpcError::new(
                "diagram_render_store_text_mode_invalid",
                "stored native SVG artifacts require outlined glyphs",
                "remove textMode text and render outlines so the saved SVG is font-independent",
                Vec::new(),
            ));
        }
        if request.text_mode.is_none() {
            request.text_mode = Some("outlines".into());
        }
    }
    serde_json::to_string(&request).map_err(|cause| {
        crate::IpcError::new(
            "diagram_render_request_encode_failed",
            format!("SVG render request cannot be encoded: {cause}"),
            "retry the render; if it repeats, report the malformed source request",
            Vec::new(),
        )
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderDocumentContext {
    pub doc_id: String,
    pub document_name: String,
    pub document_revision: String,
    pub diagram_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderGate {
    pub status: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderGates {
    pub schema: RenderGate,
    pub artifact: RenderGate,
    pub browser: RenderGate,
    pub visual_review: RenderGate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderConversion {
    pub format: String,
    pub theme: String,
    pub pixel_ratio: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyArchifyEnginePin {
    pub name: String,
    pub version: String,
    pub revision: String,
}

/// Strict compatibility shape for receipts already written by Archify.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyArchifyReceipt {
    pub schema_version: u32,
    pub input_spec_sha256: String,
    pub engine_pin: LegacyArchifyEnginePin,
    pub output_sha256: String,
    pub output_mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_output_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversion: Option<RenderConversion>,
    pub gates: RenderGates,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readback: Option<RenderGate>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum StoredRenderReceipt {
    LegacyArchify(LegacyArchifyReceipt),
    Engine(EngineReceipt),
}

impl<'de> Deserialize<'de> for StoredRenderReceipt {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let object = value.as_object().ok_or_else(|| {
            <D::Error as serde::de::Error>::custom("render receipt must be an object")
        })?;
        let has_engine = object.contains_key("engine");
        let has_engine_pin = object.contains_key("enginePin");
        if has_engine && has_engine_pin {
            return Err(<D::Error as serde::de::Error>::custom(
                "render receipt cannot contain both engine and legacy enginePin identities",
            ));
        }
        if has_engine {
            serde_json::from_value::<EngineReceipt>(value)
                .map(Self::Engine)
                .map_err(<D::Error as serde::de::Error>::custom)
        } else if has_engine_pin {
            serde_json::from_value::<LegacyArchifyReceipt>(value)
                .map(Self::LegacyArchify)
                .map_err(<D::Error as serde::de::Error>::custom)
        } else {
            Err(<D::Error as serde::de::Error>::custom(
                "render receipt lacks engine or legacy enginePin identity",
            ))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramRenderReceipt {
    #[serde(flatten)]
    pub render: StoredRenderReceipt,
    pub doc_id: String,
    pub document_name: String,
    pub document_revision: String,
    pub rendered_at: String,
    pub diagram_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredRender {
    pub doc_id: String,
    pub render_id: String,
    pub artifact_name: String,
    pub receipt: DiagramRenderReceipt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderEntry {
    pub doc_id: String,
    pub render_id: String,
    pub receipt: Option<DiagramRenderReceipt>,
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderGroup {
    pub doc_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_doc_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_name: Option<String>,
    pub orphaned: bool,
    #[serde(default)]
    pub ambiguous: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    pub renders: Vec<RenderEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderView {
    pub path: String,
    pub mime_type: String,
    pub receipt: DiagramRenderReceipt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderAndStoreReport {
    pub report: ArtifactReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_warning: Option<String>,
}

pub trait RenderStoreHost: Send + Sync + 'static {
    fn list_renders(&self, workspace: &str) -> Result<Vec<RenderGroup>, HostError>;
    fn prepare_render_view(
        &self,
        workspace: &str,
        doc_id: &str,
        render_id: &str,
    ) -> Result<RenderView, HostError>;
    fn delete_render(
        &self,
        workspace: &str,
        doc_id: &str,
        render_id: &str,
    ) -> Result<(), HostError>;
    fn store_engine_render(
        &self,
        workspace: &str,
        context: RenderDocumentContext,
        source_spec_json: &str,
        report: ArtifactReport,
    ) -> Result<StoredRender, HostError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source_request(extra: serde_json::Value) -> String {
        let mut request = json!({
            "specJson": "{}",
            "format": "svg",
            "theme": "dark",
            "pixelRatio": 1,
            "pinSet": null
        });
        request
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        request.to_string()
    }

    #[test]
    fn store_request_defaults_svg_to_outline_text_mode() {
        let normalized = prepare_render_store_request(&source_request(json!({}))).unwrap();
        let request: RenderStoreRequest = serde_json::from_str(&normalized).unwrap();
        assert_eq!(request.text_mode.as_deref(), Some("outlines"));
        assert!(matches!(request.format, ArtifactFormat::Svg));
    }

    #[test]
    fn store_request_preserves_outlines_and_rejects_font_dependent_svg_text() {
        let outlines =
            prepare_render_store_request(&source_request(json!({"textMode":"outlines"}))).unwrap();
        let request: RenderStoreRequest = serde_json::from_str(&outlines).unwrap();
        assert_eq!(request.text_mode.as_deref(), Some("outlines"));

        let error =
            prepare_render_store_request(&source_request(json!({"textMode":"text"}))).unwrap_err();
        assert_eq!(error.code, "diagram_render_store_text_mode_invalid");
    }

    #[test]
    fn store_request_keeps_png_font_text_and_pixel_ratio() {
        let default_png =
            prepare_render_store_request(&source_request(json!({"format":"png"}))).unwrap();
        let default_png: RenderStoreRequest = serde_json::from_str(&default_png).unwrap();
        assert!(default_png.text_mode.is_none());
        assert_eq!(default_png.pixel_ratio, 1);

        let normalized = prepare_render_store_request(&source_request(json!({
            "format":"png", "pixelRatio":3, "textMode":"text"
        })))
        .unwrap();
        let request: RenderStoreRequest = serde_json::from_str(&normalized).unwrap();
        assert!(matches!(request.format, ArtifactFormat::Png));
        assert_eq!(request.pixel_ratio, 3);
        assert_eq!(request.text_mode.as_deref(), Some("text"));
    }

    fn engine_receipt() -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "inputSpecSha256": "a".repeat(64),
            "engine": {
                "id": "maru-diagram-engine",
                "version": "1.0.0",
                "revision": "engine-test"
            },
            "gates": {
                "schema": {"status":"passed", "scope":"schema"},
                "artifact": {"status":"passed", "scope":"svg"},
                "browser": {"status":"not-run", "scope":"none"},
                "visualReview": {"status":"not-run", "scope":"manual"}
            }
        })
    }

    #[test]
    fn receipt_reader_requires_one_identity_and_rejects_conflicting_legacy_identity() {
        let mut missing = json!({"schemaVersion":1, "metadata":{"future":true}});
        assert!(serde_json::from_value::<StoredRenderReceipt>(missing.clone()).is_err());

        let mut conflict = engine_receipt();
        conflict["enginePin"] = json!({
            "name":"archify", "version":"3.0.0", "revision":"legacy"
        });
        assert!(serde_json::from_value::<StoredRenderReceipt>(conflict).is_err());

        missing["engine"] = engine_receipt()["engine"].clone();
        missing["inputSpecSha256"] = json!("a".repeat(64));
        missing["gates"] = engine_receipt()["gates"].clone();
        let with_future_metadata = serde_json::from_value::<StoredRenderReceipt>(missing).unwrap();
        assert!(matches!(
            with_future_metadata,
            StoredRenderReceipt::Engine(_)
        ));
    }

    #[test]
    fn legacy_engine_pin_ignores_extra_pin_provenance_but_receipt_envelope_stays_strict() {
        let legacy = json!({
            "schemaVersion": 1,
            "inputSpecSha256": "a".repeat(64),
            "enginePin": {
                "schemaVersion": 1,
                "name": "archify",
                "version": "3.0.0",
                "repository": "https://example.invalid/archify",
                "revision": "0123456789abcdef0123456789abcdef01234567",
                "revisionRef": "refs/tags/v3.0.0",
                "pinnedAt": "2026-10-05",
                "license": "MIT",
                "licenseHolders": ["Archify"],
                "fileHashes": {"bin/archify.mjs": "b".repeat(64)}
            },
            "outputSha256": "c".repeat(64),
            "outputMimeType": "text/html",
            "gates": {
                "schema": {"status":"passed", "scope":"pinned-engine-validation"},
                "artifact": {"status":"passed", "scope":"pinned-engine-rendered-html"},
                "browser": {"status":"not-run", "scope":"none"},
                "visualReview": {"status":"not-run", "scope":"manual"}
            }
        });
        let parsed = serde_json::from_value::<StoredRenderReceipt>(legacy.clone()).unwrap();
        let StoredRenderReceipt::LegacyArchify(pin) = &parsed else {
            panic!("enginePin identity must retain the legacy receipt variant")
        };
        assert_eq!(pin.engine_pin.name, "archify");
        assert_eq!(pin.engine_pin.version, "3.0.0");
        assert_eq!(
            pin.engine_pin.revision,
            "0123456789abcdef0123456789abcdef01234567"
        );
        let serialized = serde_json::to_value(parsed).unwrap();
        assert_eq!(serialized["enginePin"]["name"], "archify");
        assert!(serialized["enginePin"].get("fileHashes").is_none());

        let mut unknown_receipt_field = legacy;
        unknown_receipt_field["futureReceiptField"] = json!(true);
        assert!(serde_json::from_value::<StoredRenderReceipt>(unknown_receipt_field).is_err());
    }
}
