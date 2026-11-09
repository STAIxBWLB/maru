//! Semantic identifiers retained from an accepted source spec for SVG output.

use crate::Diagnostic;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticContext {
    pub family: String,
    pub schema_version: u32,
    pub nodes: BTreeMap<String, NodeSemantic>,
    #[serde(default)]
    pub frame_variants: BTreeMap<String, String>,
    #[serde(default)]
    pub activations: BTreeMap<String, ActivationSemantic>,
    /// Authored transition override, keyed by the producer's stable route id.
    #[serde(default)]
    pub lifecycle_variants: BTreeMap<String, Option<String>>,
    #[serde(default)]
    pub route_labels: BTreeMap<String, RouteLabelSemantic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeSemantic {
    pub kind: String,
    #[serde(default)]
    pub lane: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivationSemantic {
    pub explicit_type: Option<String>,
    pub participant_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteLabelSemantic {
    pub primary_lines: usize,
}

impl SemanticContext {
    /// Preserve only node identity and semantic type/lane; coordinates and
    /// other layout inputs deliberately do not cross into this context.
    pub fn from_spec(spec: &Value) -> Result<Self, Diagnostic> {
        let family = spec
            .get("diagram_type")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                super::error(
                    "semantic",
                    "/diagram_type",
                    "diagram family is missing or is not a string",
                    "provide one accepted diagram family: architecture, workflow, sequence, dataflow, or lifecycle",
                )
            })?;
        let (collection, lane_required) = match family {
            "architecture" => ("components", false),
            "workflow" => ("nodes", true),
            "sequence" => ("participants", false),
            "dataflow" => ("nodes", false),
            "lifecycle" => ("states", true),
            _ => {
                return Err(super::error(
                    "semantic",
                    "/diagram_type",
                    format!("unsupported diagram family {family:?}"),
                    "use an accepted family: architecture, workflow, sequence, dataflow, or lifecycle",
                ));
            }
        };
        let schema_version = spec
            .get("schema_version")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| {
                super::error(
                    "semantic",
                    "/schema_version",
                    "schema version is missing or is not a supported unsigned integer",
                    "provide the accepted integer schema_version for this diagram family",
                )
            })?;
        let entries = spec
            .get(collection)
            .and_then(Value::as_array)
            .ok_or_else(|| {
                super::error(
                    "semantic",
                    &format!("/{collection}"),
                    format!("semantic collection {collection:?} is missing or is not an array"),
                    "provide the accepted node collection for this diagram family",
                )
            })?;

        let mut nodes = BTreeMap::new();
        for (index, entry) in entries.iter().enumerate() {
            let path = format!("/{collection}/{index}");
            let object = entry.as_object().ok_or_else(|| {
                super::error(
                    "semantic",
                    &path,
                    "semantic node entry is not an object",
                    "provide each node as an object with id and type",
                )
            })?;
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    super::error(
                        "semantic",
                        &format!("{path}/id"),
                        "semantic node id is missing or is not a nonempty string",
                        "provide a unique nonempty id for every node",
                    )
                })?;
            let kind = object
                .get("type")
                .and_then(Value::as_str)
                .filter(|kind| !kind.is_empty())
                .ok_or_else(|| {
                    super::error(
                        "semantic",
                        &format!("{path}/type"),
                        "semantic node type is missing or is not a nonempty string",
                        "provide the accepted type for every node",
                    )
                })?;
            let lane = match object.get("lane") {
                Some(value) => Some(
                    value
                        .as_str()
                        .filter(|lane| !lane.is_empty())
                        .ok_or_else(|| {
                            super::error(
                                "semantic",
                                &format!("{path}/lane"),
                                "semantic lane is not a nonempty string",
                                "provide the accepted lane id for this node",
                            )
                        })?
                        .to_owned(),
                ),
                None if lane_required => {
                    return Err(super::error(
                        "semantic",
                        &format!("{path}/lane"),
                        "semantic lane is missing",
                        "provide the accepted lane id for this node",
                    ));
                }
                None => None,
            };
            if nodes
                .insert(
                    id.to_owned(),
                    NodeSemantic {
                        kind: kind.to_owned(),
                        lane,
                    },
                )
                .is_some()
            {
                return Err(super::error(
                    "semantic",
                    &format!("{path}/id"),
                    format!("duplicate semantic node id {id:?}"),
                    "provide a unique id for every node in the family collection",
                ));
            }
        }

        let frame_variants = if family == "workflow" {
            let mut variants = BTreeMap::new();
            collect_frame_variants(spec, "lanes", "lane", true, &mut variants)?;
            collect_frame_variants(spec, "phases", "phase", false, &mut variants)?;
            collect_frame_variants(spec, "groups", "group", false, &mut variants)?;
            variants
        } else {
            BTreeMap::new()
        };
        let activations = if family == "sequence" {
            collect_activation_semantics(spec)?
        } else {
            BTreeMap::new()
        };

        let mut lifecycle_variants = BTreeMap::new();
        if family == "lifecycle" {
            if let Some(transitions) = spec.get("transitions").and_then(Value::as_array) {
                let ids = crate::layout::allocate_route_ids(
                    "transition",
                    transitions
                        .iter()
                        .map(|edge| edge.get("id").and_then(Value::as_str)),
                );
                for (edge, id) in transitions.iter().zip(ids) {
                    lifecycle_variants.insert(
                        id,
                        edge.get("variant")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    );
                }
            }
        }
        let route_labels = collect_route_labels(spec, family);
        Ok(Self {
            family: family.to_owned(),
            schema_version,
            nodes,
            frame_variants,
            activations,
            lifecycle_variants,
            route_labels,
        })
    }
}

