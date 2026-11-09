export interface OfflineViewerInput {
  readonly svg: string;
  readonly specJson: string;
  readonly title?: string;
}

export const OFFLINE_VIEWER_RUNTIME_BUDGET_BYTES = 12 * 1024;

const VIEWER_STYLE = `
:root{color-scheme:light dark;font:14px/1.4 system-ui,sans-serif;background:#f4f5f7;color:#111827}
*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0;overflow:hidden}
body{display:grid;grid-template-rows:auto minmax(0,1fr)}
.toolbar{display:flex;align-items:center;gap:8px;min-height:48px;padding:7px 12px;background:#fff;border-bottom:1px solid #d1d5db}
.toolbar button{min-height:32px;padding:5px 10px;border:1px solid #9ca3af;border-radius:5px;background:#fff;color:#111827;font:inherit;cursor:pointer}
.toolbar button:focus-visible,#viewport:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
#zoom-level{min-width:48px;text-align:center;font-variant-numeric:tabular-nums}
#selection{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#viewport{min-height:0;overflow:hidden;touch-action:none;background:#e5e7eb;cursor:grab}
#viewport[data-panning=true]{cursor:grabbing}
#stage{width:100%;height:100%}
#stage>svg{display:block;width:100%;height:100%;max-width:none;max-height:none;user-select:none}
#stage svg text[data-kind=label-text]{font-feature-settings:'liga' 0,'clig' 0,'calt' 0,'locl' 0,'kern' 0,'mark' 0,'mkmk' 0;font-kerning:none;font-variant-ligatures:none}
#stage svg [data-kind=node],#stage svg [data-kind=route]{cursor:pointer}
#stage svg [data-viewer-selected=true]{filter:drop-shadow(0 0 3px #2563eb)}
#stage svg [data-kind=node]:focus-visible,#stage svg [data-kind=route]:focus-visible{outline:none;filter:drop-shadow(0 0 4px #2563eb)}
@media(prefers-color-scheme:dark){:root{background:#020617;color:#f8fafc}.toolbar{background:#0f172a;border-color:#334155}.toolbar button{background:#1e293b;color:#f8fafc;border-color:#64748b}#viewport{background:#0b1220}}
`;

