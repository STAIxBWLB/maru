// Original synthetic inputs and an audit of the pinned oracle's refusal sites.
// No renderer implementation is imported. Actual oracle verdicts, not the
// intended boundary side, decide acceptance when these cases enter the corpus.
const ARCH = "sidecars/archify/renderers/architecture/render-architecture.mjs";
const WF = "sidecars/archify/renderers/workflow/workflow-compiler.mjs";
const SHARED = "sidecars/archify/renderers/shared/geometry.mjs";
const DETOUR = "sidecars/archify/renderers/shared/route-quality.mjs";
const audit = (renderer, location, cause, engineCode, expression, threshold, coverage) => ({ renderer, location, cause, engineCode, expression, threshold, coverage });
/** Each coverage entry is an audit status, never an unmeasured oracle result. */
export const ROUTE_REFUSAL_AUDIT = [
  audit("sidecars/archify/renderers/architecture/grid.mjs","33-59","grid mode, position, nonnegative cell, column and uniqueness","architecture/{enum,placement-input,range,grid-column,grid-cell}","pos overrides grid hints; otherwise valid unique declared cell",null,"E1 architecture.rs and generated cases"),
  audit(ARCH,"430-454","identity, placement and finite positive size","architecture/{duplicate-id,placement-input,shape,range}","ids unique; free pos required; finite positive size",null,"E1: architecture.rs; generated E1 cases"),
  audit(ARCH,"458","component outside canvas","architecture/geometry-node-viewbox","node bounds contained in viewBox",0,"existing e2 primary viewBox/origin cases"),
  audit(ARCH,"460-476","primary/detail/tag/brand readability","architecture/geometry-label-fit","text minimum width <= available rail",null,"existing e2 primary/detail/tag; new brand-rail71/73 around48+5*8*.6=72px"),
  audit(ARCH,"480-486","component clearance","architecture/geometry-node-overlap","rectsOverlap(a,b,8)",8,"new boundary: architecture-node-gap"),
  audit(ARCH,"494","unknown wrapped component","architecture/reference","wraps names existing components",null,"E1: architecture.rs reference"),
  audit(ARCH,"500-519","boundary title width/frame/page/node containment","architecture/geometry-boundary-title-fit","title fits frame/page and avoids components",null,"existing e2 boundary-title; individual title/frame intersections unisolated"),
  audit(ARCH,"528-579","boundary title pair and deployment frame containment","architecture/geometry-boundary-overlap","title pair disjoint; nested wraps agree with frames",null,"E1 ownership handles membership; geometry branches require frame-worker fixtures"),
  audit(ARCH,"585-617","boundary canvas containment","architecture/geometry-boundary-viewbox","boundary contained in origin-zero page",0,"existing frame cases; no isolated route boundary"),
  audit(ARCH,"622-623","unknown relation endpoints","architecture/reference","from/to names component",null,"E1 reference cases"),
  audit(ARCH,"626-635","route outside canvas","architecture/geometry-route-viewbox","showcase all route points in page",0,"new boundary: architecture-route-origin"),
  audit(ARCH,"638-651","endpoint distance/self-loop port distance","architecture/geometry-route-distance","euclidean endpoint span >=24",24,"new boundary: architecture-port-span; self-loop existing positive case"),
  audit(ARCH,"656-739","shared route gates","architecture/geometry-route-quality","delegates endpoint/node/crossing/corridor/border/rhythm",null,"shared inventory below"),
  audit(ARCH,"739-747","excessive route detour","architecture/geometry-route-quality","shortest legal orthogonal route ratio + excess + empty excursion",{ratio:2.5,excessPx:200,emptyPx:96},"oracle observed shortest408px; new actual-length1019/1021 ratio pair and excess199/201 pair"),
  audit(ARCH,"750-764","automatic short label gap","architecture/geometry-label-overlap","un-pinned label blocked and direct span <ceil(label.width+16)",16,"new architecture automatic gap; exact text metric boundary intentionally not assumed"),
  audit(ARCH,"773-780","label/component and boundary title overlap","architecture/geometry-label-overlap","rectsOverlap(label,node,-2); title overlap",-2,"new label-node pair; boundary title pair remains frame-worker coverage"),
  audit(ARCH,"785-805","label route/page containment","architecture/geometry-route-clearance","delegates shared label gates",null,"shared inventory below"),
  audit(WF,"1941-2080","v2 explicit pair pin conflicts","workflow/geometry-route-quality","label-route4; label-label -2; proper crossing; corridor8",{labelRoute:4,labelOverlap:-2,corridor:8},"new v2 pin boundary cases; actual final oracle diagnostics retained"),
  audit(WF,"2087-2106","v2 preset/channel compatibility","workflow/geometry-route-quality","preset supports authored channel field",null,"new v2 incompatible preset case; engine support requires audit"),
  audit(WF,"2227-2273","v2 origin pin containment","workflow/geometry-route-viewbox","labelAt/via/channel origin >=0",0,"new workflow-v2-origin pair"),
  audit(WF,"2280-2300","v2 finite and nonzero pinned segments","workflow/geometry-route-quality","finite coordinates; segment != zero",0,"finite E1 shape/range; new duplicate-via case"),
  audit(WF,"2301-2337","v2 orthogonal pin segments and min lengths","workflow/geometry-route-quality","axis aligned; direct>=28, endpoints>=8, interior>=16",{direct:28,endpoint:8,interior:16},"v2 anchors observed144,119 to288,119; turn15 rejects16px,17 accepted; endpoint9 accepted"),
  audit(WF,"2338-2378","v2 channel preservation and preset family","workflow/geometry-route-quality","via path contains authored channel; route fits preset family",null,"new channel-preservation/preset conflict; engine support requires audit"),
  audit(WF,"2379-2412","v2 endpoint orientation and unrelated-node clearance","workflow/geometry-route-clearance","honors sides; unrelated-node intersection",2,"new endpoint direction/node-clearance cases"),
  audit(WF,"2413-2448","v2 route legend/scene-label/frame clearance","workflow/geometry-route-quality","route avoids legend, title rails and frame border",0,"new source-via route legend189/191, title63/65 pairs based on observed baseline legend/header rectangles"),
  audit(WF,"2450-2496","v2 pinned label node/legend/title clearance","workflow/geometry-label-overlap","pinned label avoids measured obstacles",{node:-2,legend:0,title:0},"new pinned label legend bottom189/191 and lane-title bottom63/65 pairs"),
  audit(WF,"2503-2565","schema, identity, references, column rules","workflow/{shape,schema-version,diagram-type,text,id,duplicate-id,lane-reference,range}","typed document and declared references",null,"E1 workflow.rs and generated cases"),
  audit(WF,"2567-2597","node finite/label/brand/lane bounds","workflow/geometry-node-lane","finite geometry; text fits; node within lane",null,"E1 finite/range; existing e2 fit/lane and new brand-rail71/73"),
  audit(WF,"2600-2643","phase/group validity and title width","workflow/{phase-range,phase-overlap,group-range,lane-reference,empty-group,geometry-phase-label-fit}","declared ranges valid; title fits span",null,"E1 range/reference/membership; frame-worker title boundary"),
  audit(WF,"2645-2655","same-lane node clearance","workflow/geometry-node-overlap","rectsOverlap(a,b,8)",8,"existing same-lane-col; exact column/offset spacing needs layout-aware fixture"),
  audit(WF,"2660-2668","endpoints and direct span","workflow/geometry-route-distance","valid endpoints; direct span>=28",28,"E1 endpoints; new workflow-direct-span controls are oracle-measured"),
  audit(WF,"2674-2759","shared route gates","workflow/geometry-route-quality","endpoint/node/crossing/corridor/arrow/border/rhythm",null,"shared inventory below"),
  audit(WF,"2760-2779","mainPath node/link/order","workflow/{main-path-node,main-path-edge,main-path-order}","all path steps linked and forward",null,"E1 workflow.rs; existing generated rejection cases"),
  audit(WF,"2782-2799","label node/pair overlap","workflow/geometry-label-overlap","rectsOverlap(label,node-or-label,-2)",-2,"new common label-node and label-pair"),
  audit(WF,"2801-2829","label-route and v1 page/legend containment","workflow/geometry-route-clearance","label-route4; lane right+16; legendY+18<=page",{route:4,lane:16,legend:18},"shared label-route; existing e2 page/legend cases"),
  audit(WF,"2840-3056","v2 pre-routing shape/reference/overlap errors","workflow/{duplicate-id,edge-endpoint,lane-reference,range,geometry-node-overlap}","source-valid nodes and identities before solve",8,"E1 for structure; node-overlap existing E2 case"),
  audit(WF,"3803,3878,4258,4606,4639,4836","v2 feasibility, preset conflict, capacity, bounded solver","workflow/geometry-route-quality","feasible sides/pins/ranks/lanes/page; finite planning budget",{direct:28,stub:8,turn:16,laneGap:32},"new preset/channel cases; solver exhaustion is algorithm-dependent, not a source numeric boundary"),
  audit("sidecars/archify/renderers/workflow/render-workflow.mjs","24-26","compiled error propagation","workflow/geometry-route-quality","compiled.ok false => throw original diagnostics",null,"wrapper has no independent geometry predicates"),
  audit(SHARED,"388-455","endpoint-side-direction","*/geometry-route-quality","first/final nonzero segment honors declared/inferred side",0,"new endpoint-orientation plus raw diagonal controls"),
  audit(SHARED,"463-522","edge-through-node","*/geometry-route-clearance","unrelated opaque obstacle intersects segment with2px clearance",2,"new unrelated-node-clearance"),
  audit(SHARED,"607-693","proper-crossing","*/geometry-route-quality","strict interior segment intersection; shared ends/profile exceptions",0,"new proper-crossing raw pin case; touching control"),
  audit(SHARED,"706-855","ambiguous-corridor","*/geometry-route-quality","collinear overlap >=8; v2 same-style terminal trunk <=24 exempt",{minimum:8,trunkMaximum:24},"new corridor7/9 pairs; individually observed v2 trunk23 pass /25 measured corridor refusal"),
  audit(SHARED,"788-815","arrowhead-collision","*/geometry-route-quality","same destination/axis/direction, tip distance <3.5*(widthA+widthB)","3.5*(widthA+widthB)","observed v2 tips288,119 /288,126; widths6/7 and8/7 test marker sums6/8 around7px; C-generated notice policy explicit"),
  audit(SHARED,"876-953","container-border-run","*/geometry-route-quality","positive overlap beyond epsilon on corner-trimmed frame side",0.0001,"existing seq segment-border; new sequence border-neighbor pair"),
  audit(SHARED,"1028-1104","micro/short interior segment","*/geometry-route-quality","nonzero segment length <8; interior length <16",{micro:8,interior:16},"new 7/9 and15/17 source-via pairs"),
  audit(SHARED,"1108-1153","label-route-clearance","*/geometry-route-clearance","other-route distance <4 (own relation exempt)",4,"new authored label-route3/5 pairs"),
  audit(SHARED,"1179-1259","label-canvas-containment","*/geometry-label-viewbox","label rect overflow >0.5",0.5,"new label-origin -0.5/+1.5 controls; actual rect extent oracle measured"),
  audit(DETOUR,"10-18,494-615","excessive-route-detour","*/geometry-route-quality","ratio>=2.5 AND excess>=200 AND empty>=96; <=80 obstacles; shared outer corridor exemption32",{ratio:2.5,excess:200,empty:96,obstacles:80,shared:32},"ratio, excess and serpentine empty95/97 pairs; shared outer-corridor32 exemption requires a separate multi-route witness"),
];

