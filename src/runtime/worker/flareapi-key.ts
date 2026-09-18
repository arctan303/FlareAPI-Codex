import { GatewayError } from '../../errors';
import { decryptJson } from '../../security';
import type { AccountStorage } from '../contracts';
import type { EncryptedValue } from '../../types';

const KEY = 'flareapi-encryption-key-v1';
interface KeyState { version: 1; encryptionKey: string; }
function validateKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value) || atob(value).length !== 32) {
    throw new GatewayError(503, 'runtime_key_invalid', '内部加密密钥无效。', undefined, 'server_error');
  }
}
function generateKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}
/** Private DO state: never returned by an admin/public endpoint, independent of the login password. */
export async function persistentEncryptionKey(storage: AccountStorage, legacyKey?: string): Promise<string> {
  return storage.transaction(async tx => {
    const saved = await tx.get<KeyState>(KEY);
    if (saved !== undefined) {
      if (!saved || saved.version !== 1) throw new GatewayError(503, 'runtime_key_invalid', '内部加密状态无效。', undefined, 'server_error');
      validateKey(saved.encryptionKey);
      return saved.encryptionKey;
    }
    const credentials = await tx.get<EncryptedValue>('credentials');
    const settings = await tx.get<EncryptedValue>('webshare-settings-v1');
    const login = await tx.get<EncryptedValue>('login-private');
    const hasEncryptedData = credentials !== undefined || settings !== undefined || login !== undefined;
    if (hasEncryptedData && !legacyKey) {
      throw new GatewayError(503, 'encryption_key_migration_required', '已有加密数据需要先迁入原加密密钥。', undefined, 'server_error');
    }
    const key = legacyKey ?? generateKey();
    validateKey(key);
    // Validate every encrypted record before persisting a migration key. Never overwrite corrupt state.
    if (credentials !== undefined) await decryptJson(credentials, key, 'oneapi:credentials:v1');
    if (settings !== undefined) await decryptJson(settings, key, 'oneapi:webshare-settings:v1');
    if (login !== undefined) {
      const generation = await tx.get<number>('generation');
      if (!Number.isSafeInteger(generation) || generation! < 0) throw new GatewayError(503, 'runtime_key_invalid', '授权状态无法迁移。', undefined, 'server_error');
      await decryptJson(login, key, 'oneapi:login:' + generation);
    }
    await tx.put(KEY, { version: 1, encryptionKey: key } satisfies KeyState);
    return key;
  });
}