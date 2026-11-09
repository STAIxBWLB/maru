// Remote Chromium captures of the real test-only Rust/WASM SVG facade.
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { seedFor, TYPES } from "./diagram-engine-e1-cases.mjs";
const root=resolve(import.meta.dirname,"..");
const output=join(root,".engine-e2/e3-screenshots");mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(join(root,"src-tauri/crates/maru-diagram-engine/src/metrics/data/manifest.json"),"utf8"));
const fonts=new Map();
for(const font of manifest.fonts){
  const filename=font.weight===400?"NotoSansCJKkr-Regular.otf":"NotoSansCJKkr-Bold.otf";
  const bytes=readFileSync(join(root,".engine-e2/fonts",manifest.sourceRevision,filename));
  if(createHash("sha256").update(bytes).digest("hex")!==font.sourceSha256)throw new Error("Screenshot font hash differs from E2 metrics; regenerate pinned fonts before capturing.");
  fonts.set(`/fonts/${font.weight}.otf`,bytes);
}
const assets=new Map(readdirSync(join(root,".engine-e0/browser-test")).filter(f=>/^[A-Za-z0-9._-]+\.(?:js|wasm)$/.test(f)).map(f=>[`/assets/${f}`,readFileSync(join(root,".engine-e0/browser-test",f))]));
const server=createServer((req,res)=>{
  const url=new URL(req.url,"http://localhost");let body;
  if(url.pathname==="/"){body=Buffer.from('<!doctype html><html lang="ko"><meta charset="utf-8"><title>Engine SVG capture</title><style>@font-face{font-family:"Noto Sans CJK KR";font-weight:400;src:url(/fonts/400.otf)}@font-face{font-family:"Noto Sans CJK KR";font-weight:700;src:url(/fonts/700.otf)}html,body{margin:0}svg{display:block}</style><body></body></html>');res.setHeader("Content-Type","text/html; charset=utf-8");}
  else if(fonts.has(url.pathname)){body=fonts.get(url.pathname);res.setHeader("Content-Type","font/otf");}
  else if(assets.has(url.pathname)){body=assets.get(url.pathname);res.setHeader("Content-Type",url.pathname.endsWith("wasm")?"application/wasm":"application/javascript");}
  if(!body){res.writeHead(404);res.end();return;}res.setHeader("Cache-Control","no-store");res.end(body);
});
await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>resolve(undefined));});
const address=server.address();
if(!address||typeof address==="string")throw new Error("Screenshot server has no TCP address; retry with an available local socket.");
const origin=`http://127.0.0.1:${address.port}`;
let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1200,height:1000},deviceScaleFactor:1});
 const external=[];page.on("request",req=>{if(!req.url().startsWith(origin)&&!req.url().startsWith("data:"))external.push(req.url());});
 const receipts=[];
 for(const type of TYPES){
  const spec=seedFor(type);spec.meta.title=`마루 ${type} 렌더`;spec.meta.subtitle="결정적 SVG · 접근성 검증";
  const collection={architecture:"components",workflow:"nodes",sequence:"participants",dataflow:"nodes",lifecycle:"states"}[type];
  spec[collection].forEach((node,i)=>{node.label=["입력","처리","완료"][i%3];});
  for(const theme of ["light","dark"]){
   await page.goto(origin);
   const captured=await page.evaluate(async({spec,theme})=>{
    const moduleUrl="/assets/engine-e0.js";const module=await import(/* @vite-ignore */ moduleUrl);const engine=await module.loadGeometryEngine();
    const scene=engine.layout({specJson:JSON.stringify(spec)});
    if(!scene.ok||!scene.geometry)throw new Error(`CJK screenshot scene refused: ${JSON.stringify(scene.diagnostics)}`);
    const options={theme,title:spec.meta.title,description:spec.meta.subtitle};
    const first=await engine.renderSvgForTest(scene.geometry,options);const second=await engine.renderSvgForTest(scene.geometry,options);
    if(!first.ok||first.svg!==second.svg)throw new Error(`SVG artifact/repeat gate failed: ${JSON.stringify(first.diagnostics)}`);
    await document.fonts.load('400 13px "Noto Sans CJK KR"',"입력처리완료");await document.fonts.load('700 13px "Noto Sans CJK KR"',"입력처리완료");await document.fonts.ready;
    if(!document.fonts.check('700 13px "Noto Sans CJK KR"',"입력"))throw new Error("Pinned CJK font did not load; stop capture instead of accepting fallback.");
    document.body.innerHTML=first.svg;
    await document.fonts.ready;
    const root=document.querySelector("svg");if(root.getAttribute("role")!=="img"||root.querySelector("title").textContent!==options.title)throw new Error("SVG accessibility root differs from source metadata");
    const labels=Array.from(root.querySelectorAll('[data-kind="label"]'));
    const typographicBounds=labels.map(l=>{if(!(l instanceof SVGGraphicsElement))throw new Error("Label is not an SVG graphics element");const b=l.getBBox();return {x:b.x,y:b.y,width:b.width,height:b.height};});
    // SVG2 8.10 text bounds use full glyph cells, not the E2 ink/line box.
    // Compare quantities with the same definition, without widening 1/64px.
    for(let i=0;i<labels.length;i++){
      const expected=scene.geometry.labels[i];
      const frame=labels[i].querySelector('[data-kind="label-bounds"]');
      if(!(frame instanceof SVGGraphicsElement))throw new Error("SVG label selection frame is missing");
      const actual=frame.getBBox();
      if(["x","y","width","height"].some(k=>Math.abs(actual[k]-expected.bounds[k]/64)>1/64))throw new Error(`SVG frame differs at label ${i}`);
      const painted=Array.from(labels[i].querySelectorAll('[data-kind="glyph"]'));
      const glyphs=expected.glyphs.filter(g=>!g.ignored&&!g.replaced);
      if(painted.length!==glyphs.length)throw new Error("SVG painted glyph count differs from geometry");
      for(let j=0;j<painted.length;j++){
        const element=painted[j],glyph=glyphs[j];
        if(!(element instanceof SVGTextContentElement))throw new Error("Visible glyph is not SVG text");
        const style=getComputedStyle(element);
        if(Math.abs(parseFloat(style.fontSize)-expected.fontSize/64)>1/64||Number(style.fontWeight)!==expected.font.weight)throw new Error("Browser text font differs from geometry");
        if(Math.abs(Number(element.getAttribute("x"))-glyph.position.x/64)>1/64||Math.abs(Number(element.getAttribute("y"))-glyph.position.y/64)>1/64)throw new Error("Browser glyph origin differs from geometry");
        if(Math.abs(element.getComputedTextLength()-glyph.advance/64)>1/64)throw new Error(`Pinned-font scalar advance differs: ${JSON.stringify({label:expected.id,text:expected.text,glyph:glyph.input,actual:element.getComputedTextLength(),expected:glyph.advance/64,font:style.font,fontFamily:style.fontFamily,fontWeight:style.fontWeight,fontSize:style.fontSize,loaded:Array.from(document.fonts).map(f=>({family:f.family,weight:f.weight,status:f.status}))})}`);
      }
    }
    return {svg:first.svg,nodes:scene.geometry.nodes.length,routes:scene.geometry.routes.length,labels:labels.length,width:scene.geometry.page.bounds.width/64,height:scene.geometry.page.bounds.height/64,fontLoaded:true,physicalScalarAdvancesChecked:true,typographicBounds};
   },{spec,theme});
   await page.setViewportSize({width:Math.ceil(captured.width),height:Math.ceil(captured.height)});
   const stem=`${type}-${theme}`;writeFileSync(join(output,`${stem}.svg`),captured.svg);await page.screenshot({path:join(output,`${stem}.png`),fullPage:true});
   receipts.push({type,theme,...captured,svg:undefined,svgSha256:createHash("sha256").update(captured.svg).digest("hex")});
  }
 }
 if(external.length)throw new Error(`Screenshot tried external requests: ${external}; keep fixture traffic on the isolated local artifact server.`);
 writeFileSync(join(output,"receipt.json"),JSON.stringify({scope:"actual Rust/WASM SVG, pinned source fonts loaded in isolated Chromium, not a native app or Archify pixel comparison",screenshots:receipts},null,2)+"\n");
 console.log(`ENGINE_E3_SCREENSHOTS ${JSON.stringify(receipts)}`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));server.closeAllConnections();}
