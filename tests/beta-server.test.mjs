import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {betaServer} from '../scripts/beta-server.mjs';

test('serves only website files and proxies cookies and API failures', async t => {
  const upstream=createServer((req,res)=>{
    if(req.url==='/v1/fail'){res.writeHead(422,{'content-type':'application/json'}).end('{"error":{"code":"VALIDATION"}}');return;}
    res.writeHead(200,{'content-type':'application/json','set-cookie':['clubby_beta=test; HttpOnly; SameSite=Lax; Path=/']});
    res.end(JSON.stringify({url:req.url,cookie:req.headers.cookie,origin:req.headers.origin,forwarded:req.headers['x-forwarded-for']}));
  }).listen(0,'127.0.0.1');
  await once(upstream,'listening');
  const server=betaServer({apiTarget:`http://127.0.0.1:${upstream.address().port}`}).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const page=await fetch(origin);
  assert.equal(page.status,200);assert.match(await page.text(),/Clubby/);
  assert.match(page.headers.get('content-security-policy'),/tile.openstreetmap.org/);
  assert.equal((await fetch(origin+'/src/app.js')).headers.get('content-type'),'text/javascript; charset=utf-8');
  for(const path of ['/.env','/package.json','/src/missing.js','/vendor/leaflet.js.map','/%2e%2e/package.json']) assert.equal((await fetch(origin+path)).status,404);
  assert.equal((await fetch(origin,{method:'POST'})).status,405);
  const proxy=await fetch(origin+'/v1/beta/state?test=1',{headers:{cookie:'clubby_beta=abc',origin,'x-forwarded-for':'1.2.3.4'}});
  assert.match(proxy.headers.get('set-cookie'),/HttpOnly/);
  assert.deepEqual(await proxy.json(),{url:'/v1/beta/state?test=1',cookie:'clubby_beta=abc',origin});
  assert.equal((await fetch(origin+'/v1/fail')).status,422);
  await new Promise(r=>upstream.close(r));
  const unavailable=await fetch(origin+'/v1/beta/state');
  assert.equal(unavailable.status,502);assert.equal((await unavailable.json()).error.code,'API_UNAVAILABLE');
});
