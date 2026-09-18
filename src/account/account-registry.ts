import type { EncryptedValue, StoredCredentials } from "../types";
import type { StorageTransaction } from "../runtime/contracts";
import { accountInfoFromIdToken, decryptJson, hashSecret } from "../security";
import { GatewayError } from "../errors";

export const ACCOUNTS_KEY = "saved-accounts-v1";
export const ACTIVE_ACCOUNT_KEY = "active-account-v1";
export const ACCOUNT_LIMIT = 32;
export interface SavedAccount {
  id: string;
  credentials: EncryptedValue | null;
  email: string | null;
  plan: string | null;
  idHint: string;
  tokenExpiresAt: number | null;
  lastRefreshAt: number;
  createdAt: number;
  reauthenticationReason: string | null;
}

// The legacy active slot remains authoritative; every write updates its saved record atomically.
export async function saveAccount(tx: StorageTransaction, value: StoredCredentials, encrypted: EncryptedValue, activate: boolean): Promise<string> {
  const id = await hashSecret(value.accountId);
  const rows = (await tx.get<SavedAccount[]>(ACCOUNTS_KEY)) ?? [];
  const previous = rows.find(row => row.id === id);
  if (!previous && rows.length >= ACCOUNT_LIMIT) throw new GatewayError(409, "account_capacity", "最多保存32个账号，请先移除不再使用的账号。", undefined, "invalid_request_error");
  const row: SavedAccount = {
    id, credentials: encrypted, ...accountInfoFromIdToken(value.idToken),
    idHint: `…${value.accountId.slice(-6)}`, tokenExpiresAt: value.expiresAt,
    lastRefreshAt: value.lastRefreshAt, createdAt: previous?.createdAt ?? Date.now(), reauthenticationReason: null
  };
  await tx.put(ACCOUNTS_KEY, previous ? rows.map(item => item.id === id ? row : item) : [...rows, row]);
  if (activate) await tx.put(ACTIVE_ACCOUNT_KEY, id);
  return id;
}

export async function registerLegacyAccount(tx: StorageTransaction, encryptionKey: string): Promise<void> {
  if (await tx.get(ACCOUNTS_KEY) !== undefined) return;
  const encrypted = await tx.get<EncryptedValue>("credentials");
  if (encrypted) {
    const value = await decryptJson<StoredCredentials>(encrypted, encryptionKey, "oneapi:credentials:v1");
    await saveAccount(tx, value, encrypted, true);
  } else await tx.put(ACCOUNTS_KEY, []);
}

export async function markActiveAccountUnavailable(tx: StorageTransaction, reason: string): Promise<void> {
  const id = await tx.get<string>(ACTIVE_ACCOUNT_KEY);
  const rows = (await tx.get<SavedAccount[]>(ACCOUNTS_KEY)) ?? [];
  await tx.put(ACCOUNTS_KEY, rows.map(row => row.id === id ? { ...row, credentials: null, reauthenticationReason: reason } : row));
}

export async function removeActiveAccount(tx: StorageTransaction): Promise<void> {
  const id = await tx.get<string>(ACTIVE_ACCOUNT_KEY);
  const rows = (await tx.get<SavedAccount[]>(ACCOUNTS_KEY)) ?? [];
  await tx.put(ACCOUNTS_KEY, rows.filter(row => row.id !== id));
  await tx.delete(ACTIVE_ACCOUNT_KEY);
}