fn collect_route_labels(spec: &Value, family: &str) -> BTreeMap<String, RouteLabelSemantic> {
    let (collection, prefix) = match family {
        "architecture" => ("connections", "connection"),
        "workflow" => ("edges", "edge"),
        "sequence" => ("messages", "message"),
        "dataflow" => ("flows", "flow"),
        "lifecycle" => ("transitions", "transition"),
        _ => return BTreeMap::new(),
    };
    let Some(entries) = spec.get(collection).and_then(Value::as_array) else {
        return BTreeMap::new();
    };
    let ids = crate::layout::allocate_route_ids(
        prefix,
        entries
            .iter()
            .map(|entry| entry.get("id").and_then(Value::as_str)),
    );
    entries
        .iter()
        .zip(ids)
        .map(|(entry, id)| {
            let primary_lines = entry
                .get("label")
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty())
                .map(|label| label.split('\n').count())
                .unwrap_or(0);
            (id, RouteLabelSemantic { primary_lines })
        })
        .collect()
}

fn collect_activation_semantics(
    spec: &Value,
) -> Result<BTreeMap<String, ActivationSemantic>, Diagnostic> {
    let Some(value) = spec.get("activations") else {
        return Ok(BTreeMap::new());
    };
    let entries = value.as_array().ok_or_else(|| {
        super::error(
            "semantic",
            "/activations",
            "sequence activations are not an array",
            "provide the accepted sequence activation collection",
        )
    })?;

    // Read participant types from the source collection itself. These raw
    // values let both SVG passes apply the accepted component-type fallback
    // independently, without relying on a presentation default.
    let participant_types: BTreeMap<&str, &str> = spec
        .get("participants")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|participant| {
            Some((
                participant.get("id")?.as_str()?,
                participant.get("type")?.as_str()?,
            ))
        })
        .collect();

    let mut activations = BTreeMap::new();
    for (index, activation) in entries.iter().enumerate() {
        let object = activation.as_object().ok_or_else(|| {
            super::error(
                "semantic",
                &format!("/activations/{index}"),
                "sequence activation is not an object",
                "provide each activation as an object with a participant id",
            )
        })?;
        let explicit_type = object
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let participant_type = object
            .get("participant")
            .and_then(Value::as_str)
            .and_then(|id| participant_types.get(id))
            .map(|kind| (*kind).to_owned());
        activations.insert(
            format!("activation:{index}"),
            ActivationSemantic {
                explicit_type,
                participant_type,
            },
        );
    }
    Ok(activations)
}

