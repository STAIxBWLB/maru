// Geometry-only oracle mappings. No renderer implementation or SDK code is used.
const signatures = {
  "geometry-viewbox-capacity": /workflow(?: v2)? viewbox(?!-origin)[^\n]*(?:small|short|narrow|require|need|minimum)|^legend exceeds viewbox/i,
  "geometry-column-capacity": /under the fixed-v1 layout/i,
  "geometry-route-quality": /(?:micro.segment|short[^\n]*segment|border[^\n]*run|runs along[^\n]*border|explicit geometry[^\n]*(?:orthogonal|non-zero|route preset|channel pin|16px interior|8px endpoint))/i,
  "geometry-route-viewbox": /(?:Connection[^\n]*extends outside the viewBox|explicit geometry[^\n]*viewBox-origin containment)/i,
  "geometry-route-clearance": /(?:label[^\n]*route[^\n]*clearance|label[^\n]*too close[^\n]*route|explicit geometry[^\n]*lane\/phase\/group label clearance)/i,
  "geometry-legend-clearance": /(?:legend[^\n]*(?:needs|clearance|requires)|content[^\n]*ends[^\n]*legend)/i,
  "geometry-label-viewbox": /(?:label[^\n]*(?:extends past|canvas containment)|explicit geometry[^\n]*label[^\n]*viewBox-origin)/i,
  "geometry-label-overlap": /(?:explicit geometry[^\n]*edge-label (?:node|legend|lane\/phase\/group) clearance|labels?[^\n]*overlaps?[^\n]*(?:state|node|component|label)|labels[^\n]*overlap)/i,
  "geometry-route-distance": /(?:is too short[^\n]*minimum (?:24|34|32)px|spans[^\n]*minimum 60px)/i,
  "geometry-state-column": /uses invalid column[^\n]*band[^\n]*columns/i,
  "geometry-participant-canvas-width": /Participants exceed viewBox width/i,
  "fixed-row-slots": /uses invalid row|produced non-finite coordinates/i,
  "stage-canvas-width": /Stages exceed viewBox width/i,
  "reserved-main-lane": /need[s]? a lane with id ["']main["']/i,
  "geometry-label-fit": /(?:label[^\n]*(?:wider than|needs[^\n]*legible minimum)|(?:sublabel|tag)[^\n]*needs)/i,
  "geometry-node-viewbox": /(?:viewBox height[^\n]*too short for the fixed band layout|outside[^\n]*(?:viewBox|canvas)|exceeds[^\n]*(?:bounds|area)|viewBox[^\n]*(?:leaves under|too small)|leaves under[^\n]*timeline)/i,
  "geometry-node-lane": /node[^\n]*collides with[^\n]*lane/i,
  "geometry-node-overlap": /(?:less than [\d.]+px apart|nodes?[^\n]*overlap|states?[^\n]*overlap|components?[^\n]*overlap)/i,
  "geometry-boundary-title-fit": /boundary[^\n]*(?:label|title)[^\n]*(?:overlap|fit|available|width|readable|extends outside)/i,
  "geometry-message-time": /outside the readable timeline/i,
  "geometry-message-spacing": /(?:messages?[^\n]*(?:apart|overlap)|labels?[^\n]*overlap)/i,
  "geometry-segment-range": /segment[^\n]*extends outside the canvas/i,
  "geometry-segment-label-fit": /segment[^\n]*label[^\n]*exceeds[^\n]*available width/i,
};
const families = {
  "geometry-viewbox-capacity": ["workflow"],
  "fixed-row-slots": ["dataflow"], "stage-canvas-width": ["dataflow"],
  "reserved-main-lane": ["lifecycle"], "geometry-state-column": ["lifecycle"],
  "geometry-message-time": ["sequence"], "geometry-message-spacing": ["sequence"],
  "geometry-segment-range": ["sequence"], "geometry-segment-label-fit": ["sequence"],
  "geometry-participant-canvas-width": ["sequence"],
  "geometry-route-viewbox": ["architecture","workflow"],
  "geometry-column-capacity": ["workflow"],
  "geometry-node-lane": ["workflow"], "geometry-boundary-title-fit": ["architecture"],
  "geometry-node-viewbox": ["architecture", "dataflow", "lifecycle"],
  "geometry-node-overlap": ["architecture", "workflow", "dataflow", "lifecycle"],
  "geometry-route-distance": ["architecture", "sequence", "dataflow", "lifecycle"],
};
export function geometryComparisonFor(item) {
  const comparison = item.comparison;
  const oracle = item.validityOracle ?? item.oracle;
  if (!comparison.accepted) return {
    inputJson: comparison.inputJson, accepted: false, equivalentCodes: comparison.equivalentCodes,
    layer: "document-validity", geometryExpected: false,
  };
  if (oracle.ok) return {
    inputJson: comparison.inputJson, accepted: true, equivalentCodes: [],
    layer: item.validityOracle ? "evidence-stripped-renderer" : "renderer", geometryExpected: true,
  };
  const messages = oracle.diagnostics.map((diagnostic) => diagnostic.message ?? "").join("\n");
  const oracleCodes = {
    "geometry-viewbox-capacity": ["workflow/viewbox-capacity"],
    "geometry-route-quality": ["composition/micro-segment", "composition/short-interior-segment", "composition/container-border-run", "composition/ambiguous-corridor", "composition/arrowhead-collision", "composition/proper-crossing", "composition/excessive-route-detour", "clean-flow/endpoint-side-direction"],
    "geometry-route-clearance": ["composition/label-route-clearance", "clean-flow/edge-through-node"],
    "geometry-label-viewbox": ["composition/label-canvas-containment"],
  };
  const matched = Object.entries(signatures).filter(([rule, pattern]) => (!families[rule] || families[rule].includes(item.diagramType)) && (pattern.test(messages) || (oracleCodes[rule] ?? []).some((code) => (oracle.codes ?? []).includes(code)))).map(([rule]) => `${item.diagramType}/${rule}`);
  if (item.geometryRule && !matched.includes(item.geometryRule)) {
    throw new Error(`Geometry probe ${item.id} does not produce its claimed renderer cause ${item.geometryRule}: ${messages}; repair its synthetic input or map the specific oracle diagnostic.`);
  }
  if (matched.length === 0) throw new Error(`Unmapped renderer refusal for ${item.id}: ${messages}; add a cause-specific geometry rule mapping before recording this case.`);
  return {
    inputJson: comparison.inputJson, accepted: false,
    equivalentCodes: item.geometryRule ? [item.geometryRule] : matched,
    layer: item.validityOracle ? "evidence-stripped-renderer" : "renderer", geometryExpected: true,
  };
}
