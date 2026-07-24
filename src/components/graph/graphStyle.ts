import type { GraphEdge, GraphNode } from "../../lib/graph/model";
import type { GraphDisplaySettings } from "../../lib/settings";

// dataviz-validated categorical palettes (12 slots, same hue per slot across
// themes). Light: min adjacent deutan dE 13.3 on #f4f3ee. Dark: 14.8 on
// #181a18. Slot ORDER is the CVD-safety mechanism; never reorder or cycle.
const LIGHT_COMMUNITY_COLORS = [
  "#2a78d6", "#eda100", "#008300", "#e34948", "#0894ab", "#eb6834",
  "#4a3aa7", "#6b8e23", "#e87ba4", "#9c6410", "#1baf7a", "#7a4fb5",
];
const DARK_COMMUNITY_COLORS = [
  "#3987e5", "#c98500", "#17913a", "#e25b70", "#1a95aa", "#d95926",
  "#9085e9", "#7a9630", "#d55181", "#b07b28", "#199e70", "#a678d8",
];
// Domains map onto palette slots so domain and community coloring share hues.
const DOMAIN_SLOTS: Record<string, number> = {
  research: 0,      // blue
  projects: 5,      // orange
  teaching: 2,      // green
  operations: 3,    // red
  people: 11,       // purple
  "ai-practice": 4, // cyan
};

export interface GraphTheme {
  bg: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
  warn: string;
  labelColor: string;
  edge: string;
  edgeStrong: string;
  edgeDim: string;
  nodeBorder: string;
  ghostFill: string;
  dimNode: string;
  dark: boolean;
  communityColors: string[];
  domainColors: Record<string, string>;
  fallback: string;
  neutralNode: string;
  neutralNodeStrong: string;
}

const LIGHT_DEFAULTS = {
  bg: "#f4f3ee",
  ink: "#1f1d18",
  muted: "#69645b",
  line: "#dedbd1",
  accent: "#7c5ce7",
};
const DARK_DEFAULTS = {
  bg: "#1e1e1e",
  ink: "#f2f0e8",
  muted: "#8f918c",
  line: "#30322f",
  accent: "#8b5cf6",
};

