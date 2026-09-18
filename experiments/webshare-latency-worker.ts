import { connect } from 'cloudflare:sockets';
import { measureProxyTcp } from '../src/runtime/worker/webshare-latency';
import type { WebshareProxy } from '../src/webshare/api';
declare const PROBE_DEADLINE:number;
export const TARGETS = [['9.142.39.218',7388],['138.226.61.165',6338],['9.249.18.109',7343]] as const;
const ORIGIN='https://flareapi-latency-test.12213443th.workers.dev';
export default {
 async fetch(request:Request,env:{PROBE_KEY:string}):Promise<Response>{
  const url=new URL(request.url);
  if(url.origin!==ORIGIN&&!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(url.origin))return new Response(null,{status:403});
  if(url.pathname==='/health'&&request.method==='GET'&&!url.search)return Response.json({service:'flareapi-latency-test',expiresAt:PROBE_DEADLINE});
  if(url.pathname!=='/measure'||url.search)return new Response(null,{status:404});
  if(request.method!=='POST')return new Response(null,{status:405});
  if(!env.PROBE_KEY||request.headers.get('Authorization')!=='Bearer '+env.PROBE_KEY)return new Response(null,{status:401});
  if(request.headers.has('Origin')&&request.headers.get('Origin')!==ORIGIN)return new Response(null,{status:403});
  if(Date.now()>PROBE_DEADLINE)return Response.json({error:'probe_expired'},{status:410});
  const reader=request.body?.getReader();if(!reader)return new Response(null,{status:400});
  let timer:ReturnType<typeof setTimeout>|undefined;let body='';let size=0;
  try{
   const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),5000);});
   for(;;){const part=await Promise.race([reader.read(),timeout]);if(part.done)break;size+=part.value.byteLength;if(size>512)throw new Error('large');body+=new TextDecoder().decode(part.value);}
   const value=JSON.parse(body);if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length)throw new Error('fields');
  }catch{return new Response(null,{status:400});}finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
  const results=[];
  for(const [host,port] of TARGETS){
   const proxy:WebshareProxy={host,port,id:'probe',username:'not-used',password:'not-used',valid:true,countryCode:'US'};
   const result=await measureProxyTcp(proxy,connect);
   results.push({host,port,...result,source:'test-worker'});
  }
  const colo=typeof request.cf?.colo==='string'?request.cf.colo:null;
  return Response.json({at:new Date().toISOString(),source:'test-worker',colo,metric:'TCP connection establishment; no proxy authentication or Codex request',results},{headers:{'Cache-Control':'no-store'}});
 }
};