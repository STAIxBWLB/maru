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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeSemantic {
    pub kind: String,
    #[serde(default)]
    pub lane: Option<String>,
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

        Ok(Self {
            family: family.to_owned(),
            schema_version,
            nodes,
        })
    }
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
                json!({"nodes":[{"id":"a","type":"backend","lane":"main"}]}),
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
        let base = json!({"diagram_type":"workflow","schema_version":2,"meta":{"viewBox":[900,700]},"nodes":[{"id":"a","type":"backend","lane":"main","col":1,"width":100,"height":60,"yOffset":4}],"edges":[]});
        let changed = json!({"diagram_type":"workflow","schema_version":2,"meta":{"viewBox":[1400,1200]},"layout":{"origin":[75,95]},"nodes":[{"id":"a","type":"backend","lane":"main","col":5,"width":210,"height":130,"yOffset":99,"pos":[777,888],"row":8,"x":17,"y":29}],"edges":[]});
        assert_eq!(
            SemanticContext::from_spec(&base).unwrap(),
            SemanticContext::from_spec(&changed).unwrap()
        );
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
