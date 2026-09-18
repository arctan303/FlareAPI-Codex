import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdir}from'node:fs/promises';
import{randomBytes}from'node:crypto';import{homedir}from'node:os';import{join}from'node:path';import{spawn}from'node:child_process';
export const CONFIG='wrangler.latency-test.jsonc',NAME='flareapi-latency-test',ORIGIN='https://'+NAME+'.12213443th.workers.dev',SECRET_FILE='.env.worker-latency.json';
export function assertConfig(c){
 assert.equal(c.name,NAME);assert.equal(c.account_id,'ed6c2f7b12e4f0659cf8b70077fa649b');assert.equal(c.main,'experiments/webshare-latency-worker.ts');assert.equal(c.compatibility_date,'2026-09-06');assert.deepEqual(c.routes,[]);assert.equal(c.workers_dev,true);assert.equal(c.preview_urls,false);assert.deepEqual(c.observability,{enabled:false});assert.deepEqual(c.secrets,{required:['PROBE_KEY']});assert.deepEqual(Object.keys(c.define),['PROBE_DEADLINE']);assert.ok(/^\d{13}$/.test(c.define.PROBE_DEADLINE));
 const allowed=new Set(['name','account_id','main','compatibility_date','routes','workers_dev','preview_urls','observability','define','secrets']);for(const key of Object.keys(c))assert.ok(allowed.has(key),'unexpected_resource');
}
export async function inventory(){
 const token=/^oauth_token\s*=\s*"([^"]+)"/m.exec(await readFile(join(homedir(),'.wrangler/config/default.toml'),'utf8'))?.[1];assert.ok(token,'cloud_auth_unavailable');
 const base='https://api.cloudflare.com/client/v4/accounts/ed6c2f7b12e4f0659cf8b70077fa649b';const result={};
 await Promise.all(Object.entries({workers:'/workers/scripts',domains:'/workers/domains',durableObjects:'/workers/durable_objects/namespaces',subdomain:'/workers/subdomain'}).map(async([kind,path])=>{const r=await fetch(base+path,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});const d=await r.json();assert.ok(r.ok&&d.success,'cloud_inventory_failed');result[kind]=d.result;}));return result;
}
export function compareIsolation(before,after){
 const changed=before.workers.filter(w=>{const a=after.workers.find(x=>x.id===w.id);return !a||a.etag!==w.etag||a.modified_on!==w.modified_on}).map(w=>w.id);
 const canonical=a=>JSON.stringify([...a].sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y))));
 const report={at:new Date().toISOString(),existingWorkersCompared:before.workers.length,existingWorkerChanges:changed,newWorkers:after.workers.filter(w=>!before.workers.some(x=>x.id===w.id)).map(w=>w.id),domainsUnchanged:canonical(before.domains)===canonical(after.domains),subdomainUnchanged:JSON.stringify(before.subdomain)===JSON.stringify(after.subdomain),durableObjectsUnchanged:canonical(before.durableObjects)===canonical(after.durableObjects)};
 assert.deepEqual(changed,[]);assert.deepEqual(report.newWorkers,[NAME]);assert.ok(report.domainsUnchanged&&report.subdomainUnchanged&&report.durableObjectsUnchanged,'unrelated_resources_changed');return report;
}
export async function prepare(){
 const c=JSON.parse(await readFile(CONFIG,'utf8'));assertConfig(c);const deadline=Number(c.define.PROBE_DEADLINE);assert.ok(deadline>Date.now()+120000&&deadline<Date.now()+7200000,'invalid_probe_deadline');
 let secrets;try{secrets=JSON.parse(await readFile(SECRET_FILE,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;secrets={PROBE_KEY:randomBytes(32).toString('base64url')};await writeFile(SECRET_FILE,JSON.stringify(secrets,null,2),{flag:'wx',mode:0o600});}assert.deepEqual(Object.keys(secrets),['PROBE_KEY']);assert.match(secrets.PROBE_KEY,/^[A-Za-z0-9_-]{43}$/);
 const values=[secrets.PROBE_KEY];for(const file of ['.env.worker-flareapi.json','.env.worker-flareapi.legacy.json','.env.worker-webshare-app.json']){const v=JSON.parse(await readFile(file,'utf8'));for(const x of Object.values(v))if(typeof x==='string'&&x.length)values.push(x);if(v.PROXY_CONFIG){const p=JSON.parse(v.PROXY_CONFIG);values.push(p.username,p.password);}}for(const p of JSON.parse(await readFile('.env.webshare.json','utf8')))values.push(p.username,p.password);
 const files=['experiments/webshare-latency-worker.ts','src/runtime/worker/webshare-latency.ts','src/webshare/api.ts',CONFIG];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())await walk(p);else files.push(p)}}await walk('output/flareapi/latency-dist');for(const file of files){const b=await readFile(file);assert.ok(!values.some(v=>v&&b.includes(Buffer.from(v))),'secret_in_artifact')}
 const report={at:new Date().toISOString(),target:NAME,files:files.length,secretValueMatches:0,requiredSecrets:['PROBE_KEY'],proxyCredentialsUploaded:false,deadline};await writeFile('output/flareapi/latency-audit.json',JSON.stringify(report,null,2));return report;
}
async function run(args){const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args,'--config',CONFIG],{windowsHide:true,stdio:'inherit'});assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)}),0,'isolated_deployment_failed');}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/deploy-latency-test.mjs')){
 try{assert.ok(process.argv.slice(2).every(x=>x==='--deploy'),'invalid_command');await mkdir('output/flareapi',{recursive:true});console.log(JSON.stringify(await prepare()));if(process.argv.includes('--deploy')){const before=await inventory();assert.ok(!before.workers.some(w=>w.id===NAME),'target_already_exists_no_overwrite');await writeFile('output/flareapi/latency-before.json',JSON.stringify(before,null,2));await run(['secret','bulk',SECRET_FILE]);await run(['deploy']);const report=compareIsolation(before,await inventory());await writeFile('output/flareapi/latency-isolation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}}
 catch(error){console.error(error.code??error.message??'latency_prepare_failed');process.exitCode=1;}
}