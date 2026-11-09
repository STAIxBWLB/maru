// Synthetic geometry probes only. Archify runs in the host oracle, never the SDK.
export function generatedGeometryCases(seedFor) {
  const cases = [];
  function add(type, rule, suffix, mutate) {
    const spec = seedFor(type);
    mutate(spec);
    cases.push({ id: `e2-${type}-${rule}-${suffix}`, diagramType: type, rule,
      geometryRule: `${type}/${rule}`, spec });
  }
  for (const type of ["architecture", "workflow", "sequence", "dataflow", "lifecycle"]) {
    const nodes = { architecture: "components", workflow: "nodes", sequence: "participants", dataflow: "nodes", lifecycle: "states" }[type];
    add(type, "geometry-label-fit", "primary", (s) => { s[nodes][0].label = "W".repeat(60); });
    add(type, "geometry-label-fit", "detail", (s) => { s[nodes][0].sublabel = "W".repeat(80); });
    if (type !== "sequence") add(type, "geometry-label-fit", "tag", (s) => { s[nodes][0].tag = "W".repeat(80); });
    add(type, "geometry-node-viewbox", "authored-page", (s) => { s.meta.viewBox = { architecture: [320,240], workflow: [700,240], sequence: [480,480], dataflow: [360,360], lifecycle: [420,300] }[type]; });
  }
  add("architecture", "geometry-node-overlap", "free", (s) => {
    delete s.layout; s.components.forEach((n) => { n.pos = [120, 140]; delete n.row; delete n.col; }); s.connections = [];
  });
  add("architecture", "geometry-node-viewbox", "origin", (s) => { s.components[0].pos = [-100, 160]; });
  add("architecture", "geometry-boundary-title-fit", "long", (s) => {
    s.boundaries = [{ kind: "region", label: "W".repeat(80), wraps: ["a"] }]; s.meta.quality_profile = "showcase";
  });
  add("workflow", "geometry-node-overlap", "same-lane-col", (s) => { s.nodes[1].col = 0; s.edges = []; });
  add("workflow", "geometry-node-lane", "origin", (s) => { s.nodes[0].yOffset = -200; });
  add("dataflow", "fixed-row-slots", "sixth-row", (s) => { s.nodes[0].row = 5; });
  add("dataflow", "geometry-node-overlap", "same-slot", (s) => { s.nodes[1].stage = 0; s.flows = []; });
  add("dataflow", "geometry-node-viewbox", "offset", (s) => { s.nodes[0].yOffset = -300; });
  add("lifecycle", "geometry-node-overlap", "same-slot", (s) => { s.states[1].col = 0; s.transitions = []; });
  add("lifecycle", "geometry-node-viewbox", "offset", (s) => { s.states[0].yOffset = -300; });
  add("sequence", "geometry-message-time", "after-timeline", (s) => { s.messages[0].y = 2000; });
  add("sequence", "geometry-message-spacing", "same-time", (s) => { s.messages.push({ ...s.messages[0], label: "Second" }); });
  add("sequence", "geometry-segment-range", "beyond-page", (s) => { s.segments = [{ label: "Phase", from: 160, to: 2000 }]; });
  add("sequence", "geometry-segment-label-fit", "long", (s) => { s.segments = [{ label: "W".repeat(80), from: 160, to: 300 }]; });
  add("sequence", "geometry-route-quality", "segment-border", (s) => { s.meta.quality_profile="showcase"; s.segments=[{from:180,to:300,label:"Phase"}]; });
  add("dataflow", "geometry-route-clearance", "label-on-other-route", (s) => { s.meta.quality_profile="showcase"; s.flows=[{from:"a",to:"b",label:"Data",labelAt:[200,170]},{from:"b",to:"a",label:"Return",labelAt:[220,230]}]; });
  add("dataflow", "geometry-route-quality", "micro-segment", (s) => { s.meta.quality_profile="showcase"; s.flows[0].via=[[160,157],[160,160],[200,160],[200,157]];s.flows[0].labelAt=[500,400]; });
  add("lifecycle", "geometry-route-quality", "micro-segment", (s) => { s.meta.quality_profile="showcase";s.transitions[0].via=[[157,157],[157,167],[175,167],[175,157]];s.transitions[0].labelAt=[350,220]; });
  add("sequence", "geometry-legend-clearance", "showcase-note", (s) => { s.meta.quality_profile="showcase";s.meta.viewBox=[920,760];s.messages[0].y=650;s.messages[0].note="Detail"; });
  add("sequence", "geometry-message-time", "authored-page", (s) => { s.meta.viewBox=[920,760];s.messages[0].y=2000; });
  add("sequence", "geometry-segment-label-fit", "authored-page", (s) => { s.meta.viewBox=[480,760];s.segments=[{label:"W".repeat(80),from:160,to:300}]; });
  add("lifecycle", "geometry-label-overlap", "state", (s) => { s.transitions[0].labelAt=[94,150]; });
  add("dataflow", "geometry-label-overlap", "pair", (s) => { s.flows=[{id:"first",from:"a",to:"b",label:"One",labelAt:[500,400]},{id:"second",from:"a",to:"b",label:"Two",labelAt:[500,400]}]; });
  add("sequence", "geometry-segment-range", "before-header", (s) => { s.segments=[{label:"Phase",from:20,to:300}]; });
  add("architecture", "geometry-route-distance", "short-port-span", (s) => {
    delete s.layout;s.components.forEach((node,index)=>{node.pos=[100+index*120,100];node.size=[100,60];delete node.row;delete node.col;});
    s.connections[0].labelAt=[210,200];
  });
  add("dataflow", "geometry-route-distance", "wide-stage-nodes", (s) => {
    s.stages.push({label:"Third"});s.nodes.forEach((node,index)=>{node.stage=index+1;node.width=198;node.height=58;});s.flows[0].labelAt=[500,300];
  });
  add("lifecycle", "geometry-route-distance", "event-band", (s) => {
    s.lanes.push({id:"ordinary",label:"Ordinary"});s.states.forEach((node)=>{node.lane="ordinary";});s.transitions[0].label="Go";s.transitions[0].labelAt=[470,220];
  });
  add("sequence", "geometry-route-distance", "same-participant", (s) => {s.messages[0].to="a";s.messages[0].label="Self";});
  add("architecture", "geometry-route-distance", "self-loop-positive", (s) => {
    delete s.layout;s.components.forEach((node,index)=>{node.pos=[100+index*200,100];node.size=[120,80];delete node.row;delete node.col;});
    s.connections=[{from:"a",to:"a",label:"Loop",fromSide:"top",toSide:"right",labelAt:[250,280]}];
  });
  add("lifecycle", "geometry-route-distance", "self-loop-positive", (s) => {s.transitions=[{from:"a",to:"a",label:"Loop"}];});
  add("lifecycle", "geometry-route-distance", "v2-cross-row-same-side-positive", (s) => {
    s.schema_version = 2;
    s.lanes.push({ id: "ordinary", label: "Ordinary" });
    s.states[1].lane = "ordinary";
    s.states[1].col = 0;
    s.transitions = [{ from: "a", to: "b", fromSide: "right", toSide: "right" }];
  });
  add("lifecycle", "geometry-route-distance", "v2-width-aware-column-positive", (s) => {
    s.schema_version = 2;
    s.states[0].width = 240;
    // Source columns leave a 64px edge gap even when the first column grows.
    // A fixed-pitch duplicate model incorrectly makes the port span 14px.
    s.transitions = [{ from: "a", to: "b", fromSide: "right", toSide: "left" }];
  });
  for (const version of [1,2]) add("lifecycle", "geometry-state-column", `band-version-${version}`, (s) => {
    s.schema_version=version;s.lanes.push({id:"ordinary",label:"Ordinary"});s.states[1].lane="ordinary";s.states[1].col=3;
  });
  for (const widened of [false,true]) add("sequence", "geometry-participant-canvas-width", widened ? "widened-positive" : "default-budget", (s) => {
    s.participants=Array.from({length:9},(_,index)=>({id:`p${index}`,type:"backend",label:`P${index}`}));s.messages=[{from:"p0",to:"p8",y:180,label:"Call"}];if(widened)s.meta.viewBox=[1100,760];
  });
  return cases;
}
