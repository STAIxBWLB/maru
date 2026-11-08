//! S1 foundation probes for every corpus record, not scene-layout acceptance.
use maru_diagram_engine::{layout::fixed, metrics};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{error::Error, fs};

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            // serde_json's default map is lexically ordered on every platform.
            for (key, value) in map {
                if matches!(
                    key.as_str(),
                    "label" | "title" | "sublabel" | "subtitle" | "note" | "tag"
                ) {
                    if let Some(text) = value.as_str() {
                        out.push(text.into());
                    }
                }
                strings(value, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                if let Some(text) = item.as_str() {
                    out.push(text.into());
                } else {
                    strings(item, out);
                }
            }
        }
        _ => {}
    }
}

fn case_texts(case_id: &str, input_json: &str) -> Result<Vec<String>, String> {
    let value: Value = serde_json::from_str(input_json).map_err(|error| {
        format!(
            "corpus case {case_id:?} inputJson is invalid: {error}; repair or regenerate that corpus case"
        )
    })?;
    let mut texts = vec!["Latin 한글 日本語 漢字".to_string()];
    strings(&value, &mut texts);
    Ok(texts)
}
fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Expected corpus and output paths; pass testdata/parity.json and a writable output JSON path".into());
    }
    let bytes = fs::read(&args[1])?;
    let corpus: Value = serde_json::from_slice(&bytes)?;
    let items = corpus["cases"]
        .as_array()
        .ok_or("Corpus has no cases; regenerate the parity corpus")?;
    if items.is_empty() {
        return Err("Corpus cases are empty; regenerate the parity corpus".into());
    }
    let mut cases = Vec::new();
    for case in items {
        let id = case["id"]
            .as_str()
            .ok_or("Corpus case has no id; regenerate the parity corpus")?;
        let selected_input = case
            .get("comparison")
            .and_then(|comparison| comparison.get("inputJson"))
            .unwrap_or(&case["inputJson"]);
        let input = selected_input.as_str().ok_or_else(|| {
            format!("corpus case {id:?} has no string inputJson; regenerate the parity corpus")
        })?;
        let texts = case_texts(id, input)?;
        let mut probes = Vec::new();
        for text in &texts {
            for weight in [400, 700] {
                probes.push(match metrics::measure_text(text, weight, 14 * 64 + 7) {
                    Ok(measured) => json!({"metrics": measured}),
                    Err(diagnostic) => json!({"diagnostic": diagnostic}),
                });
            }
        }
        let quantized: Vec<_> = [-100.0078125, -0.0078125, 0.0, 0.0078125, 100.0078125]
            .into_iter()
            .map(fixed::quantize_pixels)
            .collect::<Result<_, _>>()?;
        let probe =
            json!({"inputSha256":sha(input.as_bytes()),"quantized":quantized,"text":probes});
        cases.push(json!({"id":id,"hash":sha(&serde_json::to_vec(&probe)?)}));
    }
    let fonts: Vec<_> = [400, 700]
        .into_iter()
        .map(metrics::font_identity)
        .collect::<Result<_, _>>()
        .map_err(|d| format!("{}; {}", d.message, d.fix))?;
    let report = json!({"apiVersion":1,"scope":"foundation-text-metrics-not-scene-layout","corpusSha256":sha(&bytes),"corpusCaseCount":items.len(),"fontManifestSha256":sha(metrics::font_manifest().as_bytes()),"fonts":fonts,"cases":cases});
    fs::write(
        &args[2],
        format!("{}\n", serde_json::to_string_pretty(&report)?),
    )?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Geometry foundation hashing failed: {error}; verify the corpus path, bundled metric tables and writable output folder, then rerun geometry-foundation-hashes.");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::case_texts;

    #[test]
    fn includes_rendered_card_item_strings_in_the_metrics_probe() {
        let texts = case_texts(
            "cards",
            r#"{"cards":[{"dot":"cyan","title":"Card title","items":["First rendered item","Second rendered item"]}],"captionLines":["Other rendered array text"]}"#,
        )
        .unwrap();
        assert!(texts.iter().any(|text| text == "First rendered item"));
        assert!(texts.iter().any(|text| text == "Second rendered item"));
        assert!(texts.iter().any(|text| text == "Other rendered array text"));
    }

    #[test]
    fn reports_malformed_input_json_with_case_cause_and_next_step() {
        let error = case_texts("broken-case", "{").unwrap_err();
        assert!(error.contains("broken-case"));
        assert!(error.contains("inputJson is invalid"));
        assert!(error.contains("repair or regenerate"));
    }
}
