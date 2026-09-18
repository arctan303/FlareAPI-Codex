import {describe,it,expect,vi} from "vitest";
import {WebshareSettings} from "../src/webshare/settings";
import type {AccountStorage} from "../src/runtime/contracts";
const key="fixture_webshare_api_key_123456";
const bootstrap={id:"bootstrap",host:"138.226.61.165",port:6338,username:"bootstrap-user",password:"bootstrap-password",countryCode:"US",valid:true};
const node={id:"d-1",proxy_address:"9.142.39.218",port:7388,username:"node-user",password:"node-password",country_code:"US",valid:true};
function fixture(){
 const values=new Map<string,unknown>();const storage={async get(k:string){return values.get(k)},async put(k:string,v:unknown){values.set(k,v)}} as unknown as AccountStorage;
 const apiFetch=vi.fn(async()=>Response.json({count:1,next:null,results:[node]}));
 const proxyFetch=vi.fn(async()=>new Response(null,{status:401}));const directFetch=vi.fn(async()=>new Response("direct"));
 const service=new WebshareSettings(storage,Buffer.alloc(32,13).toString("base64"),{bootstrap,apiFetch,proxyFetch,directFetch});
 const call=(path="/admin/webshare",method="GET",body?:unknown)=>service.handle(new Request("https://fixture.workers.dev"+path,{method,...(body===undefined?{}:{body:JSON.stringify(body),headers:{"Content-Type":"application/json"}})}));
 const state=async()=> (await call())!.json() as Promise<{activeSource:string;activeNode:{host:string}|null;apiKeyConfigured:boolean;nodes:unknown[];selectedNodeId:string|null}>;
 return {values,service,call,state,apiFetch,proxyFetch,directFetch,storage};
}
describe("encrypted Webshare fixed-node settings",()=>{
 it("preserves bootstrap, encrypts keys and proxy passwords, returns only public fields and survives a new service instance",async()=>{
  const f=fixture();expect((await f.state()).activeSource).toBe("bootstrap");
  await f.call("/admin/webshare","PATCH",{apiKey:key,planId:14320842});
  await f.call("/admin/webshare/sync","POST",{});
  const publicState=await f.state();expect(publicState.apiKeyConfigured).toBe(true);expect(publicState.nodes).toHaveLength(1);expect(publicState.activeNode!.host).toBe(bootstrap.host);
  const raw=JSON.stringify([...f.values]);const out=JSON.stringify(publicState);
  for(const secret of [key,node.password,node.username]){expect(raw).not.toContain(secret);expect(out).not.toContain(secret);}
  const reopened=new WebshareSettings(f.storage,Buffer.alloc(32,13).toString("base64"),{bootstrap,proxyFetch:f.proxyFetch,directFetch:f.directFetch});
  expect(await (await reopened.handle(new Request("https://fixture.workers.dev/admin/webshare")))!.json()).toEqual(publicState);
 });
 it("a validated selected node applies only after target HTTPS test, and outbound takes that snapshot",async()=>{
  const f=fixture();await f.call("/admin/webshare","PATCH",{apiKey:key});await f.call("/admin/webshare/sync","POST",{});
  await f.call("/admin/webshare/apply","POST",{nodeId:"d-1"});
  expect((await f.state()).activeSource).toBe("webshare");
  const [proxy,request]=f.proxyFetch.mock.calls[0] as unknown as [typeof bootstrap,Request];
  expect(proxy.host).toBe(node.proxy_address);expect(request.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.153.4");expect(request.headers.has("Authorization")).toBe(false);
  await f.service.outboundFetch(new Request("https://chatgpt.com/backend-api/wham/usage"));
  expect((f.proxyFetch.mock.calls[1] as unknown as [typeof bootstrap])[0].host).toBe(node.proxy_address);
 });
 it("failed sync keeps the full old list, removed nodes keep current active credentials; changing API key clears only the list",async()=>{
  const f=fixture();await f.call("/admin/webshare","PATCH",{apiKey:key});await f.call("/admin/webshare/sync","POST",{});await f.call("/admin/webshare/apply","POST",{nodeId:"d-1"});
  f.apiFetch.mockImplementationOnce(async()=>new Response(null,{status:401}));
  await expect(f.call("/admin/webshare/sync","POST",{})).rejects.toMatchObject({code:"webshare_api_key_rejected"});expect((await f.state()).nodes).toHaveLength(1);
  f.apiFetch.mockImplementationOnce(async()=>Response.json({count:0,next:null,results:[]}));
  await f.call("/admin/webshare/sync","POST",{});expect((await f.state()).activeNode!.host).toBe(node.proxy_address);expect((await f.state()).selectedNodeId).toBeNull();
  await f.call("/admin/webshare","PATCH",{apiKey:key+"_changed",planId:7});expect((await f.state()).nodes).toEqual([]);expect((await f.state()).activeNode!.host).toBe(node.proxy_address);
 });
 it("failed tests, missing/offline/arbitrary nodes leave bootstrap unchanged; explicit null disables the proxy",async()=>{
  const f=fixture();await f.call("/admin/webshare","PATCH",{apiKey:key});await f.call("/admin/webshare/sync","POST",{});
  f.proxyFetch.mockImplementationOnce(async()=>new Response(null,{status:403}));
  await expect(f.call("/admin/webshare/apply","POST",{nodeId:"d-1"})).rejects.toMatchObject({code:"webshare_proxy_test_failed"});
  await expect(f.call("/admin/webshare/apply","POST",{nodeId:"127.0.0.1"})).rejects.toMatchObject({code:"invalid_webshare_node"});
  expect((await f.state()).activeSource).toBe("bootstrap");
  await f.call("/admin/webshare/apply","POST",{nodeId:null});await f.service.outboundFetch(new Request("https://chatgpt.com/backend-api/wham/usage"));expect(f.directFetch).toHaveBeenCalledTimes(1);
 });
 it("concurrent changes are rejected, readers and traffic keep old settings until commit",async()=>{
  const f=fixture();await f.call("/admin/webshare","PATCH",{apiKey:key});
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r});
  f.apiFetch.mockImplementationOnce(async()=>{await gate;return Response.json({count:1,next:null,results:[node]});});
  const sync=f.call("/admin/webshare/sync","POST",{});await new Promise(r=>setImmediate(r));
  await expect(f.call("/admin/webshare","PATCH",{planId:7})).rejects.toMatchObject({code:"webshare_update_in_progress"});
  expect((await f.state()).nodes).toEqual([]);expect((await f.state()).activeSource).toBe("bootstrap");
  release();await sync;expect((await f.state()).nodes).toHaveLength(1);
 });
 it("rejects unknown fields, unsupported routes and methods without network or credential changes",async()=>{
  const f=fixture();
  await expect(f.call("/admin/webshare","PATCH",{url:"https://bad.invalid"})).rejects.toMatchObject({code:"invalid_request"});
  await expect(f.call("/admin/webshare/sync","POST",{key:"x"})).rejects.toMatchObject({code:"invalid_request"});
  await expect(f.call("/admin/webshare","DELETE",{})).rejects.toMatchObject({code:"method_not_allowed"});
  expect(await f.call("/admin/other")).toBeNull();expect(f.apiFetch).not.toHaveBeenCalled();
 });
});