const COLLECTION = { architecture:"connections", workflow:"edges", sequence:"messages", dataflow:"flows", lifecycle:"transitions" };
/** @typedef {Record<string, any>} RawSpec */
/** @param {(type:string)=>RawSpec} seedFor */
export function generatedRouteBoundaryCases(seedFor) {
  const result = [];
  const add = (type, suffix, rule, boundary, mutate) => {
    const spec = seedFor(type);
    mutate(spec);
    let category="source-geometry";
    let layer="exact";
    if(/label-route|label-node|label-pair|brand-rail/.test(suffix)){
      layer="model-difference";category="text-capacity";
    }
    if(type==="workflow" && suffix.startsWith("v2-")){
      const sourcePrimitive=/^(v2-turn-(15|17)|v2-duplicate-via|v2-orthogonality-|v2-channel-|v2-preset-conflict|v2-origin-)/.test(suffix);
      if(!sourcePrimitive){layer="model-difference";category="readable-v2-placement";}
      else category="authored-route-primitive";
    }
    if(suffix==="automatic-control")category="generated-quality-policy";
    result.push({ id:`e2-boundary-${type}-${suffix}`, diagramType:type, rule,
      geometryRule:`${type}/${rule}`, spec,
      boundary:{...boundary,layer,category,preemptionPolicy:"retain and report any unrelated oracle refusal; do not count a preempted case as this threshold's proof",oracleVerdict:"pending-host-oracle",source:"synthetic-original"} });
  };
  const architecture = (s) => {
    delete s.layout;
    s.meta.quality_profile="showcase";s.meta.viewBox=[1000,800];
    s.components=[{id:"a",type:"frontend",label:"A",pos:[80,100],size:[120,60]},
      {id:"b",type:"backend",label:"B",pos:[480,100],size:[120,60]}];
    s.connections=[{id:"route-a",from:"a",to:"b",fromSide:"right",toSide:"left",label:"Call",labelAt:[300,500]}];
  };
  for(const n of [7,9,15,17]) add("architecture",`turn-${n}`,"geometry-route-quality",{cause:n<10?"micro-segment":"short-interior-segment",threshold:n<10?8:16,value:n,side:n%8===7?"below":"above",authorship:"via"},s=>{
    architecture(s);s.connections[0].via=[[240,130],[240,130+n],[360,130+n],[360,130]];
  });
  for(const gap of [7,9]) add("architecture",`node-gap-${gap}`,"geometry-node-overlap",{cause:"node-clearance",threshold:8,value:gap},s=>{
    architecture(s);s.connections=[];s.components[1].pos=[200+gap,100];
  });
  for(const span of [23,25]) add("architecture",`port-span-${span}`,"geometry-route-distance",{cause:"endpoint-distance",threshold:24,value:span,authorship:"node-pos"},s=>{
    architecture(s);s.components[1].pos=[200+span,100];s.connections[0].route="straight";
  });
  for(const x of [-1,1]) add("architecture",`route-origin-${x<0?"outside":"inside"}`,"geometry-route-viewbox",{cause:"route-page",threshold:0,value:x,authorship:"via"},s=>{
    architecture(s);s.connections[0].fromSide="top";s.connections[0].toSide="top";
    s.connections[0].via=[[140,60],[x,60],[x,30],[540,30],[540,60]];
  });
  for(const via of [false,true]) add("architecture",`endpoint-${via?"conflict":"truthful"}`,"geometry-route-quality",{cause:"endpoint-side-direction",authorship:"fromSide",variant:via?"mismatch":"aligned"},s=>{
    architecture(s);s.connections[0].via=via?[[140,60],[540,60],[540,130]]:[[240,130],[440,130]];
  });
  for(const n of [3,5]) add("dataflow",`label-route-${n}`,"geometry-route-clearance",{cause:"label-route-clearance",threshold:4,value:n,authorship:"labelAt+via",measurement:"label bottom at y=306 for one 16px line centered by labelAt y=301"},s=>{
    s.meta.quality_profile="showcase";s.meta.viewBox=[1000,800];
    s.flows=[{id:"label-owner",from:"a",to:"b",label:"Data",labelAt:[300,301],via:[[180,157],[180,400],[270,400],[270,157]]},
      {id:"route-owner",from:"a",to:"b",label:"Return",labelAt:[700,500],via:[[180,157],[180,306+n],[270,306+n],[270,157]]}];
  });
  // Every generated pair records its intended witness. It does not hard-code a
  // successful verdict: another independent refusal is retained by the oracle.
  for(const type of ["dataflow","lifecycle"]) for(const n of [7,9,15,17]) add(type,`turn-${n}`,"geometry-route-quality",{cause:n<10?"micro-segment":"short-interior-segment",threshold:n<10?8:16,value:n,authorship:"via"},s=>{
    s.meta.quality_profile="showcase";s.meta.viewBox=[1000,800];const edge=s[COLLECTION[type]][0];
    const [start,end,bottom,middle]=type==="dataflow"?[100,315,186,200]:[94,248,188,170];
    edge.fromSide="bottom";edge.toSide="bottom";
    edge.via=n<10?[[start,bottom+n],[end,bottom+n]]:
      [[start,bottom+24],[middle,bottom+24],[middle,bottom+24+n],[end,bottom+24+n],[end,bottom+24]];
    edge.labelAt=[500,500];
  });
  for(const y of [179,181]) add("sequence",`segment-border-${y}`,"geometry-route-quality",{cause:"container-border-run",threshold:180,value:y,authorship:"message-y+segment"},s=>{
    s.meta.quality_profile="showcase";s.segments=[{label:"Phase",from:180,to:300}];s.messages[0].y=y;
  });
  const pairArchitecture = (s) => {
    architecture(s);
    s.components.push({id:"c",type:"frontend",label:"C",pos:[80,400],size:[120,60]},
      {id:"d",type:"backend",label:"D",pos:[480,400],size:[120,60]});
    s.connections=[
      {id:"upper",from:"a",to:"b",fromSide:"right",toSide:"left",label:"Upper",labelAt:[700,400],via:[[220,130],[220,300],[360,300],[360,130]]},
      {id:"lower",from:"c",to:"d",fromSide:"right",toSide:"left",label:"Lower",labelAt:[700,500],via:[[353,430],[353,300],[440,300],[440,430]]}];
  };
  for(const overlap of [7,9]) add("architecture",`corridor-${overlap}`,"geometry-route-quality",{cause:"ambiguous-corridor",threshold:8,value:overlap,authorship:"via",witness:{y:300,fromX:360-overlap,toX:360}},s=>{
    pairArchitecture(s);s.connections[1].via=[[360-overlap,430],[360-overlap,300],[440,300],[440,430]];
  });
  for(const crossing of [false,true]) add("architecture",`crossing-${crossing?"interior":"touch"}`,"geometry-route-quality",{cause:"proper-crossing",threshold:0,variant:crossing?"strict-interior":"endpoint-touch",authorship:"via"},s=>{
    pairArchitecture(s);s.connections[1].via=[[300,430],[300,crossing?250:300],[440,crossing?250:300],[440,430]];
  });
  for(const gap of [1,3]) add("architecture",`unrelated-node-clearance-${gap}`,"geometry-route-clearance",{cause:"edge-through-node",threshold:2,value:gap,authorship:"via"},s=>{
    architecture(s);s.components.push({id:"obstacle",type:"backend",label:"Obstacle",pos:[280,300],size:[120,60]});
    s.connections[0].via=[[240,130],[240,300-gap],[440,300-gap],[440,130]];
  });
  for(const overlap of [1,3]) add("architecture",`label-node-overlap-${overlap}`,"geometry-label-overlap",{cause:"label-node-overlap",threshold:2,value:overlap,authorship:"labelAt",measurement:"raw label height16, top=labelAtY-11; node top100"},s=>{
    architecture(s);s.connections[0].label="Call";s.connections[0].labelAt=[140,95+overlap];
  });
  for(const overlap of [1,3]) add("architecture",`label-pair-overlap-${overlap}`,"geometry-label-overlap",{cause:"label-label-overlap",threshold:2,value:overlap,authorship:"labelAt",measurement:"two16px labels; vertical extent overlap given below"},s=>{
    architecture(s);s.meta.quality_profile="standard";
    s.connections=[{id:"label-one",from:"a",to:"b",label:"One",labelAt:[300,400]},
      {id:"label-two",from:"a",to:"b",label:"Two",labelAt:[300,416-overlap]}];
  });
  // The standalone pinned oracle reports shortestLegalLengthPx=408 for
  // these bottom ports. At depth310 the actual1020px route is exactly2.5x;
  // changing depth by0.5 moves the route length one pixel across that boundary.
  for(const delta of [-1,1]) add("architecture",`detour-ratio-${delta<0?"below":"above"}`,"geometry-route-quality",{cause:"excessive-route-detour",threshold:1020,value:1020+delta,authorship:"via",measurement:{shortestLegalLengthPx:408,minimumRatio:2.5,actualLengthPx:1020+delta,depthPx:310+delta/2}},s=>{
    architecture(s);s.connections[0].fromSide="bottom";s.connections[0].toSide="bottom";
    s.connections[0].via=[[140,470+delta/2],[540,470+delta/2]];
  });
  // Narrow source boxes give a shortest legal bottom route of88px. Here the
  // ratio and empty-excursion predicates are already satisfied, so the200px
  // excess-length boundary can be tested independently.
  for(const excess of [199,201]) add("architecture",`detour-excess-${excess}`,"geometry-route-quality",{cause:"excessive-route-detour",threshold:200,value:excess,authorship:"via",measurement:{shortestLegalLengthPx:88,actualLengthPx:88+excess,depthPx:(8+excess)/2}},s=>{
    architecture(s);s.components[0].size=[40,60];s.components[1].pos=[160,100];s.components[1].size=[40,60];
    s.connections[0].fromSide="bottom";s.connections[0].toSide="bottom";s.connections[0].labelAt=[300,400];
    const y=160+(8+excess)/2;s.connections[0].via=[[100,y],[180,y]];
  });
  // A serpentine path keeps all control points directly below the two
  // endpoint boxes. Its ratio/excess already exceed their gates; only maximum
  // empty control-point clearance95/97 crosses the96px excursion condition.
  for(const depth of [95,97]) add("architecture",`detour-empty-${depth}`,"geometry-route-quality",{cause:"excessive-route-detour",threshold:96,value:depth,authorship:"via",measurement:{shortestLegalLengthPx:408,actualLengthPx:1200+2*depth,maximumEmptyClearancePx:depth}},s=>{
    architecture(s);s.connections[0].fromSide="bottom";s.connections[0].toSide="bottom";
    s.connections[0].via=[[140,120+depth],[540,120+depth],[540,140+depth],[140,140+depth],[140,160+depth],[540,160+depth]];
  });
  // The observed auto face slots are7px apart. Widths6/7 and8/7 make the
  // two marker half-width sums6/8px. A collision on an authored destination
  // face is owned; differing engine slot placement is separately reported.
  for(const markerWidth of [6,8]) add("workflow",`v2-arrow-spacing-${markerWidth}`,"geometry-route-quality",{cause:"arrowhead-collision",threshold:7,value:markerWidth,authorship:"toSide",measurement:{tips:[[288,119],[288,126]],tipDistancePx:7,minimumPx:markerWidth},expectedPolicy:"an actual engine collision on an authored face refuses; separated engine tips are a placement-model difference"},s=>{
    s.schema_version=2;s.meta.quality_profile="showcase";s.lanes.push({id:"other",label:"Other"});
    s.nodes[1].lane="other";s.nodes[1].col=0;s.nodes[2].col=2;
    s.edges=[{id:"incoming-one",from:"a",to:"c",toSide:"left",width:markerWidth/7},
      {id:"incoming-two",from:"b",to:"c",toSide:"left",width:markerWidth/7}];
  });
  for(const v2 of [false,true]) for(const n of [7,9,15,17]) add("workflow",`v${v2?2:1}-turn-${n}`,"geometry-route-quality",{cause:n<10?"micro-segment":"short-interior-segment",threshold:n<10?8:16,value:n,authorship:"via",measurement:"source route controls; readable-v2 may reject before final shared gate"},s=>{
    s.schema_version=v2?2:1;s.meta.quality_profile="showcase";
    s.edges=[{from:"a",to:"b",fromSide:"right",toSide:"left",via:n<10?[[ (v2?144:136)+n,119],[(v2?144:136)+n,170],[v2?264:228,170],[v2?264:228,119]]:[[v2?168:160,119],[v2?168:160,119+n],[v2?264:228,119+n],[v2?264:228,119]],label:"Call",labelAt:[700,200]}];
  });
  for(const x of [-1,1]) add("architecture",`origin-truthful-${x<0?"outside":"inside"}`,"geometry-route-viewbox",{cause:"route-page",threshold:0,value:x,authorship:"via"},s=>{
    architecture(s);s.meta.viewBox=[900,600];s.components[0].pos=[100,100];
    s.connections[0].fromSide="left";s.connections[0].toSide="bottom";s.connections[0].labelAt=[300,400];
    s.connections[0].via=[[60,130],[x,130],[x,230],[540,230]];
  });
  for(const x of [-1,1]) add("workflow",`v2-origin-${x<0?"outside":"inside"}`,"geometry-route-viewbox",{cause:"explicit-pin-origin",threshold:0,value:x,authorship:"via",measurement:{sourcePort:[48,119],targetPort:[336,143]}},s=>{
    s.schema_version=2;s.meta.quality_profile="standard";
    s.edges=[{from:"a",to:"b",fromSide:"left",toSide:"bottom",via:[[24,119],[x,119],[x,160],[336,160]]}];
  });
  add("workflow","v2-duplicate-via","geometry-route-quality",{cause:"non-zero-route-segments",threshold:0,authorship:"via"},s=>{
    s.schema_version=2;s.edges=[{from:"a",to:"b",fromSide:"right",toSide:"left",via:[[168,119],[168,119],[168,170],[264,170],[264,119]]}];
  });
  for(const diagonal of [false,true]) add("workflow",`v2-orthogonality-${diagonal?"diagonal":"axis"}`,"geometry-route-quality",{cause:"orthogonal-route-segments",threshold:0,authorship:"via"},s=>{
    s.schema_version=2;s.edges=[{from:"a",to:"b",fromSide:"right",toSide:"left",via:[[168,119],[168,170],[264,diagonal?171:170],[264,119]]}];
  });
  for(const keep of [false,true]) add("workflow",`v2-channel-${keep?"preserved":"lost"}`,"geometry-route-quality",{cause:"channel-pin-preservation",authorship:"via+channelX"},s=>{
    s.schema_version=2;s.edges=[{from:"a",to:"b",fromSide:"right",toSide:"left",channelX:keep?200:201,via:[[200,119],[200,170],[264,170],[264,119]]}];
  });
  for(const compatible of [false,true]) add("workflow",`v2-preset-${compatible?"compatible":"conflict"}`,"geometry-route-quality",{cause:"route-preset-compatibility",authorship:"route+channel"},s=>{
    s.schema_version=2;s.edges=[{from:"a",to:"b",route:"bottom-channel",...(compatible?{channelY:160}:{channelX:160})}];
  });
  // Individually observed compileWorkflow receipts preserve the144,119 source
  // port:23px is accepted;25px is a measured ambiguous-corridor refusal.
  for(const trunk of [23,25]) add("workflow",`v2-shared-trunk-${trunk}`,"geometry-route-quality",{cause:"short-workflow-trunk-exemption",threshold:24,value:trunk,authorship:"via",measurement:{sourcePort:[144,119],overlapPx:trunk},observedProbe:trunk===23?"accepted":"composition/ambiguous-corridor"},s=>{
    s.schema_version=2;s.meta.quality_profile="showcase";
    s.edges=[{id:"trunk-one",from:"a",to:"b",fromSide:"right",toSide:"left",via:[[144+trunk,119],[144+trunk,70],[264,70],[264,119]]},
      {id:"trunk-two",from:"a",to:"c",fromSide:"right",toSide:"left",via:[[144+trunk,119],[144+trunk,170],[504,170],[504,119]]}];
  });
  for(const y of [189,191]) add("workflow",`v2-route-legend-${y}`,"geometry-legend-clearance",{cause:"route-legend-clearance",threshold:190,value:y,authorship:"via",measurement:{legendRect:{x:101,y:190,width:91,height:14}}},s=>{
    s.schema_version=2;s.edges=[{from:"a",to:"b",fromSide:"right",toSide:"left",via:[[168,119],[168,y],[264,y],[264,119]]}];
  });
  for(const center of [185,187]) add("workflow",`v2-label-legend-${center}`,"geometry-legend-clearance",{cause:"label-legend-clearance",threshold:190,value:center+4,authorship:"labelAt",measurement:{labelHeight:14,labelTop:center-10,labelBottom:center+4,legendRect:{x:101,y:190,width:91,height:14}}},s=>{
    s.schema_version=2;s.edges=[{from:"a",to:"b",fromSide:"right",toSide:"left",via:[[168,119],[264,119]],label:"Call",labelAt:[140,center]}];
  });
  for(const center of [59,61]) add("workflow",`v2-label-lane-title-${center}`,"geometry-label-overlap",{cause:"label-lane-title-clearance",threshold:64,value:center+4,authorship:"labelAt",measurement:{headerTop:64,headerBottom:78,labelBottom:center+4}},s=>{
    s.schema_version=2;s.edges=[{from:"a",to:"b",fromSide:"right",toSide:"left",via:[[168,119],[264,119]],label:"Call",labelAt:[80,center]}];
  });
  for(const y of [63,65]) add("workflow",`v2-route-lane-title-${y}`,"geometry-route-clearance",{cause:"route-lane-title-clearance",threshold:64,value:y,authorship:"via",measurement:{headerX:54,headerTop:64,headerBottom:78}},s=>{
    s.schema_version=2;s.edges=[{from:"a",to:"b",fromSide:"right",toSide:"top",via:[[168,119],[168,y],[80,y],[80,40],[336,40],[336,70]]}];
  });
  for(const type of ["architecture","workflow"]) for(const width of [71,73]) add(type,`brand-rail-${width}`,"geometry-label-fit",{cause:"brand-top-rail",threshold:72,value:width,authorship:"node-width",measurement:{reservedRailPx:48,label:"Brand",labelUnits:5,minimumFontPx:8,minimumTextWidthPx:24}},s=>{
    if(type==="architecture"){architecture(s);s.connections=[];Object.assign(s.components[0],{label:"Brand",brand:"openai",size:[width,60]});}
    else{s.edges=[];Object.assign(s.nodes[0],{label:"Brand",brand:"openai",width});}
  });
  for(const span of [27,29]) add("workflow",`v1-direct-span-${span}`,"geometry-column-capacity",{cause:"direct-route-distance",threshold:28,value:span,authorship:"node-width"},s=>{
    s.nodes[0].col=2;s.nodes[1].col=3;s.nodes[1].width=2*(82-span);s.nodes[2].col=5;
    s.edges=[{from:"a",to:"b",fromSide:"right",toSide:"left",route:"straight"}];
  });
  for(const profile of ["standard","showcase"]) add("architecture",`profile-rhythm-${profile}`,"geometry-route-quality",{cause:"micro-segment",threshold:8,value:7,authorship:"via",profile},s=>{
    architecture(s);s.meta.quality_profile=profile;s.connections[0].via=[[240,130],[240,137],[360,137],[360,130]];
  });
  for(const type of ["architecture","workflow","dataflow","lifecycle"]) add(type,"automatic-control","geometry-route-quality",{cause:"generated-quality-control",authorship:"none",expectedPolicy:"oracle positive remains positive; generated quality failures are nonfatal engine notices"},s=>{
    s.meta.quality_profile="showcase";
  });
  return result;
}
