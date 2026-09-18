import assert from 'node:assert/strict';
import { readFile,writeFile,readdir } from 'node:fs/promises';
import { randomBytes,createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { validateProxy } from '../experiments/webshare-probe-core.mjs';
export const ORIGIN='https://oneapi-webshare-test.12213443th.workers.dev';
export const CONFIG='wrangler.webshare-test.jsonc';
export const SECRET_FILE='.env.worker-webshare-app.json';
export function assertAppConfig(c) {
 assert.equal(c.name,'oneapi-webshare-test');assert.equal(c.account_id,'ed6c2f7b12e4f0659cf8b70077fa649b');assert.equal(c.main,'experiments/oneapi-webshare-worker.ts');
 assert.deepEqual(c.routes,[]);assert.equal(c.workers_dev,true);assert.equal(c.preview_urls,false);assert.deepEqual(c.observability,{enabled:false});
 assert.equal(c.compatibility_date,'2026-09-06');assert.deepEqual(c.compatibility_flags,['nodejs_compat']);
 assert.deepEqual(c.assets,{directory:'./public',binding:'ASSETS',run_worker_first:true});
 assert.deepEqual(c.durable_objects,{bindings:[{name:'ACCOUNT',class_name:'WebshareAccount'}]});
 assert.deepEqual(c.migrations,[{tag:'webshare-v1',new_sqlite_classes:['WebshareAccount']}]);
 assert.equal(c.vars.PUBLIC_ORIGIN,ORIGIN);assert.equal(c.vars.WORKER_ORIGIN,ORIGIN);
 assert.deepEqual(Object.keys(c.vars).sort(),['ONEAPI_INSTANCE_KEYS_SHA256','PUBLIC_ORIGIN','WORKER_ORIGIN']);assert.match(c.vars.ONEAPI_INSTANCE_KEYS_SHA256,/^[a-f0-9]{64}$/);
 assert.deepEqual(c.secrets,{required:['ADMIN_API_KEY','GATEWAY_API_KEY','TOKEN_ENCRYPTION_KEY','PROXY_CONFIG']});
 const allowed=new Set(['$schema','name','account_id','main','routes','workers_dev','preview_urls','observability','compatibility_date','compatibility_flags','assets','durable_objects','migrations','vars','secrets']);
 for(const key of Object.keys(c))assert.ok(allowed.has(key),'unexpected_resource_config');
}
export function compareExistingWorkers(before, after) {
 return before.filter(w=>w.id!=='oneapi-webshare-test').filter(w=>{ const a=after.find(x=>x.id===w.id);return !a||a.etag!==w.etag||a.modified_on!==w.modified_on; }).map(w=>w.id);
}
export async function inventory(stage = "app") {
 assert.ok(stage === "app" || stage === "settings" || stage === "layout" || stage === "concise");
 const config=JSON.parse(await readFile(CONFIG,'utf8'));assertAppConfig(config);
 const token=/^oauth_token\s*=\s*"([^"]+)"/m.exec(await readFile(join(homedir(),'.wrangler/config/default.toml'),'utf8'))?.[1];
 if(!token)throw new Error('cloud_auth_unavailable');
 const base='https://api.cloudflare.com/client/v4/accounts/'+config.account_id;
 const result={};
 await Promise.all(Object.entries({workers:'/workers/scripts',domains:'/workers/domains',durableObjects:'/workers/durable_objects/namespaces',subdomain:'/workers/subdomain'}).map(async([kind,path])=>{
  const r=await fetch(base+path,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});
  const d=await r.json();if(!r.ok||!d.success)throw new Error('inventory_failed');result[kind]=d.result;
 }));
 const before=JSON.parse(await readFile("output/worker-webshare/"+stage+"-before.json",'utf8'));
 const changed=compareExistingWorkers(before.workers,result.workers);
 const canonical=a=>JSON.stringify([...a].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
 const newNamespaces=result.durableObjects.filter(n=>!before.durableObjects.some(b=>b.id===n.id));
 const report={at:new Date().toISOString(),existingWorkersCompared:before.workers.filter(w=>w.id!=='oneapi-webshare-test').length,existingWorkerChanges:changed,domainsUnchanged:canonical(before.domains)===canonical(result.domains),subdomainUnchanged:JSON.stringify(before.subdomain)===JSON.stringify(result.subdomain),newNamespaces:newNamespaces.map(n=>({id:n.id,name:n.name,script:n.script,class:n.class}))};
 assert.deepEqual(changed,[]);assert.equal(report.domainsUnchanged,true);assert.equal(report.subdomainUnchanged,true);
 for(const old of before.durableObjects)assert.deepEqual(result.durableObjects.find(n=>n.id===old.id),old);
 for(const n of newNamespaces)assert.equal(n.script,'oneapi-webshare-test','unrelated_namespace_changed');
 assert.ok(newNamespaces.length<=1,'unexpected_extra_namespace');
 await writeFile("output/worker-webshare/"+stage+"-isolation.json",JSON.stringify(report,null,2));
 return report;
}
async function run(args) {
 const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args,'--config',CONFIG],{stdio:'inherit',windowsHide:true});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 if(code!==0)throw new Error('isolated_command_failed');
}
export function keyFingerprint(secrets) {
 return createHash('sha256').update(JSON.stringify(['ADMIN_API_KEY','GATEWAY_API_KEY','TOKEN_ENCRYPTION_KEY'].map(key=>secrets[key]))).digest('hex');
}
export function assertKeyContinuity(secrets, cloudFingerprint, hasNamespace) {
 if(hasNamespace || cloudFingerprint) {
  assert.ok(secrets,'existing_cloud_instance_needs_original_secret_file');
  assert.match(cloudFingerprint ?? '',/^[a-f0-9]{64}$/,'existing_cloud_instance_fingerprint_missing');
  assert.equal(keyFingerprint(secrets),cloudFingerprint,'cloud_instance_keys_mismatch');
 }
}
export async function cloudKeyState() {
 const token=/^oauth_token\s*=\s*"([^"]+)"/m.exec(await readFile(join(homedir(),'.wrangler/config/default.toml'),'utf8'))?.[1];
 if(!token)throw new Error('cloud_auth_unavailable');
 const base='https://api.cloudflare.com/client/v4/accounts/ed6c2f7b12e4f0659cf8b70077fa649b/workers';
 const headers={Authorization:'Bearer '+token};
 const [settings,namespaces]=await Promise.all(['/scripts/oneapi-webshare-test/settings','/durable_objects/namespaces'].map(async path=>{
  const r=await fetch(base+path,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});const d=await r.json();
  if(!r.ok||!d.success)throw new Error('cloud_key_state_unavailable');return d.result;
 }));
 const cloudFingerprint=settings.bindings?.find(b=>b.name==='ONEAPI_INSTANCE_KEYS_SHA256')?.text;
 const hasNamespace=namespaces.some(n=>n.script==='oneapi-webshare-test');
 return {cloudFingerprint,hasNamespace};
}
export async function prepare() {
 const config=JSON.parse(await readFile(CONFIG,'utf8'));
 const tls=await readFile('output/worker-webshare/tls-runtime/node_modules/@reclaimprotocol/tls/lib/make-tls-client.js');
 assert.equal(createHash('sha256').update(tls).digest('hex'),'accf51dd31b5c5783cfdfd2ebfc44ea1438896897078dc7e58b6b27a997ca405');
 const cloud=await cloudKeyState();
 let secrets;
 try {secrets=JSON.parse(await readFile(SECRET_FILE,'utf8'));}
 catch(error) {
  if(error.code!=='ENOENT')throw error;
  assertKeyContinuity(undefined,cloud.cloudFingerprint,cloud.hasNamespace);
  const proxies=JSON.parse(await readFile('.env.webshare.json','utf8'));
  const proxy=validateProxy(proxies.find(p=>p.host==='138.226.61.165'));
  secrets={ADMIN_API_KEY:randomBytes(24).toString('base64url'),GATEWAY_API_KEY:randomBytes(32).toString('base64url'),TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('base64'),PROXY_CONFIG:JSON.stringify(proxy)};
  await writeFile(SECRET_FILE,JSON.stringify(secrets,null,2),{flag:'wx',mode:0o600});
 }
 assertKeyContinuity(secrets,cloud.cloudFingerprint,cloud.hasNamespace);
 config.vars.ONEAPI_INSTANCE_KEYS_SHA256=keyFingerprint(secrets);
 assertAppConfig(config);
 await writeFile(CONFIG,JSON.stringify(config,null,2)+'\n');
 assert.deepEqual(Object.keys(secrets).sort(),['ADMIN_API_KEY','GATEWAY_API_KEY','PROXY_CONFIG','TOKEN_ENCRYPTION_KEY']);
 for(const key of ['ADMIN_API_KEY','GATEWAY_API_KEY','TOKEN_ENCRYPTION_KEY'])assert.ok(typeof secrets[key]==='string'&&secrets[key].length>=32);
 const proxy=validateProxy(JSON.parse(secrets.PROXY_CONFIG));assert.equal(proxy.host,'138.226.61.165');
 const files=['experiments/oneapi-webshare-worker.ts','experiments/webshare-fetch.mjs','experiments/webshare-tls-transport.mjs',CONFIG,'public/index.html','public/styles.css','public/app.js','src/account-core.ts','src/runtime/contracts.ts','src/webshare/api.ts','src/webshare/settings.ts'];
 async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(p);}}
 await walk('output/worker-webshare/app-dist');
 const values=[...Object.values(secrets),proxy.username,proxy.password];
 for(const path of files){const bytes=await readFile(path);if(values.some(value=>bytes.includes(Buffer.from(value))))throw new Error('secret_in_artifact');}
 const report={at:new Date().toISOString(),files:files.length,secretValueMatches:0,tlsPatchVerified:true,isolatedConfigVerified:true};
 await writeFile('output/worker-webshare/app-audit.json',JSON.stringify(report,null,2));return report;
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/deploy-webshare-app.mjs')) {
 try {
  console.log(JSON.stringify(await prepare()));
  if(process.argv.includes('--deploy')) {
   console.log(JSON.stringify(await inventory(process.argv.includes("--concise")?"concise":process.argv.includes("--layout")?"layout":process.argv.includes("--settings")?"settings":"app")));
   await run(['secret','bulk',SECRET_FILE]);
   await run(['deploy']);
   console.log(JSON.stringify(await inventory(process.argv.includes("--concise")?"concise":process.argv.includes("--layout")?"layout":process.argv.includes("--settings")?"settings":"app")));
  }
 }catch {console.error('webshare_app_prepare_or_deploy_failed');process.exitCode=1;}
}
