// Real native child-webview proof with an isolated console-contract fixture.
// The fixture enforces the published top-level/CSP/Origin/session contract;
// it does not claim to exercise the published acon package or its plugins.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";
import { fixtureRootDir } from "../helpers/fixtureWorkspace";

const consoleFixture = String.raw`
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const home = process.env.HOME;
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['ui','--no-open','--json'])) process.exit(7);
fs.appendFileSync(path.join(home, 'acon-starts.log'), JSON.stringify(process.argv.slice(2)) + require('node:os').EOL);
let origin, count = 0;
const script = "(async()=>{if(location.hash){await fetch('/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:location.hash.slice(1)})});history.replaceState(null,'','/')}let ipcDenied=true;if(typeof window.__TAURI_INTERNALS__?.invoke==='function'){try{await window.__TAURI_INTERNALS__.invoke('read_sites');ipcDenied=false}catch{}}await fetch('/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topLevel:top===self,ipcDenied,httpOnlyHidden:!document.cookie.includes('fixture-session')})});document.body.textContent='Native console ready'})()";
const server = http.createServer((req,res)=>{
  if (req.headers.host !== new URL(origin).host) { res.writeHead(403); res.end(); return; }
  if (req.url === '/stop') { res.end('stopped'); setTimeout(()=>{server.closeAllConnections();server.close(()=>process.exit(0))},20); return; }
  if (req.method === 'GET') { res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"default-src 'self'; script-src 'nonce-fixture-native-1234567890'; connect-src 'self'; frame-ancestors 'none'"});res.end('<!doctype html><title>Native console</title><body>Starting<script nonce="fixture-native-1234567890">'+script+'</script>');return; }
  if (req.headers.origin !== origin) { res.writeHead(403);res.end();return; }
  let body='';req.on('data',part=>{body+=part;if(body.length>8192)req.destroy()});req.on('end',()=>{
    const data=JSON.parse(body);
    if(req.url==='/bootstrap'&&data.ticket==='fixture-ticket'){res.writeHead(200,{'Set-Cookie':'fixture-session=ok; HttpOnly; SameSite=Strict; Path=/'});res.end('{}');return;}
    if(req.url==='/verify'&&String(req.headers.cookie).includes('fixture-session=ok')){count++;fs.writeFileSync(path.join(home,'acon-proof.json'),JSON.stringify({...data,count,origin,requestOrigin:req.headers.origin,cookie:true}));res.end('{}');return;}
    res.writeHead(403);res.end();
  });
});
server.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;fs.writeFileSync(path.join(home,'acon-ready.json'),JSON.stringify({origin,pid:process.pid}));console.log(JSON.stringify({url:origin+'/#fixture-ticket',origin,pid:process.pid,plugins:[]}))});
`;
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\"'\"'")}'`;

describe("native console site launch", () => {
  let home: string;
  after(async () => {
    if (!home) return;
    try { const ready = JSON.parse(await fs.readFile(path.join(home, "acon-ready.json"), "utf8")) as { origin: string }; await fetch(`${ready.origin}/stop`, { signal: AbortSignal.timeout(2000) }); } catch { /* owned fixture may already have stopped */ }
  });
  it("runs fixed argv and proves a top-level session under frame-ancestors none, then opens a manual URL without acon", async () => {
    home = path.join(fixtureRootDir(), "home");
    const bin = path.join(home, ".bun", "bin");
    const pkg = path.join(home, ".bun", "install", "global", "node_modules", "@staix", "agent-console");
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(path.join(pkg, "bin"), { recursive: true });
    await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@staix/agent-console", version: "0.1.0", bin: { acon: "bin/acon.js" } }));
    await fs.writeFile(path.join(pkg, "bin", "acon.js"), consoleFixture);
    await fs.writeFile(path.join(bin, "bun"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o755 });
    await fs.symlink(path.join(pkg, "bin", "acon.js"), path.join(bin, "acon"));
    await fs.writeFile(path.join(home, ".maru", "sites.json"), JSON.stringify({ version: 1, sites: [{ id: "native-console", label: "Native Console", url: "http://127.0.0.1", launch: "acon ui --no-open --json" }] }));
    const sites = await browser.$('.activity-rail button[aria-label="사이트"]');
    await sites.waitForDisplayed({ timeout: 30_000 }); await sites.click();
    const entry = await browser.$(".sites-item-primary");
    await entry.waitForDisplayed({ timeout: 30_000 }); await entry.click();
    const proofFile = path.join(home, "acon-proof.json");
    await browser.waitUntil(async () => { try { return JSON.parse(await fs.readFile(proofFile, "utf8")).count >= 1; } catch { return false; } }, { timeout: 30_000, timeoutMsg: "console child must execute its CSP-protected same-origin cookie bootstrap" });
    const proof = JSON.parse(await fs.readFile(proofFile, "utf8")) as { origin: string; requestOrigin: string; topLevel: boolean; ipcDenied: boolean; httpOnlyHidden: boolean; cookie: boolean };
    assert.equal(proof.topLevel, true); assert.equal(proof.ipcDenied, true); assert.equal(proof.httpOnlyHidden, true); assert.equal(proof.cookie, true); assert.equal(proof.requestOrigin, proof.origin);
    await fs.unlink(path.join(bin, "acon"));
    const address = await browser.$(".sites-url input");
    await address.click(); await address.setValue(`${proof.origin}/`); await browser.keys("Enter");
    await browser.waitUntil(async () => JSON.parse(await fs.readFile(proofFile, "utf8")).count >= 2, { timeout: 15_000, timeoutMsg: "manual URL must still load without a console executable" });
    assert.equal((await fs.readFile(path.join(home, "acon-starts.log"), "utf8")).trim().split("\n").length, 1);
    const stored = await fs.readFile(path.join(home, ".maru", "sites.json"), "utf8");
    assert.ok(!stored.includes("fixture-ticket"), "one-time launch URL must not be persisted in Sites");
  });
});
