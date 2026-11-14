//! Shared native/WASM whole-scene determinism harness. No filesystem or host API.
//! Build identity and receipt transport metadata are deliberately excluded from
//! case hashes; geometry and stable diagnostics are compared without rewriting.

use crate::{geometry::GeometryReport, Diagnostic};
use serde_json::{json, Value};
use std::collections::HashSet;

fn error(suffix: &str, path: &str, cause: impl Into<String>, fix: &str) -> Diagnostic {
    Diagnostic {
        code: format!("document/corpus-{suffix}"),
        path: path.into(),
        rule: format!("geometry-v1/corpus-{suffix}"),
        message: cause.into(),
        fix: fix.into(),
    }
}

fn canonical(report: &GeometryReport) -> Result<String, Diagnostic> {
    if report.api_version != crate::API_VERSION || (report.ok && report.geometry.is_none()) {
        return Err(error(
            "report",
            "/",
            "layout returned an incompatible report or success without scene geometry",
            "repair the layout report contract before regenerating determinism receipts",
        ));
    }
    serde_json::to_string(&json!({
        "ok": report.ok,
        "geometry": &report.geometry,
        "diagnostics": &report.diagnostics,
    }))
    .map_err(|cause| {
        error(
            "serialization",
            "/",
            format!("scene geometry could not be serialized: {cause}"),
            "keep geometry coordinates finite fixed-point integers and regenerate the report",
        )
    })
}

/// Lay out one corpus case in whichever family its document declares.
///
/// A Floorplan document carries no `diagram_type`, so it is placed through its
/// own entry point rather than the five-family dispatcher, and the corpus has to
/// hash that family on every platform too (`maru#553` E5 T2). The SVG options
/// branch the same way in `SvgOptions::from_source`.
fn layout_case(spec: &Value, request: &str) -> GeometryReport {
    if crate::floorplan::is_document(spec) {
        return crate::layout::layout_floorplan_json(request);
    }
    crate::layout::layout_json(request)
}

fn svg_hashes(
    geometry: Option<&crate::geometry::GeometryDocument>,
    spec: &Value,
    case_path: &str,
    id: &str,
) -> Result<Option<serde_json::Map<String, Value>>, Diagnostic> {
    let Some(geometry) = geometry else {
        return Ok(None);
    };
    let mut themes = serde_json::Map::new();
    for theme in [
        crate::render::SvgTheme::Light,
        crate::render::SvgTheme::Dark,
    ] {
        let options = crate::render::SvgOptions::from_source(spec, theme)?;
        let first_svg = crate::render::render_svg(geometry, &options);
        let second_svg = crate::render::render_svg(geometry, &options);
        if !first_svg.ok || !second_svg.ok || first_svg.svg != second_svg.svg {
            return Err(error("svg", case_path, format!("case {id:?} {} SVG failed its artifact/repeat gate: {:?}", theme.name(), first_svg.diagnostics), "repair deterministic SVG output and its artifact gate while preserving retained geometry"));
        }
        let bytes = first_svg.svg.as_deref().ok_or_else(|| {
            error(
                "svg",
                case_path,
                "successful SVG report omitted its artifact",
                "restore the SVG report contract",
            )
        })?;
        themes.insert(
            theme.name().into(),
            json!({"hash":crate::spec_hash(bytes),"bytes":bytes.len(),"artifactGate":true}),
        );
    }
    Ok(Some(themes))
}

