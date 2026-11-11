//! The semantic projection moved to `crate::semantics` so the layout can read
//! it to publish render primitives; this module keeps the writer's import path
//! (`render::SemanticContext`) working.
pub use crate::semantics::{ActivationSemantic, NodeSemantic, RouteLabelSemantic, SemanticContext};
