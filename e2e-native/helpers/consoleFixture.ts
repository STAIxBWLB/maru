// Synthetic console-contract fixture only; not the published package.
export const consoleFixture = String.raw`
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