const VIEWER_RUNTIME = String.raw`
(function(){
  "use strict";
  var viewport=document.getElementById("viewport");
  var svg=document.querySelector("#stage > svg");
  var status=document.getElementById("selection");
  var zoomLevel=document.getElementById("zoom-level");
  var source=document.getElementById("offline-viewer-source");
  if(!viewport||!svg||!status||!zoomLevel||!source)return;

  var spec=JSON.parse(source.textContent||"{}");
  var collections={architecture:"components",workflow:"nodes",sequence:"participants",dataflow:"nodes",lifecycle:"states"};
  var relationCollections={architecture:"connections",workflow:"edges",sequence:"messages",dataflow:"flows",lifecycle:"transitions"};
  var routePrefixes={architecture:"connection",workflow:"edge",sequence:"message",dataflow:"flow",lifecycle:"transition"};
  var nodes=new Map();
  var relations=new Map();
  var nodeRows=Array.isArray(spec[collections[spec.diagram_type]])?spec[collections[spec.diagram_type]]:[];
  nodeRows.forEach(function(row){if(row&&typeof row.id==="string")nodes.set(row.id,row);});
  var relationRows=Array.isArray(spec[relationCollections[spec.diagram_type]])?spec[relationCollections[spec.diagram_type]]:[];
  var prefix=routePrefixes[spec.diagram_type]||"edge";
  var used=new Set(relationRows.map(function(row){return row&&typeof row.id==="string"?row.id:null;}).filter(Boolean));
  relationRows.forEach(function(row,index){
    if(!row||typeof row!=="object")return;
    var id=typeof row.id==="string"?row.id:prefix+":"+index;
    if(typeof row.id!=="string")while(used.has(id))id+=":generated";
    used.add(id);
    relations.set(id,row);
  });

  var initial=svg.viewBox.baseVal;
  var original={x:initial.x,y:initial.y,width:initial.width,height:initial.height};
  var current={x:original.x,y:original.y,width:original.width,height:original.height};
  var selected=null;
  var gesture=null;
  var targets=Array.from(svg.querySelectorAll('[data-kind="node"],[data-kind="route"]'));
  targets.forEach(function(target){target.setAttribute("tabindex","0");target.setAttribute("focusable","true");});

  function applyViewBox(next){
    if(![next.x,next.y,next.width,next.height].every(Number.isFinite)||next.width<=0||next.height<=0)return;
    current=next;
    svg.setAttribute("viewBox",[next.x,next.y,next.width,next.height].join(" "));
    zoomLevel.textContent=Math.round(original.width/next.width*100)+"%";
  }
  function clearSelection(){
    if(selected){selected.removeAttribute("data-viewer-selected");selected.removeAttribute("aria-selected");}
    selected=null;
    status.textContent="Click a node or route to inspect it.";
  }
  function sourceIdFor(target){
    return target.getAttribute("data-source-id")||"";
  }
  function routeInfo(sourceId){
    var routeId=sourceId.indexOf("id:")===0?sourceId.slice(3):sourceId;
    return {id:routeId,row:relations.get(routeId)};
  }
  function targetForLabel(label){
    if(!label)return null;
    var id=label.getAttribute("data-target-id");
    if(!id)return null;
    var node=targets.find(function(target){return target.getAttribute("data-kind")==="node"&&sourceIdFor(target)===id;});
    if(node)return node;
    return targets.find(function(target){
      if(target.getAttribute("data-kind")!=="route")return false;
      var info=routeInfo(sourceIdFor(target));
      return info.id===id||"id:"+info.id===id;
    })||null;
  }
  function resolveTarget(target){
    if(!(target instanceof Element))return null;
    var direct=target.closest('[data-kind="node"],[data-kind="route"]');
    if(direct&&svg.contains(direct))return direct;
    var label=target.closest('[data-kind="label"]');
    return label&&svg.contains(label)?targetForLabel(label):null;
  }
  function selectTarget(target){
    if(!target)return clearSelection();
    if(selected){selected.removeAttribute("data-viewer-selected");selected.removeAttribute("aria-selected");}
    selected=target;
    selected.setAttribute("data-viewer-selected","true");
    selected.setAttribute("aria-selected","true");
    var kind=target.getAttribute("data-kind")==="route"?"edge":"node";
    var rawId=sourceIdFor(target);
    var id=kind==="edge"?routeInfo(rawId).id:rawId;
    var row=kind==="edge"?routeInfo(rawId).row:nodes.get(id);
    var label=row&&typeof row.label==="string"?row.label:"";
    if(kind==="edge"&&!label){
      var from=row&&typeof row.from==="string"?row.from:"";
      var to=row&&typeof row.to==="string"?row.to:"";
      label=from&&to?from+" -> "+to:"(unlabelled)";
    }
    if(kind==="edge"&&row&&typeof row.note==="string"&&row.note)label=label+"; "+row.note;
    if(!label&&row&&typeof row.label!=="string")label="(unlabelled)";
    status.textContent=kind+" "+id+" - "+label;
  }
  function screenToSvg(x,y,matrix){
    var point=svg.createSVGPoint();point.x=x;point.y=y;
    return point.matrixTransform(matrix||svg.getScreenCTM().inverse());
  }
  function zoomAt(x,y,factor){
    var anchor=screenToSvg(x,y);
    var nextWidth=Math.max(original.width/8,Math.min(original.width*8,current.width*factor));
    var ratio=nextWidth/current.width;
    var next={x:anchor.x-(anchor.x-current.x)*ratio,y:anchor.y-(anchor.y-current.y)*ratio,width:nextWidth,height:current.height*ratio};
    applyViewBox(next);
  }
  function zoomCenter(factor){var rect=viewport.getBoundingClientRect();zoomAt(rect.left+rect.width/2,rect.top+rect.height/2,factor);}
  function panBy(dx,dy){applyViewBox({x:current.x+dx,y:current.y+dy,width:current.width,height:current.height});}
  function fit(){applyViewBox({x:original.x,y:original.y,width:original.width,height:original.height});}
  document.querySelectorAll("[data-viewer-zoom]").forEach(function(button){
    button.addEventListener("click",function(){
      var action=button.getAttribute("data-viewer-zoom");
      if(action==="in")zoomCenter(0.8);else if(action==="out")zoomCenter(1.25);else fit();
    });
  });
  viewport.addEventListener("pointerdown",function(event){
    if(event.button!==0)return;
    var inverse=svg.getScreenCTM().inverse();
    gesture={target:resolveTarget(event.target),startX:event.clientX,startY:event.clientY,start:screenToSvg(event.clientX,event.clientY,inverse),view:{x:current.x,y:current.y,width:current.width,height:current.height},inverse:inverse,panning:false};
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener("pointermove",function(event){
    if(!gesture)return;
    var dx=event.clientX-gesture.startX,dy=event.clientY-gesture.startY;
    if(Math.abs(dx)>3||Math.abs(dy)>3){gesture.panning=true;viewport.setAttribute("data-panning","true");}
    if(!gesture.panning)return;
    var point=screenToSvg(event.clientX,event.clientY,gesture.inverse);
    applyViewBox({x:gesture.view.x-(point.x-gesture.start.x),y:gesture.view.y-(point.y-gesture.start.y),width:gesture.view.width,height:gesture.view.height});
  });
  function endPointer(event){
    if(!gesture)return;
    if(!gesture.panning)selectTarget(gesture.target);
    gesture=null;
    viewport.removeAttribute("data-panning");
    if(viewport.hasPointerCapture(event.pointerId))viewport.releasePointerCapture(event.pointerId);
  }
  viewport.addEventListener("pointerup",endPointer);
  viewport.addEventListener("pointercancel",function(){gesture=null;viewport.removeAttribute("data-panning");});
  viewport.addEventListener("wheel",function(event){
    event.preventDefault();
    zoomAt(event.clientX,event.clientY,event.deltaY<0?0.9:1.1);
  },{passive:false});
  viewport.addEventListener("keydown",function(event){
    var stepX=current.width*0.08,stepY=current.height*0.08;
    if(event.key==="Escape"){clearSelection();event.preventDefault();}
    else if(event.key==="Home"){fit();event.preventDefault();}
    else if(event.key==="+"||event.key==="="){zoomCenter(0.8);event.preventDefault();}
    else if(event.key==="-"){zoomCenter(1.25);event.preventDefault();}
    else if(event.key==="ArrowLeft"){panBy(-stepX,0);event.preventDefault();}
    else if(event.key==="ArrowRight"){panBy(stepX,0);event.preventDefault();}
    else if(event.key==="ArrowUp"){panBy(0,-stepY);event.preventDefault();}
    else if(event.key==="ArrowDown"){panBy(0,stepY);event.preventDefault();}
    else if(event.key==="Enter"||event.key===" "){selectTarget(resolveTarget(event.target));event.preventDefault();}
  });
  status.textContent="Click a node or route to inspect it.";
})();
`;

