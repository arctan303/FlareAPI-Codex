import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { Readable, Writable } from 'node:stream';
import { webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { makeTLSClient, setCryptoImplementation, loadX509FromPem } from '../output/worker-webshare/tls-runtime/node_modules/@reclaimprotocol/tls/lib/index.js';
import { webcryptoCrypto } from '../output/worker-webshare/tls-runtime/node_modules/@reclaimprotocol/tls/lib/crypto/webcrypto.js';
import { X509CertificateGenerator, BasicConstraintsExtension, KeyUsagesExtension, SubjectAlternativeNameExtension, ExtendedKeyUsageExtension } from '../output/worker-webshare/tls-runtime/node_modules/@peculiar/x509/build/x509.cjs.js';
import { assertStrictCertificates, assertTlsMetadata, createVerifiedTlsSocket } from '../experiments/webshare-tls-transport.mjs';
setCryptoImplementation(webcryptoCrypto);
const logger = Object.fromEntries(['info','debug','error','warn','trace'].map(x => [x,()=>{}]));
async function certificates(san = 'probe.invalid', expired = false) {
  const caKeys = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const leafKeys = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const ca = await X509CertificateGenerator.createSelfSigned({name:'CN=Probe Test CA',keys:caKeys,signingAlgorithm:{name:'ECDSA',hash:'SHA-256'},notBefore:new Date(Date.now()-86400000),notAfter:new Date(Date.now()+86400000),extensions:[new BasicConstraintsExtension(true,0,true),new KeyUsagesExtension(32|64,true)]},webcrypto);
  const leaf = await X509CertificateGenerator.create({subject:'CN=probe.invalid',issuer:ca.subject,publicKey:leafKeys.publicKey,signingKey:caKeys.privateKey,signingAlgorithm:{name:'ECDSA',hash:'SHA-256'},notBefore:new Date(Date.now()-86400000),notAfter:new Date(Date.now()+(expired?-60000:86400000)),extensions:[new BasicConstraintsExtension(false,undefined,true),new KeyUsagesExtension(1,true),new ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']),new SubjectAlternativeNameExtension([{type:'dns',value:san}])]},webcrypto);
  const der = await webcrypto.subtle.exportKey('pkcs8',leafKeys.privateKey);
  const key = '-----BEGIN PRIVATE KEY-----\n'+Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END PRIVATE KEY-----';
  return {ca,leaf,key};
}
async function probe(fixture, trustCa, onRead) {
  const server=tls.createServer({key:fixture.key,cert:fixture.leaf.toString('pem'),minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},socket=>{
    socket.on('error',()=>{});
    socket.once('data',()=>socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'));
  });
  server.on('tlsClientError',()=>{}); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const nodeSocket=net.createConnection({port:server.address().port,host:'127.0.0.1'}); nodeSocket.on('error',()=>{}); await once(nodeSocket,'connect');
  const socket={readable:Readable.toWeb(nodeSocket),writable:Writable.toWeb(nodeSocket),closed:Promise.resolve(),async close(){nodeSocket.destroy();}};
  const report={};
  // The test-only factory trusts its generated CA; production adds no roots.
  const factory=options=>makeTLSClient({...options,logger,onRead,...(trustCa?{rootCAs:[loadX509FromPem(fixture.ca.toString('pem'))]}:{})});
  const adapted=createVerifiedTlsSocket(socket,'probe.invalid',report,factory);
  let timer; const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{void adapted.close();reject(new Error('fixture_timeout'));},5000);});
  try {
    await Promise.race([adapted.opened,timeout]);
    const writer=adapted.writable.getWriter(); await writer.write(new TextEncoder().encode('GET / HTTP/1.1\r\nHost: probe.invalid\r\nConnection: close\r\n\r\n')); writer.releaseLock();
    const reader=adapted.readable.getReader(); let body='';
    while(true){const c=await Promise.race([reader.read(),timeout]);if(c.done)break;body+=new TextDecoder().decode(c.value);}reader.releaseLock();
    return {report,body};
  } finally {clearTimeout(timer);await adapted.close();await new Promise(resolve=>server.close(resolve));}
}
test('real TLS 1.3 handshake verifies generated trusted certificate and reads HTTPS',async()=>{
  const result=await probe(await certificates(),true);
  assert.equal(result.report.tlsHandshakeVerified,true);assert.equal(result.report.certificateChecksPassed,true);assert.equal(result.report.tlsVersion,'TLS1_3');assert.match(result.body,/HTTP\/1\.1 200 OK/);
});
test('untrusted CA fails before application request',async()=>{await assert.rejects(probe(await certificates(),false),/Missing issuer|Verification/);});
test('matching CN cannot override mismatched SAN',async()=>{await assert.rejects(probe(await certificates('evil.invalid'),true),/certificate_hostname_invalid/);});
test('expired leaf fails before application request',async()=>{await assert.rejects(probe(await certificates('probe.invalid',true),true),/outside validity/);});
test('wildcard matches exactly one leftmost DNS label and issuer CA constraints are required',()=>{
  const cert=names=>({getAlternativeDNSNames:()=>names,isWithinValidity:()=>true,internal:{extensions:[],getExtension:()=>undefined}});
  assert.doesNotThrow(()=>assertStrictCertificates([cert(['*.example.com'])],'api.example.com'));
  for(const host of ['example.com','a.b.example.com'])assert.throws(()=>assertStrictCertificates([cert(['*.example.com'])],host),/hostname/);
  assert.throws(()=>assertStrictCertificates([cert(['api.example.com']),cert([])],'api.example.com'),/issuer_usage/);
});

test('missing CertificateVerify is rejected before Finished, even with a trusted certificate',async()=>{
  let removed=false;
  const omitSignature=(packet,ctx)=>{
    if(ctx.contentType!=='HANDSHAKE')return;
    for(let i=0;i+4<=packet.content.length;){
      const n=(packet.content[i+1]<<16)|(packet.content[i+2]<<8)|packet.content[i+3];
      if(packet.content[i]===15){packet.content[i]=255;removed=true;}
      i+=4+n;
    }
  };
  await assert.rejects(probe(await certificates(),true,omitSignature),/certificate_verify_required/);
  assert.equal(removed,true);
});
test('actual negotiated legacy protocol and unadvertised cipher are rejected',()=>{
  assert.doesNotThrow(()=>assertTlsMetadata({version:'TLS1_3',cipherSuite:'TLS_AES_128_GCM_SHA256'}));
  for(const metadata of [{version:'TLS1_2',cipherSuite:'TLS_AES_128_GCM_SHA256'},{version:'TLS1_3',cipherSuite:'TLS_CHACHA20_POLY1305_SHA256'}])assert.throws(()=>assertTlsMetadata(metadata),/tls_negotiation_not_allowed/);
});
import {createWebshareFetch} from '../experiments/webshare-fetch.mjs';
test('full CONNECT -> verified TLS -> HTTP adapter streams incremental events over a real socket and cancels independently',async()=>{
 const fixture=await certificates('chatgpt.com');let serverSocket;let connectRequest='';let innerRequest='';let sendLater;
 const server=net.createServer(socket=>{
  socket.on('error',()=>{});
  socket.once('data',bytes=>{
   connectRequest=bytes.toString();
   socket.write('HTTP/1.1 200 Connection established\r\n\r\n',()=>{
    serverSocket=new tls.TLSSocket(socket,{isServer:true,secureContext:tls.createSecureContext({key:fixture.key,cert:fixture.leaf.toString('pem'),minVersion:'TLSv1.3',maxVersion:'TLSv1.3'})});
    serverSocket.on('error',()=>{});
    serverSocket.once('data',bytes=>{
     innerRequest=bytes.toString();
     const first='data: 你好\n\n';
     serverSocket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/event-stream\r\n\r\n'+Buffer.byteLength(first).toString(16)+'\r\n'+first+'\r\n');
     sendLater=()=>serverSocket.end('0\r\n\r\n');
    });
   });
  });
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 let nodeSocket;let closes=0;
 const connect=()=>{
  nodeSocket=net.createConnection({port:server.address().port,host:'127.0.0.1'});nodeSocket.on('error',()=>{});
  return {opened:once(nodeSocket,'connect'),closed:once(nodeSocket,'close'),readable:Readable.toWeb(nodeSocket),writable:Writable.toWeb(nodeSocket),async close(){closes++;nodeSocket.destroy();}};
 };
 const factory=options=>makeTLSClient({...options,logger,rootCAs:[loadX509FromPem(fixture.ca.toString('pem'))]});
 const fetcher=createWebshareFetch({proxy:{host:'138.226.61.165',port:6338,username:'fixture-proxy',password:'fixture-password'},connect,makeClient:factory});
 const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),5000);
 try{
  const r=await fetcher(new Request('https://chatgpt.com/backend-api/codex/responses',{method:'POST',body:'{}',signal:abort.signal,headers:{Authorization:'Bearer fixture-account','CF-Worker':'strip-me'}}));
  const reader=r.body.getReader();const first=await reader.read();assert.equal(new TextDecoder().decode(first.value),'data: 你好\n\n');
  assert.equal(closes,0);assert.match(connectRequest,/CONNECT chatgpt.com:443/);assert.doesNotMatch(connectRequest,/fixture-account/);assert.match(innerRequest,/fixture-account/);assert.doesNotMatch(innerRequest,/cf-worker/i);
  await reader.cancel();assert.ok(closes);assert.equal(typeof sendLater,'function');
 }finally{clearTimeout(timeout);nodeSocket?.destroy();serverSocket?.destroy();await new Promise(resolve=>server.close(resolve));}
});
