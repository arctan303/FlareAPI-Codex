import assert from 'node:assert/strict';
import {readFile,writeFile,readdir}from'node:fs/promises';
import {createHash}from'node:crypto';
export const ORIGIN='https://flareapi.12213443th.workers.dev';
export const CONFIG='wrangler.flareapi.jsonc';
export const SECRET_FILE='.env.worker-flareapi.json';
export function assertAppConfig(c){
 assert.equal(c.name,'flareapi');assert.equal(c.account_id,'ed6c2f7b12e4f0659cf8b70077fa649b');assert.equal(c.main,'experiments/flareapi-worker.ts');
 assert.deepEqual(c.routes,[]);assert.equal(c.workers_dev,true);assert.equal(c.preview_urls,false);assert.deepEqual(c.observability,{enabled:false});
 assert.equal(c.compatibility_date,'2026-09-06');assert.deepEqual(c.compatibility_flags,['nodejs_compat']);
 assert.deepEqual(c.assets,{directory:'./public',binding:'ASSETS',run_worker_first:true});
 assert.deepEqual(c.durable_objects,{bindings:[{name:'ACCOUNT',class_name:'WebshareAccount'}]});
 assert.deepEqual(c.migrations,[{tag:'webshare-v1',new_sqlite_classes:['WebshareAccount']}]);
 assert.deepEqual(c.define,{FLAREAPI_ORIGIN:JSON.stringify(ORIGIN)});
 assert.deepEqual(c.secrets,{required:['ADMIN_API_KEY']});
 const allowed=new Set(['$schema','name','account_id','main','routes','workers_dev','preview_urls','observability','compatibility_date','compatibility_flags','assets','durable_objects','migrations','define','secrets']);
 for(const key of Object.keys(c))assert.ok(allowed.has(key),'unexpected_resource_or_variable');
}
export async function prepare(){
 assertAppConfig(JSON.parse(await readFile(CONFIG,'utf8')));
 const secrets=JSON.parse(await readFile(SECRET_FILE,'utf8'));assert.deepEqual(Object.keys(secrets),['ADMIN_API_KEY']);assert.ok(typeof secrets.ADMIN_API_KEY==='string'&&secrets.ADMIN_API_KEY.length>=16);
 const tls=await readFile('output/worker-webshare/tls-runtime/node_modules/@reclaimprotocol/tls/lib/make-tls-client.js');
 assert.equal(createHash('sha256').update(tls).digest('hex'),'accf51dd31b5c5783cfdfd2ebfc44ea1438896897078dc7e58b6b27a997ca405');
 const values=[secrets.ADMIN_API_KEY];
 try{const legacy=JSON.parse(await readFile('.env.worker-flareapi.legacy.json','utf8'));for(const value of Object.values(legacy))if(typeof value==='string'&&value.length)values.push(value);const proxy=JSON.parse(legacy.PROXY_CONFIG??'null');if(proxy)values.push(proxy.username,proxy.password);}catch(error){if(error.code!=='ENOENT')throw error;}
 const files=['experiments/flareapi-worker.ts','experiments/webshare-fetch.mjs','experiments/webshare-tls-transport.mjs',CONFIG,'public/index.html','public/styles.css','public/app.js','src/runtime/worker/flareapi-key.ts','src/runtime/worker/webshare-latency.ts','src/webshare/settings.ts'];
 async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())await walk(p);else files.push(p);}}
 await walk('output/flareapi/single-dist');
 for(const file of files){const b=await readFile(file);if(values.some(v=>b.includes(Buffer.from(v))))throw new Error('secret_in_artifact');}
 const report={at:new Date().toISOString(),localOnly:true,requiredSecrets:['ADMIN_API_KEY'],runtimeVars:0,files:files.length,secretValueMatches:0,tlsPatchVerified:true};
 await writeFile('output/flareapi/single-audit.json',JSON.stringify(report,null,2));return report;
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/deploy-flareapi.mjs')){
 try{if(process.argv.slice(2).length)throw new Error('deployment_disabled_for_local_only_task');console.log(JSON.stringify(await prepare()));}
 catch(error){console.error(error.message==='deployment_disabled_for_local_only_task'?error.message:'flareapi_local_prepare_failed');process.exitCode=1;}
}