function colorLuminance(color: string): number {
  const value = color.trim();
  const shortHex = /^#([0-9a-f]{3})$/i.exec(value);
  const longHex = /^#?([0-9a-f]{6})$/i.exec(value);
  let channels: [number, number, number] | null = null;
  if (shortHex) {
    channels = shortHex[1]
      .split("")
      .map((digit) => parseInt(`${digit}${digit}`, 16)) as [number, number, number];
  } else if (longHex) {
    const packed = parseInt(longHex[1], 16);
    channels = [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
  } else if (/^rgba?\(/i.test(value)) {
    const components = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (components?.length === 3 && components.every(Number.isFinite)) {
      channels = components.map((component) => Math.min(255, Math.max(0, component))) as [
        number,
        number,
        number,
      ];
    }
  }
  if (!channels) return 1;
  const channel = (component: number) => {
    const c = component / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(channels[0])
    + 0.7152 * channel(channels[1])
    + 0.0722 * channel(channels[2]);
}

function buildTheme(read: (name: string, fallback: string) => string): GraphTheme {
  const bgProbe = read("--graph-canvas", read("--bg", LIGHT_DEFAULTS.bg));
  const dark = colorLuminance(bgProbe) < 0.5;
  const defaults = dark ? DARK_DEFAULTS : LIGHT_DEFAULTS;
  const bg = read("--graph-canvas", defaults.bg);
  const ink = read("--graph-ink", defaults.ink);
  const line = read("--graph-line", defaults.line);
  const communityColors = dark ? DARK_COMMUNITY_COLORS : LIGHT_COMMUNITY_COLORS;
  const domainColors = Object.fromEntries(
    Object.entries(DOMAIN_SLOTS).map(([domain, slot]) => [domain, communityColors[slot]]),
  );
  return {
    bg,
    ink,
    muted: read("--graph-muted", defaults.muted),
    line,
    accent: read("--graph-accent", defaults.accent),
    warn: dark ? "#d6b070" : "#b8690f",
    labelColor: read(
      "--graph-label-strong",
      dark ? "rgba(242, 240, 232, 0.92)" : "rgba(31, 29, 24, 0.9)",
    ),
    // Sigma/WebGL blends thousands of overlapping strokes. Opaque,
    // near-background colors stay restrained on dense graphs more reliably
    // than rgba strings, which some GPU paths flatten too brightly.
    edge: read("--graph-edge", dark ? "#292a29" : "#d8d6cf"),
    edgeStrong: dark ? "#555854" : "#8d8980",
    edgeDim: dark ? "#232423" : "#e7e5df",
    nodeBorder: bg,
    ghostFill: bg,
    dimNode: dark ? "#30332f" : "#dedbd3",
    dark,
    communityColors,
    domainColors,
    fallback: dark ? "#686b66" : "#aaa69c",
    neutralNode: dark ? "#686b66" : "#aaa69c",
    neutralNodeStrong: dark ? "#d2d5cf" : "#565248",
  };
}

let activeTheme: GraphTheme = buildTheme((_name, fallback) => fallback);

// Every theme token ends up in Sigma's parseColor, which only understands
// hex/rgb/rgba; unevaluated tokens like `color-mix(...)` or `var(...)` (as
// returned by getPropertyValue for custom properties) would silently become
// opaque black. Only concrete colors may pass through.
function isConcreteColor(value: string): boolean {
  return /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(value);
}

export function refreshGraphTheme(element?: Element | null): GraphTheme {
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const style = getComputedStyle(element ?? document.documentElement);
    const resolvedBackground = style.backgroundColor.trim();
    activeTheme = buildTheme((name, fallback) => {
      const value = style.getPropertyValue(name).trim();
      if (name === "--graph-canvas" && !isConcreteColor(value)) {
        return resolvedBackground || fallback;
      }
      return isConcreteColor(value) ? value : fallback;
    });
  }
  return activeTheme;
}

export function graphTheme(): GraphTheme {
  return activeTheme;
}

export function nodeRadius(degree: number): number {
  // Keep isolated notes large enough to see and reliably pick on HiDPI/WebGL
  // canvases; degree still adds hierarchy without letting hubs dominate.
  return Math.min(14, Math.max(5, 5 + 1.2 * Math.sqrt(degree)));
}

export function nodeColor(
  node: GraphNode,
  enriched: boolean,
  colorMode: GraphDisplaySettings["colorMode"] = "neutral",
): string {
  const theme = activeTheme;
  if (node.type === "unresolved") return theme.ghostFill;
  if (colorMode === "neutral") return theme.neutralNode;
  if (colorMode === "community" && enriched && node.community != null) {
    return theme.communityColors[node.community % theme.communityColors.length];
  }
  if (colorMode === "domain" && node.domain) {
    return theme.domainColors[node.domain] ?? theme.fallback;
  }
  return theme.fallback;
}

export function communityColor(community: number): string {
  return activeTheme.communityColors[community % activeTheme.communityColors.length];
}

export function domainColor(domain: string | null): string {
  return domain ? (activeTheme.domainColors[domain] ?? activeTheme.fallback) : activeTheme.fallback;
}

/** Stable per-relation edge color: FNV hash into the categorical palette.
 *  Body `wiki_link` edges are handled by the caller (they stay neutral). */
export function relationColor(relation: string): string {
  const palette = activeTheme.communityColors;
  let hash = 2166136261;
  for (let index = 0; index < relation.length; index += 1) {
    hash ^= relation.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return palette[(hash >>> 0) % palette.length];
}

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export function graphTopologySignature(nodes: GraphNode[], edges: GraphEdge[]): string {
  let hash = 2166136261;
  const add = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 16777619);
  };
  for (const node of nodes) add(node.id);
  for (const edge of edges) {
    add(edge.source);
    add(edge.target);
    add(edge.relation);
  }
  return `${nodes.length}:${edges.length}:${hash >>> 0}`;
}
