// Source-contract boundary probes. No renderer implementation is imported.
// Every geometryRule is a claim checked by the host's real pinned oracle;
// boundary metadata is an authored test hypothesis, never an oracle receipt.
/** @typedef {Record<string, any>} RawSpec */
/** @typedef {{renderer:string,rule:string,expression:string,threshold:number,unit:string,side:string,layer:"exact"|"model-difference",category:string,note?:string}} Boundary */
/** @typedef {{id:string,diagramType:string,rule:string,geometryRule:string,spec:RawSpec,boundary:Boundary}} BoundaryCase */
/** @typedef {{renderer:string,location:number|string,cause:string,engineCode:string,expression:string,coverage:string,reason?:string}} RefusalAudit */

/** @param {(type:string)=>RawSpec} seedFor @returns {BoundaryCase[]} */
export function generatedBoundaryCases(seedFor) {
  /** @type {BoundaryCase[]} */
  const cases = [];
  /** @param {string} type @param {string} rule @param {string} name @param {number} threshold @param {string} expression @param {(spec:RawSpec,value:number)=>void} mutate @param {number} [step] */
  function pair(type, rule, name, threshold, expression, mutate, step = 1 / 64) {
    for (const side of ["below", "above"]) {
      const spec = seedFor(type);
      const value = threshold + (side === "below" ? -step : step);
      mutate(spec, value);
      const textCapacity = name.includes("family-label-route") || rule === "geometry-label-fit" || rule === "geometry-segment-label-fit" || rule === "geometry-label-overlap" || /legend-wrap/.test(name);
      const solverPlacement = !textCapacity && type === "lifecycle" && spec.schema_version === 2;
      const layer = textCapacity || solverPlacement ? "model-difference" : "exact";
      const category = textCapacity ? "text-capacity" : solverPlacement ? "readable-v2-implicit-placement" : "source-budget";
      cases.push({ id: `e2-boundary-${type}-${name}-${side}`, diagramType: type, rule,
        geometryRule: `${type}/${rule}`, spec,
        boundary: { renderer: type, rule, expression, threshold, unit: step === 1 ? "px" : "1/64px", side, layer, category,
          ...(/legend-(?:note|message|activation)/.test(name) ? { note: "The source growth hint uses content+98, but measureLegend accepts content+96 plus 22px per additional legacy row; this pair targets the effective placement boundary." } : {}) } });
    }
  }
  /** @param {string} type @param {string} rule @param {string} name @param {number[]} values @param {number} threshold @param {string} expression @param {(spec:RawSpec,value:number)=>void} mutate @param {"exact"|"model-difference"} [layer] @param {string} [category] */
  function samples(type, rule, name, values, threshold, expression, mutate, layer = "exact", category = "source-route") {
    for (const value of values) {
      const spec = seedFor(type); mutate(spec,value);
      const artifactRounding = type === "lifecycle" && name === "physical-corridor";
      const sampleLayer = artifactRounding ? "model-difference" : layer;
      const sampleCategory = artifactRounding ? "artifact-route-rounding" : category;
      cases.push({id:`e2-boundary-${type}-${name}-${value}`,diagramType:type,rule,geometryRule:`${type}/${rule}`,spec,
        boundary:{renderer:type,rule,expression,threshold,unit:name==="physical-crossing"?"fixture-mode":name==="brand-rail"&&type==="sequence"?"characters":"px",side:value<threshold?"below":value>threshold?"above":"equal",layer:sampleLayer,category:sampleCategory,
          ...(artifactRounding?{note:"Lifecycle7px source corridor is preempted by final-artifact rounded SVG corner proper-crossing at[183.9,338.6]; retain the oracle trace and do not count either lifecycle case as isolated8px threshold proof. Exact shared predicate proof is architecture corridor7/9."}:{})}});
    }
  }
  pair("sequence", "geometry-message-time", "timeline-upper", 677, "message.y <= authored height - 83", (s,v) => { s.meta.viewBox=[920,760];s.messages[0].y=v; });
  pair("sequence", "geometry-segment-range", "segment-start", 72, "segment.from >= header top 72", (s,v) => { s.meta.viewBox=[920,760];s.segments=[{label:"Phase",from:v,to:300}]; });
  pair("sequence", "geometry-segment-range", "segment-end", 715, "segment.to <= authored height - 45", (s,v) => { s.meta.viewBox=[920,760];s.segments=[{label:"Phase",from:160,to:v}]; });
  pair("sequence", "geometry-segment-label-fit", "segment-title", 534, "80 W title: frame width >= title width 430 + margins 104", (s,v) => { s.meta.viewBox=[v,760];s.segments=[{label:"W".repeat(80),from:160,to:300}]; });
  pair("sequence", "geometry-message-spacing", "message-spacing", 208, "second y - first y >= 28 when horizontal spans overlap", (s,v) => { s.messages=[{from:"a",to:"b",y:180,label:"First"},{from:"a",to:"b",y:v,label:"Second"}]; });
  pair("sequence", "geometry-legend-clearance", "legend-note", 768, "content y650 + note22 + effective reserve96 <= authored height", (s,v) => { s.meta.viewBox=[920,v];s.meta.quality_profile="showcase";s.messages[0].y=650;s.messages[0].note="Detail"; });
  pair("sequence", "geometry-legend-clearance", "legend-message", 752, "content y650 + message6 + effective reserve96 <= authored height", (s,v) => { s.meta.viewBox=[920,v];s.meta.quality_profile="showcase";s.messages[0].y=650; });
  pair("sequence", "geometry-legend-clearance", "legend-activation", 796, "activation.to700 + effective reserve96 <= authored height", (s,v) => { s.meta.viewBox=[920,v];s.meta.quality_profile="showcase";s.activations=[{participant:"a",from:200,to:700}]; });
  for (const spread of [false,true]) {
    const count = spread ? 4 : 9;
    pair("sequence", "geometry-participant-canvas-width", `participant-width-${spread ? "spread" : "fixed"}`, spread ? 512 : 1009, "final participant center + half header + right margin40 <= width", (s,v) => {
      s.participants=Array.from({length:count},(_,i)=>({id:`p${i}`,type:"backend",label:`P${i}`}));
      s.messages=[{from:"p0",to:`p${count-1}`,y:180,label:"Call"}];s.meta.viewBox=[v,760];if(spread)s.meta.column_fit="spread";
    });
  }
  pair("dataflow", "geometry-node-viewbox", "left-margin-width", 152, "stage0 center100 - node.width/2 >= margin24", (s,v) => { s.nodes[0].width=v; });
  pair("dataflow", "geometry-node-viewbox", "top-margin", -24, "row0 y128 + yOffset >= stageY46 + stageH36 +22", (s,v) => { s.nodes[0].yOffset=v; });
  pair("dataflow", "geometry-node-viewbox", "bottom-reserve", 460, "row0 y128 + yOffset + default height58 <= page720 - reserve74", (s,v) => { s.nodes[0].yOffset=v; });
  pair("dataflow", "stage-canvas-width", "five-stage-page", 1068, "final stage center960 + half stage84 + margin24 <= page width", (s,v) => { s.stages=["A","B","C","D","E"].map(label=>({label}));s.meta.viewBox=[v,720]; });
  pair("dataflow", "geometry-node-overlap", "node-gap", 68, "same stage row0: second offset - node height58 >= gap10", (s,v) => { s.nodes[1].stage=0;s.nodes[1].yOffset=v;s.flows=[]; });
  pair("dataflow", "geometry-label-fit", "primary-width", 118, "20 W *6.2 <= node width +6", (s,v) => { s.nodes[0].label="W".repeat(20);s.nodes[0].width=v; });
  for (const field of ["sublabel","tag"]) pair("dataflow", "geometry-label-fit", `detail-width-${field}`, 116, "30 W *minimum6 *0.6 <= node width -8", (s,v) => { s.nodes[0][field]="W".repeat(30);s.nodes[0].width=v; });
  pair("lifecycle", "geometry-node-viewbox", "v1-page-floor", 566, "v1 fixed bands: height -122 +4 >=448", (s,v) => { s.meta.viewBox=[980,v]; });
  pair("lifecycle", "geometry-node-viewbox", "v1-left-margin", 124, "phase center94 - width/2 >= margin32", (s,v) => { s.states[0].width=v;s.transitions=[]; });
  pair("lifecycle", "geometry-node-viewbox", "v1-top-margin", -62, "phase y126 + offset >=64", (s,v) => { s.states[0].yOffset=v;s.transitions=[]; });
  pair("lifecycle", "geometry-node-viewbox", "v1-bottom-reserve", 350, "phase y126 + offset +height62 <= page660 -122", (s,v) => { s.states[0].yOffset=v;s.transitions=[]; });
  pair("lifecycle", "geometry-node-overlap", "v1-node-gap", 72, "same phase column: offset >=height62 +gap10", (s,v) => { s.states[1].col=0;s.states[1].yOffset=v;s.transitions=[]; });
  pair("lifecycle", "geometry-label-fit", "v1-primary-width", 118, "20 W *6.2 <= state width +6", (s,v) => { s.states[0].label="W".repeat(20);s.states[0].width=v;s.transitions=[]; });
  for (const field of ["sublabel","tag"]) pair("lifecycle", "geometry-label-fit", `v1-detail-width-${field}`, 116, "30 W *minimum6 *0.6 <= state width -8", (s,v) => { s.states[0][field]="W".repeat(30);s.states[0].width=v;s.transitions=[]; });
  pair("lifecycle", "geometry-node-viewbox", "v2-top-margin", -12, "v2 first row56 + offset >=44", (s,v) => { s.schema_version=2;s.states[0].yOffset=v;s.transitions=[]; });
  pair("lifecycle", "geometry-node-overlap", "v2-node-gap", 74, "same v2 row/column: offset >=height64 +gap10", (s,v) => { s.schema_version=2;s.states[1].col=0;s.states[1].yOffset=v;s.transitions=[]; });
  pair("dataflow", "geometry-route-distance", "route-span", 181, "stage pitch215 - equal node width >=34", (s,v) => { s.stages.push({label:"Third"});s.nodes.forEach((n,i)=>{n.stage=i+1;n.width=v;n.height=58;});s.flows[0].labelAt=[500,300]; });
  pair("lifecycle", "geometry-route-distance", "v1-route-span", 122, "phase pitch154 - equal state width >=32", (s,v) => { s.states.forEach(n=>{n.width=v;});s.transitions[0].labelAt=[470,220]; });
  pair("dataflow", "geometry-route-clearance", "label-route-clearance", 172, "label centerY -11 - routeY157 >= clearance4", (s,v) => { s.meta.quality_profile="showcase";s.flows=[{id:"first",from:"a",to:"b",label:"One",labelAt:[200,v]},{id:"second",from:"b",to:"a",label:"Two",labelAt:[220,230]}]; });
  pair("dataflow", "geometry-label-overlap", "label-pair-gap", 414, "second label center -11 >=first bottom405 -inset2", (s,v) => { s.flows=[{id:"first",from:"a",to:"b",label:"One",labelAt:[500,400]},{id:"second",from:"a",to:"b",label:"Two",labelAt:[500,v]}]; });
  pair("sequence", "geometry-label-fit", "spread-primary-header", 499, "25 W *6.8 <= rounded spread header+6", (s,v) => { s.meta.viewBox=[v,760];s.meta.column_fit="spread";s.participants[0].label="W".repeat(25); });
  pair("sequence", "geometry-label-fit", "spread-sublabel-header", 511, "45 W *6*.6 <= rounded spread header-8", (s,v) => { s.meta.viewBox=[v,760];s.meta.column_fit="spread";s.participants[0].sublabel="W".repeat(45); });
  pair("lifecycle", "geometry-node-viewbox", "v2-right-margin", 432, "v2 second column right404 +margin28 <=width", (s,v) => { s.schema_version=2;s.meta.viewBox=[v,300];s.transitions=[]; });
  pair("lifecycle", "geometry-node-viewbox", "v2-bottom-reserve", 84, "v2 row56 +offset+height64 <=page300 -reserve96", (s,v) => { s.schema_version=2;s.meta.viewBox=[640,300];s.states[0].yOffset=v;s.transitions=[]; });
  pair("lifecycle", "geometry-label-fit", "v2-primary-width", 118, "20 W *6.2 <=state width+6", (s,v) => { s.schema_version=2;s.states[0].width=v;s.states[0].label="W".repeat(20);s.transitions=[]; });
  for (const field of ["sublabel","tag"]) pair("lifecycle", "geometry-label-fit", `v2-detail-width-${field}`, 134, "30 W *minimum7 *.6 <=state width-8", (s,v) => { s.schema_version=2;s.states[0].width=v;s.states[0][field]="W".repeat(30);s.transitions=[]; });
  for (const lane of ["ordinary","terminal"]) pair("lifecycle", "geometry-node-viewbox", `v1-${lane}-right-margin`, 497, "event/outcome right465 +margin32 <=width", (s,v) => { s.meta.viewBox=[v,660];s.lanes.push({id:lane,label:"Other"});s.states[1].lane=lane;s.states[1].col=0;s.states[1].width=126;s.transitions=[]; });
  for (const type of ["dataflow","lifecycle"]) samples(type,"geometry-label-fit","brand-rail",[71,73],72,"Brand label at8px: width-48 >=5*8*.6",(s,v)=>{
    const nodes=type==="dataflow"?s.nodes:s.states;Object.assign(nodes[0],{label:"Brand",brand:"openai",width:v});s[type==="dataflow"?"flows":"transitions"]=[];
  },"model-difference","text-capacity");
  samples("sequence","geometry-label-fit","brand-rail",[7,9],8,"fixed86 header minus48 brand rail accommodates at most7 full W glyph estimates",(s,v)=>{s.participants[0].brand="openai";s.participants[0].label="W".repeat(v);},"model-difference","text-capacity");
  samples("dataflow","geometry-route-quality","diagonal-via",[0,1],.01,"raw via segment accepts axis alignment; both dx and dy above.01 reject",(s,v)=>{Object.assign(s.flows[0],{fromSide:"right",toSide:"left",via:[[180,157],[240,157+v]],labelAt:[700,500]});});
  samples("dataflow","geometry-route-clearance","third-node-gap",[1,3],2,"authored horizontal route stays at least2px above unrelated node c.top242",(s,v)=>{
    s.stages.push({label:"Third"});s.nodes[1].stage=2;s.nodes.push({id:"c",type:"backend",label:"C",stage:1,row:1});
    Object.assign(s.flows[0],{fromSide:"right",toSide:"left",via:[[180,157],[180,242-v],[450,242-v],[450,157]],labelAt:[700,500]});
  });
  samples("lifecycle","geometry-route-clearance","third-state-gap",[1,3],2,"authored route stays at least2px above unrelated main state c.top126",(s,v)=>{
    s.states[1].col=4;s.states.push({id:"c",type:"active",label:"C",lane:"main",col:2});
    Object.assign(s.transitions[0],{fromSide:"right",toSide:"left",via:[[180,157],[180,126-v],[600,126-v],[600,157]],labelAt:[800,500]});
  });
  samples("dataflow","geometry-route-quality","stage-border",[45,46,47],46,"exact route/frame top-side collinearity rejects; both1px neighbours are clear",(s,v)=>{
    s.meta.quality_profile="showcase";s.meta.title="X";Object.assign(s.flows[0],{fromSide:"right",toSide:"left",via:[[180,157],[180,v],[10,v],[10,220],[230,220],[230,157]],labelAt:[700,500]});
  });
  for (const type of ["dataflow","lifecycle"]) {
    samples(type,"geometry-route-quality","physical-crossing",[-1,1],0,"four physical nodes: separated left corridor versus crossing at[180,200]",(s,v)=>{
      s.meta.quality_profile="showcase";
      if(type==="dataflow") {
        s.nodes=[{id:"a",type:"backend",label:"A",stage:0,row:0},{id:"b",type:"backend",label:"B",stage:1,row:1},{id:"c",type:"backend",label:"C",stage:0,row:1},{id:"d",type:"backend",label:"D",stage:1,row:0}];
        s.flows=[{from:"a",to:"b",label:"First",fromSide:"right",toSide:"left",via:[[180,157],[180,300],[240,300],[240,271]],labelAt:[600,400]},
          {from:"c",to:"d",label:"Second",fromSide:v<0?"left":"right",toSide:"left",via:v<0?[[10,271],[10,100],[250,100],[250,157]]:[[170,271],[170,200],[250,200],[250,157]],labelAt:[600,500]}];
      } else {
        s.states=[{id:"a",type:"active",label:"A",lane:"main",col:0},{id:"b",type:"active",label:"B",lane:"main",col:2,yOffset:150},{id:"c",type:"active",label:"C",lane:"main",col:0,yOffset:150},{id:"d",type:"active",label:"D",lane:"main",col:2}];
        s.transitions=[{from:"a",to:"b",label:"First",fromSide:"right",toSide:"left",via:[[180,157],[180,340],[300,340],[300,307]],labelAt:[700,500]},
          {from:"c",to:"d",label:"Second",fromSide:v<0?"left":"right",toSide:"left",via:v<0?[[10,307],[10,110],[320,110],[320,157]]:[[170,307],[170,200],[320,200],[320,157]],labelAt:[700,550]}];
      }
    });
    samples(type,"geometry-route-quality","physical-corridor",[7,9],8,"disjoint endpoint routes share below/above8px of horizontal corridor",(s,v)=>{
      s.meta.quality_profile="showcase";
      if(type==="dataflow") {
        s.nodes=[{id:"a",type:"backend",label:"A",stage:0,row:0},{id:"b",type:"backend",label:"B",stage:1,row:1},{id:"c",type:"backend",label:"C",stage:0,row:1},{id:"d",type:"backend",label:"D",stage:1,row:0}];
        s.flows=[{from:"a",to:"b",label:"First",fromSide:"right",toSide:"left",via:[[180,157],[180,300],[240,300],[240,271]],labelAt:[600,400]},
          {from:"c",to:"d",label:"Second",fromSide:"right",toSide:"left",via:[[170,271],[170,300],[180+v,300],[180+v,157]],labelAt:[600,500]}];
      } else {
        s.states=[{id:"a",type:"active",label:"A",lane:"main",col:0},{id:"b",type:"active",label:"B",lane:"main",col:2,yOffset:150},{id:"c",type:"active",label:"C",lane:"main",col:0,yOffset:150},{id:"d",type:"active",label:"D",lane:"main",col:2}];
        s.transitions=[{from:"a",to:"b",label:"First",fromSide:"right",toSide:"left",via:[[180,157],[180,340],[300,340],[300,307]],labelAt:[700,500]},
          {from:"c",to:"d",label:"Second",fromSide:"right",toSide:"left",via:[[170,307],[170,340],[180+v,340],[180+v,157]],labelAt:[700,550]}];
      }
    });
  }
  for (const type of ["dataflow","lifecycle"]) samples(type,"geometry-label-overlap","label-canvas",[15,18],type==="dataflow"?16.5:15.5,"showcase label center minus half width may overflow at most.5px",(s,v)=>{
    s.meta.quality_profile="showcase";const edge=s[type==="dataflow"?"flows":"transitions"][0];edge.label="Go";edge.labelAt=[v,400];
  },"model-difference","text-capacity");
  samples("sequence","geometry-label-overlap","message-label-canvas",[32,34],33,"showcase long message label expands past left canvas edge",(s,v)=>{s.meta.quality_profile="showcase";s.messages[0].label="W".repeat(v);},"model-difference","text-capacity");
  samples("lifecycle","geometry-label-overlap","band-title",[114-1/64,114+1/64],114,"main band title bottom103 versus transition label top=centerY-11",(s,v)=>{s.meta.quality_profile="showcase";s.transitions[0].label="Go";s.transitions[0].labelAt=[100,v];},"model-difference","text-capacity");
  samples("lifecycle","geometry-label-overlap","label-pair",[412,416],414,"two16px label masks with2px inset around centerY400",(s,v)=>{s.transitions=[{id:"first",from:"a",to:"b",label:"One",labelAt:[500,400]},{id:"second",from:"a",to:"b",label:"Two",labelAt:[500,v]}];},"model-difference","text-capacity");
  samples("dataflow","geometry-route-quality","endpoint-direction",[0,1],.5,"declared right source side: rightward stub versus border-tangent first segment",(s,v)=>{Object.assign(s.flows[0],{fromSide:"right",toSide:"left",via:v?[[156,200],[240,200],[240,157]]:[[180,157],[180,200],[240,200],[240,157]],labelAt:[700,500]});});
  samples("lifecycle","geometry-route-quality","endpoint-direction",[0,1],.5,"straight preset: declared rightward side versus incorrect left source side",(s,v)=>{Object.assign(s.transitions[0],{route:"straight",fromSide:v?"left":"right",toSide:"left",labelAt:[470,220]});});
  samples("sequence","geometry-route-quality","parallel-messages",[180,212],180,"exact same-y collinear disjoint-endpoint messages versus separated rows",(s,v)=>{s.meta.quality_profile="showcase";s.participants=["a","b","c","d"].map(id=>({id,type:"backend",label:id}));s.messages=[{from:"a",to:"c",y:180,label:"First"},{from:"b",to:"d",y:v,label:"Second"}];});
  pair("sequence","geometry-route-clearance","family-label-route",204,"tangent arrow spans: second label top(y-20) minus first route180 >=4",(s,v)=>{s.meta.quality_profile="showcase";s.participants.push({id:"c",type:"backend",label:"C"});s.messages.push({from:"b",to:"c",y:v,label:"W".repeat(20)});});
  pair("lifecycle","geometry-route-clearance","family-label-route",172,"second label top(centerY-11) minus authored first horizontal157 >=4",(s,v)=>{
    s.meta.quality_profile="showcase";s.states[1].yOffset=150;s.states.push({id:"c",type:"active",label:"C",lane:"main",col:2,yOffset:150});
    s.transitions=[{from:"a",to:"b",label:"First",fromSide:"right",toSide:"left",via:[[500,157],[500,230],[170,230],[170,307]],labelAt:[700,400]},
      {from:"b",to:"c",label:"W".repeat(55),route:"straight",fromSide:"right",toSide:"left",labelAt:[325,v]}];
  });
  for(const type of ["dataflow","lifecycle"]) samples(type,"geometry-label-overlap","label-node",type==="dataflow"?[124,126]:[122,124],type==="dataflow"?125:123,"label mask bottom=centerY+5 exceeds node top plus2px inset",(s,v)=>{s[type==="dataflow"?"flows":"transitions"][0].label="Go";s[type==="dataflow"?"flows":"transitions"][0].labelAt=[type==="dataflow"?100:94,v];},"model-difference","text-capacity");
  samples("sequence","geometry-label-overlap","label-pair",[194-1/64,194+1/64],194,"tangent arrow spans: second label top(y-20) versus first label bottom176 minus2px inset",(s,v)=>{s.participants.push({id:"c",type:"backend",label:"C"});s.messages=[{from:"a",to:"b",y:180,label:"W".repeat(20)},{from:"b",to:"c",y:v,label:"W".repeat(20)}];},"model-difference","text-capacity");
  samples("sequence","geometry-legend-clearance","legend-wrap-label-width",[71,73],72,"explicit W legend override at8px: label width plus43px swatch <=400px row",(s,v)=>{s.meta.viewBox=[480,760];s.meta.legend={entries:{default:{label:"W".repeat(v)}}};},"model-difference","text-capacity");
  samples("sequence","geometry-legend-clearance","legend-wrap-overrides",[790-1/64,790+1/64],790,"two60 W override entries wrap to2 legacy rows: note content672 +96 +22",(s,v)=>{s.meta.viewBox=[480,v];s.meta.quality_profile="showcase";s.messages[0].y=650;s.messages[0].note="Detail";s.meta.legend={entries:{default:{label:"W".repeat(60)},return:{label:"W".repeat(60),visible:true}}};},"model-difference","text-capacity");
  return cases;
}

