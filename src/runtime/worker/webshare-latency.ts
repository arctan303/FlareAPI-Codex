import { validateWebshareProxy, type WebshareProxy } from '../../webshare/api';
export interface TcpProbeSocket { opened: Promise<unknown>; closed: Promise<unknown>; close(): Promise<unknown>; }
export type TcpProbeConnect = (address: {hostname:string;port:number}, options:{secureTransport:'off';allowHalfOpen:false}) => TcpProbeSocket;
export interface TcpLatencySample { latencyMs: number|null; error: 'timeout'|'connect_failed'|null; }
export interface TcpLatencyResult { kind:'tcp-connect'; source:'account-do'; samples:TcpLatencySample[]; successCount:number; medianMs:number|null; }
export async function measureProxyTcp(proxy:WebshareProxy,connect:TcpProbeConnect,now:()=>number=Date.now):Promise<TcpLatencyResult> {
  validateWebshareProxy(proxy);
  const samples:TcpLatencySample[]=[];
  for(let i=0;i<3;i++){
    let socket:TcpProbeSocket|undefined;let timer:ReturnType<typeof setTimeout>|undefined;let timedOut=false;
    const start=now();
    try{
      socket=connect({hostname:proxy.host,port:proxy.port},{secureTransport:'off',allowHalfOpen:false});
      void socket.closed.catch(()=>{});
      await Promise.race([socket.opened,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new Error('timeout'));},3000);})]);
      samples.push({latencyMs:Math.max(0,Math.round(now()-start)),error:null});
    }catch{
      samples.push({latencyMs:null,error:timedOut?'timeout':'connect_failed'});
    }finally{
      clearTimeout(timer);
      // Start close immediately even after opened rejects; never leave a probe socket alive.
      if(socket){let cleanupTimer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([socket.close(),new Promise<void>(resolve=>{cleanupTimer=setTimeout(resolve,1000);})]);}catch{}finally{clearTimeout(cleanupTimer);}}
    }
  }
  const values=samples.flatMap(s=>s.latencyMs===null?[]:[s.latencyMs]).sort((a,b)=>a-b);
  const n=values.length;
  return {kind:'tcp-connect',source:'account-do',samples,successCount:n,medianMs:n?(values[Math.floor((n-1)/2)]+values[Math.floor(n/2)])/2:null};
}