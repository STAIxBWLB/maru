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
    pub mask: &'static str,
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
                mask: "#0f172a",
                lane_fill: "#0f172a",
                lane_stroke: "#334155",
                arrow: "#64748b",
                emphasis: "#34d399",
            },
            Self::Light => Tokens {
                background: "#f4f5f7",
                text: "#111827",
                muted: "#5b6474",
                mask: "#ffffff",
                lane_fill: "#f8fafc",
                lane_stroke: "#cbd5e1",
                arrow: "#94a3b8",
                emphasis: "#059669",
            },
        }
    }
}

/// One semantic component palette per theme. Lifecycle kinds alias the same
/// component tokens as the pinned renderer's typeClass mapping.
#[derive(Debug, Clone, Copy)]
pub(crate) struct KindTokens {
    pub fill: &'static str,
    pub stroke: &'static str,
}
const DARK_KINDS: [KindTokens; 7] = [
    KindTokens {
        fill: "rgba(8,51,68,0.4)",
        stroke: "#22d3ee",
    },
    KindTokens {
        fill: "rgba(6,78,59,0.4)",
        stroke: "#34d399",
    },
    KindTokens {
        fill: "rgba(76,29,149,0.4)",
        stroke: "#a78bfa",
    },
    KindTokens {
        fill: "rgba(120,53,15,0.3)",
        stroke: "#fbbf24",
    },
    KindTokens {
        fill: "rgba(136,19,55,0.4)",
        stroke: "#fb7185",
    },
    KindTokens {
        fill: "rgba(251,146,60,0.3)",
        stroke: "#fb923c",
    },
    KindTokens {
        fill: "rgba(30,41,59,0.5)",
        stroke: "#94a3b8",
    },
];
const LIGHT_KINDS: [KindTokens; 7] = [
    KindTokens {
        fill: "rgba(34,211,238,0.15)",
        stroke: "#0891b2",
    },
    KindTokens {
        fill: "rgba(52,211,153,0.18)",
        stroke: "#059669",
    },
    KindTokens {
        fill: "rgba(167,139,250,0.2)",
        stroke: "#7c3aed",
    },
    KindTokens {
        fill: "rgba(251,191,36,0.18)",
        stroke: "#d97706",
    },
    KindTokens {
        fill: "rgba(251,113,133,0.15)",
        stroke: "#e11d48",
    },
    KindTokens {
        fill: "rgba(251,146,60,0.15)",
        stroke: "#ea580c",
    },
    KindTokens {
        fill: "rgba(148,163,184,0.18)",
        stroke: "#64748b",
    },
];
impl SvgTheme {
    pub(crate) fn kind(self, name: &str) -> Option<&'static KindTokens> {
        let index = match name {
            "frontend" | "start" | "active" => 0,
            "backend" | "success" => 1,
            "database" | "decision" => 2,
            "cloud" | "waiting" => 3,
            "security" | "failure" => 4,
            "messagebus" => 5,
            "external" | "neutral" | "final" => 6,
            _ => return None,
        };
        Some(match self {
            Self::Light => &LIGHT_KINDS[index],
            Self::Dark => &DARK_KINDS[index],
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn component_kind_tokens_are_distinct_and_state_aliases_are_deliberate() {
        for theme in [SvgTheme::Light, SvgTheme::Dark] {
            let colors: std::collections::BTreeSet<_> = [
                "frontend",
                "backend",
                "database",
                "cloud",
                "security",
                "messagebus",
                "external",
            ]
            .iter()
            .map(|kind| theme.kind(kind).unwrap().fill)
            .collect();
            assert_eq!(colors.len(), 7);
            assert_eq!(
                theme.kind("active").unwrap().fill,
                theme.kind("frontend").unwrap().fill
            );
            assert_eq!(
                theme.kind("decision").unwrap().fill,
                theme.kind("database").unwrap().fill
            );
            assert!(theme.kind("unknown").is_none());
        }
    }
}
