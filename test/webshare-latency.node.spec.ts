import {describe,it,expect,vi,afterEach}from'vitest';
import {measureProxyTcp}from'../src/runtime/worker/webshare-latency';
import {WebshareSettings}from'../src/webshare/settings';
import type{AccountStorage}from'../src/runtime/contracts';
const proxy={host:'9.142.39.218',port:7388,id:'one',username:'secret-user',password:'secret-password',valid:true,countryCode:'US'};
afterEach(()=>vi.useRealTimers());
describe('Worker to Webshare TCP measurement',()=>{
 it('measures three fresh sockets and median, sends no authentication/application data, closes all sockets',async()=>{
  let clock=100;const closes=Array.from({length:3},()=>vi.fn(async()=>{}));const times=[90,20,40];let i=0;
  const connect=vi.fn((address,options)=>{expect(address).toEqual({hostname:proxy.host,port:proxy.port});expect(options).toEqual({secureTransport:'off',allowHalfOpen:false});const index=i++;return{opened:Promise.resolve().then(()=>{clock+=times[index]}),closed:Promise.resolve(),close:closes[index]}});
  const result=await measureProxyTcp(proxy,connect,()=>clock);
  expect(result.medianMs).toBe(40);expect(result.successCount).toBe(3);expect(result.samples.map(s=>s.latencyMs)).toEqual([90,20,40]);closes.forEach(close=>expect(close).toHaveBeenCalledTimes(1));expect(JSON.stringify(result)).not.toContain(proxy.password);
 });
 it('errors are redacted and partial successes have correct median',async()=>{
  let clock=0;let i=0;const close=vi.fn(async()=>{});
  const result=await measureProxyTcp(proxy,()=>{const index=i++;return{opened:index===1?Promise.reject(new Error(proxy.password)):Promise.resolve().then(()=>{clock+=index===0?10:20}),closed:Promise.resolve(),close}},()=>clock);
  expect(result.successCount).toBe(2);expect(result.medianMs).toBe(15);expect(result.samples[1]).toEqual({latencyMs:null,error:'connect_failed'});expect(close).toHaveBeenCalledTimes(3);expect(JSON.stringify(result)).not.toContain(proxy.password);
 });
 it('timeouts close each stalled socket and return no latency',async()=>{
  vi.useFakeTimers();const close=vi.fn(async()=>{});const resultPromise=measureProxyTcp(proxy,()=>({opened:new Promise(()=>{}),closed:Promise.resolve(),close}));await vi.advanceTimersByTimeAsync(9000);const result=await resultPromise;expect(result.successCount).toBe(0);expect(result.medianMs).toBeNull();expect(result.samples.every(s=>s.error==='timeout')).toBe(true);expect(close).toHaveBeenCalledTimes(3);
 });
 it('private or invalid destinations never connect',async()=>{const connect=vi.fn();await expect(measureProxyTcp({...proxy,host:'127.0.0.1'},connect)).rejects.toMatchObject({code:'invalid_webshare_response'});expect(connect).not.toHaveBeenCalled();});
 it('measuring a listed node does not write settings or enable/change the current node; guards and cooldown hold',async()=>{
  const values=new Map<string,unknown>();const storage={async get(k:string){return values.get(k)},async put(k:string,v:unknown){values.set(k,v)}}as unknown as AccountStorage;
  const measureProxy=vi.fn(async()=>({kind:'tcp-connect' as const,source:'account-do' as const,samples:[{latencyMs:12,error:null}],successCount:1,medianMs:12}));
  const service=new WebshareSettings(storage,Buffer.alloc(32,9).toString('base64'),{bootstrap:null,requireProxy:true,measureProxy,apiFetch:async()=>Response.json({count:1,next:null,results:[{id:proxy.id,proxy_address:proxy.host,port:proxy.port,username:proxy.username,password:proxy.password,valid:true,country_code:'US'}]}),proxyFetch:async()=>new Response(null,{status:401}),directFetch:async()=>new Response('direct')});
  const call=(path:string,body:unknown)=>service.handle(new Request('https://fixture.workers.dev/admin/webshare'+path,{method:path===''?'PATCH':'POST',body:JSON.stringify(body)}));
  await expect(call('/measure',{nodeId:'one'})).rejects.toMatchObject({code:'invalid_webshare_node'});
  await call('',{apiKey:'fixture_webshare_key_123456'});await call('/sync',{});await call('/apply',{nodeId:'one'});const before=JSON.stringify([...values]);
  await expect(call('/measure',{nodeId:'one',host:'127.0.0.1'})).rejects.toMatchObject({code:'invalid_request'});
  const result=await(await call('/measure',{nodeId:'one'}))!.json() as {medianMs:number};expect(result.medianMs).toBe(12);expect(JSON.stringify([...values])).toBe(before);expect(measureProxy).toHaveBeenCalledTimes(1);
  await expect(call('/measure',{nodeId:'one'})).rejects.toMatchObject({code:'webshare_measure_rate_limited'});
 });
});