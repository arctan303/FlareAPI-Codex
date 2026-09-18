import assert from 'node:assert/strict';
import test from 'node:test';
import { handleProbe, modelRequestText, parseHttpResponse, runModelsPair, runProbe } from '../experiments/webshare-probe-core.mjs';
const enc=new TextEncoder();
const proxy={host:'138.226.61.165',port:6338,username:'TEST_PROXY_USER',password:'TEST_PROXY_PASSWORD'};
const account={authorization:'Bearer TEST_ACCOUNT_ACCESS_TOKEN_12345',accountId:'12345678-1234-1234-1234-123456789abc'};
const body={operation:'models-pair',runId:'test-run',...account};
function fixture(statuses=[200,403], verified=true){
 const state={calls:0,writes:[],targets:[]};
 const writer=()=>new WritableStream({write(b){state.writes.push(new TextDecoder().decode(b));}});
 const stream=text=>new ReadableStream({start(c){c.enqueue(enc.encode(text));c.close();}});
 const connect=()=>({opened:Promise.resolve(),closed:Promise.resolve(),writable:writer(),readable:stream('HTTP/1.1 200 Connection established\r\n\r\n'),async close(){}});
 const upgrade=(socket,target,report)=>{state.targets.push(target);const status=statuses[state.calls++]??200;const b=status===200?'{"models":[]}':'<html>denied</html>';if(verified)report.tlsHandshakeVerified=true;
 return {opened:Promise.resolve(),closed:Promise.resolve(),writable:writer(),readable:stream('HTTP/1.1 '+status+' Result\r\nContent-Type: '+(status===200?'application/json':'text/html')+'\r\nContent-Length: '+b.length+'\r\n\r\n'+b),async close(){}};};
 return {state,connect,upgrade};
}
test('fixed model headers match and only CF-Worker changes between requests',()=>{
 const baseline=modelRequestText({...account,marker:false});const marker=modelRequestText({...account,marker:true});
 assert.equal(marker.replace('CF-Worker: oneapi.12213443th.workers.dev\r\n',''),baseline);
 assert.match(baseline,/^GET \/backend-api\/codex\/models\?client_version=0\.153\.4 HTTP\/1\.1/);
 assert.equal(/Proxy-Authorization|CF-Worker|CF-Connecting-IP/i.test(baseline),false);
 for(const invalid of [{...account,authorization:account.authorization+'\r\nHost: evil.invalid',marker:false},{...account,accountId:'evil\r\n',marker:false}])assert.throws(()=>modelRequestText(invalid),/model_auth_invalid/);
});
test('pair uses two separate verified tunnels, redacts credentials and performs no other request',async()=>{
 const f=fixture();const result=await runModelsPair(f.connect,proxy,body,f.upgrade);
 assert.equal(result.withoutMarker.httpStatus,200);assert.equal(result.withoutMarker.jsonValid,true);assert.equal(result.withMarker.httpStatus,403);
 assert.equal(result.modelRequestAttempts,2);assert.equal(result.modelRequestWritesCompleted,2);assert.equal(result.generationRequests,0);assert.equal(result.refreshRequests,0);assert.equal(result.automaticRetries,0);
 assert.deepEqual(f.state.targets,['chatgpt.com','chatgpt.com']);assert.equal(f.state.writes.length,4);
 for(const i of [0,2]){assert.match(f.state.writes[i],/^CONNECT chatgpt.com:443/);assert.equal(f.state.writes[i].includes(account.authorization),false);assert.equal(f.state.writes[i].includes(account.accountId),false);}
 assert.equal(f.state.writes[1].includes('CF-Worker:'),false);assert.equal(f.state.writes[3].includes('CF-Worker:'),true);
 for(const secret of [account.authorization,account.accountId,proxy.password,proxy.username])assert.equal(JSON.stringify(result).includes(secret),false);
});
test('401, redirect or failed TLS stops pair; no redirect followed and no account sent before verified handshake',async()=>{
 for(const status of [401,302]){const f=fixture([status,200]);const r=await runModelsPair(f.connect,proxy,body,f.upgrade);assert.equal(r.modelRequestAttempts,1);assert.equal(r.withMarker,null);assert.equal(f.state.calls,1);}
 const f=fixture([200],false);const r=await runModelsPair(f.connect,proxy,body,f.upgrade);assert.equal(r.modelRequestAttempts,0);assert.equal(r.withMarker,null);assert.equal(f.state.writes.length,1);assert.equal(r.withoutMarker.error,'verified_tls_required');
 await assert.rejects(runProbe(f.connect,proxy,'models',1000,undefined,{...account,marker:false}),/verified_tls_required/);
});
test('model run nonce, expiry, body fields and admin key are validated before dialing; replay rejected within isolate',async()=>{
 const env={PROBE_KEY:'key',PROXY_CONFIG:JSON.stringify(proxy),MODEL_RUN_ID:'test-run',MODEL_PROBE_DEADLINE:String(Date.now()+600000)};
 const request=b=>new Request('https://probe/probe',{method:'POST',headers:{Authorization:'Bearer key'},body:JSON.stringify(b)});
 let calls=0;const forbidden=()=>{calls++;throw new Error('should_not_dial');};
 for(const [e,b] of [[env,{...body,runId:'other'}],[{...env,MODEL_PROBE_DEADLINE:'NaN'},body],[{...env,MODEL_PROBE_DEADLINE:String(Date.now()-1)},body],[{...env,MODEL_PROBE_DEADLINE:String(Date.now()+3600000)},body],[env,{...body,url:'https://evil.invalid'}],[env,{...body,authorization:'bad'}]])assert.ok([400,503].includes((await handleProbe(request(b),e,forbidden,()=>{})).status));
 assert.equal(calls,0);
 const f=fixture();assert.equal((await handleProbe(request(body),env,f.connect,f.upgrade)).status,200);
 assert.equal((await handleProbe(request(body),env,forbidden,()=>{})).status,409);assert.equal(calls,0);
});
test('byte framing accepts UTF-8 chunk bodies and rejects missing terminator, duplicate lengths and ambiguous framing',()=>{
 const json=enc.encode('{"name":"模型"}');const a=enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'+json.length.toString(16)+'\r\n');const z=enc.encode('\r\n0\r\n\r\n');const all=new Uint8Array(a.length+json.length+z.length);all.set(a);all.set(json,a.length);all.set(z,a.length+json.length);
 assert.equal(parseHttpResponse(all).body,'{"name":"模型"}');assert.equal(parseHttpResponse(all).bodyData.length,json.length);
 for(const text of ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n','HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}','HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n0\r\n\r\n'])assert.throws(()=>parseHttpResponse(enc.encode(text)));
});
