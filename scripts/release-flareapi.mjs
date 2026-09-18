import assert from 'node:assert/strict';
import{readFile,writeFile}from'node:fs/promises';import{createHash}from'node:crypto';import{homedir}from'node:os';import{join}from'node:path';import{spawn}from'node:child_process';
import{assertAppConfig,prepare,CONFIG,ORIGIN,SECRET_FILE}from'./deploy-flareapi.mjs';
import{inventory}from'./deploy-latency-test.mjs';
export const ACCOUNT_ID='ed6c2f7b12e4f0659cf8b70077fa649b',NAMESPACE='17a8dd0ea83c47edbdbf94ce6c33c71c';
export const OBSOLETE_SECRETS=['GATEWAY_API_KEY','PROXY_CONFIG','TOKEN_ENCRYPTION_KEY'];
const canonical=x=>JSON.stringify(x);
const fingerprint=s=>createHash('sha256').update(JSON.stringify(['ADMIN_API_KEY','GATEWAY_API_KEY','TOKEN_ENCRYPTION_KEY'].map(k=>s[k]))).digest('hex');
export function assertExistingTarget(settings,legacy,active){
 assert.equal(active.ADMIN_API_KEY,legacy.ADMIN_API_KEY,'original_admin_key_required');
 const bindings=settings.bindings??[];assert.equal(bindings.find(b=>b.name==='ACCOUNT')?.namespace_id,NAMESPACE,'wrong_existing_namespace');
 assert.equal(bindings.find(b=>b.name==='ACCOUNT')?.class_name,'WebshareAccount');assert.ok(!bindings.find(b=>b.name==='ACCOUNT')?.script_name,'shared_worker_binding');
 assert.equal(bindings.find(b=>b.name==='ONEAPI_INSTANCE_KEYS_SHA256')?.text,fingerprint(legacy),'original_key_fingerprint_mismatch');
 assert.equal(bindings.find(b=>b.name==='PUBLIC_ORIGIN')?.text,ORIGIN);assert.equal(bindings.find(b=>b.name==='WORKER_ORIGIN')?.text,ORIGIN);
 assert.deepEqual(bindings.filter(b=>b.type==='secret_text').map(b=>b.name).sort(),['ADMIN_API_KEY',...OBSOLETE_SECRETS].sort());
 assert.deepEqual(bindings.map(b=>b.name).sort(),['ACCOUNT','ASSETS','ADMIN_API_KEY',...OBSOLETE_SECRETS,'ONEAPI_INSTANCE_KEYS_SHA256','PUBLIC_ORIGIN','WORKER_ORIGIN'].sort());
}
export function assertFinalBindings(settings){const b=settings.bindings??[];assert.deepEqual(b.map(x=>x.name).sort(),['ACCOUNT','ASSETS','ADMIN_API_KEY'].sort());assert.equal(b.find(x=>x.name==='ADMIN_API_KEY')?.type,'secret_text');assert.equal(b.find(x=>x.name==='ACCOUNT')?.namespace_id,NAMESPACE);assert.equal(b.find(x=>x.name==='ACCOUNT')?.class_name,'WebshareAccount');assert.ok(!b.find(x=>x.name==='ACCOUNT')?.script_name);}
export function assertMigrationBindings(settings){
 const b=settings.bindings??[];assert.deepEqual(b.map(x=>x.name).sort(),['ACCOUNT','ASSETS','ADMIN_API_KEY',...OBSOLETE_SECRETS].sort());
 assert.equal(b.find(x=>x.name==='ACCOUNT')?.namespace_id,NAMESPACE);assert.equal(b.find(x=>x.name==='ACCOUNT')?.class_name,'WebshareAccount');assert.ok(!b.find(x=>x.name==='ACCOUNT')?.script_name);
 assert.deepEqual(b.filter(x=>x.type==='secret_text').map(x=>x.name).sort(),['ADMIN_API_KEY',...OBSOLETE_SECRETS].sort());
}
export function assertDataContinuity(before,after){
 assert.equal(after.status.connected,before.status.connected,'account_connected_changed');assert.equal(after.status.reauthenticationRequired,before.status.reauthenticationRequired,'account_auth_state_changed');
 assert.ok(!after.keys.some(k=>k.id==='legacy'),'legacy_gateway_still_enabled');assert.equal(canonical(after.keys),canonical(before.keys.filter(k=>k.id!=='legacy')),'api_keys_changed');
 for(const field of ['apiKeyConfigured','planId','lastSyncedAt','nodes'])assert.equal(canonical(after.webshare[field]),canonical(before.webshare[field]),'webshare_'+field+'_changed');
 const expected=before.webshare.activeSource==='bootstrap'?null:before.webshare.activeNode;
 assert.equal(canonical(after.webshare.activeNode),canonical(expected),'explicit_selected_node_changed');
 assert.equal(after.webshare.tcpTestSupported,true,'tcp_measure_not_available');
 if(!expected)assert.equal(after.webshare.activeSource,'none','unexpected_default_proxy');
}
export function compareIsolation(before,after){
 assert.ok(before.workers.some(w=>w.id==='flareapi'),'existing_target_missing');
 const changed=before.workers.filter(w=>w.id!=='flareapi').filter(w=>{const a=after.workers.find(x=>x.id===w.id);return !a||a.etag!==w.etag||a.modified_on!==w.modified_on}).map(w=>w.id);
 assert.deepEqual(changed,[],'other_workers_changed');assert.deepEqual(after.workers.map(w=>w.id).sort(),before.workers.map(w=>w.id).sort(),'workers_added_or_deleted');
 const sorted=x=>canonical([...x].sort((a,b)=>canonical(a).localeCompare(canonical(b))));
 for(const field of ['domains','durableObjects'])assert.equal(sorted(after[field]),sorted(before[field]),field+'_changed');assert.equal(canonical(after.subdomain),canonical(before.subdomain),'subdomain_changed');
 return{at:new Date().toISOString(),otherWorkersCompared:before.workers.length-1,otherWorkerChanges:changed,domainsUnchanged:true,subdomainUnchanged:true,durableObjectsUnchanged:true};
}
async function api(path,init={}){const token=/^oauth_token\s*=\s*"([^"]+)"/m.exec(await readFile(join(homedir(),'.wrangler/config/default.toml'),'utf8'))?.[1];assert.ok(token,'cloud_auth_unavailable');const response=await fetch('https://api.cloudflare.com/client/v4'+path,{...init,headers:{Authorization:'Bearer '+token,...init.headers},redirect:'error',signal:AbortSignal.timeout(15000)});const data=await response.json();assert.ok(response.ok&&data.success,'cloud_api_'+response.status);return data.result;}
export const cloudSettings=()=>api('/accounts/'+ACCOUNT_ID+'/workers/scripts/flareapi/settings');
async function app(path,key,init={}){const response=await fetch(ORIGIN+path,{...init,headers:{Authorization:'Bearer '+key,Origin:ORIGIN,...init.headers},redirect:'manual',signal:AbortSignal.timeout(20000)});assert.ok(response.ok,'app_'+path+'_'+response.status);return response.json();}
export async function snapshot(key){const [status,webshare,keys]=await Promise.all([app('/admin/status',key),app('/admin/webshare',key),app('/admin/api-keys',key)]);return{status:{connected:status.connected,reauthenticationRequired:status.reauthenticationRequired},webshare,keys:keys.data};}
async function preflight(){
 assertAppConfig(JSON.parse(await readFile(CONFIG,'utf8')));const active=JSON.parse(await readFile(SECRET_FILE,'utf8')),legacy=JSON.parse(await readFile('.env.worker-flareapi.legacy.json','utf8'));
 const [user,account]=await Promise.all([api('/user'),api('/accounts/'+ACCOUNT_ID)]);assert.equal(user.email,'12213443th@gmail.com');assert.equal(account.id,ACCOUNT_ID);
 const settings=await cloudSettings();assertExistingTarget(settings,legacy,active);const resources=await inventory();assert.ok(resources.durableObjects.some(n=>n.id===NAMESPACE&&n.script==='flareapi'),'original_namespace_missing');
 const state=await snapshot(active.ADMIN_API_KEY);const report={at:new Date().toISOString(),target:'flareapi',accountId:account.id,email:user.email,namespace:NAMESPACE,originalKeyFingerprintVerified:true,adminKeyUnchanged:true,bindings:settings.bindings.map(b=>({name:b.name,type:b.type})),connected:state.status.connected,nodeCount:state.webshare.nodes.length,activeSource:state.webshare.activeSource,apiKeyCount:state.keys.filter(k=>k.id!=='legacy').length};await writeFile('output/flareapi/release-preflight.json',JSON.stringify(report,null,2));return{active,state,resources,report};
}
export const deploymentArgs=()=>['node_modules/wrangler/bin/wrangler.js','deploy','--config',CONFIG,'--keep-vars=false','--secrets-file',SECRET_FILE];
async function runDeploy(){const child=spawn(process.execPath,deploymentArgs(),{windowsHide:true,stdio:'inherit'});const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});assert.equal(code,0,'target_deployment_failed');}
export async function verifyPageAndLogin(key){
 const checks={};let cookie;
 try{
 const page=await fetch(ORIGIN+'/admin/login',{redirect:'manual',signal:AbortSignal.timeout(15000)});assert.equal(page.status,200);assert.match(await page.text(),/FlareAPI/);checks.brand=true;
 const login=await fetch(ORIGIN+'/admin/session',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({password:key}),redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(login.status,200);cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);await login.body?.cancel();checks.login=true;
 const session=await fetch(ORIGIN+'/admin/webshare',{headers:{Cookie:cookie},redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(session.status,200);const c=await session.json();assert.equal(c.tcpTestSupported,true);checks.cookieSettings=true;
 const denied=await fetch(ORIGIN+'/admin/webshare/measure',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(denied.status,401);await denied.body?.cancel();checks.anonymousMeasureDenied=true;
 const invalid=await fetch(ORIGIN+'/admin/webshare/measure',{method:'POST',headers:{Cookie:cookie,Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({nodeId:'__invalid_node__'}),redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(invalid.status,400);await invalid.body?.cancel();checks.invalidNodeDenied=true;
 const foreign=await fetch(ORIGIN+'/admin/webshare/measure',{method:'POST',headers:{Cookie:cookie,Origin:'https://foreign.example','Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(foreign.status,403);await foreign.body?.cancel();checks.csrfRejected=true;
 const assets={};for(const [url,file]of [['/','public/index.html'],['/app.js','public/app.js'],['/styles.css','public/styles.css']]){const r=await fetch(ORIGIN+(url==='/'?'/admin/login':url),{redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);const remote=Buffer.from(await r.arrayBuffer()),local=await readFile(file);assert.equal(createHash('sha256').update(remote).digest('hex'),createHash('sha256').update(local).digest('hex'));assets[file]=true;}checks.assets=assets;
 }finally{if(cookie){const logout=await fetch(ORIGIN+'/admin/session',{method:'DELETE',headers:{Cookie:cookie,Origin:ORIGIN,'Content-Type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(15000)});assert.ok(logout.ok,'test_session_cleanup_failed');await logout.body?.cancel();checks.testSessionRemoved=true;}}
 return checks;
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/release-flareapi.mjs')){
 try{assert.ok(process.argv.slice(2).length<=1&&process.argv.slice(2).every(a=>['--preflight','--deploy'].includes(a)),'invalid_release_command');console.log(JSON.stringify(await prepare()));const baseline=await preflight();console.log(JSON.stringify(baseline.report));
 if(process.argv.includes('--deploy')){
  await writeFile('output/flareapi/release-before.json',JSON.stringify(baseline.resources,null,2));const checkpoint={at:new Date().toISOString(),target:'flareapi',namespace:NAMESPACE,stage:'before-deploy',removed:[]};const save=async()=>writeFile('output/flareapi/release-checkpoint.json',JSON.stringify(checkpoint,null,2));await save();
  await runDeploy();checkpoint.stage='deployed-awaiting-migration';await save();assertMigrationBindings(await cloudSettings());
  const migrated=await snapshot(baseline.active.ADMIN_API_KEY);assertDataContinuity(baseline.state,migrated);assert.equal((await cloudSettings()).bindings.find(b=>b.name==='ACCOUNT')?.namespace_id,NAMESPACE);checkpoint.stage='migration-verified';await save();
  for(const name of OBSOLETE_SECRETS){assert.ok(checkpoint.stage==='migration-verified','migration_not_verified');await api('/accounts/'+ACCOUNT_ID+'/workers/scripts/flareapi/secrets/'+name,{method:'DELETE'});checkpoint.removed.push(name);await save();assertDataContinuity(baseline.state,await snapshot(baseline.active.ADMIN_API_KEY));}
  assertFinalBindings(await cloudSettings());const live=await verifyPageAndLogin(baseline.active.ADMIN_API_KEY);const isolation=compareIsolation(baseline.resources,await inventory());
  const report={at:new Date().toISOString(),target:'flareapi',origin:ORIGIN,remainingSecrets:['ADMIN_API_KEY'],removedSecrets:checkpoint.removed,namespace:NAMESPACE,dataContinuity:true,connected:migrated.status.connected,nodeCount:migrated.webshare.nodes.length,activeSource:migrated.webshare.activeSource,live,isolation};await writeFile('output/flareapi/release-live.json',JSON.stringify(report,null,2));checkpoint.stage='complete';await save();console.log(JSON.stringify(report));
 }
 }catch(error){console.error(error.message??'flareapi_release_failed');process.exitCode=1;}
}