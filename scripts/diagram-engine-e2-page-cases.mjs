// Synthetic far-margin and authored-coordinate page regressions. The pinned
// host oracle supplies actual verdicts; these are not source-placement models.
export function generatedPageCases(seedFor) {
  const cases = [];
  const add = (id, type, rule, expected, mutate) => {
    const spec = seedFor(type);
    mutate(spec);
    cases.push({ id: `e2-page-${id}`, diagramType: type, rule, geometryRule: `${type}/${rule}`, spec,
      boundary: { layer: "exact", category: "page-source-regression",
        expectedOracleAccepted: expected, expectedEngineAccepted: expected,
        gateOnNegativeRefs: [], coveredAuditSites: [],
        expression: "evaluate authored or fixed-default source bounds against resolved content, never the auto-grown diagnostic page" } });
  };
  for (const [height, expected] of [[240, false], [244, true]]) {
    add(`architecture-grid-bottom-${height}`, "architecture", "geometry-node-viewbox", expected, (s) => {
      s.meta.viewBox = [320, height]; s.layout = { mode: "grid", cols: 3 };
      s.components = [{ id: "a", type: "backend", label: "A", row: 1, col: 0 }]; s.connections = [];
    });
  }
  for (const [width, expected] of [[320, false], [480, true]]) {
    add(`architecture-grid-right-${width}`, "architecture", "geometry-node-viewbox", expected, (s) => {
      s.meta.viewBox = [width, 240]; s.layout = { mode: "grid", cols: 3 };
      s.components = [{ id: "a", type: "backend", label: "A", row: 0, col: 2 }]; s.connections = [];
    });
  }
  for (const [height, expected] of [[341, false], [343, true]]) {
    add(`workflow-v1-bottom-${height}`, "workflow", "geometry-viewbox-capacity", expected, (s) => {
      s.meta.viewBox = [700, height]; s.lanes.push({ id: "other", label: "Other" });
    });
  }
  for (const [width, expected] of [[700, false], [800, true]]) {
    add(`workflow-v2-route-right-${width}`, "workflow", "geometry-viewbox-capacity", expected, (s) => {
      s.schema_version = 2; s.meta.viewBox = [width, 800];
      s.edges = [{ from: "a", to: "b", fromSide: "right", toSide: "left",
        via: [[168,119],[168,70],[750,70],[750,170],[264,170],[264,119]] }];
    });
  }
  for (const [height, expected] of [[300, false], [800, true]]) {
    add(`workflow-v2-label-bottom-${height}`, "workflow", "geometry-viewbox-capacity", expected, (s) => {
      s.schema_version = 2; s.meta.viewBox = [800, height];
      s.edges = [{ from: "a", to: "b", label: "Call", labelAt: [500,400] }];
    });
  }
  for (const type of ["dataflow","lifecycle"]) {
    for (const [x, expected] of [[900,true],[1100,false]]) {
      add(`${type}-default-label-right-${x}`, type, "geometry-label-viewbox", expected, (s) => {
        delete s.meta.viewBox;s.meta.quality_profile="showcase";
        const collection=type==="dataflow"?"flows":"transitions";
        s[collection]=[{from:"a",to:"b",label:"Call",labelAt:[x,400]}];
      });
    }
  }
  const shape = (s) => {
    delete s.layout; s.meta.quality_profile = "showcase"; s.meta.viewBox = [900,600];
    s.components = [{ id:"a",type:"backend",label:"A",pos:[100,100],size:[100,60] },
      { id:"b",type:"backend",label:"B",pos:[480,100],size:[100,60] }];
  };
  /** @type {Array<[number, boolean]>} */
  const stubCases = [[7,false],[9,true]];
  for (const [stub, expected] of stubCases) {
    add(`architecture-source-stub-${stub}`, "architecture", "geometry-route-quality", expected, (s) => {
      shape(s); s.connections = [{from:"a",to:"b",fromSide:"right",toSide:"left",
        via:[[200+stub,130],[200+stub,180],[400,180],[400,130]]}];
    });
    add(`architecture-target-stub-${stub}`, "architecture", "geometry-route-quality", expected, (s) => {
      shape(s); s.connections = [{from:"a",to:"b",fromSide:"right",toSide:"left",
        via:[[280,130],[280,180],[480-stub,180],[480-stub,130]]}];
    });
  }
  /** @type {Array<[number, boolean]>} */
  const interiorCases = [[15,false],[17,true]];
  for (const [interior, expected] of interiorCases) {
    add(`architecture-interior-${interior}`, "architecture", "geometry-route-quality", expected, (s) => {
      shape(s); s.connections = [{from:"a",to:"b",fromSide:"right",toSide:"left",
        via:[[280,130],[280,130+interior],[400,130+interior],[400,130]]}];
    });
  }
  return cases;
}
