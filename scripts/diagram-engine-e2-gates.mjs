// Renderer gate/adjustment inventory. Every key is explicitly assigned below;
// neither source text nor diagnostic names are classified by regular expression.
import { generatedBoundaryCases, REFUSAL_AUDIT } from "./diagram-engine-e2-boundaries.mjs";
import { generatedGeometryCases } from "./diagram-engine-e2-cases.mjs";
import { ROUTE_REFUSAL_AUDIT, generatedRouteBoundaryCases } from "./diagram-engine-e2-route-boundaries.mjs";
const ARCH="sidecars/archify/renderers/architecture/render-architecture.mjs";
const WF="sidecars/archify/renderers/workflow/workflow-compiler.mjs";
const SHARED="sidecars/archify/renderers/shared/geometry.mjs";
const DETOUR="sidecars/archify/renderers/shared/route-quality.mjs";
const assignments=new Map();
const assign=(renderer,locations,gate,adjustments=[],controlIds=[],exemption)=>{
  for(const location of locations){const key=`${renderer}:${location}`;
    if(assignments.has(key))throw new Error(`Gate audit key assigned twice: ${key}; remove the duplicate explicit assignment.`);
    assignments.set(key,{renderer,location,gate,adjustments,requiresUngatedControl:controlIds.length>0,
      controlIds,...(exemption?{exemption}:{}),reviewedSource:"pinned renderer control flow; source-line keys match the refusal audit"});}
};
const seq=["legend selection precedes wrapping in catalog order emphasis, return, security, dashed, default; hidden entries and mode selection are resolved first",
  "auto viewBox height grows from messages, notes, activations and measured legend rows when meta.viewBox is absent",
  "column_fit=spread resolves participant header width/pitch before every text/page check; fixed mode retains fixed86px headers",
  "showcase enables the readable message label mask before label collision checks"];
const df=["resolve fixed stage centers100+215*stage and five row slots128+114*row before checking",
  "source route presets and labelPoint are resolved directly; dataflow has no lifecycle-style automatic label relocation pass"];
const life=["schema1 uses reserved fixed main/event/terminal bands; schema2 orders reserved main first/terminal last and resolves row metrics",
  "schema2 without authored viewBox grows to node bounds and resolved legend rows before checks",
  "showcase places unpinned labels before checks; schema2 also uses gridSweep/near-route fallback"];
const arch=["readable boundary titles use preferred9px/minimum6px font,4px frame inset,10px mask padding,minimum30px mask width and16px mask height,2px clearance/rail gap; symmetric expansion never clamps negative origins",
  "resolve authored pos ahead of grid row/col; declared node size is retained",
  "automatic canvas includes nodes, boundary frames, connection labels and route points; authored viewBox is not grown",
  "title rails stack before checks; only a present quality profile expands the containing frame and iteratively resolves desktop-readable minimum; profile-less source keeps the legacy frame"];
const wf=["schema1 resolves legacy fixed columns/lanes before checks",
  "schema2 canonicalizes readable rows/ranks, reserves absolute pins, solves automatic routes/labels, then validates pinned geometry",
  "schema2 grows automatic canvas; authored viewBox is checked against required capacity, not silently enlarged"];
