export interface OfflineViewerInput {
  readonly svg: string;
  readonly specJson: string;
  readonly title?: string;
}

export const OFFLINE_VIEWER_RUNTIME_BUDGET_BYTES = 12 * 1024;
export const OFFLINE_VIEWER_SVG_MAX_BYTES = 16 * 1024 * 1024;
export const OFFLINE_VIEWER_SPEC_MAX_BYTES = 4 * 1024 * 1024;

const SVG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(["xmlns", "id", "role", "aria-labelledby", "viewBox", "width", "height", "data-theme"]),
  title: new Set(["id"]),
  desc: new Set(["id"]),
  defs: new Set(),
  marker: new Set(["id", "markerWidth", "markerHeight", "refX", "refY", "orient", "markerUnits"]),
  g: new Set(["id", "data-kind", "data-source-id", "data-target-id", "data-route-role", "data-route-variant", "role", "aria-label"]),
  rect: new Set(["id", "data-kind", "data-target-id", "aria-hidden", "x", "y", "width", "height", "rx", "fill", "stroke", "stroke-width", "stroke-dasharray"]),
  polyline: new Set(["id", "data-kind", "data-target-id", "aria-hidden", "data-index", "points", "fill", "stroke", "stroke-width", "stroke-dasharray", "marker-end"]),
  line: new Set(["id", "data-kind", "data-target-id", "aria-hidden", "x1", "y1", "x2", "y2", "fill", "stroke", "stroke-width", "stroke-dasharray", "marker-end"]),
  polygon: new Set(["id", "data-kind", "data-target-id", "aria-hidden", "points", "fill", "stroke", "stroke-width"]),
  circle: new Set(["id", "data-kind", "data-target-id", "aria-hidden", "cx", "cy", "r", "fill", "stroke", "stroke-width"]),
  path: new Set(["id", "data-kind", "data-target-id", "aria-hidden", "data-index", "d", "transform", "fill", "stroke", "stroke-width"]),
  text: new Set(["data-kind", "font-family", "font-size", "font-weight", "font-kerning", "font-variant-ligatures", "text-rendering", "style", "xml:space", "fill", "aria-hidden"]),
  tspan: new Set(["data-kind", "data-index", "x", "y", "fill"]),
};
const SVG_LEAF_TAGS = new Set(["rect", "polyline", "line", "polygon", "circle", "path"]);
const SVG_CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = {
  svg: new Set(["title", "desc", "rect", "defs", "g", "polyline", "line", "polygon", "circle", "path"]),
  defs: new Set(["marker"]),
  marker: new Set(["polygon"]),
  g: new Set(["g", "rect", "polyline", "line", "polygon", "circle", "path", "text"]),
  text: new Set(["tspan"]),
};
const SVG_REQUIRED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  svg: ["xmlns", "id", "role", "aria-labelledby", "viewBox", "width", "height", "data-theme"],
  title: ["id"],
  desc: ["id"],
  defs: [],
  marker: ["id", "markerWidth", "markerHeight", "refX", "refY", "orient", "markerUnits"],
  g: ["id", "data-kind", "role", "aria-label"],
  rect: ["data-kind", "x", "y", "width", "height", "rx", "fill", "stroke", "stroke-width"],
  polyline: ["data-kind", "points", "fill", "stroke", "stroke-width"],
  line: ["data-kind", "x1", "y1", "x2", "y2", "fill", "stroke", "stroke-width"],
  polygon: ["points", "fill"],
  circle: ["cx", "cy", "r", "fill", "stroke", "stroke-width"],
  path: ["data-kind", "data-index", "d", "transform", "fill", "aria-hidden"],
  text: ["data-kind", "font-family", "font-size", "font-weight", "font-kerning", "font-variant-ligatures", "text-rendering", "style", "xml:space", "fill", "aria-hidden"],
  tspan: ["data-kind", "data-index", "x", "y", "fill"],
};
const SVG_STYLE_ATTRIBUTE = "font-feature-settings:'liga' 0,'clig' 0,'calt' 0,'locl' 0,'kern' 0,'mark' 0,'mkmk' 0";
const SVG_MARKER_IDS = new Set(["arrow", "arrow-emphasis", "arrow-security", "arrow-dashed"]);