/// Hash every input, accepted or rejected, and verify an unchanged re-layout.
/// The corpus string must be the checked-in file's exact UTF-8 contents.
pub fn scene_corpus_hashes(input: &str) -> Result<String, Diagnostic> {
    let corpus: Value = serde_json::from_str(input).map_err(|cause| {
        error(
            "json",
            "/",
            format!("parity corpus is not valid JSON: {cause}"),
            "repair or regenerate the parity corpus file before hashing scenes",
        )
    })?;
    if !corpus.is_object() {
        return Err(error(
            "shape",
            "/",
            "parity corpus must be a JSON object",
            "supply the checked-in parity corpus object",
        ));
    }
    let cases = corpus
        .get("cases")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            error(
                "cases",
                "/cases",
                "parity corpus has no nonempty case array",
                "regenerate the complete parity corpus",
            )
        })?;
    let mut seen = HashSet::new();
    let mut hashes = Vec::new();
    let mut accepted = 0_usize;
    for (index, case) in cases.iter().enumerate() {
        let case_path = format!("/cases/{index}");
        if !case.is_object() {
            return Err(error(
                "shape",
                &case_path,
                "corpus case must be a JSON object",
                "restore the case object with an id and inputJson",
            ));
        }
        let id = case
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                error(
                    "id",
                    &format!("{case_path}/id"),
                    "corpus case has no nonempty string id",
                    "give every corpus case a unique nonempty id",
                )
            })?;
        if !seen.insert(id) {
            return Err(error(
                "id",
                &format!("{case_path}/id"),
                format!("corpus case id {id:?} is duplicated"),
                "give every corpus case a unique id and regenerate the reports",
            ));
        }
        let comparison = case.get("comparison");
        if comparison.is_some_and(|v| !v.is_object()) {
            return Err(error(
                "shape",
                &format!("{case_path}/comparison"),
                "case comparison must be a JSON object when present",
                "restore the comparison object or omit it to use the original inputJson",
            ));
        }
        let selected = comparison.and_then(|v| v.get("inputJson"));
        let source = selected.or_else(|| case.get("inputJson"));
        let input_path = if selected.is_some() {
            format!("{case_path}/comparison/inputJson")
        } else {
            format!("{case_path}/inputJson")
        };
        let spec_json = source.and_then(Value::as_str).ok_or_else(|| {
            error(
                "input",
                &input_path,
                "corpus case inputJson is missing or is not a string",
                "restore the serialized JSON input for this corpus case",
            )
        })?;
        let spec = serde_json::from_str::<Value>(spec_json).map_err(|cause| {
            error(
                "input",
                &input_path,
                format!("corpus case {id:?} inputJson is invalid: {cause}"),
                "repair or regenerate this corpus case's JSON input",
            )
        })?;
        let request = json!({ "specJson": spec_json }).to_string();
        let first = layout_case(&spec, &request);
        let second = layout_case(&spec, &request);
        let first_bytes = canonical(&first)?;
        if first_bytes != canonical(&second)? {
            return Err(error("nondeterministic", &case_path, format!("unchanged re-layout of corpus case {id:?} produced different geometry or diagnostics"), "remove unordered iteration, platform text lookup or other nondeterminism before regenerating receipts"));
        }
        accepted += usize::from(first.ok);
        let codes: std::collections::BTreeSet<_> =
            first.diagnostics.iter().map(|d| d.code.as_str()).collect();
        let notices: Vec<_> = first
            .diagnostics
            .iter()
            .filter(|d| crate::layout::is_route_quality_notice(d))
            .map(|d| json!({"code":d.code,"rule":d.rule,"path":d.path,"message":d.message}))
            .collect();
        let svg = svg_hashes(first.geometry.as_ref(), &spec, &case_path, id)?;
        hashes.push(json!({ "id": id, "ok": first.ok, "diagnosticCodes":codes,"routeQualityNotices":notices,"hash": crate::spec_hash(&first_bytes), "geometryRetained": first.geometry.is_some(), "svg": svg }));
    }
    let report = json!({
        "apiVersion": crate::API_VERSION,
        "scope": "whole-scene-geometry",
        "svgHashVersion": 1,
        "corpusSha256": crate::spec_hash(input),
        "corpusCaseCount": cases.len(),
        "acceptedCaseCount": accepted,
        "rejectedCaseCount": cases.len() - accepted,
        "repeatCheck": true,
        "fontManifestSha256": crate::spec_hash(crate::metrics::font_manifest()),
        "benchmarkWork": crate::work::benchmark_work(),
        "cases": hashes,
    });
    serde_json::to_string_pretty(&report).map_err(|cause| {
        error(
            "serialization",
            "/",
            format!("scene corpus report could not be serialized: {cause}"),
            "inspect the SDK report contract and regenerate the determinism receipts",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const VALID: &str = include_str!("../testdata/valid-architecture.json");

    #[test]
    fn hashes_accepted_and_rejected_scenes_repeatably_in_corpus_order() {
        let corpus = json!({"cases":[{"id":"valid","inputJson":VALID},{"id":"wrong-shape","inputJson":"[]"}]}).to_string();
        let first = scene_corpus_hashes(&corpus).unwrap();
        assert_eq!(first, scene_corpus_hashes(&corpus).unwrap());
        let report: Value = serde_json::from_str(&first).unwrap();
        assert_eq!(report["corpusCaseCount"], 2);
        assert_eq!(report["cases"][0]["id"], "valid");
        assert_eq!(report["cases"][1]["id"], "wrong-shape");
        assert_eq!(report["cases"][1]["ok"], false);
        assert_eq!(report["cases"][0]["hash"].as_str().unwrap().len(), 64);
        assert_eq!(report["repeatCheck"], true);
        assert_eq!(report["benchmarkWork"]["viaBenchmarkWork"]["nodes"], 27);
        assert_eq!(report["benchmarkWork"]["viaBenchmarkWork"]["routes"], 1);
        assert_eq!(report["benchmarkWork"]["viaBenchmarkWork"]["viaPoints"], 17);
        assert!(
            report["benchmarkWork"]["viaBenchmarkWork"]["stats"]["endpointMaskEvaluations"]
                .as_u64()
                .unwrap()
                > 0
        );
        assert!(
            report["benchmarkWork"]["viaBenchmarkWork"]["stats"]["maskedAstarExpandedStates"]
                .as_u64()
                .unwrap()
                > 0
        );
    }

    #[test]
    fn corpus_refuses_malformed_inputs_missing_ids_and_duplicates() {
        for corpus in [
            "[]".to_owned(),
            json!({"cases":[]}).to_string(),
            json!({"cases":[{"id":"bad","inputJson":"{"}]}).to_string(),
            json!({"cases":[{"id":"bad","inputJson":VALID,"comparison":{"inputJson":4}}]})
                .to_string(),
            json!({"cases":[{"inputJson":VALID}]}).to_string(),
            json!({"cases":[{"id":"same","inputJson":VALID},{"id":"same","inputJson":VALID}]})
                .to_string(),
        ] {
            let diagnostic = scene_corpus_hashes(&corpus).unwrap_err();
            assert!(!diagnostic.message.is_empty() && !diagnostic.fix.is_empty());
        }
    }

    #[test]
    fn every_seeded_dense_scene_passes_e1_document_validity() {
        let dense: Value =
            serde_json::from_str(include_str!("../testdata/dense-scenes.json")).unwrap();
        let cases = dense["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 3);
        for case in cases {
            let spec = &case["spec"];
            let report = crate::validate_json(&spec.to_string());
            assert!(
                report.ok,
                "dense case {:?}: {:?}",
                case["id"], report.diagnostics
            );
            let nodes = spec
                .get("components")
                .or_else(|| spec.get("nodes"))
                .unwrap()
                .as_array()
                .unwrap();
            assert_eq!(nodes.len(), 200);
        }
    }

    /// The checked-in fixture is the case every platform hashes, so the corpus
    /// has to place and render it rather than refuse it: a Floorplan document is
    /// not an E1 `diagram_type` family, and only the corpus dispatch in
    /// `layout_case` reaches its layout (`maru#553` E5 T2). Accepted with
    /// retained geometry and both theme artifacts is that dispatch working.
    #[test]
    fn the_floorplan_fixture_is_placed_and_rendered_by_the_corpus() {
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/floorplan-scene.json")).unwrap();
        let cases: Vec<Value> = fixture["cases"]
            .as_array()
            .expect("the fixture carries its cases")
            .iter()
            .map(|case| {
                assert!(crate::floorplan::is_document(&case["spec"]));
                json!({"id": case["id"], "inputJson": case["spec"].to_string()})
            })
            .collect();
        let report: Value = serde_json::from_str(
            &scene_corpus_hashes(&json!({ "cases": cases }).to_string()).unwrap(),
        )
        .unwrap();
        assert_eq!(report["corpusCaseCount"], cases.len());
        assert_eq!(report["acceptedCaseCount"], cases.len());
        for case in report["cases"].as_array().unwrap() {
            assert_eq!(case["ok"], true, "{case}");
            assert_eq!(case["geometryRetained"], true, "{case}");
            for theme in ["light", "dark"] {
                assert_eq!(case["svg"][theme]["artifactGate"], true, "{theme}: {case}");
            }
        }
    }

    #[test]
    fn platform_and_build_receipt_identity_do_not_enter_scene_hashes() {
        let request = json!({"specJson":VALID}).to_string();
        let original = crate::layout::layout_json(&request);
        let mut other = original.clone();
        other.receipt.engine.revision = "another-platform-build".into();
        assert_eq!(canonical(&original).unwrap(), canonical(&other).unwrap());
    }
}
