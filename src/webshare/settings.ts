import { GatewayError } from "../errors";
import { decryptJson,encryptJson } from "../security";
import { normalizeTeamDomain } from "../access";
import type { AccountStorage } from "../runtime/contracts";
import type { EncryptedValue } from "../types";
import { fetchWebshareNodes,validateWebshareApiKey,validateWebsharePlanId,validateWebshareProxy,type WebshareProxy,type WebshareApiFetch } from "./api";
import type { TcpLatencyResult } from '../runtime/worker/webshare-latency';
const KEY="webshare-settings-v1";
interface State { apiKey: string|null; planId: number|null; nodes: WebshareProxy[]; activeProxy?: WebshareProxy|null; lastSyncedAt: number|null; }
interface Options { measureProxy?: (proxy:WebshareProxy)=>Promise<TcpLatencyResult>; apiFetch?: WebshareApiFetch; proxyFetch: (proxy:WebshareProxy,request:Request)=>Promise<Response>; bootstrap:WebshareProxy|null; requireProxy?:boolean; directFetch: (request:Request)=>Promise<Response>; }
export class WebshareSettings {
  private mutation: Promise<unknown>|null=null;
  private lastMeasureAt:number|null=null;
  constructor(private readonly storage:AccountStorage,private readonly encryptionKey:string,private readonly options:Options) {}
  private async state():Promise<State> {
    const saved=await this.storage.get<EncryptedValue>(KEY);
    return saved?decryptJson<State>(saved,this.encryptionKey,"oneapi:webshare-settings:v1"):{apiKey:null,planId:null,nodes:[],lastSyncedAt:null};
  }
  private save(state:State) { return encryptJson(state,this.encryptionKey,"oneapi:webshare-settings:v1").then(value=>this.storage.put(KEY,value)); }
  private public(state:State) {
    const active=state.activeProxy===undefined?this.options.bootstrap:state.activeProxy;
    return {supported:true,tcpTestSupported:Boolean(this.options.measureProxy),apiKeyConfigured:Boolean(state.apiKey),planId:state.planId,lastSyncedAt:state.lastSyncedAt,
      activeSource:!active&&this.options.requireProxy?"none":state.activeProxy===undefined?(this.options.bootstrap?"bootstrap":"direct"):state.activeProxy===null?"direct":"webshare",
      activeNode:active?{host:active.host,port:active.port,countryCode:active.countryCode}:null,
      selectedNodeId:state.nodes.find(p=>active&&p.host===active.host&&p.port===active.port)?.id??null,
      nodes:state.nodes.map(p=>({id:p.id,host:p.host,port:p.port,countryCode:p.countryCode,valid:p.valid}))};
  }
  async outboundFetch(request:Request):Promise<Response> {
    const url=new URL(request.url);
    // Access signing keys are public control-plane data, independent of the Codex proxy.
    if(request.method==="GET" && url.protocol==="https:" && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname==="/cdn-cgi/access/certs") {
      let accessTeam=false;
      try { accessTeam=normalizeTeamDomain(url.hostname)===url.hostname; } catch { /* Other targets retain the existing proxy policy. */ }
      if(accessTeam) return this.options.directFetch(new Request(url.href, {
        method:"GET",headers:{Accept:"application/json"},redirect:"manual",signal:request.signal
      }));
    }
    const state=await this.state();
    const proxy=state.activeProxy===undefined?this.options.bootstrap:state.activeProxy;
    if (!proxy && this.options.requireProxy) throw new GatewayError(503,"webshare_proxy_required","请在设置中配置 Webshare 并启用节点。",undefined,"server_error");
    return proxy?this.options.proxyFetch(validateWebshareProxy(proxy),request):this.options.directFetch(request);
  }
  async handle(request:Request):Promise<Response|null> {
    const url=new URL(request.url);
    if(!/^\/admin\/webshare(?:\/sync|\/apply|\/measure)?$/.test(url.pathname))return null;
    if(url.search)throw new GatewayError(400,"invalid_request","Webshare 设置不接受 query。");
    if(request.method==="GET"&&url.pathname==="/admin/webshare")return Response.json(this.public(await this.state()),{headers:{"Cache-Control":"no-store"}});
    if(request.method!=="POST"&&request.method!=="PATCH")throw new GatewayError(405,"method_not_allowed","此操作的方法不受支持。");
    if(this.mutation)throw new GatewayError(409,"webshare_update_in_progress","Webshare 设置正在更新，请等待完成。");
    const operation=this.change(request,url.pathname);
    this.mutation=operation;
    try{return await operation;}finally{if(this.mutation===operation)this.mutation=null;}
  }
  private async change(request:Request,path:string):Promise<Response> {
    const reader=request.body?.getReader();if(!reader)throw new GatewayError(400,"invalid_request","请求缺少JSON正文。");
    let timer:ReturnType<typeof setTimeout>|undefined;const chunks:Uint8Array[]=[];let size=0;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new GatewayError(408,"request_timeout","设置请求超时。"));},5000);});
    void timeout.catch(()=>{});
    let body:Record<string,unknown>;
    try {
      for(;;){const part=await Promise.race([reader.read(),timeout]);if(part.done)break;size+=part.value.length;if(size>4096)throw new GatewayError(413,"request_too_large","设置请求过大。");chunks.push(part.value);}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
      if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("invalid_json");
    }catch(error){if(error instanceof GatewayError)throw error;throw new GatewayError(400,"invalid_request","设置请求必须为JSON对象。");}
    finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
    const state=await this.state();
    const noExtra=(keys:string[])=>{if(Object.keys(body).some(k=>!keys.includes(k)))throw new GatewayError(400,"invalid_request","包含不支持的设置字段。");};
    if(path==="/admin/webshare"&&request.method==="PATCH"){
      noExtra(["apiKey","planId"]);if(!Object.keys(body).length)throw new GatewayError(400,"invalid_request","没有要保存的字段。");
      const apiKey=body.apiKey===undefined?state.apiKey:validateWebshareApiKey(body.apiKey);
      const planId=body.planId===undefined?state.planId:validateWebsharePlanId(body.planId);
      if(apiKey!==state.apiKey||planId!==state.planId){state.nodes=[];state.lastSyncedAt=null;}
      state.apiKey=apiKey;state.planId=planId;await this.save(state);
    }else if(path==="/admin/webshare/sync"&&request.method==="POST"){
      noExtra([]);if(!state.apiKey)throw new GatewayError(400,"webshare_key_required","请先保存 Webshare API key。");
      // Commit only a fully validated list; retain the active connection settings on sync failures/replacements.
      state.nodes=await fetchWebshareNodes(state.apiKey,state.planId,this.options.apiFetch);state.lastSyncedAt=Date.now();await this.save(state);
    }else if(path==="/admin/webshare/measure"&&request.method==="POST"){
      noExtra(["nodeId"]);
      if(!this.options.measureProxy)throw new GatewayError(501,"webshare_measure_unavailable","当前实例不支持 Worker 测速。");
      if(typeof body.nodeId!=="string")throw new GatewayError(400,"invalid_webshare_node","请选择有效的固定节点。","nodeId");
      const proxy=state.nodes.find(p=>p.id===body.nodeId&&p.valid);
      if(!proxy)throw new GatewayError(400,"invalid_webshare_node","所选节点不在最新列表中或不可用。","nodeId");
      validateWebshareProxy(proxy);
      const now=Date.now();if(this.lastMeasureAt!==null&&now-this.lastMeasureAt<10000)throw new GatewayError(429,"webshare_measure_rate_limited","请稍后再测速。");
      this.lastMeasureAt=now;
      const result=await this.options.measureProxy(proxy);
      return Response.json({nodeId:proxy.id,...result},{headers:{"Cache-Control":"no-store"}});
    }else if(path==="/admin/webshare/apply"&&request.method==="POST"){
      noExtra(["nodeId"]);
      if(body.nodeId===null){state.activeProxy=null;await this.save(state);}
      else{
        if(typeof body.nodeId!=="string")throw new GatewayError(400,"invalid_webshare_node","请选择有效的固定节点。","nodeId");
        const proxy=state.nodes.find(p=>p.id===body.nodeId&&p.valid);
        if(!proxy)throw new GatewayError(400,"invalid_webshare_node","所选节点不在最新列表中或不可用。","nodeId");
        const request=new Request("https://chatgpt.com/backend-api/codex/models?client_version=0.153.4",{headers:{Accept:"application/json"},redirect:"manual"});
        let response:Response;
        try{response=await this.options.proxyFetch(proxy,request);}
        catch{throw new GatewayError(502,"webshare_proxy_test_failed","节点连通测试失败，当前出口保持原状。",undefined,"server_error");}
        const status=response.status;void response.body?.cancel().catch(()=>{});
        if(status!==200&&status!==401)throw new GatewayError(502,"webshare_proxy_test_failed","节点未通过目标HTTPS连通测试，当前出口保持原状。",undefined,"server_error");
        state.activeProxy=proxy;await this.save(state);
      }
    }else throw new GatewayError(405,"method_not_allowed","此操作的方法不受支持。");
    return Response.json(this.public(state),{headers:{"Cache-Control":"no-store"}});
  }
}
