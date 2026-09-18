import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SqliteAccountStorage } from '../src/runtime/node/sqlite-storage';
import { persistentEncryptionKey } from '../src/runtime/worker/flareapi-key';
import { encryptJson, decryptJson } from '../src/security';
const stateKey='flareapi-encryption-key-v1';
const oldKey=Buffer.alloc(32,19).toString('base64');
async function fixture(){const root=await mkdtemp(join(tmpdir(),'flareapi-key-'));const path=join(root,'state.sqlite');return {path,storage:new SqliteAccountStorage(path)};}
describe('private persistent FlareAPI key',()=>{
 it('concurrent initializers share one key; restart/changed external key cannot reset it',async()=>{
  const f=await fixture();let storage=f.storage;
  try {
   const keys=await Promise.all(Array.from({length:8},()=>persistentEncryptionKey(storage)));
   expect(new Set(keys).size).toBe(1);expect(Buffer.from(keys[0],'base64')).toHaveLength(32);
   const cipher=await encryptJson({secret:'fixture-token'},keys[0],'oneapi:credentials:v1');await storage.put('credentials',cipher);
   await storage.close();storage=new SqliteAccountStorage(f.path);
   expect(await persistentEncryptionKey(storage,oldKey)).toBe(keys[0]);
   expect(await decryptJson(await storage.get('credentials') as typeof cipher,keys[0],'oneapi:credentials:v1')).toEqual({secret:'fixture-token'});
  } finally {await storage.close();}
 });
 it('new independent stores never share keys',async()=>{const a=await fixture(),b=await fixture();try{expect(await persistentEncryptionKey(a.storage)).not.toBe(await persistentEncryptionKey(b.storage));}finally{await a.storage.close();await b.storage.close();}});
 it('validates and adopts original key without modifying any three old encrypted records',async()=>{
  const f=await fixture();try{
   const rows={credentials:await encryptJson({refreshToken:'fixture'},oldKey,'oneapi:credentials:v1'),'webshare-settings-v1':await encryptJson({apiKey:'fixture'},oldKey,'oneapi:webshare-settings:v1'),'login-private':await encryptJson({deviceAuthId:'fixture'},oldKey,'oneapi:login:3')};
   await f.storage.put({...rows,generation:3});expect(await persistentEncryptionKey(f.storage,oldKey)).toBe(oldKey);
   for(const [key,value]of Object.entries(rows))expect(await f.storage.get(key)).toEqual(value);
  }finally{await f.storage.close();}
 });
 it('missing/wrong migration keys fail before saving runtime state or changing encrypted data',async()=>{
  const f=await fixture();try{
   const cipher=await encryptJson({token:'fixture'},oldKey,'oneapi:webshare-settings:v1');await f.storage.put('webshare-settings-v1',cipher);
   await expect(persistentEncryptionKey(f.storage)).rejects.toMatchObject({code:'encryption_key_migration_required'});
   await expect(persistentEncryptionKey(f.storage,Buffer.alloc(32,20).toString('base64'))).rejects.toMatchObject({code:'credential_decryption_failed'});
   expect(await f.storage.get(stateKey)).toBeUndefined();expect(await f.storage.get('webshare-settings-v1')).toEqual(cipher);
  }finally{await f.storage.close();}
 });
 it('corrupt saved state is never silently replaced',async()=>{const f=await fixture();try{const bad={version:1,encryptionKey:'bad'};await f.storage.put(stateKey,bad);await expect(persistentEncryptionKey(f.storage)).rejects.toMatchObject({code:'runtime_key_invalid'});expect(await f.storage.get(stateKey)).toEqual(bad);}finally{await f.storage.close();}});
});