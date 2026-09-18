import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {decryptJson,createModelsRequest} from '../output/webshare-marker/helpers.mjs';
import {readServerConfig} from '../dist/server/oneapi.mjs';
import {validatePreflightStatus} from './probe-local-marker.mjs';
import {modelRequestText} from '../experiments/webshare-probe-core.mjs';
const origin='https://oneapi-webshare-test.12213443th.workers.dev';
const result={at:new Date().toISOString(),origin,preflight:null,cloudResponse:null,credentialUnchanged:null,modelPairInvocations:0,generationRequests:0,refreshRequests:0,automaticRetries:0,error:null};
let db;let before;
const fingerprint=value=>createHash('sha256').update(value).digest('hex');
try {
 const cloudConfig=JSON.parse(await readFile('wrangler.webshare-test.jsonc','utf8'));
 assert.equal(cloudConfig.name,'oneapi-webshare-test');assert.deepEqual(cloudConfig.routes,[]);
 const deadline=Number(cloudConfig.vars?.MODEL_PROBE_DEADLINE);
 if(!cloudConfig.vars?.MODEL_RUN_ID||deadline<Date.now()+60000||deadline>Date.now()+30*60000)throw new Error('cloud_model_gate_not_ready');
 const resolved=readServerConfig(process.env,resolve('.'),['--host','127.0.0.1','--port','8787']);
 db=new DatabaseSync(resolved.databasePath,{readOnly:true});db.exec('PRAGMA query_only = ON');
 const row=db.prepare('SELECT value FROM oneapi_kv WHERE key = ?').get('credentials');
 if(!row||db.prepare('SELECT value FROM oneapi_kv WHERE key = ?').get('reauth-required'))throw new Error('account_not_ready');
 before=fingerprint(row.value);
 const c=await decryptJson(JSON.parse(row.value),resolved.config.TOKEN_ENCRYPTION_KEY,'oneapi:credentials:v1');
 validatePreflightStatus({connected:true,reauthenticationRequired:false,account:{tokenExpiresAt:c.expiresAt,lastRefreshAt:c.lastRefreshAt}});
 result.preflight={ready:true};
 const request=createModelsRequest(c);
 assert.equal(request.url,'https://chatgpt.com/backend-api/codex/models?client_version=0.153.4');assert.equal(request.method,'GET');
 const auth={authorization:request.headers.get('authorization'),accountId:request.headers.get('chatgpt-account-id')};
 const raw=modelRequestText({...auth,marker:false});
 const rawHeaders=new Headers(raw.split('\r\n').slice(1).filter(Boolean).map(line=>{const colon=line.indexOf(':');return [line.slice(0,colon),line.slice(colon+1).trim()];}));
 for(const [name,value] of request.headers)assert.equal(rawHeaders.get(name),value);
 assert.equal(rawHeaders.has('cf-worker'),false);
 const files=['experiments/webshare-worker.mjs','experiments/webshare-probe-core.mjs','experiments/webshare-tls-transport.mjs','wrangler.webshare-test.jsonc'];
 async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(p);}}await walk('dist/webshare-test');
 for(const file of files){const b=await readFile(file);for(const secret of [c.accessToken,c.refreshToken,auth.accountId,resolved.config.TOKEN_ENCRYPTION_KEY,resolved.config.ADMIN_API_KEY])if(typeof secret==='string'&&secret.length>8&&b.includes(Buffer.from(secret)))throw new Error('account_secret_in_artifact');}
 const gate=JSON.parse(await readFile('.env.worker-webshare.json','utf8'));
 const payload={operation:'models-pair',runId:cloudConfig.vars.MODEL_RUN_ID,...auth};
 // One invocation, two bounded fixed GETs on the Worker; never persist payload.
 result.modelPairInvocations=1;
 const response=await fetch(origin+'/probe',{method:'POST',headers:{Authorization:'Bearer '+gate.PROBE_KEY,'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(50000)});
 const text=await response.text();if(text.length>16384)throw new Error('cloud_response_too_large');
 const cloud=JSON.parse(text);
 const encoded=JSON.stringify(cloud);
 for(const secret of [c.accessToken,c.refreshToken,auth.accountId,resolved.config.TOKEN_ENCRYPTION_KEY])if(typeof secret==='string'&&secret.length>8&&encoded.includes(secret))throw new Error('cloud_result_contains_secret');
 result.cloudResponse={status:response.status,result:cloud};
} catch(error) {
 const allowed=['cloud_model_gate_not_ready','account_not_ready','account_secret_in_artifact','cloud_response_too_large','cloud_result_contains_secret','refresh_window_too_close','model_auth_invalid'];
 result.error=allowed.includes(error?.message)?error.message:error?.name==='TimeoutError'?'cloud_probe_timeout':'local_probe_failed';
} finally {
 if(db){try{const after=db.prepare('SELECT value FROM oneapi_kv WHERE key = ?').get('credentials');result.credentialUnchanged=!!after&&fingerprint(after.value)===before;}catch{result.credentialUnchanged=false;}db.close();}
 await writeFile('output/worker-webshare/models-pair-result.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}