/** @type {Array<[string,number,string,string,string,string,string?]>} */
const inventory = [
  ["sequence",197,"duplicate participant ids","duplicate-id","unique participant.id","E1-covered"],
  ["sequence",200,"short readable timeline","geometry-node-viewbox","height -65 -142 >=120","schema-unreachable","sequence schema requires height >=480; renderer threshold327 cannot be crossed by a document-valid input"],
  ["sequence",206,"primary participant label fit","geometry-label-fit","textUnits(label)*6.8 <= headerWidth+6","existing-synthetic","spread header width boundary generated using schema-valid25 W text"],
  ["sequence",209,"brand top rail","geometry-label-fit","brand mark and sigil fit participant header","coverage-gap","requires a synthetic pinned brand mark fixture; no network capture in boundary generation"],
  ["sequence",216,"participant sublabel fit","geometry-label-fit","textUnits(sublabel)*6*.6 <= headerWidth-8","existing-synthetic","spread sublabel width boundary generated using45 W text"],
  ["sequence",222,"unknown message source","participant-reference","message.from in participants","E1-covered"],
  ["sequence",223,"unknown message target","participant-reference","message.to in participants","E1-covered"],
  ["sequence",224,"nonnumeric message time","shape","typeof message.y is number","E1-covered"],
  ["sequence",226,"message timeline bounds","geometry-message-time","160 <= message.y <= authored height-83","generated-boundary","lower bound160 is already schema-minimum; upper authored budget has 1/64px neighbours"],
  ["sequence",230,"message endpoint span","geometry-route-distance","message endpoint distance >=60","existing-synthetic","non-self fixed/spread pitch >=108; self relation is discrete14px case, not a continuous threshold"],
  ["sequence",236,"edge through participant header","geometry-route-clearance","route avoids third-party opaque header","delegated-shared","shared clean-flow predicate; source time floor160 keeps horizontal routes below header bottom132"],
  ["sequence",246,"proper route crossing","geometry-route-quality","showcase disjoint endpoints do not cross","renderer-invariant","sequence routes are horizontal so no proper perpendicular crossing; coincident overlaps handled corridor predicate"],
  ["sequence",255,"ambiguous corridor","geometry-route-quality","showcase unrelated horizontal overlap is separated","coverage-gap","existing same-time probe covers crowding but not isolated corridor threshold"],
  ["sequence",264,"segment border run","geometry-route-quality","no positive collinear overlap with trimmed frame side","existing-synthetic","equality predicate is non-monotone: y==border is negative, both 1/64px neighbours positive; not represented as a false one-sided boundary"],
  ["sequence",274,"route rhythm","geometry-route-quality","showcase micro segment8/interior16 floors","renderer-invariant","one horizontal sequence segment has no interior turns; self span14 is above micro floor"],
  ["sequence",298,"message row crowding","geometry-message-spacing","overlapping horizontal span requires deltaY >=28","generated-boundary"],
  ["sequence",311,"message label overlap","geometry-label-overlap","message label masks do not overlap at inset-2","existing-synthetic","same-time case rejects; independent label-only span fixture remains a gap"],
  ["sequence",315,"label near another route","geometry-route-clearance","showcase label-to-other-route clearance >=4","delegated-shared","single dataflow clearance boundary generated; sequence-specific endpoint case remains a gap"],
  ["sequence",325,"message label canvas containment","geometry-label-overlap","showcase label overflow <=0.5px","coverage-gap","needs a long message label with authored page, separate from primary participant label-fit"],
  ["sequence",336,"reversed segment range","range-order","segment.to > segment.from","E1-covered"],
  ["sequence",339,"segment canvas range","geometry-segment-range","from>=72 and to<=authored height-45","generated-boundary"],
  ["sequence",345,"segment title fit","geometry-segment-label-fit","label width +104 <= page width","generated-boundary"],
  ["sequence",350,"unknown activation participant","participant-reference","activation.participant in participants","E1-covered"],
  ["sequence",351,"reversed activation range","range-order","activation.to > activation.from","E1-covered"],
  ["sequence",357,"participant columns exceed page","geometry-participant-canvas-width","last center +half header+40 <=width","generated-boundary","fixed and spread modes both covered"],
  ["sequence",365,"implicit showcase legend hidden","geometry-legend-clearance","effective contentBottom +96 +22/additional row <=height (conservative growth hint uses98)","generated-boundary","note/no-note/activation reserves covered; localized multi-row chrome remains a gap"],
  ["sequence",369,"aggregate sequence refusal","aggregate","any accumulated problem","aggregation-only"],
  ["dataflow",122,"duplicate node ids","duplicate-id","unique node.id","E1-covered"],
  ["dataflow",127,"unknown node stage","stage-reference","stage in existing stage indices","E1-covered"],
  ["dataflow",130,"fixed row slots","fixed-row-slots","row integer in0..4","existing-synthetic","row5 rejection already recorded; row4/5 is a discrete integer boundary"],
  ["dataflow",133,"nonfinite placed coordinates","fixed-row-slots","finite stage/row/width/height/offset projection","mixed-admission","malformed scalar is E1-covered; schema-unbounded row5+ is fixed-row-slots; fixedpoint overflow is SDK coordinate refusal"],
  ["dataflow",137,"node horizontal page bounds","geometry-node-viewbox","24 <= node.left; node.right <=width-24","generated-boundary","left margin covered; stage-frame width budget dominates a narrow authored-page right margin"],
  ["dataflow",140,"node vertical readable bounds","geometry-node-viewbox","104 <=node.y; node.bottom <=height-74","generated-boundary"],
  ["dataflow",144,"primary node label fit","geometry-label-fit","textUnits(label)*6.2 <=width+6","generated-boundary"],
  ["dataflow",147,"brand top rail","geometry-label-fit","brand mark and sigil fit node width","coverage-gap","requires local synthetic pinned brand fixture"],
  ["dataflow",158,"sublabel and tag fit","geometry-label-fit","textUnits(value)*6*.6 <=width-8","generated-boundary","separate sublabel/tag pairs"],
  ["dataflow",169,"node collision gap","geometry-node-overlap","separation >=10px","generated-boundary"],
  ["dataflow",175,"unknown flow source","reference","flow.from in nodes","E1-covered"],
  ["dataflow",176,"unknown flow target","reference","flow.to in nodes","E1-covered"],
  ["dataflow",177,"missing flow data label","text","nonempty flow.label","E1-covered"],
  ["dataflow",182,"flow endpoint span","geometry-route-distance","Euclidean endpoint distance >=34","generated-boundary"],
  ["dataflow",191,"authored diagonal via","geometry-route-quality","each via segment dx<=.01 or dy<=.01","coverage-gap","schema admits diagonal via; needs .01 tolerance neighbours and endpoint-side-independent fixture"],
  ["dataflow",197,"endpoint side direction","geometry-route-quality","first/last segment crosses selected border perpendicularly","coverage-gap","shared endpoint predicate needs isolated side/direction fixtures"],
  ["dataflow",207,"flow through third-party node","geometry-route-clearance","segment avoids third-party node interior","coverage-gap","requires three-node occluder fixture"],
  ["dataflow",216,"proper crossing","geometry-route-quality","showcase unrelated paths do not cross","coverage-gap","requires four-node disjoint endpoint fixture"],
  ["dataflow",225,"ambiguous shared corridor","geometry-route-quality","showcase unrelated paths do not share corridor","coverage-gap","requires four-node disjoint endpoint fixture"],
  ["dataflow",234,"stage border run","geometry-route-quality","no positive collinear overlap with trimmed stage side","coverage-gap","sequence exact-collinearity probe exists; dataflow stage-side equality remains unisolated"],
  ["dataflow",244,"route rhythm","geometry-route-quality","showcase micro8/interior16 floors","existing-synthetic","real micro3/4px probe exists; 8/16 threshold pairs still need endpoint-safe route fixture"],
  ["dataflow",264,"label overlaps node","geometry-label-overlap","label/node inset overlap forbidden","existing-synthetic","lifecycle label-node actual probe; dataflow-specific threshold not isolated"],
  ["dataflow",271,"label pairs overlap","geometry-label-overlap","label pair inset-2 overlap forbidden","generated-boundary"],
  ["dataflow",275,"label route clearance","geometry-route-clearance","showcase label/other-route distance >=4","generated-boundary"],
  ["dataflow",285,"label canvas overflow","geometry-label-overlap","showcase label overflow <=.5px","coverage-gap","authored labelAt negative/large positive boundary needed"],
  ["dataflow",295,"stages exceed page width","stage-canvas-width","last stage center +84+24 <=width","generated-boundary"],
  ["dataflow",299,"aggregate dataflow refusal","aggregate","any accumulated problem","aggregation-only"],
  ["lifecycle",351,"duplicate state ids","duplicate-id","unique state.id","E1-covered"],
  ["lifecycle",357,"v1 fixed band page floor","geometry-node-viewbox","height -122 +4 >=448","generated-boundary","v2 auto-row layout intentionally does not apply this floor"],
  ["lifecycle",361,"duplicate lane ids","duplicate-id","unique lane.id","E1-covered"],
  ["lifecycle",363,"reserved main lane absent","reserved-main-lane","main lane exists in v1/v2","existing-synthetic","not E1: preserved from previous stage; discrete main/nonmain probe"],
  ["lifecycle",370,"unknown state lane","lane-reference","state.lane in lanes","E1-covered"],
  ["lifecycle",375,"v2 state column range","range","integer col in0..4","E1-covered"],
  ["lifecycle",386,"v1 fixed band column capacity","geometry-state-column","phase col0..4; event/outcome col0..2","existing-synthetic","v1 ordinary/terminal col3 rejects; v2 col3 accepted by its five-column grid"],
  ["lifecycle",391,"nonfinite placed coordinates","geometry-node-viewbox","finite column/size/offset projection","mixed-admission","wrong scalar shape is E1; invalid fixed-band columns above; huge valid coordinates hit SDK fixedpoint boundary"],
  ["lifecycle",395,"state horizontal page bounds","geometry-node-viewbox","v1 margin32;v2 margin28","generated-boundary","v1 phase left and ordinary/outcome right margins; v2 authored right margin covered; v2 source-sized first left stays60 and cannot cross margin28"],
  ["lifecycle",398,"state vertical lifecycle area","geometry-node-viewbox","v1 top64,bottomH-122;v2 top44,bottomH-extra-96","generated-boundary","v1/v2 top and authored bottom reserves covered; auto-growth controls remain separate"],
  ["lifecycle",402,"primary state label fit","geometry-label-fit","textUnits(label)*6.2 <=width+6","generated-boundary","v1/v2 separate width pairs"],
  ["lifecycle",405,"brand top rail","geometry-label-fit","brand mark and sigil fit state width","coverage-gap","requires local synthetic pinned brand fixture"],
  ["lifecycle",416,"sublabel and tag fit","geometry-label-fit","v1 minimum6,v2 minimum7; width budget minus8","generated-boundary","v1/v2 separate sublabel/tag pairs"],
  ["lifecycle",429,"state collision gap","geometry-node-overlap","state separation >=10px","generated-boundary","v1/v2 same-column offset pairs"],
  ["lifecycle",435,"unknown transition source","transition-endpoint","transition.from in states","E1-covered"],
  ["lifecycle",436,"unknown transition target","transition-endpoint","transition.to in states","E1-covered"],
  ["lifecycle",441,"transition endpoint span","geometry-route-distance","Euclidean endpoint distance >=32","generated-boundary"],
  ["lifecycle",449,"endpoint side direction","geometry-route-quality","automatic route border crossing perpendicular","coverage-gap","authored v1 via explicitly bypasses this gate; test must avoid mislabeling bypass as success proof"],
  ["lifecycle",460,"route through third-party state","geometry-route-clearance","segment avoids third-party state interior","coverage-gap","three-state occluder fixture needed"],
  ["lifecycle",469,"proper crossing","geometry-route-quality","showcase disjoint routes do not cross unless planner halo resolves","coverage-gap","plannerRouted pair can intentionally resolve crossing; authored version must distinguish it"],
  ["lifecycle",480,"ambiguous corridor","geometry-route-quality","showcase unrelated routes do not merge","coverage-gap","dedicated disjoint-endpoint corridor pair needed"],
  ["lifecycle",492,"container border run","geometry-route-quality","frames=[]","renderer-invariant","lifecycle bands are guides, not closed structural containers; no admitted source can trigger this call"],
  ["lifecycle",501,"route rhythm","geometry-route-quality","showcase micro8/interior16 floors","existing-synthetic","actual4/10px probe; exact threshold pairs need source-safe via fixture"],
  ["lifecycle",517,"transition label overlaps band title","geometry-label-overlap","showcase label rect misses band title rect","coverage-gap","v1 horizontal/v2 vertical band titles need independent labelAt boundaries"],
  ["lifecycle",523,"band-title refusal accumulation","geometry-label-overlap","same recorded cause as line517","aggregation-only"],
  ["lifecycle",530,"label overlaps state","geometry-label-overlap","label/state inset overlap forbidden","existing-synthetic","actual labelAt94,150 rejection; threshold fixture remains to add"],
  ["lifecycle",537,"label pairs overlap","geometry-label-overlap","label pair inset-2 overlap forbidden","coverage-gap","two transition labels at same point; boundary analogous to dataflow but unisolated"],
  ["lifecycle",541,"label route clearance","geometry-route-clearance","showcase label/other-route distance >=4","delegated-shared","dataflow boundary covers shared predicate; lifecycle-specific source geometry still needs probe"],
  ["lifecycle",550,"label canvas overflow","geometry-label-overlap","showcase label overflow <=.5px","coverage-gap","explicit labelAt border tolerance pair needed"],
  ["lifecycle",559,"aggregate lifecycle refusal","aggregate","any accumulated problem","aggregation-only"],
];