assign("sequence",[197,200,206,222,223,224,226,230,236,298,311,336,339,345,350,351,357],"always for each admitted member/reference",seq);
assign("sequence",[209],"participant has a resolved brand mark",seq,["gate-sequence-brand-absent"]);
assign("sequence",[216],"participant.sublabel is nonempty",seq,["gate-sequence-optional-detail-absent"]);
assign("sequence",[246],"effective quality profile=showcase; proper crossing only",seq,[],"messagePath emits horizontal segments only; a proper interior X cannot be authored in the admitted sequence format; gate is retained, no fake positive proof");
assign("sequence",[255],"effective quality profile=showcase; qualifying unrelated/shared endpoint policy",seq,[],"a same-row overlapping message corridor also violates unconditional row-spacing; no isolated accepted gate-off source exists for that witness");
assign("sequence",[264],"effective quality profile is present (standard or showcase)",seq,["gate-sequence-border-profile-absent"]);
assign("sequence",[274],"effective quality profile=showcase",seq,[],"a valid sequence message is one horizontal segment spanning>=60px; no admitted micro/interior turn can trigger this call");
assign("sequence",[315],"effective quality profile=showcase",seq,["gate-sequence-label-route-standard"]);
assign("sequence",[325],"effective quality profile=showcase",seq,["gate-sequence-label-page-standard"]);
assign("sequence",[365],"source quality_profile=showcase AND meta.legend absent AND required legend exceeds page AND implicit legend cannot be measured",seq,["gate-sequence-late-standard","gate-sequence-late-hidden","gate-sequence-auto-height","adjust-sequence-legend-catalog-wrap"]);
assign("sequence",[369],"aggregate previously collected failures",seq,[],"aggregation is not an independently switchable predicate");
assign("dataflow",[122,127,130,133,137,140,144,169,175,176,177,182,191,197,207,264,271,295],"always for admitted members/references",df);
assign("dataflow",[147],"node has resolved brand mark",df,["gate-dataflow-brand-absent"]);
assign("dataflow",[158],"sublabel/tag value is nonempty",df,["gate-dataflow-optional-detail-absent"]);
assign("dataflow",[216],"effective quality profile=showcase",df,["gate-dataflow-crossing-standard"]);
assign("dataflow",[225],"effective quality profile=showcase",df,["gate-dataflow-corridor-standard"]);
assign("dataflow",[234],"effective quality profile is present",df,["gate-dataflow-border-profile-absent"]);
assign("dataflow",[244],"effective quality profile=showcase",df,["gate-dataflow-rhythm-standard"]);
assign("dataflow",[275],"effective quality profile=showcase",df,["gate-dataflow-label-route-standard"]);
assign("dataflow",[285],"effective quality profile=showcase",df,["gate-dataflow-label-page-standard"]);
assign("dataflow",[299],"aggregate previously collected failures",df,[],"aggregation only");
assign("lifecycle",[351,361,363,370,391,395,402,429,435,436,441,460,530,537],"always for admitted members/references; bounds use schema-specific resolved metrics",life);
assign("lifecycle",[398],"schema-specific area after auto-height adjustment; authored page is not resized",life,["gate-lifecycle-v2-auto-height"]);
assign("lifecycle",[357],"schema_version=1 (fixed band floor)",life,["gate-lifecycle-v2-no-fixed-floor"]);
assign("lifecycle",[375],"schema_version=2; declared col integer0..4",life,[],"v1 column admission is no more permissive for any lane, so no source can violate v2's col0..4 predicate while valid in v1");
assign("lifecycle",[386],"schema_version=1; fixed event/outcome bands admit only col0..2",life,["gate-lifecycle-v2-ordinary-col3"]);
assign("lifecycle",[405],"state has resolved brand mark",life,["gate-lifecycle-brand-absent"]);
assign("lifecycle",[416],"sublabel/tag nonempty; minimum6 for v1,7 for v2",life,["gate-lifecycle-optional-detail-absent"]);
assign("lifecycle",[449],"transition.via is NOT an array (actual callback has no schema-version condition)",life,["gate-lifecycle-via-side-bypass"]);
assign("lifecycle",[469],"effective quality profile=showcase; plannerRouted(left)&&plannerRouted(right) resolves the crossing with halo",life,["gate-lifecycle-crossing-standard"],"planner halo sub-branch cannot be forced to retain an exact X from source; planner regenerates both paths; do not treat a clean auto seed as halo proof");
assign("lifecycle",[480],"effective quality profile=showcase",life,["gate-lifecycle-corridor-standard"]);
assign("lifecycle",[492],"effective profile present but frames is always empty",life,[],"unreachable: lifecycle bands are open guides and this call supplies frames=[]");
assign("lifecycle",[501],"effective quality profile=showcase",life,["gate-lifecycle-rhythm-standard"]);
assign("lifecycle",[517,523],"source quality_profile=showcase",life,["gate-lifecycle-title-standard"]);
assign("lifecycle",[541],"effective quality profile=showcase",life,["gate-lifecycle-label-route-standard"]);
assign("lifecycle",[550],"effective quality profile=showcase",life,["gate-lifecycle-label-page-standard"]);
assign("lifecycle",[559],"aggregate previously collected failures",life,[],"aggregation only");
assign("sidecars/archify/renderers/architecture/grid.mjs",["33-59"],"layout.mode=grid; authored pos bypasses row/col/grid-cell checks",arch,["gate-architecture-pos-overrides-grid"]);
assign(ARCH,["430-454","458","480-486","494","585-617","622-623","638-651"],"always after source layout resolution",arch);
assign(ARCH,["460-476"],"primary label always; brand/detail/tag branches require the corresponding nonempty source value",arch,["gate-architecture-brand-absent","gate-architecture-optional-detail-absent"]);
assign(ARCH,["500-519"],"meta.quality_profile is present",arch,["gate-architecture-titles-profile-absent","adjust-architecture-title-expansion"]);
assign(ARCH,["528-579"],"title pair check: quality_profile present; membership/frame nesting: engineering_profile=deployment-ownership",arch,["gate-architecture-titles-profile-absent","gate-architecture-nondeployment-scopes","adjust-architecture-title-stack"]);
assign(ARCH,["626-635"],"source quality_profile=showcase",arch,["gate-architecture-origin-standard"]);
assign(ARCH,["656-739"],"endpoint/node gates always; crossing/corridor/rhythm showcase; border any effective profile; auto-only arrow selection",arch,["gate-architecture-crossing-standard","gate-architecture-corridor-standard","gate-architecture-rhythm-standard","gate-architecture-border-profile-absent"]);
assign(ARCH,["739-747"],"source quality_profile=showcase AND nonempty authored via; all detour thresholds conjunctive",arch,["gate-architecture-detour-standard"]);
assign(ARCH,["750-764"],"showcase AND label unpinned AND automatic label blocked AND direct horizontal gap below measured minimum",arch,[],"not an independent acceptance gate: else-branch still refuses every blocked label; message specialization must not be counted as a gate-off acceptance proof");
assign(ARCH,["773-780"],"label/component overlap always; boundary-title/label overlap only when quality_profile is present",arch,["gate-architecture-title-label-profile-absent"]);
assign(ARCH,["785-805"],"effective quality profile=showcase",arch,["gate-architecture-label-route-standard","gate-architecture-label-page-standard"]);
assign(WF,["1941-2080"],"schema2; label-route requires labelAt or other authored route assertions; pair crossing/corridor additionally source showcase",wf,["gate-workflow-v1-pair-controls","gate-workflow-v2-corridor-standard"]);
assign(WF,["2087-2106","2227-2273","2280-2300","2301-2337","2338-2378","2379-2412","2413-2448","2450-2496"],"schema_version=2; named/source assertions apply before renderer repair",wf,["gate-workflow-v1-origin","gate-workflow-v1-preset-fields","gate-workflow-v1-via-rhythm"]);
assign(WF,["2567-2597"],"node coordinate/lane checks always; brand/detail/tag branches require their nonempty source value",wf,["gate-workflow-brand-absent","gate-workflow-optional-detail-absent"]);
assign(WF,["2503-2565","2600-2643","2645-2655","2660-2668","2760-2779","2782-2799"],"always; optional phases/groups/mainPath/card/detail branches require their source members",wf,["gate-workflow-optional-structures-absent"]);
assign(WF,["2674-2759"],"endpoint/node always; crossing/corridor/rhythm source showcase; border source profile present; arrowheads schema2 with showcase refusal/standard warning",wf,["gate-workflow-rhythm-standard","gate-workflow-border-profile-absent","gate-workflow-v1-no-v2-arrows","gate-workflow-v2-arrows-standard"]);
assign(WF,["2801-2829"],"label-route source showcase; fixed lane/legend page checks schema1; shared label page containment schema1 AND source showcase",wf,["gate-workflow-label-route-standard","gate-workflow-label-page-standard","gate-workflow-v2-auto-height"]);
assign(WF,["2840-3056","3803,3878,4258,4606,4639,4836"],"schema_version=2; readable solver may adjust layout before emitting source/preset/capacity/budget error",wf,["gate-workflow-v1-origin","gate-workflow-v1-preset-fields","gate-workflow-v1-via-rhythm"]);
assign("sidecars/archify/renderers/workflow/render-workflow.mjs",["24-26"],"compiled.ok is false",wf,[],"error propagation only; compiler audit supplies the actual gates");
assign(SHARED,["388-455"],"always except renderer shouldCheckRelation callback (lifecycle via-array bypass)",[],["gate-lifecycle-via-side-bypass"]);
assign(SHARED,["463-522"],"valid referenced endpoints; unrelated opaque obstacles only; source/target exempt",["renderer selects opaque obstacles; sequence excludes lifelines, activations and segments"],[],"applicability guard, not a profile/version refusal; exempt source/target is covered by normal endpoint routes");
assign(SHARED,["607-693"],"effective showcase refuses; standard warning only when caller enables warnInStandard; crossingResolved callback may exempt automatic halo routes",[],["gate-architecture-crossing-standard","gate-dataflow-crossing-standard","gate-lifecycle-crossing-standard"],"halo callback requires observing actual planner geometry, not an arbitrary synthetic crossing override");
assign(SHARED,["706-855"],"showcase refusal; standard only warning for v2 short-trunk mode; shared-endpoint policies and <=24px same-style terminal-trunk exception",[],["gate-architecture-corridor-standard","gate-workflow-v2-corridor-standard"]);
assign(SHARED,["788-815"],"caller selects architecture auto unlabeled-position routes or workflow schema2; standard workflow is warning, showcase refusal",[],["gate-workflow-v1-no-v2-arrows","gate-workflow-v2-arrows-standard"]);
assign(SHARED,["876-953"],"effective profile is present",[],["gate-architecture-border-profile-absent","gate-sequence-border-profile-absent","gate-dataflow-border-profile-absent"]);
assign(SHARED,["1028-1104"],"effective quality profile=showcase",[],["gate-architecture-rhythm-standard","gate-workflow-rhythm-standard","gate-dataflow-rhythm-standard","gate-lifecycle-rhythm-standard"]);
assign(SHARED,["1108-1153"],"effective quality profile=showcase",[],["gate-architecture-label-route-standard","gate-sequence-label-route-standard","gate-dataflow-label-route-standard","gate-lifecycle-label-route-standard"]);
assign(SHARED,["1179-1259"],"effective quality profile=showcase; readable-v2 uses its separate grow/explicit-origin path",["architecture auto canvas grows around labels; other authored page budgets remain fixed"],["gate-architecture-label-page-standard","gate-sequence-label-page-standard","gate-dataflow-label-page-standard","gate-lifecycle-label-page-standard"]);
assign(DETOUR,["10-18,494-615"],"source profile=showcase AND via nonempty; <=80 obstacles; ratio/excess/empty conjunction; related shared outer corridor>=32px exempt",["compute shortest obstacle-clearing reference and content bounds after layout"],["gate-architecture-detour-standard"]);
const sources=[...REFUSAL_AUDIT,...ROUTE_REFUSAL_AUDIT];
if(sources.length!==132 || assignments.size!==132)throw new Error("Gate audit must explicitly cover all132 refusal rows; update the row assignments after reviewing the pinned source.");
export const GATE_ADJUST_AUDIT=sources.map(row=>{
  const key=`${row.renderer}:${row.location}`;const item=assignments.get(key);
  if(!item)throw new Error(`Gate audit row is missing: ${key}; add its explicit gate and adjustment metadata.`);
  return {key,...item,cause:row.cause};
});

