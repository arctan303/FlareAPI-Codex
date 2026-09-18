import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../output/worker-webshare/tls-runtime/node_modules/@reclaimprotocol/tls/',import.meta.url);
const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
if(pkg.version!=='0.1.4')throw new Error('unsupported_tls_version');
const path=new URL('lib/make-tls-client.js',root);
const original=await readFile(path,'utf8');
const fingerprint=text=>createHash('sha256').update(text).digest('hex');
const expected='6203af15f12e36409d0778d7f2d9da0f1d2a666eac178efc818315a3749bb5d1';
if(original.includes('ONEAPI_REQUIRE_CERTIFICATE_VERIFY_V1')){
  if(fingerprint(original)!=='accf51dd31b5c5783cfdfd2ebfc44ea1438896897078dc7e58b6b27a997ca405')throw new Error('patched_tls_source_fingerprint_mismatch');
  console.log(JSON.stringify({version:pkg.version,alreadyPatched:true,sha256:fingerprint(original)}));
}else{
 if(fingerprint(original)!==expected)throw new Error('tls_source_fingerprint_mismatch');
 let patched=original;
 const edits=[
  ['let certificatesVerified = false;','let certificatesVerified = false;\n    let certificateVerifyVerified = false; // ONEAPI_REQUIRE_CERTIFICATE_VERIFY_V1'],
  ['signatureData,\n                        });\n                        break;','signatureData,\n                        });\n                        certificateVerifyVerified = true;\n                        break;'],
  ["logger.debug('received server finish');","logger.debug('received server finish');\n        if (connTlsVersion === 'TLS1_3' && !certificateVerifyVerified) {\n            throw new Error('certificate_verify_required');\n        }"]
 ];
 for(const [from,to]of edits){if(patched.split(from).length!==2)throw new Error('tls_patch_anchor_ambiguous');patched=patched.replace(from,to);}
 await writeFile(path,patched);
 console.log(JSON.stringify({version:pkg.version,originalSha256:expected,patchedSha256:fingerprint(patched),patched:true}));
}
