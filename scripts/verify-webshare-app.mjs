import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import OpenAI from 'openai';
import {assertAppConfig,CONFIG,ORIGIN,SECRET_FILE} from './deploy-webshare-app.mjs';
assertAppConfig(JSON.parse(await readFile(CONFIG,'utf8')));
const secrets=JSON.parse(await readFile(SECRET_FILE,'utf8'));
const start=process.argv.includes('--start-login'),upstream=process.argv.includes('--upstream');
const admin={Authorization:'Bearer '+secrets.ADMIN_API_KEY,Origin:ORIGIN};
const report={at:new Date().toISOString(),origin:ORIGIN,generations:0,modelsRequests:0};let cookie,keyId;
const req=(path,init={})=>fetch(ORIGIN+path,{...init,redirect:'manual',signal:AbortSignal.timeout(20000)});
try{
 const health=await req('/health');assert.equal(health.status,200);report.health=await health.json();assert.equal(report.health.service,'oneapi-codex-gateway-demo');
 const page=await req('/admin/login');assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);await page.body.cancel();report.adminPage=true;
 assert.equal((await req('/admin/status')).status,401);report.anonymousDenied=true;
 const login=await req('/admin/session',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({password:secrets.ADMIN_API_KEY})});
 assert.equal(login.status,200);cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);report.adminLogin=true;
 const status=await req('/admin/status',{headers:{Cookie:cookie}});assert.equal(status.status,200);const data=await status.json();report.connected=data.connected;report.reauthenticationRequired=data.reauthenticationRequired;
 assert.equal((await req('/admin/api-keys',{method:'POST',headers:{Cookie:cookie,Origin:'https://foreign.example','Content-Type':'application/json'},body:'{}'})).status,403);report.csrfRejected=true;
 assert.equal((await req('/admin/account/import',{method:'POST',headers:{...admin,'Content-Type':'application/json'},body:'{}'})).status,404);report.oldAccountImportDisabled=true;
 if(start && !report.connected) {
  const device=await req('/admin/device/start',{method:'POST',headers:{...admin,'Content-Type':'application/json'},body:'{}'});
  report.deviceStartStatus=device.status;
  const value=await device.json();
  if(device.ok){assert.equal(value.status,'pending');assert.equal(new URL(value.verificationUrl).hostname,'auth.openai.com');await writeFile('output/worker-webshare/app-login.json',JSON.stringify(value,null,2));report.deviceLogin={status:value.status,verificationUrl:value.verificationUrl,userCode:value.userCode,expiresAt:value.expiresAt};}
  else{report.deviceError={code:value.error?.code??'device_start_failed'};process.exitCode=1;}
 }
 if(upstream) {
  assert.equal(report.connected,true);
  const created=await req('/admin/api-keys',{method:'POST',headers:{...admin,'Content-Type':'application/json'},body:JSON.stringify({name:'isolated-webshare-smoke',modelAccess:{mode:'allowlist',models:['gpt-5.5']}})});
  assert.equal(created.status,201);const value=await created.json();keyId=value.id??value.apiKey?.id;const key=value.key??value.apiKey?.key;assert.ok(keyId&&key);
  assert.equal((await req('/admin/status',{headers:{Authorization:'Bearer '+key}})).status,401);report.apiKeyAdminDenied=true;
  report.modelsRequests++;const modelRes=await req('/v1/models',{headers:{Authorization:'Bearer '+key}});
  const models=await modelRes.json();report.models={status:modelRes.status,items:models.data?.map(m=>m.id),code:models.error?.code};
  assert.equal(modelRes.status,200);assert.ok(models.data.length);assert.ok(models.data.every(m=>m.id==='gpt-5.5'));
  const client=new OpenAI({apiKey:key,baseURL:ORIGIN+'/v1',maxRetries:0,timeout:60000});
  report.generations++;
  const response=await client.responses.create({model:'gpt-5.5',input:'Reply only WORKER_OK',reasoning:{effort:'low'}});
  assert.equal(response.status,'completed');assert.ok(response.output_text);report.responses={completed:true,output:response.output_text,usage:response.usage};
  report.generations++;
  const stream=await client.chat.completions.create({model:'gpt-5.5',messages:[{role:'user',content:'Reply only WORKER_OK'}],reasoning_effort:'low',stream:true,stream_options:{include_usage:true}});
  let output='',usage,finish=false;for await(const chunk of stream){output+=chunk.choices?.[0]?.delta?.content??'';if(chunk.usage)usage=chunk.usage;if(chunk.choices?.[0]?.finish_reason)finish=true;}
  assert.ok(output&&finish);report.chat={completed:true,output,usage};
 }
}catch(e){report.failure={name:e.name,code:typeof e.code==='string'?e.code:undefined,status:e.status};process.exitCode=1;}
finally{
 if(keyId){try{report.tempKeyRemoved=(await req('/admin/api-keys/'+encodeURIComponent(keyId),{method:'DELETE',headers:{...admin,'Content-Type':'application/json'},body:'{}'})).ok;}catch{report.tempKeyRemoved=false;}if(!report.tempKeyRemoved)process.exitCode=1;}
 if(cookie){try{report.sessionRemoved=(await req('/admin/session',{method:'DELETE',headers:{Cookie:cookie,Origin:ORIGIN,'Content-Type':'application/json'},body:'{}'})).ok;}catch{report.sessionRemoved=false;}if(!report.sessionRemoved)process.exitCode=1;}
 report.finishedAt=new Date().toISOString();await writeFile('output/worker-webshare/app-live-'+(upstream?'upstream':'admin')+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
