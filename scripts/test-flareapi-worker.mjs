import test from 'node:test';
import {spawnSync}from'node:child_process';
import assert from 'node:assert/strict';
import {readFile,mkdtemp}from'node:fs/promises';
import{tmpdir}from'node:os';import{join}from'node:path';
import {Miniflare,convertV4MiniflareOptions,Response}from'miniflare';
import {assertAppConfig,ORIGIN}from'./deploy-flareapi.mjs';
const admin='fixture-single-admin-long-enough',changed='fixture-replacement-admin-long-enough';
const fakeApiKey='fixture_webshare_api_key_123456';
const proxy={id:'fixture-node',proxy_address:'9.142.39.218',port:7388,username:'fixture-user',password:'fixture-password',valid:true,country_code:'US'};
function options(script,persist,password){return convertV4MiniflareOptions({name:'flareapi-single-fixture',script,modules:true,compatibilityDate:'2026-09-06',compatibilityFlags:['nodejs_compat'],host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},resourcePersistencePath:persist,durableObjects:{ACCOUNT:{className:'WebshareAccount',useSQLite:true}},bindings:{ADMIN_API_KEY:password},serviceBindings:{ASSETS:async request=>{
 const p=new URL(request.url).pathname;const files={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/styles.css':['styles.css','text/css']};if(!files[p])return new Response(null,{status:404});const [file,type]=files[p];return new Response(await readFile('public/'+file),{headers:{'Content-Type':type}});
}},outboundService:async request=>{const u=new URL(request.url);assert.equal(u.origin,'https://proxy.webshare.io');assert.equal(u.pathname,'/api/v2/proxy/list/');assert.equal(request.headers.get('Authorization'),'Token '+fakeApiKey);return Response.json({count:1,next:null,results:[proxy]});}});}
test('one-password configuration rejects old vars, other target/routes/shared namespaces and deployment',async()=>{
 const c=JSON.parse(await readFile('wrangler.flareapi.jsonc','utf8'));assertAppConfig(c);assert.deepEqual(c.secrets.required,['ADMIN_API_KEY']);assert.equal(c.vars,undefined);
 const blocked=spawnSync(process.execPath,['scripts/deploy-flareapi.mjs','--deploy'],{encoding:'utf8',windowsHide:true});assert.equal(blocked.status,1);assert.ok(blocked.stderr.includes('deployment_disabled_for_local_only_task'));
 for(const change of [x=>x.name='oneapi-webshare-test',x=>x.vars={GATEWAY_API_KEY:'x'},x=>x.routes=['*/*'],x=>x.define={FLAREAPI_ORIGIN:'"https://evil.example"'},x=>x.durable_objects.bindings[0].script_name='oneapi-webshare-test']){const bad=structuredClone(c);change(bad);assert.throws(()=>assertAppConfig(bad));}
});
test('actual single-password SQLite DO Worker: login, no default, user key sync, boundaries, restart and changed password',async()=>{
 const script=await readFile('output/flareapi/single-dist/flareapi-worker.js','utf8');const persist=await mkdtemp(join(tmpdir(),'flareapi-worker-'));let m=new Miniflare(options(script,persist,admin));
 const auth=password=>({Authorization:'Bearer '+password,Origin:ORIGIN,'Content-Type':'application/json'});
 let call=(path,init)=>m.dispatchFetch(ORIGIN+path,init);
 try{
  await m.ready;
  assert.equal((await call('/admin/login')).status,200);
  assert.equal((await call('/admin/status')).status,401);
  assert.equal((await call('/admin/webshare')).status,401);
  assert.equal((await m.dispatchFetch('https://foreign.example/admin/status',{headers:auth(admin)})).status,403);
  const login=await call('/admin/session',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({password:admin})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const state=await(await call('/admin/webshare',{headers:{Cookie:cookie}})).json();assert.equal(state.activeSource,'none');assert.equal(state.activeNode,null);assert.deepEqual(state.nodes,[]);
  const list=await(await call('/admin/api-keys',{headers:auth(admin)})).json();assert.deepEqual(list.data,[]);
  assert.equal((await call('/v1/models',{headers:auth(admin)})).status,401);
  assert.equal((await call('/v1/models',{headers:auth('fixture-old-gateway')})).status,401);
  assert.equal((await call('/admin/webshare',{method:'PATCH',headers:{...auth(admin),Origin:'https://foreign.example'},body:JSON.stringify({apiKey:fakeApiKey})})).status,403);
  assert.equal((await call('/admin/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:admin})})).status,403);
  const rejectedInternal=await call('/__internal/cancel?lease_id=fixture',{method:'POST',headers:auth(admin)});assert.ok(rejectedInternal.status>=400&&rejectedInternal.status<500);await rejectedInternal.body?.cancel();
  assert.equal((await m.dispatchFetch('https://oneapi.internal/__internal/request-groups/open',{method:'POST',headers:auth(admin),body:'{}'})).status,403);
  const saved=await call('/admin/webshare',{method:'PATCH',headers:auth(admin),body:JSON.stringify({apiKey:fakeApiKey})});assert.equal(saved.status,200);assert.equal((await saved.json()).activeNode,null);
  const synced=await call('/admin/webshare/sync',{method:'POST',headers:auth(admin),body:'{}'});assert.equal(synced.status,200);const nodes=await synced.json();assert.equal(nodes.nodes.length,1);assert.equal(nodes.activeNode,null);
  const created=await call('/admin/api-keys',{method:'POST',headers:auth(admin),body:JSON.stringify({name:'fixture client'})});assert.equal(created.status,201);const clientKey=(await created.json()).key;
  const validKey=await call('/v1/models',{headers:auth(clientKey)});assert.notEqual(validKey.status,401);await validKey.body?.cancel();
  const publicConfig=JSON.stringify(nodes);for(const secret of [fakeApiKey,proxy.password,proxy.username])assert.ok(!publicConfig.includes(secret));
  const privateState=await call('/admin/flareapi-encryption-key-v1',{headers:auth(admin)});assert.ok(privateState.status>=400&&privateState.status<500);const privateBody=await privateState.text();assert.ok(!privateBody.includes('encryptionKey'));
  await m.dispose();m=new Miniflare(options(script,persist,changed));await m.ready;call=(path,init)=>m.dispatchFetch(ORIGIN+path,init);
  assert.equal((await call('/admin/status',{headers:auth(admin)})).status,401);
  const reopened=await call('/admin/webshare',{headers:auth(changed)});assert.equal(reopened.status,200);const restored=await reopened.json();assert.equal(restored.apiKeyConfigured,true);assert.equal(restored.nodes.length,1);assert.equal(restored.activeNode,null);
  assert.equal((await call('/admin/webshare/sync',{method:'POST',headers:auth(changed),body:'{}'})).status,200);
  assert.equal((await(await call('/admin/api-keys',{headers:auth(changed)})).json()).data.length,1);
  console.log('Single ADMIN_API_KEY full Worker, no default proxy, sync, auth/Host/CSRF/internal boundaries, restart and password change passed');
 }finally{await m.dispose();}
});
