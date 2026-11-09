use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SvgTheme {
    Light,
    Dark,
}
pub(crate) struct Tokens {
    pub background: &'static str,
    pub text: &'static str,
    pub muted: &'static str,
    pub node_fill: &'static str,
    pub node_stroke: &'static str,
    pub lane_fill: &'static str,
    pub lane_stroke: &'static str,
    pub arrow: &'static str,
    pub emphasis: &'static str,
}
impl SvgTheme {
    pub fn name(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
    pub(crate) fn tokens(self) -> Tokens {
        match self {
            Self::Dark => Tokens {
                background: "#020617",
                text: "#ffffff",
                muted: "#94a3b8",
                node_fill: "#0f172a",
                node_stroke: "#34d399",
                lane_fill: "#0f172a",
                lane_stroke: "#334155",
                arrow: "#64748b",
                emphasis: "#34d399",
            },
            Self::Light => Tokens {
                background: "#f4f5f7",
                text: "#111827",
                muted: "#5b6474",
                node_fill: "#ffffff",
                node_stroke: "#059669",
                lane_fill: "#f8fafc",
                lane_stroke: "#cbd5e1",
                arrow: "#94a3b8",
                emphasis: "#059669",
            },
        }
    }
}