/** @typedef {Record<string, any>} RawSpec */
/** @param {(type:string)=>RawSpec} seedFor */
export function generatedGateCases(seedFor){
  const probes=[...generatedBoundaryCases(seedFor),...generatedRouteBoundaryCases(seedFor),...generatedGeometryCases(seedFor)];
  const result=[];
  const controls=new Set();
  const add=(id,type,change,activeCaseId,why,category="ungated-control")=>{
    if(controls.has(id))throw new Error(`Gate control is duplicated: ${id}; give each control one explicit definition.`);
    const original=activeCaseId?probes.find(c=>c.id===activeCaseId):undefined;
    if(activeCaseId&&!original)throw new Error(`Gate-on probe ${activeCaseId} is missing; restore its reviewed fixture before regenerating controls.`);
    const spec=structuredClone(original?.spec??seedFor(type));change(spec);
    const coveredAuditSites=GATE_ADJUST_AUDIT.filter(row=>row.controlIds.includes(id)).map(row=>row.key);
    if(!coveredAuditSites.length)throw new Error(`Ungated control ${id} covers no declared site; link it explicitly in the gate audit.`);
    controls.add(id);
    result.push({id,diagramType:type,rule:"geometry-gate-control",spec,
      boundary:{layer:"exact",category,expectedOracleAccepted:true,expectedEngineAccepted:true,
        coveredAuditSites,gateOnNegativeRefs:activeCaseId?[activeCaseId]:[],disarmedPredicate:why,
        acceptanceRequirement:"the actual oracle AND engine must accept; false/false is not a passing positive control"}});
  };
  const standard=s=>{s.meta.quality_profile="standard";};
  const noProfile=s=>{delete s.meta.quality_profile;};
  for(const type of ["architecture","workflow","sequence","dataflow","lifecycle"]){
    add(`gate-${type}-brand-absent`,type,s=>{
      const collection={architecture:"components",workflow:"nodes",sequence:"participants",dataflow:"nodes",lifecycle:"states"}[type];
      const n=s[collection][0];n.label=type==="sequence"?"BrandBrand":"Brand";
      if(type==="architecture")n.size=[71,60];else if(type!=="sequence")n.width=71;
      delete n.brand;
      // With the brand present these exact source widths fail the48px rail
      // budget. Absence removes that rail, not the primary-label fit check.
    },undefined,"resolved brand mark absent; narrow source width would fail the brand rail if the mark were present");
    add(`gate-${type}-optional-detail-absent`,type,s=>{
      const collection={architecture:"components",workflow:"nodes",sequence:"participants",dataflow:"nodes",lifecycle:"states"}[type];
      delete s[collection][0].sublabel;delete s[collection][0].tag;
    },undefined,"optional text fields absent; only their own fit branches are disabled");
  }
  add("gate-architecture-pos-overrides-grid","architecture",s=>{
    s.layout={mode:"grid",cols:1};s.components.forEach((n,i)=>{n.row=0;n.col=3;n.pos=[100+i*240,160];});
  },undefined,"authored pos overrides out-of-grid duplicate row/col hints before grid validation");
  const wideArchitecture=s=>{
    delete s.layout;s.meta.viewBox=[2000,900];s.components.forEach((n,i)=>{delete n.row;delete n.col;n.pos=[500+i*300,300];n.size=[120,60];});s.connections=[];
  };
  add("gate-architecture-titles-profile-absent","architecture",s=>{
    wideArchitecture(s);noProfile(s);s.boundaries=[{kind:"region",label:"W".repeat(60),wraps:["a"],pad:24}];
  },undefined,"profile absent disables desktop-readable boundary-title refusal; source layout/title adjustment still runs");
  add("gate-architecture-nondeployment-scopes","architecture",s=>{
    wideArchitecture(s);noProfile(s);delete s.meta.engineering_profile;
    s.components.push({id:"c",type:"backend",label:"C",pos:[1100,300],size:[120,60]});
    s.boundaries=[{kind:"region",label:"Runtime",wraps:["a","b"]},{kind:"security-group",label:"Compliance",wraps:["b","c"]}];
  },undefined,"nondeployment boundary sets may overlap nonlaminarly; deployment ownership gates are absent");
  add("gate-architecture-origin-standard","architecture",standard,"e2-boundary-architecture-origin-truthful-outside","standard disables showcase-only route page check while retaining truthful source endpoints");
  add("gate-architecture-crossing-standard","architecture",standard,"e2-boundary-architecture-crossing-interior","standard does not refuse authored proper crossing");
  add("gate-architecture-corridor-standard","architecture",standard,"e2-boundary-architecture-corridor-9","standard does not refuse the9px unrelated corridor");
  add("gate-architecture-rhythm-standard","architecture",standard,"e2-boundary-architecture-turn-7","standard does not refuse the7px authored turn");
  add("gate-architecture-detour-standard","architecture",standard,"e2-boundary-architecture-detour-ratio-above","standard disables authored detour conjunction despite ratio above2.5");
  add("gate-architecture-border-profile-absent","architecture",s=>{
    wideArchitecture(s);noProfile(s);s.boundaries=[{kind:"region",label:"Frame",wraps:["a"],pad:20}];
    s.connections=[{from:"a",to:"b",fromSide:"top",toSide:"top",via:[[560,280],[560,252],[860,252],[860,280]]}];
  },undefined,"profile absent disables container-border-run gate; path follows the source boundary top rail");
  add("gate-architecture-title-label-profile-absent","architecture",s=>{
    wideArchitecture(s);noProfile(s);s.boundaries=[{kind:"region",label:"Frame",wraps:["a"],pad:20}];
    s.connections=[{from:"a",to:"b",label:"Call",labelAt:[530,284]}];
  },undefined,"boundary-title/relationship-label overlap branch disabled when profile absent; component overlap still enforced");
  add("gate-architecture-label-route-standard","architecture",s=>{
    standard(s);s.connections[0].labelAt=[400,305];
  },"e2-boundary-architecture-corridor-9","standard disables label-other-route clearance (label overlaps the other route at y300)");
  add("gate-architecture-label-page-standard","architecture",s=>{
    standard(s);s.connections[0].labelAt=[900,400];
  },"e2-boundary-architecture-origin-truthful-inside","standard disables label page clipping even with center on authored right edge");
  add("gate-sequence-border-profile-absent","sequence",s=>{
    noProfile(s);s.segments=[{label:"Phase",from:180,to:300}];s.messages[0].y=180;
  },undefined,"message lies exactly on the segment border; absent profile disables that gate");
  add("gate-sequence-label-route-standard","sequence",s=>{standard(s);s.messages[1].label="i".repeat(20);},"e2-boundary-sequence-family-label-route-below","standard disables label-other-message clearance; unconditional message spacing remains valid");
  add("gate-sequence-label-page-standard","sequence",s=>{standard(s);s.messages[0].label="문".repeat(17);},"e2-boundary-sequence-message-label-canvas-34","standard disables clipping check for a message mask crossing the authored page");
  const late=s=>{s.meta.viewBox=[920,760];s.messages[0].y=650;s.messages[0].note="Detail";};
  add("gate-sequence-late-standard","sequence",s=>{late(s);standard(s);},undefined,"standard may hide an unfit implicit legend; showcase-only implicit legend refusal is disabled");
  add("gate-sequence-late-hidden","sequence",s=>{late(s);s.meta.quality_profile="showcase";s.meta.legend={mode:"hidden"};},undefined,"explicit hidden legend yields no entries; implicit-legend-only failure does not apply");
  add("gate-sequence-auto-height","sequence",s=>{late(s);s.meta.quality_profile="showcase";delete s.meta.viewBox;},undefined,"without authored page the renderer grows before validating late message/note and legend reserve");
  for(const type of ["dataflow","lifecycle"]){
    add(`gate-${type}-crossing-standard`,type,standard,`e2-boundary-${type}-physical-crossing-1`,"standard disables the actual authored unrelated-path crossing");
    add(`gate-${type}-corridor-standard`,type,standard,`e2-boundary-${type}-physical-corridor-9`,"standard disables the shared corridor refusal");
    add(`gate-${type}-rhythm-standard`,type,standard,`e2-boundary-${type}-turn-7`,"standard disables the7px endpoint rhythm gate");
    add(`gate-${type}-label-page-standard`,type,standard,`e2-boundary-${type}-label-canvas-15`,"standard disables the explicit label page clipping gate");
    add(`gate-${type}-label-route-standard`,type,s=>{standard(s);if(type==="lifecycle")s.transitions[1].label="i".repeat(Array.from(s.transitions[1].label).length);},type==="dataflow"?"e2-boundary-dataflow-label-route-clearance-below":"e2-boundary-lifecycle-family-label-route-below","standard disables the explicit label-other-route4px gate");
  }
  add("gate-dataflow-border-profile-absent","dataflow",noProfile,"e2-boundary-dataflow-stage-border-46","absent profile permits an exact stage-top border run at y46");
  add("gate-lifecycle-title-standard","lifecycle",standard,"e2-boundary-lifecycle-band-title-113.984375","standard disables transition-label/band-title overlap while label remains outside state bodies");
  add("gate-lifecycle-v2-no-fixed-floor","lifecycle",s=>{s.schema_version=2;s.meta.viewBox=[640,300];},undefined,"v2 does not apply the566px fixed-v1 band floor");
  add("gate-lifecycle-v2-auto-height","lifecycle",s=>{
    s.schema_version=2;s.states[0].yOffset=500;s.transitions=[];delete s.meta.viewBox;
  },undefined,"v2 auto page grows below a displaced state and the measured legend before area validation");
  add("gate-lifecycle-v2-ordinary-col3","lifecycle",s=>{
    s.schema_version=2;s.lanes.push({id:"ordinary",label:"Other"});s.states[1].lane="ordinary";s.states[1].col=3;s.transitions=[];
  },undefined,"v2 ordinary rows have five columns; fixed-v1 event col0..2 capacity gate is disabled");
  add("gate-lifecycle-via-side-bypass","lifecycle",s=>{
    standard(s);s.transitions=[{from:"a",to:"b",fromSide:"right",toSide:"left",via:[[153,200],[175,200],[175,157]],label:"Call",labelAt:[500,400]}];
  },undefined,"an explicit via array bypasses lifecycle endpoint-side direction even though the first raw segment follows the right border vertically");
  add("gate-workflow-v1-origin","workflow",s=>{
    standard(s);s.edges=[{from:"a",to:"b",fromSide:"left",toSide:"bottom",via:[[24,119],[-1,119],[-1,160],[300,160]]}];
  },undefined,"workflow-v1 has no readable-v2 negative route-origin refusal");
  add("gate-workflow-v1-preset-fields","workflow",s=>{
    s.edges=[{from:"a",to:"b",route:"bottom-channel",channelX:200,channelY:170}];
  },undefined,"v1 does not apply readable-v2 preset/channel-field compatibility checks");
  add("gate-workflow-v1-via-rhythm","workflow",s=>{
    standard(s);s.edges=[{from:"a",to:"b",fromSide:"right",toSide:"left",via:[[143,119],[143,170],[228,170],[228,119]]}];
  },undefined,"v1 standard does not apply the schema2 pinned8px endpoint minimum");
  add("gate-workflow-v1-pair-controls","workflow",s=>{
    standard(s);s.edges=[{from:"a",to:"b",label:"Call",labelAt:[180,119]},{from:"b",to:"a",label:"Back",labelAt:[500,200]}];
  },undefined,"v1 standard does not run readable-v2 pin-pair label-route checks");
  add("gate-workflow-v2-corridor-standard","workflow",standard,"e2-boundary-workflow-v2-shared-trunk-25","standard records corridor warning, not refusal, for the25px same-source trunk");
  add("gate-workflow-rhythm-standard","workflow",standard,"e2-boundary-workflow-v1-turn-7","standard bypasses shared micro rhythm; source version1 has no stricter v2 pin gate");
  add("gate-workflow-border-profile-absent","workflow",s=>{
    noProfile(s);s.edges=[{from:"a",to:"b",fromSide:"bottom",toSide:"bottom",via:[[88,156],[300,156]]}];
  },undefined,"route follows fixed-v1 lane bottom156; no source profile disables border-run refusal");
  add("gate-workflow-v1-no-v2-arrows","workflow",s=>{
    standard(s);s.lanes.push({id:"other",label:"Other"});s.nodes[1].lane="other";s.nodes[1].col=0;s.nodes[2].col=2;
    s.edges=[{from:"a",to:"c",variant:"default"},{from:"b",to:"c",variant:"dashed"}];
  },undefined,"v1 has no readable-v2 arrowhead collision validator");
  add("gate-workflow-v2-arrows-standard","workflow",s=>{
    s.schema_version=2;standard(s);s.lanes.push({id:"other",label:"Other"});s.nodes[1].lane="other";s.nodes[1].col=0;s.nodes[2].col=2;
    s.edges=[{from:"a",to:"c",fromSide:"right",toSide:"left",variant:"default",via:[[168,119],[168,70],[264,70],[264,119]]},
      {from:"b",to:"c",fromSide:"right",toSide:"left",variant:"dashed",via:[[168,243],[168,170],[264,170],[264,119]]}];
  },undefined,"coincident explicit-via arrow tips on one authored target face are warning-only in standard v2; different variants disable short-trunk exemption");
  add("gate-workflow-optional-structures-absent","workflow",s=>{delete s.phases;delete s.groups;delete s.mainPath;delete s.cards;},undefined,"optional-member loops absent; this is feature-admission coverage, not proof that an invalid present value is accepted");
  add("gate-workflow-label-route-standard","workflow",s=>{
    standard(s);s.edges=[{from:"a",to:"b",label:"Call",labelAt:[180,119]},{from:"b",to:"a",label:"Back",labelAt:[500,200]}];
  },undefined,"v1 standard does not refuse a label covering another relationship's path when no node overlaps");
  add("gate-workflow-label-page-standard","workflow",s=>{standard(s);s.edges=[{from:"a",to:"b",label:"Call",labelAt:[720,200]}];},undefined,"v1 standard disables label mask clipping on the right edge of720px page");
  add("gate-workflow-v2-auto-height","workflow",s=>{
    s.schema_version=2;s.edges=[{from:"a",to:"b",fromSide:"right",toSide:"left",via:[[168,119],[264,119]],label:"Call",labelAt:[700,500]}];delete s.meta.viewBox;
  },undefined,"readable-v2 grows page to a valid explicit label at y500 rather than using the fixed-v1 page reserve");
  const additionalGateOnRefs={
    "gate-architecture-brand-absent":["e2-boundary-architecture-brand-rail-71"],
    "gate-workflow-brand-absent":["e2-boundary-workflow-brand-rail-71"],
    "gate-sequence-brand-absent":["e2-boundary-sequence-brand-rail-9"],
    "gate-dataflow-brand-absent":["e2-boundary-dataflow-brand-rail-71"],
    "gate-lifecycle-brand-absent":["e2-boundary-lifecycle-brand-rail-71"],
    "gate-architecture-optional-detail-absent":["e2-architecture-geometry-label-fit-detail","e2-architecture-geometry-label-fit-tag"],
    "gate-workflow-optional-detail-absent":["e2-workflow-geometry-label-fit-detail","e2-workflow-geometry-label-fit-tag"],
    "gate-sequence-optional-detail-absent":["e2-sequence-geometry-label-fit-detail"],
    "gate-dataflow-optional-detail-absent":["e2-dataflow-geometry-label-fit-detail","e2-dataflow-geometry-label-fit-tag"],
    "gate-lifecycle-optional-detail-absent":["e2-lifecycle-geometry-label-fit-detail","e2-lifecycle-geometry-label-fit-tag"],
    "gate-sequence-border-profile-absent":["e2-sequence-geometry-route-quality-segment-border"],
    "gate-sequence-late-standard":["e2-sequence-geometry-legend-clearance-showcase-note"],
    "gate-sequence-late-hidden":["e2-sequence-geometry-legend-clearance-showcase-note"],
    "gate-sequence-auto-height":["e2-sequence-geometry-legend-clearance-showcase-note"],
    "gate-workflow-v1-origin":["e2-boundary-workflow-v2-origin-outside"],
    "gate-workflow-v1-preset-fields":["e2-boundary-workflow-v2-preset-conflict"],
    "gate-workflow-v1-via-rhythm":["e2-boundary-workflow-v2-turn-7"],
    "gate-workflow-v2-arrows-standard":["e2-boundary-workflow-v2-arrow-spacing-8"],
  };
  for(const control of result){
    for(const ref of additionalGateOnRefs[control.id]??[]){
      if(!probes.some(probe=>probe.id===ref))throw new Error(`Gate-on reference ${ref} is absent; repair the explicit audit reference.`);
      if(!control.boundary.gateOnNegativeRefs.includes(ref))control.boundary.gateOnNegativeRefs.push(ref);
    }
    const repair={
      "gate-sequence-label-route-standard":"20 ASCII i keep exactly20 legacy text units (standard116px/showcase144px masks); narrow bundled-font ink avoids unrelated Noto endpoint occlusion",
      "gate-sequence-label-page-standard":"17 CJK characters keep34 legacy text units: showcase236.4px mask overflows center116 by2.2px; standard188.8px and bundled-font204px masks fit the origin",
      "gate-lifecycle-label-route-standard":"53 ASCII i keep exactly53 legacy text units and the271.7px active legacy mask; narrow bundled-font ink avoids unrelated overlap with state a",
    }[control.id];
    if(repair)control.boundary.fixtureRepair=repair;
    control.boundary.oracleEnvironment={ARCHIFY_QUALITY_PROFILE:"unset; workflow source profile is authoritative, shared other renderers otherwise allow this environment override"};
  }
  add("adjust-architecture-title-expansion","architecture",s=>{
    delete s.layout;delete s.meta.viewBox;s.meta.quality_profile="showcase";
    s.components=[{id:"only",type:"backend",label:"Only",pos:[800,120]}];s.connections=[];
    s.boundaries=[{kind:"region",label:"W".repeat(80),wraps:["only"]}];
  },undefined,"readable-title expansion/font fit and auto canvas growth occur before containment/fit checks","adjustment-control");
  add("adjust-sequence-legend-catalog-wrap","sequence",s=>{
    s.meta.quality_profile="showcase";s.meta.viewBox=[480,735];s.messages[0].y=600;
    s.meta.legend={mode:"all",entries:{emphasis:{label:"W"},return:{label:"W"},security:{label:"W"},dashed:{label:"W".repeat(5)},default:{label:"W".repeat(40)}}};
  },undefined,"catalog wrapping resolves two rows before reserve checking, rather than alphabetically making three Noto rows","adjustment-control");
  add("adjust-architecture-title-stack","architecture",s=>{
    delete s.layout;delete s.meta.viewBox;s.meta.quality_profile="showcase";
    s.components=[{id:"a",type:"backend",label:"A",pos:[300,180]},{id:"b",type:"database",label:"B",pos:[600,180]}];
    s.connections=[];s.boundaries=[{kind:"region",label:"W".repeat(60),wraps:["a","b"],pad:120},{kind:"security-group",label:"W".repeat(60),wraps:["a"]}];
  },undefined,"title rails stack by base frame area before collision checks, retaining member positions and authored boundary ordinals","adjustment-control");
  const pageOff=result.find(control=>control.id==="gate-architecture-label-page-standard");
  pageOff.boundary.fixtureSeedRefs=pageOff.boundary.gateOnNegativeRefs;
  pageOff.boundary.gateOnNegativeRefs=["gate-on-architecture-label-page-showcase"];
  const pageOn=structuredClone(pageOff);
  pageOn.id="gate-on-architecture-label-page-showcase";
  pageOn.spec.meta.quality_profile="showcase";
  pageOn.geometryRule="architecture/geometry-label-viewbox";
  pageOn.rule="geometry-label-viewbox";
  Object.assign(pageOn.boundary,{category:"gate-on-control",expectedOracleAccepted:false,expectedEngineAccepted:false,
    gateOnNegativeRefs:[],acceptanceRequirement:"both engines must refuse the same page-clipping input when showcase is enabled"});
  result.push(pageOn);
  const required=new Set(GATE_ADJUST_AUDIT.flatMap(row=>row.controlIds));
  for(const id of required)if(!controls.has(id))throw new Error(`Declared gate control ${id} has no source fixture; define it before running the oracle.`);
  return result;
}