/** One row per actual renderer refusal site, including unreachable/delegated sites. */
/** @type {Record<string,[string,string]>} */
const supplementalCoverage = {
  "sequence:209":["generated-boundary","e2-boundary-sequence-brand-rail-7/9; fixed86px header, model text-capacity"],
  "sequence:236":["shared-covered","e2-boundary-architecture-unrelated-node-clearance-1/3 proves shared2px predicate; sequence source y>=160 stays below all header bodies ending132"],
  "sequence:255":["generated-boundary","e2-boundary-sequence-parallel-messages-180/212; source-family disjoint endpoints"],
  "sequence:311":["generated-boundary","e2-boundary-sequence-label-pair-*; tangent arrow spans isolate label-only overlap, model text-capacity"],
  "sequence:315":["generated-boundary","e2-boundary-sequence-family-label-route-below/above; actual4px oracle cause observed"],
  "sequence:325":["generated-boundary","e2-boundary-sequence-message-label-canvas-32/34; model text-capacity"],
  "sequence:365":["generated-boundary","legend-note/message/activation exact reserves; legend-wrap-label-width and legend-wrap-overrides model text-capacity; no unclaimed locale chrome proof"],
  "dataflow:147":["generated-boundary","e2-boundary-dataflow-brand-rail-71/73; both actual CLI verdicts observed, model text-capacity"],
  "dataflow:191":["generated-boundary","e2-boundary-dataflow-diagonal-via-0/1; source-aligned versus diagonal control"],
  "dataflow:197":["generated-boundary","e2-boundary-dataflow-endpoint-direction-0/1; physical source port at156,157"],
  "dataflow:207":["generated-boundary","e2-boundary-dataflow-third-node-gap-1/3; actual clean-flow/edge-through-node observed at gap1"],
  "dataflow:216":["generated-boundary","e2-boundary-dataflow-physical-crossing--1/1; real four-node crossing observed at180,200"],
  "dataflow:225":["generated-boundary","e2-boundary-dataflow-physical-corridor-7/9; 7px control actually accepted; 50px same fixture corridor actually refused"],
  "dataflow:234":["generated-boundary","e2-boundary-dataflow-stage-border-45/46/47; showcase exact46 top border with title X and x10 corridor actually refuses148px run; no fake header-bottom82 frame"],
  "dataflow:244":["shared-covered","e2-boundary-architecture-turn-7/9/15/17 shared rhythm floors plus existing e2-dataflow-geometry-route-quality-micro-segment actual family refusal"],
  "dataflow:264":["generated-boundary","e2-boundary-dataflow-label-node-124/126; model text-capacity"],
  "dataflow:285":["generated-boundary","e2-boundary-dataflow-label-canvas-15/18; model text-capacity"],
  "lifecycle:405":["generated-boundary","e2-boundary-lifecycle-brand-rail-71/73; shared brand predicate, model text-capacity"],
  "lifecycle:449":["generated-boundary","e2-boundary-lifecycle-endpoint-direction-0/1; straight preset avoids authored-via bypass; actual source-side refusal observed"],
  "lifecycle:460":["generated-boundary","e2-boundary-lifecycle-third-state-gap-1/3; three physical main-column states"],
  "lifecycle:469":["generated-boundary","e2-boundary-lifecycle-physical-crossing--1/1; actual authored-route crossing at180,200; planner halo exemption not claimed"],
  "lifecycle:480":["shared-covered","e2-boundary-architecture-corridor-7/9 exact shared8px predicate proof; lifecycle physical-corridor7/9 retained as MODEL artifact-route-rounding because final rounded SVG corner crossing preempts isolated source-corridor proof"],
  "lifecycle:501":["shared-covered","e2-boundary-architecture-turn-7/9/15/17 shared rhythm floors plus existing e2-lifecycle-geometry-route-quality-micro-segment actual family refusal"],
  "lifecycle:517":["generated-boundary","e2-boundary-lifecycle-band-title-*; below114 actual composition/label-band-title-overlap observed; model text-capacity"],
  "lifecycle:530":["generated-boundary","e2-boundary-lifecycle-label-node-122/124; model text-capacity"],
  "lifecycle:537":["generated-boundary","e2-boundary-lifecycle-label-pair-412/416; model text-capacity"],
  "lifecycle:541":["generated-boundary","e2-boundary-lifecycle-family-label-route-below/above; actual source4px oracle cause observed with displaced lower states"],
  "lifecycle:550":["generated-boundary","e2-boundary-lifecycle-label-canvas-15/18; model text-capacity"],
};
export const REFUSAL_AUDIT = inventory.map(([renderer,location,cause,suffix,expression,coverage,reason]) => {
  const supplement = supplementalCoverage[`${renderer}:${location}`];
  return {renderer,location,cause,engineCode:suffix === "aggregate" ? "none" : `${renderer}/${suffix}`,expression,
    coverage:supplement?.[0]??coverage,...((supplement?.[1]??reason)?{reason:supplement?.[1]??reason}:{})};
});
