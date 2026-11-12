//! Versioned geometry DTOs and request parsing for the E2 layout pipeline.
//!
//! These contracts do not produce a layout. Placement, routing, metrics and
//! report construction are added by later E2 slices.

use crate::common::{self, Context};
pub use crate::layout::fixed::Coord;
use crate::layout::fixed::{self, FixedPointError};
use crate::{Diagnostic, EngineReceipt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const GEOMETRY_API_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub enum GeometryTargetKind {
    Node,
    Container,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub enum GeometryPositionSource {
    PlannedPin,
    AuthoredPosition,
    Automatic,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct GeometryPoint {
    pub x: Coord,
    pub y: Coord,
}

impl GeometryPoint {
    /// Quantize a pixel-space input exactly once at the system boundary.
    pub fn from_pixels(x: f64, y: f64) -> Result<Self, FixedPointError> {
        Ok(Self {
            x: fixed::quantize_pixels(x)?,
            y: fixed::quantize_pixels(y)?,
        })
    }

    pub fn checked_translate(self, dx: Coord, dy: Coord) -> Result<Self, FixedPointError> {
        Ok(Self {
            x: fixed::checked_add(self.x, dx)?,
            y: fixed::checked_add(self.y, dy)?,
        })
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct GeometryBox {
    pub x: Coord,
    pub y: Coord,
    pub width: Coord,
    pub height: Coord,
}

impl GeometryBox {
    pub fn new(x: Coord, y: Coord, width: Coord, height: Coord) -> Result<Self, FixedPointError> {
        if width < 0 || height < 0 {
            return Err(FixedPointError::NegativeDimension);
        }
        Ok(Self {
            x,
            y,
            width,
            height,
        })
    }

    pub fn from_pixels(x: f64, y: f64, width: f64, height: f64) -> Result<Self, FixedPointError> {
        Self::new(
            fixed::quantize_pixels(x)?,
            fixed::quantize_pixels(y)?,
            fixed::quantize_pixels(width)?,
            fixed::quantize_pixels(height)?,
        )
    }

    pub fn right(self) -> Result<Coord, FixedPointError> {
        fixed::checked_add(self.x, self.width)
    }

    pub fn bottom(self) -> Result<Coord, FixedPointError> {
        fixed::checked_add(self.y, self.height)
    }

    pub fn area(self) -> Result<i64, FixedPointError> {
        fixed::checked_area(self.width, self.height)
    }

    pub fn checked_translate(self, dx: Coord, dy: Coord) -> Result<Self, FixedPointError> {
        Self::new(
            fixed::checked_add(self.x, dx)?,
            fixed::checked_add(self.y, dy)?,
            self.width,
            self.height,
        )
    }

    pub fn union(self, other: Self) -> Result<Self, FixedPointError> {
        let left = self.x.min(other.x);
        let top = self.y.min(other.y);
        let right = self.right()?.max(other.right()?);
        let bottom = self.bottom()?.max(other.bottom()?);
        Self::new(
            left,
            top,
            fixed::checked_sub(right, left)?,
            fixed::checked_sub(bottom, top)?,
        )
    }

    pub fn contains(self, point: GeometryPoint) -> Result<bool, FixedPointError> {
        Ok(point.x >= self.x
            && point.x <= self.right()?
            && point.y >= self.y
            && point.y <= self.bottom()?)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct FontIdentity {
    pub id: String,
    pub revision: String,
    pub font_sha256: String,
    pub weight: u16,
    pub units_per_em: u16,
    pub license: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct GeometryNode {
    /// Optional semantic classification; coordinates and API version are unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub final_state: Option<bool>,
    /// The shape the engine drew this member as. `true` is an ellipse whose
    /// text was fitted inside the curve, `false` is one the fit demoted to a
    /// rounded box, and absent means the family never draws this member as a
    /// curve. The canvas and the writer draw what this says, so a demoted
    /// state's own label cannot cross a curve the engine removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub ellipse: Option<bool>,
    /// Authored main-lane column, for both versions, independent of pinned positions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub phase_order: Option<u32>,
    pub id: String,
    pub bounds: GeometryBox,
    /// Future placement resolution order is planned pin, authored position,
    /// then automatic placement.
    pub position_source: GeometryPositionSource,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct GeometryContainer {
    pub id: String,
    pub kind: String,
    pub bounds: GeometryBox,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct GeometryRoute {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub id: Option<String>,
    pub from: String,
    pub to: String,
    pub points: Vec<GeometryPoint>,
    pub variant: Option<String>,
    pub role: Option<String>,
    pub width: Option<Coord>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct GeometryGlyph {
    pub glyph_id: u16,
    pub input: String,
    pub position: GeometryPoint,
    pub ink: GeometryBox,
    pub advance: Coord,
    pub ignored: bool,
    pub replaced: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct GeometryLabel {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub id: Option<String>,
    pub target_id: String,
    pub text: String,
    pub bounds: GeometryBox,
    pub font: FontIdentity,
    pub font_size: Coord,
    pub glyphs: Vec<GeometryGlyph>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct GeometryLegendEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub swatch_bounds: Option<GeometryBox>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub text_bounds: Option<GeometryBox>,
    pub key: String,
    pub label: String,
    pub bounds: GeometryBox,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct GeometryLegend {
    /// Invisible extent of every legend label and painted primitive.
    #[serde(
        default,
        rename = "contentBounds",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typegen", ts(rename = "contentBounds", optional = nullable))]
    pub content_bounds: Option<GeometryBox>,
    #[serde(default, rename = "titleY", skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typegen", ts(rename = "titleY", optional = nullable))]
    pub title_y: Option<Coord>,
    pub bounds: GeometryBox,
    pub entries: Vec<GeometryLegendEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct GeometryPage {
    pub bounds: GeometryBox,
    /// Translation this page applies to the source drawing, so an emitted
    /// position is `source + contentOffset`. It is present only when a family
    /// draws its header inside the page (workflow, dataflow): every authored
    /// coordinate stays in source space, so a consumer that turns an emitted
    /// canvas position back into an authored one subtracts this offset
    /// (`maru#561`). Absent fields read as (0,0).
    #[serde(
        default,
        rename = "contentOffset",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typegen", ts(rename = "contentOffset", optional = nullable))]
    pub content_offset: Option<GeometryPoint>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct GeometryLine {
    pub from: GeometryPoint,
    pub to: GeometryPoint,
}

/// What a render primitive is derived from, in the source spec's terms. The
/// `kind` string is the writer's own vocabulary (`sequence-lifeline`,
/// `lifecycle-band`, `legend-node-swatch`, ...), so a consumer can special-case
/// one primitive without guessing from geometry.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub enum GeometryPrimitiveLayer {
    /// Painted before the routes, like a lane frame: nothing it draws can hide
    /// an edge the engine routed.
    Underlay,
    /// Painted after the members, like a lifecycle final border.
    Overlay,
}

/// The semantic colour role of a render primitive. The theme maps each role to
/// concrete colours; a consumer that has its own palette maps the role instead
/// of the colour, so canvas and export stay in step.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub enum GeometryPrimitivePaint {
    Line,
    AccentLine,
    SecurityLine,
    DashedLine,
    Node,
    OutlineNode,
    AccentFill,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub enum GeometryPrimitiveShape {
    Rect {
        bounds: GeometryBox,
        radius: Coord,
    },
    Line {
        from: GeometryPoint,
        to: GeometryPoint,
    },
    Polyline {
        points: Vec<GeometryPoint>,
    },
    Circle {
        center: GeometryPoint,
        radius: Coord,
    },
    /// An ellipse with its own two radii: a lifecycle final border around a
    /// state the engine kept as a curve has to follow that curve, and a circle
    /// cannot.
    Ellipse {
        center: GeometryPoint,
        rx: Coord,
        ry: Coord,
    },
    Polygon {
        points: Vec<GeometryPoint>,
    },
}

/// A shape the writer paints that is not a member, a container or a route:
/// a sequence lifeline, a workflow phase span, a lifecycle initial marker, rail
/// or band, a lifecycle final border, or a legend swatch.
///
/// These are derived from the retained geometry (`maru#552` E4). Without them
/// the canvas draws a sequence with no lifelines, so the messages float, and a
/// lifecycle scene with no initial marker or band.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct GeometryPrimitive {
    pub kind: String,
    /// The member, container, route or legend key the primitive belongs to.
    pub owner: String,
    pub shape: GeometryPrimitiveShape,
    pub paint: GeometryPrimitivePaint,
    /// Stroke width exactly as the writer paints it, in pixels.
    pub stroke: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub dash: Option<String>,
    pub arrow: bool,
    pub layer: GeometryPrimitiveLayer,
}

impl GeometryPrimitive {
    /// The same primitive expressed in the writer's own terms.
    pub(crate) fn from_derived(p: &crate::primitives::Primitive) -> Self {
        use crate::primitives::{Layer, Paint, Shape};
        Self {
            kind: p.kind.to_owned(),
            owner: p.owner.clone(),
            shape: match &p.shape {
                Shape::Rect { bounds, radius } => GeometryPrimitiveShape::Rect {
                    bounds: *bounds,
                    radius: *radius,
                },
                Shape::Line { from, to } => GeometryPrimitiveShape::Line {
                    from: *from,
                    to: *to,
                },
                Shape::Polyline { points } => GeometryPrimitiveShape::Polyline {
                    points: points.clone(),
                },
                Shape::Circle { center, radius } => GeometryPrimitiveShape::Circle {
                    center: *center,
                    radius: *radius,
                },
                Shape::Ellipse { center, rx, ry } => GeometryPrimitiveShape::Ellipse {
                    center: *center,
                    rx: *rx,
                    ry: *ry,
                },
                Shape::Polygon { points } => GeometryPrimitiveShape::Polygon {
                    points: points.clone(),
                },
            },
            paint: match p.paint {
                Paint::Line => GeometryPrimitivePaint::Line,
                Paint::AccentLine => GeometryPrimitivePaint::AccentLine,
                Paint::SecurityLine => GeometryPrimitivePaint::SecurityLine,
                Paint::DashedLine => GeometryPrimitivePaint::DashedLine,
                Paint::Node => GeometryPrimitivePaint::Node,
                Paint::OutlineNode => GeometryPrimitivePaint::OutlineNode,
                Paint::AccentFill => GeometryPrimitivePaint::AccentFill,
            },
            stroke: p.stroke.to_owned(),
            dash: p.dash.map(str::to_owned),
            arrow: p.arrow,
            layer: match p.layer {
                Layer::Underlay => GeometryPrimitiveLayer::Underlay,
                Layer::Overlay => GeometryPrimitiveLayer::Overlay,
            },
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
pub struct GeometryDocument {
    #[serde(
        default,
        rename = "lifecycleRail",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "typegen", ts(rename = "lifecycleRail", optional = nullable))]
    pub lifecycle_rail: Option<GeometryLine>,
    pub nodes: Vec<GeometryNode>,
    pub containers: Vec<GeometryContainer>,
    pub routes: Vec<GeometryRoute>,
    pub labels: Vec<GeometryLabel>,
    /// Render primitives derived from this geometry and the source semantics, in
    /// paint order: every underlay first, then every overlay. Absent for a scene
    /// decoded from a report written before they were published.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub primitives: Vec<GeometryPrimitive>,
    pub legend: GeometryLegend,
    pub page: GeometryPage,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct GeometryReport {
    pub api_version: u32,
    pub ok: bool,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub geometry: Option<GeometryDocument>,
    pub diagnostics: Vec<Diagnostic>,
    pub receipt: EngineReceipt,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct LayoutRequest {
    pub spec_json: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub pin_set: Option<PinSet>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct PinSet {
    pub source_spec_sha256: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(as = "Option<Vec<GeometryPin>>", optional))]
    pub pins: Vec<GeometryPin>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct GeometryPin {
    pub target_id: String,
    pub target_kind: GeometryTargetKind,
    pub position: GeometryPoint,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", ts(optional = nullable))]
    pub role: Option<String>,
}

/// Nonfatal pin reconciliation, separate from request/scene validity errors.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename_all = "camelCase"))]
pub struct PinResolution {
    pub pins: Vec<GeometryPin>,
    pub source_changed: bool,
    pub diagnostics: Vec<Diagnostic>,
}

/// These output namespaces describe member/timeline-derived geometry, not
/// independently authored position targets. Nodes with similar IDs are unaffected.
pub(crate) fn is_derived_container_id(id: &str) -> bool {
    id.split_once(':').is_some_and(|(role, _)| {
        matches!(
            role,
            "boundary" | "stage" | "segment" | "activation" | "card"
        )
    })
}

/// Resolve against current semantic members, never against array slots or an
/// exact source hash. Placement supplies its current node/container identity set.
/// Retained pins keep their input order and exact fixed-point positions.
pub fn resolve_pins<'a>(
    request: &LayoutRequest,
    members: impl IntoIterator<Item = (GeometryTargetKind, &'a str)>,
) -> PinResolution {
    let mut result = PinResolution {
        pins: Vec::new(),
        source_changed: false,
        diagnostics: Vec::new(),
    };
    let Some(pin_set) = &request.pin_set else {
        return result;
    };
    result.source_changed = pin_set.source_spec_sha256 != crate::spec_hash(&request.spec_json);
    if result.source_changed {
        result.diagnostics.push(Diagnostic {
            code: "document/pin-source-stale".into(), path: "/pinSet/sourceSpecSha256".into(),
            rule: "pin-v1/source-staleness".into(),
            message: "the source spec changed; pins for surviving independent members are retained".into(),
            fix: "review retained positions after the edit and update the pin set source hash when saving".into(),
        });
    }
    let members: HashMap<_, _> = members.into_iter().map(|(kind, id)| (id, kind)).collect();
    for (index, pin) in pin_set.pins.iter().enumerate() {
        if let Some(kind) = members.get(pin.target_id.as_str()) {
            if *kind == GeometryTargetKind::Container && is_derived_container_id(&pin.target_id) {
                result.diagnostics.push(Diagnostic {
                    code:"document/pin-member-removed".into(),path:format!("/pinSet/pins/{index}"),
                    rule:"pin-v1/derived-container".into(),
                    message:format!("pin {:?} was dropped because this container's position derives from its members",pin.target_id),
                    fix:"remove this pin and edit or pin the members or timeline that determine this container".into(),
                });
                continue;
            }
            let mut retained = pin.clone();
            retained.target_kind = *kind;
            result.pins.push(retained);
        } else {
            result.diagnostics.push(Diagnostic {
                code: "document/pin-member-removed".into(), path: format!("/pinSet/pins/{index}"),
                rule: "pin-v1/member-existence".into(),
                message: format!("pin {:?} was dropped because its semantic member no longer exists", pin.target_id),
                fix: "remove this pin from the saved pin set, or restore that member before pinning it again".into(),
            });
        }
    }
    result
}

fn lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Parse layout request shape. A prior source hash reports staleness only. This is an
/// input-preflight API only; it does not produce a geometry report.
pub fn parse_layout_request(input: &str) -> Result<LayoutRequest, Vec<Diagnostic>> {
    let mut ctx = Context::new("document");
    let value: Value = match serde_json::from_str(input) {
        Ok(value) => value,
        Err(error) => {
            ctx.error(
                "request-json",
                "/",
                format!("layout request is not valid JSON: {error}"),
                "repair the request JSON object and retry",
            );
            return Err(ctx.finish());
        }
    };
    ctx.fields(&value, "", &["specJson", "pinSet"]);
    if let Some(pin_set) = value.get("pinSet").filter(|item| !item.is_null()) {
        ctx.fields(pin_set, "/pinSet", &["sourceSpecSha256", "pins"]);
        if let Some(pins) = pin_set.get("pins").and_then(Value::as_array) {
            for (index, pin) in pins.iter().enumerate() {
                let path = format!("/pinSet/pins/{index}");
                ctx.fields(pin, &path, &["targetId", "targetKind", "position", "role"]);
                if pin.get("position").is_some() {
                    ctx.fields(
                        pin.get("position").unwrap(),
                        &format!("{path}/position"),
                        &["x", "y"],
                    );
                }
            }
        }
    }

    let Some(request) = common::decode::<LayoutRequest>(&value, &mut ctx) else {
        return Err(ctx.finish());
    };

    if request.spec_json.is_empty() {
        ctx.error(
            "spec-json",
            "/specJson",
            "source spec JSON is empty",
            "supply the exact nonempty serialized spec used for layout",
        );
        return Err(ctx.finish());
    }
    let spec: Value = match serde_json::from_str(&request.spec_json) {
        Ok(spec) => spec,
        Err(error) => {
            ctx.error(
                "spec-json",
                "/specJson",
                format!("source spec JSON is invalid: {error}"),
                "supply a valid serialized diagram object and retry",
            );
            return Err(ctx.finish());
        }
    };
    if !spec.is_object() {
        ctx.error(
            "spec-object",
            "/specJson",
            "source spec must be a JSON object",
            "supply a serialized diagram document object",
        );
        return Err(ctx.finish());
    }

    if let Some(pin_set) = &request.pin_set {
        if !lowercase_sha256(&pin_set.source_spec_sha256) {
            ctx.error(
                "pin-source-hash",
                "/pinSet/sourceSpecSha256",
                "sourceSpecSha256 must be a lowercase 64-character SHA-256 value",
                "hash the exact specJson UTF-8 bytes with SHA-256 and use lowercase hexadecimal",
            );
        }

        let mut seen = HashSet::new();
        for (index, pin) in pin_set.pins.iter().enumerate() {
            let path = format!("/pinSet/pins/{index}");
            if pin.target_id.trim().is_empty() {
                ctx.error(
                    "pin-target-id",
                    &format!("{path}/targetId"),
                    "pin targetId is empty",
                    "use the stable semantic member key for the pin target",
                );
            }
            if !seen.insert(pin.target_id.as_str()) {
                ctx.error(
                    "duplicate-pin-id",
                    &format!("{path}/targetId"),
                    format!("pin target id {:?} occurs more than once", pin.target_id),
                    "keep only one planned pin for each semantic member key",
                );
            }
        }
    }

    let diagnostics = ctx.finish();
    if diagnostics.is_empty() {
        Ok(request)
    } else {
        Err(diagnostics)
    }
}

#[cfg(feature = "typegen")]
pub fn declarations(cfg: &ts_rs::Config) -> Vec<String> {
    use ts_rs::TS;
    vec![
        GeometryTargetKind::decl(cfg),
        GeometryPositionSource::decl(cfg),
        GeometryPoint::decl(cfg),
        GeometryBox::decl(cfg),
        FontIdentity::decl(cfg),
        GeometryNode::decl(cfg),
        GeometryContainer::decl(cfg),
        GeometryRoute::decl(cfg),
        GeometryGlyph::decl(cfg),
        GeometryLabel::decl(cfg),
        GeometryLegendEntry::decl(cfg),
        GeometryLegend::decl(cfg),
        GeometryPage::decl(cfg),
        GeometryLine::decl(cfg),
        GeometryPrimitiveLayer::decl(cfg),
        GeometryPrimitivePaint::decl(cfg),
        GeometryPrimitiveShape::decl(cfg),
        GeometryPrimitive::decl(cfg),
        GeometryDocument::decl(cfg),
        GeometryReport::decl(cfg),
        LayoutRequest::decl(cfg),
        PinSet::decl(cfg),
        GeometryPin::decl(cfg),
        PinResolution::decl(cfg),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_json() -> String {
        r#"{"schema_version":1,"diagram_type":"architecture"}"#.to_string()
    }

    fn request_json(pin_set: Value) -> String {
        let spec_json = source_json();
        let source_hash = crate::spec_hash(&spec_json);
        serde_json::json!({"specJson":spec_json,"pinSet":{ "sourceSpecSha256": source_hash, "pins": pin_set }}).to_string()
    }

    #[test]
    fn quantized_geometry_uses_fixed_point_bounds_and_checked_arithmetic() {
        let origin = GeometryPoint::from_pixels(-0.5 / 64.0, 1.0).unwrap();
        assert_eq!(origin, GeometryPoint { x: -1, y: 64 });
        let bounds = GeometryBox::new(10, 20, 30, 40).unwrap();
        assert_eq!(bounds.right().unwrap(), 40);
        assert_eq!(bounds.bottom().unwrap(), 60);
        assert_eq!(bounds.area().unwrap(), 1200);
        assert_eq!(bounds.checked_translate(2, 3).unwrap().x, 12);
        assert_eq!(
            GeometryBox::new(0, 0, -1, 2),
            Err(FixedPointError::NegativeDimension)
        );
        assert_eq!(
            GeometryBox::new(Coord::MAX, 0, 1, 1).unwrap().right(),
            Err(FixedPointError::ArithmeticOverflow)
        );
    }

    #[test]
    fn layout_request_accepts_absent_pin_set_and_default_empty_pins() {
        let spec_json = source_json();
        let request_json = serde_json::json!({"specJson":spec_json}).to_string();
        let request = parse_layout_request(&request_json).unwrap();
        assert!(request.pin_set.is_none());
        let spec_json = source_json();
        let source_hash = crate::spec_hash(&spec_json);
        let request =
            serde_json::json!({"specJson":spec_json,"pinSet":{"sourceSpecSha256":source_hash}})
                .to_string();
        assert!(parse_layout_request(&request)
            .unwrap()
            .pin_set
            .unwrap()
            .pins
            .is_empty());
    }

    #[test]
    fn layout_request_rejects_malformed_hash_duplicate_targets_and_array_points() {
        let spec_json = source_json();
        let mismatched = serde_json::json!({"specJson":spec_json,"pinSet":{"sourceSpecSha256":"not-a-sha256","pins":[]}}).to_string();
        assert!(parse_layout_request(&mismatched)
            .unwrap_err()
            .iter()
            .any(|d| d.code == "document/pin-source-hash"));

        let duplicate = request_json(serde_json::json!([
            {"targetKind":"node","targetId":"node-a","position":{"x":64,"y":128}},
            {"targetKind":"container","targetId":"node-a","position":{"x":192,"y":256}}
        ]));
        assert!(parse_layout_request(&duplicate)
            .unwrap_err()
            .iter()
            .any(|d| d.code == "document/duplicate-pin-id"));

        let array_point = request_json(serde_json::json!([
            {"targetKind":"node","targetId":"node-a","position":[64,128]}
        ]));
        assert!(parse_layout_request(&array_point).is_err());
    }

    #[test]
    fn only_missing_members_are_dropped_with_individual_diagnostics() {
        let original = serde_json::json!({"schema_version":1,"diagram_type":"architecture","meta":{"title":"Before"}}).to_string();
        let edited = serde_json::json!({"schema_version":1,"diagram_type":"architecture","meta":{"title":"After"}}).to_string();
        let request = serde_json::json!({"specJson":edited,"pinSet":{
            "sourceSpecSha256": crate::spec_hash(&original), "pins":[
                {"targetKind":"node","targetId":"kept","position":{"x":-64,"y":128}},
                {"targetKind":"container","targetId":"gone-a","position":{"x":192,"y":256}},
                {"targetKind":"node","targetId":"gone-b","position":{"x":320,"y":384}}
            ]
        }})
        .to_string();
        let request = parse_layout_request(&request).unwrap();
        let resolved = resolve_pins(&request, [(GeometryTargetKind::Node, "kept")]);
        assert!(resolved.source_changed);
        assert_eq!(resolved.pins, request.pin_set.as_ref().unwrap().pins[..1]);
        assert_eq!(resolved.pins[0].position, GeometryPoint { x: -64, y: 128 });
        let removed: Vec<_> = resolved
            .diagnostics
            .iter()
            .filter(|d| d.code == "document/pin-member-removed")
            .collect();
        assert_eq!(removed.len(), 2);
        assert_eq!(removed[0].path, "/pinSet/pins/1");
        assert_eq!(removed[1].path, "/pinSet/pins/2");
        assert!(resolved
            .diagnostics
            .iter()
            .any(|d| d.code == "document/pin-source-stale"));
    }

    #[test]
    fn editing_an_unrelated_valid_spec_field_keeps_every_existing_pin() {
        let original = include_str!("../testdata/valid-architecture.json");
        let mut edited: Value = serde_json::from_str(original).unwrap();
        edited["meta"]["title"] = Value::String("Renamed diagram".into());
        let edited = edited.to_string();
        assert!(crate::validate_json(original).ok);
        assert!(crate::validate_json(&edited).ok);
        let request = serde_json::json!({"specJson":edited,"pinSet":{
            "sourceSpecSha256":crate::spec_hash(original),"pins":[
                {"targetKind":"node","targetId":"a","position":{"x":64,"y":128}},
                {"targetKind":"node","targetId":"b","position":{"x":192,"y":256}}
            ]
        }})
        .to_string();
        let request = parse_layout_request(&request).unwrap();
        let resolved = resolve_pins(
            &request,
            [
                (GeometryTargetKind::Node, "a"),
                (GeometryTargetKind::Node, "b"),
            ],
        );
        assert_eq!(resolved.pins, request.pin_set.as_ref().unwrap().pins);
        assert!(resolved.source_changed);
        assert_eq!(resolved.diagnostics.len(), 1);
        assert_eq!(resolved.diagnostics[0].code, "document/pin-source-stale");
    }

    #[test]
    fn a_surviving_member_id_keeps_its_position_when_its_kind_changes() {
        let request = parse_layout_request(&request_json(serde_json::json!([
            {"targetKind":"node","targetId":"kept","position":{"x":64,"y":128}}
        ])))
        .unwrap();
        let resolved = resolve_pins(&request, [(GeometryTargetKind::Container, "kept")]);
        assert_eq!(resolved.pins.len(), 1);
        assert_eq!(
            resolved.pins[0].position,
            request.pin_set.unwrap().pins[0].position
        );
        assert_eq!(resolved.pins[0].target_kind, GeometryTargetKind::Container);
        assert!(resolved.diagnostics.is_empty());
    }

    #[test]
    fn derived_containers_are_dropped_individually_but_explicit_members_remain_pinnable() {
        let ids = [
            "boundary:0",
            "stage:0",
            "segment:0",
            "activation:0",
            "card:0",
            "lane:main",
            "group:workers",
            "phase:build",
        ];
        let pins:Vec<_>=ids.iter().map(|id|serde_json::json!({"targetId":id,"targetKind":"container","position":{"x":64,"y":128}})).collect();
        let request = parse_layout_request(&request_json(serde_json::json!(pins))).unwrap();
        let resolution = resolve_pins(
            &request,
            ids.iter().map(|id| (GeometryTargetKind::Container, *id)),
        );
        assert_eq!(
            resolution
                .pins
                .iter()
                .map(|p| p.target_id.as_str())
                .collect::<Vec<_>>(),
            ids[5..]
        );
        assert_eq!(resolution.diagnostics.len(), 5);
        for (index, diagnostic) in resolution.diagnostics.iter().enumerate() {
            assert_eq!(diagnostic.code, "document/pin-member-removed");
            assert_eq!(diagnostic.path, format!("/pinSet/pins/{index}"));
            assert!(diagnostic
                .message
                .contains("this container's position derives from its members"));
            assert!(!diagnostic.fix.is_empty());
        }
    }

    #[test]
    fn unchanged_source_and_absent_pins_have_no_staleness_notice() {
        let request = parse_layout_request(&request_json(serde_json::json!([
            {"targetKind":"node","targetId":"kept","position":{"x":64,"y":128}}
        ])))
        .unwrap();
        let resolved = resolve_pins(&request, [(GeometryTargetKind::Node, "kept")]);
        assert!(!resolved.source_changed);
        assert!(resolved.diagnostics.is_empty());
        assert_eq!(resolved.pins, request.pin_set.unwrap().pins);
        let request = LayoutRequest {
            spec_json: source_json(),
            pin_set: None,
        };
        assert!(resolve_pins(&request, []).pins.is_empty());
    }

    #[test]
    fn layout_request_rejects_nonobject_request_and_unknown_fields() {
        assert!(parse_layout_request("[]").is_err());
        assert!(parse_layout_request(r#"{"specJson":"{}","unknown":true}"#).is_err());
        assert!(parse_layout_request(r#"{"specJson":"[]"}"#).is_err());
    }
}
