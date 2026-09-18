import { describe,it,expect,vi } from 'vitest';
import { WebshareSettings } from '../src/webshare/settings';
import type {AccountStorage}from'../src/runtime/contracts';
type PublicState = { activeSource: string; activeNode: unknown | null; nodes: unknown[] };
const key=Buffer.alloc(32,23).toString('base64');
function fixture(){const values=new Map<string,unknown>();const storage={async get(k:string){return values.get(k)},async put(k:string,v:unknown){values.set(k,v)}} as unknown as AccountStorage;
 const apiFetch=vi.fn(async()=>Response.json({count:1,next:null,results:[{id:'chosen',proxy_address:'9.142.39.218',port:7388,username:'fixture-user',password:'fixture-pass',country_code:'US',valid:true}]}));
 const proxyFetch=vi.fn(async()=>new Response(null,{status:401})),directFetch=vi.fn(async()=>new Response('direct'));
 const service=new WebshareSettings(storage,key,{bootstrap:null,requireProxy:true,apiFetch,proxyFetch,directFetch});
 const call=(path='/admin/webshare',method='GET',body?:unknown)=>service.handle(new Request('https://fixture.workers.dev'+path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return {storage,service,call,proxyFetch,directFetch};
}
describe('FlareAPI user-selected exit only',()=>{
 it('no default, saving/syncing do not enable a node; apply enables, restart preserves, close blocks outbound',async()=>{
  const f=fixture();let state=await (await f.call())!.json() as PublicState;expect(state.activeSource).toBe('none');expect(state.activeNode).toBeNull();
  const outbound=new Request('https://chatgpt.com/backend-api/codex/models');
  await expect(f.service.outboundFetch(outbound)).rejects.toMatchObject({code:'webshare_proxy_required'});
  await f.call('/admin/webshare','PATCH',{apiKey:'fixture_webshare_key_123456'});await f.call('/admin/webshare/sync','POST',{});
  state=await (await f.call())!.json() as PublicState;expect(state.nodes).toHaveLength(1);expect(state.activeNode).toBeNull();
  await expect(f.service.outboundFetch(outbound)).rejects.toMatchObject({code:'webshare_proxy_required'});expect(f.proxyFetch).not.toHaveBeenCalled();
  await f.call('/admin/webshare/apply','POST',{nodeId:'chosen'});await f.service.outboundFetch(outbound);expect(f.proxyFetch).toHaveBeenCalledTimes(2);
  const reopened=new WebshareSettings(f.storage,key,{bootstrap:null,requireProxy:true,proxyFetch:f.proxyFetch,directFetch:f.directFetch});await reopened.outboundFetch(outbound);expect(f.proxyFetch).toHaveBeenCalledTimes(3);
  await f.call('/admin/webshare/apply','POST',{nodeId:null});await expect(f.service.outboundFetch(outbound)).rejects.toMatchObject({code:'webshare_proxy_required'});expect(f.directFetch).not.toHaveBeenCalled();
 });
 it('failed connectivity test never activates a node',async()=>{const f=fixture();await f.call('/admin/webshare','PATCH',{apiKey:'fixture_webshare_key_123456'});await f.call('/admin/webshare/sync','POST',{});f.proxyFetch.mockResolvedValueOnce(new Response(null,{status:403}));await expect(f.call('/admin/webshare/apply','POST',{nodeId:'chosen'})).rejects.toMatchObject({code:'webshare_proxy_test_failed'});expect((await (await f.call())!.json() as PublicState).activeNode).toBeNull();});
});