const VIEWER_CSP = "default-src 'none'; script-src 'sha256-9b/Jc5IKTIOUnWnGH4VE+WWBQkwNDsSUNIYonYnuxi8='; style-src 'sha256-dPMqwh+nPnXPHCb2QAZjrDqlQmY+r+i9jn+Y2SeA+gY='; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>]/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      default: return character;
    }
  });
}

function escapeScriptClosingTags(value: string): string {
  return value.replace(/<\//gi, "<\\/");
}

export function createOfflineViewerHtml(input: Readonly<OfflineViewerInput>): string {
  let source: unknown;
  try {
    source = JSON.parse(input.specJson);
  } catch (cause) {
    throw new TypeError("The offline viewer requires a valid JSON source spec.", { cause });
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("The offline viewer source spec must be a JSON object.");
  }
  const metadata = (source as { meta?: { title?: unknown } }).meta;
  const title = input.title ?? (typeof metadata?.title === "string" ? metadata.title : "Diagram viewer");
  const runtimeBytes = new TextEncoder().encode(VIEWER_RUNTIME).byteLength;
  if (runtimeBytes > OFFLINE_VIEWER_RUNTIME_BUDGET_BYTES) {
    throw new Error("The offline viewer runtime exceeds its 12 KiB budget.");
  }
  const safeSpec = escapeScriptClosingTags(input.specJson);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP}"><title>${escapeHtmlText(title)}</title><style>${VIEWER_STYLE}</style></head><body><header class="toolbar" aria-label="Diagram viewer controls"><button type="button" data-viewer-zoom="out" aria-label="Zoom out">Zoom out</button><button type="button" data-viewer-zoom="in" aria-label="Zoom in">Zoom in</button><button type="button" data-viewer-zoom="fit" aria-label="Fit diagram">Fit</button><output id="zoom-level" aria-label="Zoom level">100%</output><output id="selection" role="status" aria-live="polite">Click a node or route to inspect it.</output></header><main id="viewport" tabindex="0" aria-label="Interactive diagram"><div id="stage">${input.svg}</div></main><script type="application/json" id="offline-viewer-source">${safeSpec}</script><script>${VIEWER_RUNTIME}</script></body></html>`;
}
