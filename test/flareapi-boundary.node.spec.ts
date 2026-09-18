import {describe,it,expect,vi}from'vitest';
import {handleGatewayRequest}from'../src/gateway';
const origin='https://flareapi.12213443th.workers.dev';
const config={ADMIN_API_KEY:'fixture-admin',GATEWAY_API_KEY:'',TOKEN_ENCRYPTION_KEY:'fixture-private-runtime-key',PUBLIC_ORIGIN:origin,WORKER_ORIGIN:origin};
describe('single-password gateway control boundary',()=>{
 it('stream cancellation forwards private lease cleanup and hides its header from clients',async()=>{
  let streamCancelled=false;
  const cancelLease=vi.fn(async()=>{});
  const response=await handleGatewayRequest(new Request(origin+'/v1/responses',{method:'POST',headers:{Authorization:'Bearer fixture-client','Content-Type':'application/json'},body:'{}'}),config,{
   accountFetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: fixture\n\n'));},cancel(){streamCancelled=true;}}),{headers:{'Content-Type':'text/event-stream','X-OneAPI-Internal-Lease':'fixture-private-lease'}}),
   staticFetch:async()=>new Response(null,{status:404}),cancelLease,allowInternalControl:false
  });
  expect(response.status).toBe(200);expect(response.headers.has('X-OneAPI-Internal-Lease')).toBe(false);
  const reader=response.body!.getReader();await reader.read();await reader.cancel();await new Promise(r=>setImmediate(r));
  expect(streamCancelled).toBe(true);expect(cancelLease).toHaveBeenCalledExactlyOnceWith('fixture-private-lease');
 });
 it('login password cannot forge the private bridge or internal control host',async()=>{
  const accountFetch=vi.fn(async(request:Request)=>{expect(request.headers.has('X-OneAPI-Local-Bridge-Token')).toBe(false);expect(request.headers.has('X-OneAPI-Local-Request-Group')).toBe(false);return new Response('fixture');});
  const handlers={accountFetch,staticFetch:async()=>new Response(null,{status:404}),allowInternalControl:false};
  await handleGatewayRequest(new Request(origin+'/v1/models',{headers:{'X-OneAPI-Local-Bridge-Token':config.ADMIN_API_KEY,'X-OneAPI-Local-Request-Group':'fixture-group'}}),config,handlers);
  expect(accountFetch).toHaveBeenCalledTimes(1);
  const reject=await handleGatewayRequest(new Request('https://oneapi.internal/__internal/request-groups/open',{method:'POST',headers:{Authorization:'Bearer '+config.ADMIN_API_KEY}}),config,handlers);
  expect(reject.status).toBe(403);expect(accountFetch).toHaveBeenCalledTimes(1);
 });
});