import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebshareFetch, ByteReader, readHead, bodyStream, validateTarget } from '../experiments/webshare-fetch.mjs';
const e = new TextEncoder();
const proxy = { host:'138.226.61.165', port:6338, username:'proxy-user',password:'proxy-password' };
function fixture(response, { verified=true, pending=false }={}) {
 const rawWrites=[], appWrites=[]; let dialed=0, closed=0, server;
 const connect = () => {
   dialed++;
   return { opened:pending?new Promise(()=>{}):Promise.resolve(), closed:Promise.resolve(),
     readable:new ReadableStream({start(c){c.enqueue(e.encode('HTTP/1.1 200 Connection established\r\n\r\n'));}}),
     writable:new WritableStream({write(x){rawWrites.push(new TextDecoder().decode(x));}}),
     async close(){closed++;}
   };
 };
 const upgrade = (_socket,_host,report) => {
   report.tlsHandshakeVerified=verified;
   return {opened:Promise.resolve(),readable:new ReadableStream({start(c){server=c;if(response)c.enqueue(e.encode(response));}}),
     writable:new WritableStream({write(x){appWrites.push(new TextDecoder().decode(x));}}),async close(){closed++;try{server.close();}catch{}}};
 };
 return {fetch:createWebshareFetch({proxy,connect,upgrade}),rawWrites,appWrites,get dialed(){return dialed;},get closed(){return closed;}, send(value){server.enqueue(e.encode(value));},end(){server.close();}};
}
const url='https://chatgpt.com/backend-api/codex/models?client_version=0.153.4';
test('fixed target allowlist rejects arbitrary hosts, methods, queries and credentials before dialing',async()=>{
 const f=fixture('');
 for(const request of [new Request('https://example.com'),new Request(url,{method:'POST'}),new Request(url+'&extra=x'),new Request('https://chatgpt.com/backend-api/codex/responses?x=y',{method:'POST'})])await assert.rejects(f.fetch(request));
 assert.equal(f.dialed,0);
 assert.equal(validateTarget(new Request('https://auth.openai.com/oauth/token',{method:'POST'})).hostname,'auth.openai.com');
});
test('CONNECT contains only proxy credentials; only verified TLS carries account headers and strips CF provenance',async()=>{
 const f=fixture('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: application/json\r\n\r\n{}');
 const r=await f.fetch(new Request(url,{headers:{Authorization:'Bearer account-secret','ChatGPT-Account-ID':'account-id','CF-Worker':'worker.example','Forwarded':'for=secret'}}));
 assert.equal(await r.text(),'{}');
 assert.match(f.rawWrites.join(''),/Proxy-Authorization: Basic/);assert.doesNotMatch(f.rawWrites.join(''),/account-secret|account-id/);
 assert.match(f.appWrites.join(''),/authorization: Bearer account-secret/);assert.doesNotMatch(f.appWrites.join(''),/cf-worker|forwarded|Proxy-Authorization/i);
 const no=fixture('',{verified:false});await assert.rejects(no.fetch(new Request(url,{headers:{Authorization:'Bearer secret'}})));assert.equal(no.appWrites.length,0);assert.ok(no.closed);
});
test('POST body framing is byte correct for unicode, no request retries or redirects',async()=>{
 const f=fixture('HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: https://untrusted.example/\r\n\r\n');
 const body='你好';const r=await f.fetch(new Request('https://auth.openai.com/oauth/token',{method:'POST',body,headers:{'Content-Type':'application/x-www-form-urlencoded'}}));
 assert.equal(r.status,302);await r.text();assert.match(f.appWrites[0],/Content-Length: 6\r\n/);assert.equal(f.appWrites[1],body);assert.equal(f.dialed,1);
});
test('streaming delivers a UTF-8 event before the upstream completes, cancellation closes only its own connection',async()=>{
 const first='data: 你好\n\n', bytes=e.encode(first);
 const f=fixture('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/event-stream\r\n\r\n'+bytes.length.toString(16)+'\r\n'+first+'\r\n');
 const other=fixture('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}');
 const r=await f.fetch(new Request('https://chatgpt.com/backend-api/codex/responses',{method:'POST',body:'{}'}));
 const concurrent=await other.fetch(new Request(url));
 const reader=r.body.getReader();const value=await reader.read();assert.equal(new TextDecoder().decode(value.value),first);assert.equal(f.closed,0);
 await reader.cancel();assert.ok(f.closed);assert.equal(await concurrent.text(),'{}');
});
test('abort while opening and while reading body closes bounded request, without retries',async()=>{
 const c=new AbortController(), f=fixture('',{pending:true});
 const p=f.fetch(new Request(url,{signal:c.signal}));await new Promise(r=>setImmediate(r));c.abort();await assert.rejects(p);assert.equal(f.dialed,1);assert.ok(f.closed);
 const c2=new AbortController(), f2=fixture('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n');
 const r=await f2.fetch(new Request(url,{signal:c2.signal}));const read=r.text();c2.abort();await assert.rejects(read);assert.ok(f2.closed);
});
test('truncated and ambiguous HTTP framing fail closed; trailer and split CRLF parsing is byte based',async()=>{
 for(const raw of ['HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\nx','HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\nx']){const f=fixture(raw);await assert.rejects(f.fetch(new Request(url)));}
 const f=fixture('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nx');const r=await f.fetch(new Request(url));const p=r.text();f.end();await assert.rejects(p);
 const split=new ReadableStream({start(c){for(const b of e.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nX-Trace: ok\r\n\r\n'))c.enqueue(new Uint8Array([b]));c.close();}});
 const bytes=new ByteReader(split.getReader(),undefined,1000);const head=await readHead(bytes);let done=false;
 const text=await new Response(bodyStream(bytes,head,()=>{done=true;},undefined,1000)).text();assert.equal(text,'abc');assert.ok(done);
});
test('body producer is not eagerly drained before the consumer pulls',async()=>{
 let reads=0;const chunks=[e.encode('abc'),e.encode('def')];
 const byteReader=new ByteReader({async read(){reads++;return chunks.length?{value:chunks.shift(),done:false}:{done:true};}},undefined,1000);
 const stream=bodyStream(byteReader,{length:6,chunked:false},()=>{},undefined,1000);await new Promise(r=>setImmediate(r));assert.equal(reads,0);
 const reader=stream.getReader();await reader.read();assert.equal(reads,1);await reader.cancel();
});
