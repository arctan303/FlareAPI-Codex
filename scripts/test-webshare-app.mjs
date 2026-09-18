import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { assertAppConfig,ORIGIN } from './deploy-webshare-app.mjs';
test('deployment configuration refuses existing product names, routes, shared namespaces, services and domain changes',async()=>{
 const c=JSON.parse(await readFile('wrangler.webshare-test.jsonc','utf8'));assertAppConfig(c);
 for(const mutate of [x=>{x.name='oneapi';},x=>{x.routes=['api.arcinks.com/*'];},x=>{x.services=[{binding:'OTHER',service:'mail'}];},x=>{x.durable_objects.bindings[0].script_name='existing';},x=>{x.vars.PUBLIC_ORIGIN='https://api.arcinks.com';},x=>{x.migrations[0].deleted_classes=['Existing'];}]){const bad=structuredClone(c);mutate(bad);assert.throws(()=>assertAppConfig(bad));}
});
test('actual complete experimental Worker instantiates isolated SQLite DO and preserves admin auth/CSRF with no network',async()=>{
 const m=new Miniflare(convertV4MiniflareOptions({
  name:'webshare-app-fixture',script:await readFile('output/worker-webshare/app-dist/oneapi-webshare-worker.js','utf8'),modules:true,
  compatibilityDate:'2026-09-06',compatibilityFlags:['nodejs_compat'],host:'127.0.0.1',port:0,cf:false,telemetry:{enabled:false},
  durableObjects:{ACCOUNT:{className:'WebshareAccount',useSQLite:true}},
  bindings:{ADMIN_API_KEY:'fixture-admin-key-long-enough',GATEWAY_API_KEY:'fixture-gateway-key-long-enough',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),PUBLIC_ORIGIN:ORIGIN,WORKER_ORIGIN:ORIGIN,
   PROXY_CONFIG:JSON.stringify({host:'138.226.61.165',port:6338,username:'fixture-user',password:'fixture-password'})},
  outboundService:async()=>{throw new Error('fixture_forbids_network');}
 }));
 try{
  await m.ready;
  const req=(path,init)=>m.dispatchFetch(ORIGIN+path,init);
  assert.equal((await req('/health')).status,200);
  assert.equal((await req('/admin/status')).status,401);
  assert.equal((await req('/admin/webshare')).status,401);
  const login=await req('/admin/session',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({password:'fixture-admin-key-long-enough'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const status=await req('/admin/status',{headers:{Cookie:cookie}});assert.equal(status.status,200);assert.equal((await status.json()).connected,false);
  assert.equal((await req('/admin/api-keys',{method:'POST',headers:{Cookie:cookie,Origin:'https://foreign.example','Content-Type':'application/json'},body:'{}'})).status,403);
  const webshare=await req('/admin/webshare',{headers:{Cookie:cookie}});assert.equal(webshare.status,200);
  const config=await webshare.json();assert.equal(config.activeSource,'bootstrap');assert.equal(config.apiKeyConfigured,false);assert.deepEqual(config.nodes,[]);assert.equal('password' in config,false);
  assert.equal((await req('/admin/webshare/sync',{method:'POST',headers:{Cookie:cookie,Origin:'https://foreign.example','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await req('/admin/webshare',{method:'PATCH',headers:{Cookie:cookie,Origin:ORIGIN,'Content-Type':'application/json'},body:'{"apiKey":"bad"}'})).status,400);
  assert.equal((await req('/admin/account/import',{method:'POST',headers:{Authorization:'Bearer fixture-admin-key-long-enough',Origin:ORIGIN,'Content-Type':'application/json'},body:'{}'})).status,404);
 }finally{await m.dispose();}
});
import { assertKeyContinuity,keyFingerprint } from './deploy-webshare-app.mjs';
test('existing cloud namespace rejects missing or different original instance keys before upload',()=>{
 const secrets={ADMIN_API_KEY:'fixture-admin',GATEWAY_API_KEY:'fixture-api',TOKEN_ENCRYPTION_KEY:'fixture-encryption'};
 const fingerprint=keyFingerprint(secrets);
 assert.doesNotThrow(()=>assertKeyContinuity(secrets,fingerprint,true));
 assert.throws(()=>assertKeyContinuity(undefined,fingerprint,true));
 assert.throws(()=>assertKeyContinuity({...secrets,TOKEN_ENCRYPTION_KEY:'replacement'},fingerprint,true));
 assert.throws(()=>assertKeyContinuity(secrets,undefined,true));
 assert.doesNotThrow(()=>assertKeyContinuity(undefined,undefined,false));
});
import {compareExistingWorkers} from './deploy-webshare-app.mjs';
test('isolation comparison permits only the authorized Worker change and rejects other product changes or removals',()=>{
 const before=[{id:'mail',etag:'a',modified_on:'old'},{id:'oneapi-webshare-test',etag:'b',modified_on:'old'}];
 assert.deepEqual(compareExistingWorkers(before,[before[0],{id:'oneapi-webshare-test',etag:'new',modified_on:'new'}]),[]);
 assert.deepEqual(compareExistingWorkers(before,[{id:'mail',etag:'changed',modified_on:'new'},before[1]]),['mail']);
 assert.deepEqual(compareExistingWorkers(before,[before[1]]),['mail']);
});
