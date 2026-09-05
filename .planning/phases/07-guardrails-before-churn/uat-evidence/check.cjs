const { chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
// Run from the repository root with Vite at http://127.0.0.1:5318.
// Only browser responses are instrumented; no production files or user data are changed.
const out = __dirname;
const root = 'mock://maru-sample-workspace';
const results=[];
function docs(n) { return Array.from({length:n},(_,i)=>({path:`${root}/archive/uat-${i}.md`,relPath:`archive/uat-${i}.md`,title:`UAT document ${i}`,frontmatter:{status:'draft',type:'note'},updatedAt:new Date().toISOString(),wordCount:5,snippet:'UAT isolated test fixture',fileKind:'md',versionCount:0})); }
function entries() { return ['pendingItem','dropFile'].map((kind,i)=>({id:`uat-${i}`,kind,path:`${root}/inbox/${i?'auto/gws/arrival.txt':'items/pending/uat-pending'}`,relPath:`inbox/${i?'auto/gws/arrival.txt':'items/pending/uat-pending'}`,title:i?'UAT auto arrival':'UAT pending item',channel:'gws',sourceKind:'mail',dropPath:i?'auto/gws':null,configuredRoot:'inbox',itemId:`uat-${i}`,status:'pending',manifestPath:null,summaryPath:null,routePath:null,sizeBytes:640,receivedAt:new Date().toISOString(),intakeMode:i?'auto':'manual'})); }
(async()=>{
const b=await chromium.launch();
try {
 for (const n of [0,1,9582]) {
  const p=await b.newPage({viewport:{width:1440,height:1000}});
  const errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(({documents,queue})=>{
   window.__UAT_DOCS=documents;window.__UAT_QUEUE=queue;window.__UAT_RELEASED=false;
   window.__UAT_GATE=new Promise(resolve=>window.__UAT_RELEASE=()=>{window.__UAT_RELEASED=true;resolve();});
   window.__MARU_E2E_INVOKE__={scan_inbox_entries:()=>window.__UAT_QUEUE};
  },{documents:docs(n),queue:n?entries():[]});
  await p.route('**/src/lib/api.ts',async route=>{
    const response=await route.fetch();let body=await response.text();
    const needle='export async function scanVault(vaultPath, scanOptions) {';
    if(!body.includes(needle)) throw Error('Missing scanVault instrumentation target');
    body=body.replace(needle,needle+' window.__UAT_SCAN_STARTED=true; await window.__UAT_GATE; return window.__UAT_DOCS;');
    if(!n) body=body.replace('if (!isTauri()) return mockInboxDropItems();','if (!isTauri()) return [];');
    await route.fulfill({response,body});
  });
  await p.goto('http://127.0.0.1:5318');
  const rows=p.locator('.type-filters').first().locator('button.type-filter');
  await expect(rows).toHaveCount(4);
  await p.waitForFunction(()=>window.__UAT_SCAN_STARTED===true);
  const labels=await rows.locator('span:nth-child(2)').allTextContents();
  expect(labels).toEqual(['전체','Drafts','Archive','최근 업데이트']);
  for(let i=0;i<4;i++) {await rows.nth(i).click();await expect(rows.nth(i)).toHaveClass(/active/);}
  expect(await p.evaluate(()=>window.__UAT_RELEASED)).toBe(false);
  await p.screenshot({animations:'disabled',path:`${out}/counts-${n}-settling.png`});
  await p.evaluate(()=>window.__UAT_RELEASE());
  await expect(rows.nth(0).locator('.count')).toHaveText(String(n),{timeout:30000});
  for(let i=0;i<4;i++) {await expect(rows.nth(i).locator('.count')).toHaveText(String(n));await rows.nth(i).click();await expect(rows.nth(i)).toHaveClass(/active/);}
  const bounds=await rows.locator('.count').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent,client:node.clientWidth,scroll:node.scrollWidth})));
  expect(bounds.every(x=>x.scroll<=x.client)).toBe(true);
  await p.screenshot({animations:'disabled',path:`${out}/counts-${n}.png`});
  results.push({test:'switcher',volume:n,labels,counts:bounds,clicksBeforeScanResolved:4,clicksAfterScanResolved:4,errors});
  if(n<2){
   await p.locator('.activity-rail').getByRole('button',{name:'인박스',exact:true}).click();
   const pane=p.locator('.inbox-pane');await expect(pane).toBeVisible();
   if(n){
    await expect(pane.locator('.configured-inbox-item')).toHaveCount(2);
    await expect(pane).toContainText('UAT pending item');await expect(pane).toContainText('UAT auto arrival');
    await expect(pane).toContainText('rise-budget-review.pdf');await expect(pane).toContainText('weekly-kpi.xlsx');
    const row=pane.locator('.configured-inbox-item').first();
    await row.locator('input[type=checkbox]').click();await expect(row.locator('input')).toBeChecked();
    await p.screenshot({animations:'disabled',path:`${out}/inbox-populated-right-panel.png`});
    await p.locator('.outline-pane').getByRole('button',{name:'개요 닫기'}).click();
    await row.getByRole('button',{name:'처리',exact:true}).click();
    await expect(p.locator('.inbox-process-dialog')).toContainText('선택 1건 처리');
    await expect(p.locator('.inbox-process-dialog')).toContainText('inbox-process gws');
    await p.screenshot({animations:'disabled',path:`${out}/inbox-action.png`});
    await p.locator('.inbox-process-dialog').getByRole('button',{name:'취소',exact:true}).last().click();
    await expect(p.locator('.inbox-process-dialog')).toBeHidden();
    results.push({test:'inbox-populated',configuredRows:2,dropFiles:2,selection:true,processComposerClicked:true});
   }else{
    await expect(pane.locator('.configured-inbox-item')).toHaveCount(0);
    await expect(pane.locator('.inbox-item')).toHaveCount(0);
    const empties=await pane.locator('.inbox-empty').allTextContents();
    expect(empties.length).toBeGreaterThanOrEqual(2);
    results.push({test:'inbox-empty',emptyStates:empties});
   }
   await p.screenshot({animations:'disabled',path:`${out}/inbox-${n?'populated':'empty'}.png`,fullPage:true});
  }
  await p.close();fs.writeFileSync(`${out}/results.json`,JSON.stringify(results,null,2));console.log('PASS volume',n);
 }
} finally {await b.close();}
console.log(JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