fn collect_frame_variants(
    spec: &Value,
    collection: &str,
    prefix: &str,
    required: bool,
    variants: &mut BTreeMap<String, String>,
) -> Result<(), Diagnostic> {
    let Some(value) = spec.get(collection) else {
        if required {
            return Err(super::error(
                "semantic",
                &format!("/{collection}"),
                format!("workflow {collection} collection is missing"),
                "provide the accepted workflow frame collection",
            ));
        }
        return Ok(());
    };
    if value.is_null() && !required {
        return Ok(());
    }
    let entries = value.as_array().ok_or_else(|| {
        super::error(
            "semantic",
            &format!("/{collection}"),
            format!("workflow {collection} collection is not an array"),
            "provide the accepted workflow frame collection",
        )
    })?;
    let mut seen = BTreeMap::<String, usize>::new();
    for (index, entry) in entries.iter().enumerate() {
        let path = format!("/{collection}/{index}");
        let object = entry.as_object().ok_or_else(|| {
            super::error(
                "semantic",
                &path,
                "workflow frame entry is not an object",
                "provide each frame as an object with a unique id",
            )
        })?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                super::error(
                    "semantic",
                    &format!("{path}/id"),
                    "workflow frame id is missing or is not a nonempty string",
                    "provide a unique nonempty id within this frame collection",
                )
            })?;
        if seen.insert(id.to_owned(), index).is_some() {
            return Err(super::error(
                "semantic",
                &format!("{path}/id"),
                format!("duplicate workflow {collection} id {id:?}"),
                "provide a unique id within this frame collection",
            ));
        }
        if let Some(value) = object.get("variant").filter(|value| !value.is_null()) {
            let variant = value
                .as_str()
                .filter(|variant| !variant.trim().is_empty())
                .ok_or_else(|| {
                    super::error(
                        "semantic",
                        &format!("{path}/variant"),
                        "workflow frame variant is not a nonempty string",
                        "provide the accepted nonempty variant string or omit variant",
                    )
                })?;
            variants.insert(format!("{prefix}:{id}"), variant.to_owned());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{NodeSemantic, SemanticContext};
    use serde_json::json;

    #[test]
    fn maps_semantic_nodes_for_all_five_families() {
        let cases = [
            (
                "architecture",
                json!({"components":[{"id":"a","type":"database"}]}),
                "database",
                None,
            ),
            (
                "workflow",
                json!({"lanes":[{"id":"main","label":"Main"}],"nodes":[{"id":"a","type":"backend","lane":"main"}]}),
                "backend",
                Some("main"),
            ),
            (
                "sequence",
                json!({"participants":[{"id":"a","type":"frontend"}]}),
                "frontend",
                None,
            ),
            (
                "dataflow",
                json!({"nodes":[{"id":"a","type":"messagebus","stage":2}]}),
                "messagebus",
                None,
            ),
            (
                "lifecycle",
                json!({"states":[{"id":"a","type":"decision","lane":"main"}]}),
                "decision",
                Some("main"),
            ),
        ];
        for (family, nodes, kind, lane) in cases {
            let mut spec = json!({"diagram_type":family,"schema_version":1});
            for (key, value) in nodes.as_object().unwrap() {
                spec[key.as_str()] = value.clone();
            }
            let context = SemanticContext::from_spec(&spec).unwrap();
            assert_eq!(context.family, family);
            assert_eq!(context.schema_version, 1);
            assert_eq!(
                context.nodes.get("a"),
                Some(&NodeSemantic {
                    kind: kind.into(),
                    lane: lane.map(str::to_owned),
                })
            );
        }
    }

    #[test]
    fn rejects_missing_and_duplicate_ids() {
        let missing = json!({"diagram_type":"architecture","schema_version":1,"components":[{"type":"backend"}]});
        let error = SemanticContext::from_spec(&missing).unwrap_err();
        assert_eq!(error.path, "/components/0/id");

        let duplicate = json!({"diagram_type":"sequence","schema_version":1,"participants":[{"id":"a","type":"frontend"},{"id":"a","type":"backend"}]});
        let error = SemanticContext::from_spec(&duplicate).unwrap_err();
        assert_eq!(error.path, "/participants/1/id");
    }

    #[test]
    fn ignores_layout_coordinates_and_other_spec_fields() {
        let base = json!({"diagram_type":"workflow","schema_version":2,"meta":{"viewBox":[900,700]},"lanes":[{"id":"main","label":"Main","variant":"exception"}],"phases":[{"id":"build","label":"Build","fromCol":0,"toCol":2,"variant":"dashed"}],"groups":[{"id":"secure","label":"Secure","lane":"main","fromCol":1,"toCol":2,"variant":"security"}],"nodes":[{"id":"a","type":"backend","lane":"main","col":1,"width":100,"height":60,"yOffset":4}],"edges":[]});
        let changed = json!({"diagram_type":"workflow","schema_version":2,"meta":{"viewBox":[1400,1200]},"layout":{"origin":[75,95]},"lanes":[{"id":"main","label":"Main","variant":"exception"}],"phases":[{"id":"build","label":"Build","fromCol":4,"toCol":5,"variant":"dashed"}],"groups":[{"id":"secure","label":"Secure","lane":"main","fromCol":3,"toCol":5,"variant":"security"}],"nodes":[{"id":"a","type":"backend","lane":"main","col":5,"width":210,"height":130,"yOffset":99,"pos":[777,888],"row":8,"x":17,"y":29}],"edges":[]});
        assert_eq!(
            SemanticContext::from_spec(&base).unwrap(),
            SemanticContext::from_spec(&changed).unwrap()
        );
    }

    #[test]
    fn maps_workflow_frame_variants_by_namespaced_id() {
        let spec = json!({"diagram_type":"workflow","schema_version":2,"lanes":[{"id":"main","label":"Main"},{"id":"catch","label":"Catch","variant":"exception"}],"phases":[{"id":"prepare","label":"Prepare","fromCol":0,"toCol":1,"variant":"dashed"}],"groups":[{"id":"guard","label":"Guard","lane":"main","fromCol":0,"toCol":1,"variant":"security"}],"nodes":[{"id":"n","type":"backend","lane":"main","col":0}]});
        let context = SemanticContext::from_spec(&spec).unwrap();
        assert_eq!(
            context.frame_variants.get("lane:catch").map(String::as_str),
            Some("exception")
        );
        assert_eq!(
            context
                .frame_variants
                .get("phase:prepare")
                .map(String::as_str),
            Some("dashed")
        );
        assert_eq!(
            context
                .frame_variants
                .get("group:guard")
                .map(String::as_str),
            Some("security")
        );
        assert!(!context.frame_variants.contains_key("lane:main"));
    }

    #[test]
    fn rejects_duplicate_frame_ids_and_malformed_variants() {
        let duplicate = json!({"diagram_type":"workflow","schema_version":2,"lanes":[{"id":"main","label":"Main"},{"id":"main","label":"Again"}],"nodes":[]});
        let error = SemanticContext::from_spec(&duplicate).unwrap_err();
        assert_eq!(error.path, "/lanes/1/id");

        let malformed = json!({"diagram_type":"workflow","schema_version":2,"lanes":[{"id":"main","label":"Main","variant":7}],"nodes":[]});
        let error = SemanticContext::from_spec(&malformed).unwrap_err();
        assert_eq!(error.path, "/lanes/0/variant");
    }

    #[test]
    fn keeps_nodes_in_id_order() {
        let spec = json!({"diagram_type":"architecture","schema_version":1,"components":[{"id":"z","type":"backend"},{"id":"a","type":"frontend"}]});
        let context = SemanticContext::from_spec(&spec).unwrap();
        assert_eq!(
            context.nodes.keys().cloned().collect::<Vec<_>>(),
            vec!["a".to_owned(), "z".to_owned()]
        );
        assert_eq!(context.nodes.len(), 2);
    }
}
