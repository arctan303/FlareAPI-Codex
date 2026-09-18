import { describe,expect,it,vi } from "vitest";
import { fetchWebshareNodes,isPublicProxyIPv4 } from "../src/webshare/api";
const key="fixture_webshare_key_123456";
const proxy={id:"d-1",proxy_address:"138.226.61.165",port:6338,username:"fixture-user",password:"fixture-password",valid:true,country_code:"US"};
describe("Webshare fixed-node API",()=>{
 it("rejects incomplete final counts and unstable pagination totals",async()=>{
  await expect(fetchWebshareNodes(key,null,async()=>Response.json({count:3,next:null,results:[proxy]}))).rejects.toMatchObject({code:"webshare_api_failed"});
  let page=0;
  await expect(fetchWebshareNodes(key,null,async()=>{page++;return Response.json({count:page===1?2:3,next:page===1?"more":null,results:[{...proxy,id:"d-"+page}]});})).rejects.toMatchObject({code:"webshare_api_failed"});
 });
 it("uses fixed official GET, plan and Token; never follows an API next URL",async()=>{
  const requests:Request[]=[];
  const f=vi.fn(async(r:Request)=>{requests.push(r);return Response.json({count:2,next:requests.length===1?"https://malicious.invalid/steal":null,results:[{...proxy,id:"d-"+requests.length}]});});
  expect(await fetchWebshareNodes(key,14320842,f)).toHaveLength(2);
  for(const r of requests){expect(new URL(r.url).origin).toBe("https://proxy.webshare.io");expect(r.method).toBe("GET");expect(r.redirect).toBe("manual");expect(r.headers.get("Authorization")).toBe("Token "+key);expect(new URL(r.url).searchParams.get("plan_id")).toBe("14320842");}
  expect(new URL(requests[1].url).searchParams.get("page")).toBe("2");
 });
 it("rejects malformed key and plan before transmission",async()=>{
  const f=vi.fn();await expect(fetchWebshareNodes("bad\r\nkey",null,f)).rejects.toMatchObject({code:"invalid_webshare_api_key"});
  await expect(fetchWebshareNodes(key,-1,f)).rejects.toMatchObject({code:"invalid_webshare_plan_id"});expect(f).not.toHaveBeenCalled();
 });
 it("rejects private, ambiguous and reserved proxy IPs",()=>{
  for(const host of ["192.88.99.2","192.88.99.1","127.0.0.1","10.1.1.1","172.16.0.1","192.168.1.1","169.254.169.254","100.64.0.1","0.0.0.0","224.0.0.1","198.18.0.1","203.0.113.1","2130706433","0138.226.61.165","localhost","[::1]"])expect(isPublicProxyIPv4(host),host).toBe(false);
  for(const host of ["192.88.98.2","192.88.100.2","9.142.39.218","138.226.61.165","9.249.18.109"])expect(isPublicProxyIPv4(host)).toBe(true);
 });
 it("rejects unsafe nodes, redirects and auth errors without retries or raw upstream body",async()=>{
  await expect(fetchWebshareNodes(key,null,async()=>Response.json({count:1,next:null,results:[{...proxy,proxy_address:"127.0.0.1"}]}))).rejects.toMatchObject({code:"invalid_webshare_response"});
  for(const status of [302,401,403,429]){
   const f=vi.fn(async()=>new Response("secret-upstream-body",{status,headers:{Location:"https://other.invalid"}}));
   await expect(fetchWebshareNodes(key,null,f)).rejects.not.toThrow("secret-upstream-body");expect(f).toHaveBeenCalledTimes(1);
  }
 });
 it("rejects a later failure or duplicate ID without returning a partial list",async()=>{
  let pages=0;
  await expect(fetchWebshareNodes(key,null,async()=>{pages++;return pages===1?Response.json({count:2,next:"more",results:[proxy]}):new Response(null,{status:500});})).rejects.toMatchObject({code:"webshare_api_failed"});
  await expect(fetchWebshareNodes(key,null,async()=>Response.json({count:2,next:"more",results:[proxy]}))).rejects.toMatchObject({code:"webshare_api_failed"});
 });
});
