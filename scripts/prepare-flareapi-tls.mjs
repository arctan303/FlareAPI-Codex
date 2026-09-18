import {readFile,writeFile,mkdir}from'node:fs/promises';
import{createHash}from'node:crypto';import{spawn}from'node:child_process';import{fileURLToPath}from'node:url';import{dirname,join}from'node:path';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const runtime=join(root,'output/worker-webshare/tls-runtime');
const patchedHash='accf51dd31b5c5783cfdfd2ebfc44ea1438896897078dc7e58b6b27a997ca405';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function run(command,args,options={}){const child=spawn(command,args,{cwd:root,windowsHide:true,stdio:'inherit',...options});const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});if(code!==0)throw new Error('tls_prepare_command_failed');}
const manifest=await readFile(join(root,'vendor/tls-runtime/package.json'));
const lock=await readFile(join(root,'vendor/tls-runtime/package-lock.json'));
let ready=false;
try{ready=hash(await readFile(join(runtime,'package-lock.json')))===hash(lock)&&hash(await readFile(join(runtime,'node_modules/@reclaimprotocol/tls/lib/make-tls-client.js')))===patchedHash;}catch(error){if(error.code!=='ENOENT')throw error;}
if(!ready){
 await mkdir(runtime,{recursive:true});await writeFile(join(runtime,'package.json'),manifest);await writeFile(join(runtime,'package-lock.json'),lock);
 const npmCli=process.env.npm_execpath??join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
 await run(process.execPath,[npmCli,'ci','--prefix',runtime,'--ignore-scripts','--no-audit','--no-fund']);
}
await run(process.execPath,['experiments/patch-webshare-tls.mjs']);
if(hash(await readFile(join(runtime,'node_modules/@reclaimprotocol/tls/lib/make-tls-client.js')))!==patchedHash)throw new Error('patched_tls_fingerprint_mismatch');
console.log(JSON.stringify({tlsVersion:'0.1.4',locked:true,patchVerified:true,cached:ready}));