//! Sequence document validity, independent of layout and rendering.

use crate::common::{self, Card, Decoration, Meta};
use crate::Diagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

const KIND: &str = "sequence";
const TYPES: &[&str] = &[
    "frontend",
    "backend",
    "database",
    "cloud",
    "security",
    "messagebus",
    "external",
];
const VARIANTS: &[&str] = &["default", "emphasis", "security", "dashed", "return"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct SequenceSpec {
    pub schema_version: u32,
    pub diagram_type: String,
    pub meta: Meta,
    pub participants: Vec<SequenceParticipant>,
    pub messages: Vec<SequenceMessage>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(as = "Option<_>", optional))]
    pub segments: Vec<SequenceSegment>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(as = "Option<_>", optional))]
    pub activations: Vec<SequenceActivation>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(as = "Option<_>", optional))]
    pub cards: Vec<Card>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct SequenceParticipant {
    pub id: String,
    #[serde(rename = "type")]
    pub component_type: String,
    pub label: String,
    #[serde(flatten)]
    #[cfg_attr(feature = "typegen", ts(flatten))]
    pub decoration: Decoration,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct SequenceMessage {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub id: Option<String>,
    pub from: String,
    pub to: String,
    pub y: f64,
    pub label: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub variant: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct SequenceSegment {
    pub from: f64,
    pub to: f64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct SequenceActivation {
    pub participant: String,
    pub from: f64,
    pub to: f64,
    #[serde(default, rename = "type")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub component_type: Option<String>,
}

fn child_fields(value: &Value, collection: &str, fields: &[&str], ctx: &mut common::Context) {
    if let Some(items) = value.get(collection).and_then(Value::as_array) {
        for (index, item) in items.iter().enumerate() {
            ctx.fields(item, &format!("/{collection}/{index}"), fields);
        }
    }
}

pub(crate) fn validate(value: Value) -> Vec<Diagnostic> {
    let mut ctx = common::base(
        &value,
        KIND,
        &[
            "schema_version",
            "diagram_type",
            "meta",
            "participants",
            "messages",
            "segments",
            "activations",
            "cards",
        ],
        &["column_fit"],
        (480.0, 480.0),
    );
    child_fields(
        &value,
        "participants",
        &[
            "id", "type", "label", "sublabel", "icon", "brand", "sources",
        ],
        &mut ctx,
    );
    child_fields(
        &value,
        "messages",
        &["id", "from", "to", "y", "label", "variant", "note"],
        &mut ctx,
    );
    child_fields(&value, "segments", &["from", "to", "label"], &mut ctx);
    child_fields(
        &value,
        "activations",
        &["participant", "from", "to", "type"],
        &mut ctx,
    );
    let Some(spec) = common::decode::<SequenceSpec>(&value, &mut ctx) else {
        return ctx.finish();
    };
    ctx.cardinality(spec.participants.len(), 2, "/participants");
    ctx.cardinality(spec.messages.len(), 1, "/messages");
    let mut participants = HashSet::new();
    for (index, participant) in spec.participants.iter().enumerate() {
        let path = format!("/participants/{index}");
        ctx.insert_id(&mut participants, &participant.id, &format!("{path}/id"));
        ctx.enum_value(&participant.component_type, TYPES, &format!("{path}/type"));
        ctx.text(&participant.label, 1, None, &format!("{path}/label"));
        common::validate_decoration(&participant.decoration, &path, &mut ctx);
    }
    let mut focus_ids = participants.clone();
    let mut message_ids = HashSet::new();
    for (index, message) in spec.messages.iter().enumerate() {
        let path = format!("/messages/{index}");
        if let Some(id) = &message.id {
            ctx.insert_id(&mut message_ids, id, &format!("{path}/id"));
            focus_ids.insert(id.clone());
        }
        ctx.reference(
            &message.from,
            &participants,
            &format!("{path}/from"),
            "participant-reference",
        );
        ctx.reference(
            &message.to,
            &participants,
            &format!("{path}/to"),
            "participant-reference",
        );
        ctx.range(message.y, Some(160.0), None, &format!("{path}/y"));
        ctx.text(&message.label, 1, None, &format!("{path}/label"));
        if let Some(variant) = &message.variant {
            ctx.enum_value(variant, VARIANTS, &format!("{path}/variant"));
        }
    }
    for (index, segment) in spec.segments.iter().enumerate() {
        let path = format!("/segments/{index}");
        ctx.text(&segment.label, 1, None, &format!("{path}/label"));
        if segment.to <= segment.from {
            ctx.error(
                "range-order",
                &format!("{path}/to"),
                "segment end must be greater than its start",
                "set segment.to above segment.from",
            );
        }
    }
    for (index, activation) in spec.activations.iter().enumerate() {
        let path = format!("/activations/{index}");
        ctx.reference(
            &activation.participant,
            &participants,
            &format!("{path}/participant"),
            "participant-reference",
        );
        if activation.to <= activation.from {
            ctx.error(
                "range-order",
                &format!("{path}/to"),
                "activation end must be greater than its start",
                "set activation.to above activation.from",
            );
        }
        if let Some(component_type) = &activation.component_type {
            ctx.enum_value(component_type, TYPES, &format!("{path}/type"));
        }
    }
    common::validate_meta_refs(&spec.meta, &focus_ids, &mut ctx);
    ctx.finish()
}

#[cfg(feature = "typegen")]
pub fn declarations(cfg: &ts_rs::Config) -> Vec<String> {
    use ts_rs::TS;
    vec![
        SequenceParticipant::decl(cfg),
        SequenceMessage::decl(cfg),
        SequenceSegment::decl(cfg),
        SequenceActivation::decl(cfg),
        SequenceSpec::decl(cfg),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn minimal() -> Value {
        json!({
            "schema_version": 1, "diagram_type": "sequence",
            "meta": { "title": "Sequence", "output": "sequence.html" },
            "participants": [
                { "id": "client", "type": "frontend", "label": "Client" },
                { "id": "api", "type": "backend", "label": "API" }
            ],
            "messages": [{ "from": "client", "to": "api", "y": 180, "label": "Call" }]
        })
    }

    #[test]
    fn accepts_minimal_sequence_with_defaulted_ranges_and_decorations_absent() {
        assert!(validate(minimal()).is_empty());
    }

    #[test]
    fn rejects_missing_participants_and_reversed_ranges_with_actionable_diagnostics() {
        let mut spec = minimal();
        spec["messages"][0]["from"] = json!("missing");
        spec["segments"] = json!([{ "from": 220, "to": 180, "label": "Phase" }]);
        spec["activations"] = json!([{ "participant": "missing", "from": 220, "to": 180 }]);
        let diagnostics = validate(spec);
        assert!(diagnostics
            .iter()
            .any(|item| item.code == "sequence/participant-reference"));
        assert!(diagnostics
            .iter()
            .any(|item| item.code == "sequence/range-order"));
        assert!(diagnostics
            .iter()
            .all(|item| !item.message.is_empty() && !item.fix.is_empty()));
    }

    #[test]
    fn rejects_duplicate_authored_message_ids_and_unknown_fields() {
        let mut spec = minimal();
        spec["messages"][0]["id"] = json!("message");
        spec["messages"].as_array_mut().unwrap().push(json!({
            "id": "message", "from": "api", "to": "client", "y": 230, "label": "Reply"
        }));
        spec["participants"][0]["tag"] = json!("not supported for a participant");
        let diagnostics = validate(spec);
        assert!(diagnostics
            .iter()
            .any(|item| item.code == "sequence/duplicate-id"));
        assert!(diagnostics
            .iter()
            .any(|item| item.code == "sequence/unknown-field"));
    }
}