function svgProfileError(reason: string): never {
  throw new TypeError(`The offline viewer refused the source SVG: ${reason}; provide the single SVG artifact from the pinned S1 engine.`);
}

function validXmlText(value: string): boolean {
  if (/&(?!amp;|lt;|gt;|quot;|#9;|#10;|#13;)/.test(value)) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
    if ((code >= 0xd800 && code <= 0xdfff) || (code & 0xffff) >= 0xfffe) return false;
  }
  return true;
}

function numericList(value: string, count?: number): boolean {
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[ ,]+-?(?:\d+(?:\.\d+)?|\.\d+))*$/.test(value)) return false;
  const values = value.trim().split(/[ ,]+/).map(Number);
  return values.every(Number.isFinite) && (count === undefined || values.length === count);
}

function validPaint(value: string): boolean {
  return value === "none" || value === "transparent"
    || /^#[0-9a-fA-F]{3,8}$/.test(value)
    || /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(value)
    || /^url\(#(?:arrow|arrow-emphasis|arrow-security|arrow-dashed)\)$/.test(value);
}

function validateSvgAttribute(element: string, name: string, value: string, ids: Set<string>, markerRefs: string[]): void {
  if (!validXmlText(value) || value.includes("<")) svgProfileError(`attribute ${name} is not safely quoted XML`);
  if (name === "xmlns" && value !== "http://www.w3.org/2000/svg") svgProfileError("SVG namespace is not the engine namespace");
  if (name === "aria-labelledby" && value !== "maru-title maru-desc") svgProfileError("root accessibility references are not engine-owned");
  if (name === "role" && !["img", "group", "listitem"].includes(value)) svgProfileError("role is outside the engine SVG profile");
  if (name === "id") {
    const rootId = element === "svg" && value === "maru-svg";
    const titleId = element === "title" && value === "maru-title";
    const descriptionId = element === "desc" && value === "maru-desc";
    const markerId = element === "marker" && SVG_MARKER_IDS.has(value);
    const encodedId = /^(?:node|route|container|legend|label|primitive)-[0-9a-f]+$/.test(value.slice("maru-".length))
      && value.startsWith("maru-");
    if (!(rootId || titleId || descriptionId || markerId || encodedId) || ids.has(value)) svgProfileError("element id is outside the engine namespace or duplicated");
    ids.add(value);
  }
  if (name === "data-kind" && !/^[a-z][a-z0-9-]*$/.test(value)) svgProfileError("data-kind is malformed");
  if (["data-source-id", "data-target-id", "data-route-role", "data-route-variant"].includes(name) && value.length > 4096) svgProfileError(`${name} exceeds the engine metadata limit`);
  if (name === "data-theme" && value !== "light" && value !== "dark") svgProfileError("theme is outside the engine SVG profile");
  if (name === "aria-hidden" && value !== "true") svgProfileError("aria-hidden must be true for engine-only glyphs");
  if (name === "font-family" && value !== "Noto Sans CJK KR, sans-serif") svgProfileError("font family is outside the pinned S1 profile");
  if (name === "font-kerning" && value !== "none") svgProfileError("font kerning must remain disabled");
  if (name === "font-variant-ligatures" && value !== "none") svgProfileError("font ligatures must remain disabled");
  if (name === "text-rendering" && value !== "geometricPrecision") svgProfileError("text rendering mode is outside the pinned S1 profile");
  if (name === "style" && value !== SVG_STYLE_ATTRIBUTE) svgProfileError("inline text style is outside the pinned S1 profile");
  if (name === "xml:space" && value !== "preserve") svgProfileError("XML whitespace handling is outside the pinned S1 profile");
  if (name === "orient" && value !== "auto") svgProfileError("marker orientation is outside the pinned S1 profile");
  if (name === "markerUnits" && value !== "strokeWidth") svgProfileError("marker units are outside the pinned S1 profile");
  if (name === "markerWidth" && value !== "10") svgProfileError("marker width is outside the pinned S1 profile");
  if (name === "markerHeight" && value !== "7") svgProfileError("marker height is outside the pinned S1 profile");
  if (name === "refX" && value !== "9") svgProfileError("marker refX is outside the pinned S1 profile");
  if (name === "refY" && value !== "3.5") svgProfileError("marker refY is outside the pinned S1 profile");
  if (name === "marker-end") {
    const match = /^url\(#([A-Za-z0-9_-]+)\)$/.exec(value);
    if (!match || !SVG_MARKER_IDS.has(match[1]!)) svgProfileError("marker reference must be a local engine arrow definition");
    markerRefs.push(match[1]!);
  }
  if (["fill", "stroke"].includes(name) && !validPaint(value)) svgProfileError(`${name} paint is not a local engine color`);
  if (["x", "y", "x1", "y1", "x2", "y2", "width", "height", "rx", "cx", "cy", "r", "stroke-width", "font-size", "markerWidth", "markerHeight", "refX", "refY"].includes(name)) {
    if (!numericList(value, 1)) svgProfileError(`${name} is not a finite scalar`);
    const numeric = Number(value);
    if (["width", "height", "rx", "r", "stroke-width", "font-size", "markerWidth", "markerHeight"].includes(name) && numeric < 0) svgProfileError(`${name} must be nonnegative`);
    if ((element === "svg" && ["width", "height"].includes(name)) || ["font-size", "markerWidth", "markerHeight"].includes(name)) {
      if (numeric === 0) svgProfileError(`${name} must be positive`);
    }
  }
  if (name === "viewBox" && (!numericList(value, 4) || Number(value.trim().split(/[ ,]+/)[2]) <= 0 || Number(value.trim().split(/[ ,]+/)[3]) <= 0)) svgProfileError("viewBox must contain four finite values and positive dimensions");
  if (name === "points") {
    const coordinates = value.trim().split(/[ ,]+/);
    if (value === "" && element !== "polyline") svgProfileError("only retained route polylines may have an empty point list");
    if (value !== "" && (!numericList(value) || coordinates.length < 4 || coordinates.length % 2 !== 0)) svgProfileError("point list is outside the engine SVG profile");
  }
  if (name === "stroke-dasharray" && !numericList(value)) svgProfileError("dash pattern is outside the engine SVG profile");
  if (name === "font-weight" && !["400", "700"].includes(value)) svgProfileError("font weight is outside the pinned S1 profile");
  if (name === "data-index" && !/^\d+$/.test(value)) svgProfileError("glyph index is malformed");
  if (name === "d" && !/^[MmLlHhVvCcSsQqTtAaZz0-9+.,\s-]+$/.test(value)) svgProfileError("glyph outline path contains unsupported syntax");
  if (name === "transform" && !/^translate\(-?(?:\d+(?:\.\d+)?|\.\d+)\s+-?(?:\d+(?:\.\d+)?|\.\d+)\)\s+scale\(-?(?:\d+(?:\.\d+)?|\.\d+)\s+-?(?:\d+(?:\.\d+)?|\.\d+)\)$/.test(value)) svgProfileError("glyph transform is outside the pinned S1 profile");
}

/** Accept the fixed, inert S1 SVG vocabulary and reject HTML or active content. */
function validateEngineSvg(svg: string): void {
  if (new TextEncoder().encode(svg).byteLength > OFFLINE_VIEWER_SVG_MAX_BYTES) svgProfileError("SVG exceeds the 16 MiB artifact limit");
  const stack: string[] = [];
  const ids = new Set<string>();
  const markerIds = new Set<string>();
  const markerRefs: string[] = [];
  let index = 0;
  let elements = 0;
  let rootSeen = false;
  let rootClosed = false;
  let titleCount = 0;
  let descCount = 0;
  while (index < svg.length) {
    if (svg[index] !== "<") {
      const end = svg.indexOf("<", index);
      const text = svg.slice(index, end < 0 ? svg.length : end);
      if (!validXmlText(text)) svgProfileError("text contains an invalid XML entity or control character");
      if (stack.length === 0 && text.length !== 0) svgProfileError("content appears outside the SVG root");
      if (stack.at(-1) !== "title" && stack.at(-1) !== "desc" && stack.at(-1) !== "tspan" && text.trim() !== "") svgProfileError("text appears outside a permitted text element");
      index = end < 0 ? svg.length : end;
      continue;
    }
    if (svg.startsWith("<!", index) || svg.startsWith("<?", index)) svgProfileError("XML declarations, comments, and doctypes are not accepted");
    if (svg.startsWith("</", index)) {
      const close = /^<\/([A-Za-z][A-Za-z0-9-]*)\s*>/.exec(svg.slice(index));
      if (!close || stack.pop() !== close[1]) svgProfileError("SVG elements are not strictly balanced");
      index += close[0].length;
      if (stack.length === 0) rootClosed = true;
      continue;
    }
    const nameMatch = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(svg.slice(index));
    if (!nameMatch) svgProfileError("SVG tag name is malformed");
    const name = nameMatch[1]!;
    const allowedAttributes = SVG_ATTRIBUTES[name];
    if (!allowedAttributes) svgProfileError(`element <${name}> is outside the pinned S1 SVG profile`);
    if (!rootSeen) {
      if (name !== "svg") svgProfileError("artifact must begin with one SVG root element");
      rootSeen = true;
    } else if (rootClosed) {
      svgProfileError("artifact contains content after the SVG root");
    }
    if (stack.length > 0 && !SVG_CHILDREN[stack.at(-1)!]?.has(name)) svgProfileError(`element <${name}> is not permitted inside <${stack.at(-1)}>`);
    index += nameMatch[0].length;
    const attrs = new Set<string>();
    const values = new Map<string, string>();
    let selfClosing = false;
    while (index < svg.length) {
      while (/\s/.test(svg[index] ?? "")) index += 1;
      if (svg.startsWith("/>", index)) {
        selfClosing = true;
        index += 2;
        break;
      }
      if (svg[index] === ">") {
        index += 1;
        break;
      }
      const attrMatch = /^[A-Za-z_:][A-Za-z0-9:_.-]*/.exec(svg.slice(index));
      if (!attrMatch) svgProfileError(`attribute syntax on <${name}> is malformed`);
      const attr = attrMatch[0];
      if (!allowedAttributes.has(attr) || attrs.has(attr)) svgProfileError(`attribute ${attr} is not allowed or is duplicated on <${name}>`);
      attrs.add(attr);
      index += attr.length;
      while (/\s/.test(svg[index] ?? "")) index += 1;
      if (svg[index] !== "=") svgProfileError(`attribute ${attr} has no quoted value`);
      index += 1;
      while (/\s/.test(svg[index] ?? "")) index += 1;
      if (svg[index] !== '"') svgProfileError(`attribute ${attr} must use a double-quoted value`);
      index += 1;
      const valueEnd = svg.indexOf('"', index);
      if (valueEnd < 0) svgProfileError(`attribute ${attr} is not closed`);
      const value = svg.slice(index, valueEnd);
      validateSvgAttribute(name, attr, value, ids, markerRefs);
      values.set(attr, value);
      if (name === "marker" && attr === "id") {
        if (!SVG_MARKER_IDS.has(value)) svgProfileError("marker id is outside the pinned S1 arrow vocabulary");
        markerIds.add(value);
      }
      index = valueEnd + 1;
    }
    elements += 1;
    if (elements > 250_000) svgProfileError("SVG exceeds the element-count limit");
    if (name === "title") titleCount += 1;
    if (name === "desc") descCount += 1;
    if (SVG_REQUIRED_ATTRIBUTES[name]!.some((attribute) => !attrs.has(attribute))) svgProfileError(`<${name}> is missing required engine attributes`);
    if (name === "g" && values.get("data-kind") !== "legend-entry" && !attrs.has("data-source-id")) svgProfileError("semantic SVG group is missing its source id");
    if (name === "g" && values.get("data-kind") === "label" && !attrs.has("data-target-id")) svgProfileError("label group is missing its target id");
    if (name === "svg") {
      if (selfClosing || values.get("id") !== "maru-svg" || values.get("xmlns") !== "http://www.w3.org/2000/svg" || values.get("role") !== "img" || values.get("aria-labelledby") !== "maru-title maru-desc") svgProfileError("SVG root is missing required engine attributes");
      if (svg.slice(0, index).match(/<svg\b/g)?.length !== 1) svgProfileError("artifact must contain exactly one SVG root");
    }
    if (name === "title" && values.get("id") !== "maru-title") svgProfileError("SVG title id is outside the engine accessibility profile");
    if (name === "desc" && values.get("id") !== "maru-desc") svgProfileError("SVG description id is outside the engine accessibility profile");
    if (selfClosing) {
      if (!SVG_LEAF_TAGS.has(name)) svgProfileError(`element <${name}> must be explicitly closed`);
    } else {
      if (SVG_LEAF_TAGS.has(name)) svgProfileError(`leaf element <${name}> must be self-closing`);
      stack.push(name);
      if (stack.length > 64) svgProfileError("SVG nesting exceeds the profile depth limit");
    }
  }
  if (!rootSeen || !rootClosed || stack.length !== 0 || titleCount !== 1 || descCount !== 1) svgProfileError("artifact must have one balanced SVG root, title, and description");
  if ([...SVG_MARKER_IDS].some((id) => !markerIds.has(id))) svgProfileError("engine arrow definitions are incomplete");
  if (markerRefs.some((id) => !markerIds.has(id))) svgProfileError("marker reference does not resolve to a local engine definition");
}

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
  if(!viewport||!svg||!status||!zoomLevel)return;

  var labelGroups=Array.from(svg.querySelectorAll('[data-kind="label"]'));

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
    return {id:routeId};
  }
  function labelForTarget(target){
    var kind=target.getAttribute("data-kind");
    var sourceId=sourceIdFor(target);
    var routeId=kind==="route"?routeInfo(sourceId).id:sourceId;
    var labelSourceId=kind==="route"?"id:edge:"+routeId+":label":"id:node:"+sourceId+":label";
    var label=labelGroups.find(function(group){return group.getAttribute("data-source-id")===labelSourceId;});
    return (label&&label.getAttribute("aria-label"))||target.getAttribute("aria-label")||"";
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
    var label=labelForTarget(target)||"(unlabelled)";
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

const VIEWER_CSP = "default-src 'none'; script-src 'sha256-qFeS9FU2CAnDeDKPRnTT3Fo9v9ur7J6tyXxwTadGvuk='; style-src 'sha256-dPMqwh+nPnXPHCb2QAZjrDqlQmY+r+i9jn+Y2SeA+gY='; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";

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
  if (new TextEncoder().encode(input.specJson).byteLength > OFFLINE_VIEWER_SPEC_MAX_BYTES) {
    throw new TypeError("The offline viewer source spec exceeds its 4 MiB limit; reduce the source JSON to 4 MiB or less and retry.");
  }
  let source: unknown;
  try {
    source = JSON.parse(input.specJson);
  } catch (cause) {
    throw new TypeError("The offline viewer source spec is not valid JSON; repair the source JSON and retry.", { cause });
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("The offline viewer source spec is not a JSON object; provide the top-level engine spec object.");
  }
  validateEngineSvg(input.svg);
  const metadata = (source as { meta?: { title?: unknown } }).meta;
  const title = input.title ?? (typeof metadata?.title === "string" ? metadata.title : "Diagram viewer");
  const runtimeBytes = new TextEncoder().encode(VIEWER_RUNTIME).byteLength;
  if (runtimeBytes > OFFLINE_VIEWER_RUNTIME_BUDGET_BYTES) {
    throw new Error("The offline viewer runtime exceeds its 12 KiB budget; reduce the inline viewer runtime and update its CSP hash.");
  }
  const safeSpec = escapeScriptClosingTags(input.specJson);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP}"><title>${escapeHtmlText(title)}</title><style>${VIEWER_STYLE}</style></head><body><header class="toolbar" aria-label="Diagram viewer controls"><button type="button" data-viewer-zoom="out" aria-label="Zoom out">Zoom out</button><button type="button" data-viewer-zoom="in" aria-label="Zoom in">Zoom in</button><button type="button" data-viewer-zoom="fit" aria-label="Fit diagram">Fit</button><output id="zoom-level" aria-label="Zoom level">100%</output><output id="selection" role="status" aria-live="polite">Click a node or route to inspect it.</output></header><main id="viewport" tabindex="0" aria-label="Interactive diagram"><div id="stage">${input.svg}</div></main><script type="application/json" id="offline-viewer-source">${safeSpec}</script><script>${VIEWER_RUNTIME}</script></body></html>`;
}
