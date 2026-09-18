import { GatewayError } from "../errors";
import { bearerToken, hashSecret, randomSecret, timingSafeEqual } from "../security";
import { readJsonBody } from "../protocol/requests";
import type { AccountStorage, StorageTransaction } from "../runtime/contracts";
import {
  DEFAULT_KEY_POLICY,
  LEGACY_KEY_ID,
  legacyKeyIdentity,
  modelAllowed,
  normalizePolicy,
  publicKey,
  storedKeyIdentity,
  validateKeyName,
  validatePolicyPatch
} from "../controls";
import type { ApiKeyPolicy, GatewayIdentity, StoredApiKey } from "../types";

export const API_KEYS_KEY = "api-keys";
export const LEGACY_POLICY_KEY = "legacy-key-policy";
export const RATE_WINDOWS_KEY = "api-key-rate-windows";
export const API_KEY_LIMIT = 32;

export interface RateWindowRecord {
  windowStart: number;
  count: number;
}

export class KeyManager {
  private readonly rateWindows = new Map<string, number[]>();

  constructor(
    private readonly storage: AccountStorage,
    private readonly env: { ADMIN_API_KEY?: string; GATEWAY_API_KEY?: string }
  ) {}

  async storedApiKeys(): Promise<StoredApiKey[]> {
    return ((await this.storage.get<StoredApiKey[]>(API_KEYS_KEY)) ?? []).slice(0, API_KEY_LIMIT);
  }

  async legacyPolicy(): Promise<ApiKeyPolicy> {
    return normalizePolicy(await this.storage.get<Partial<ApiKeyPolicy>>(LEGACY_POLICY_KEY));
  }

  assertKeyUsable(identity: GatewayIdentity): void {
    if (!identity.enabled) {
      throw new GatewayError(401, "api_key_disabled", "调用密钥已停用。", undefined, "authentication_error");
    }
    if (identity.expiresAt !== null && identity.expiresAt <= Date.now()) {
      throw new GatewayError(401, "api_key_expired", "调用密钥已过期。", undefined, "authentication_error");
    }
  }

  validateModelAccess(identity: GatewayIdentity | undefined, model: string): void {
    if (identity && !modelAllowed(identity, model)) {
      throw new GatewayError(403, "model_not_allowed", `模型 ${model} 不在该调用密钥允许范围内。`, "model", "permission_error");
    }
  }

  checkConcurrencyLimit(identity: GatewayIdentity | undefined, activeCount: number): void {
    if (identity && identity.concurrencyLimit !== null && activeCount >= identity.concurrencyLimit) {
      throw new GatewayError(429, "api_key_concurrency_limit", "该调用密钥已达到并发上限。", undefined, "rate_limit_error");
    }
  }

  private pruneRateWindows(now = Date.now()): void {
    const activeSince = now - 60_000;
    for (const [keyId, timestamps] of this.rateWindows) {
      const active = timestamps.filter((t) => t > activeSince && t <= now);
      if (active.length === 0) {
        this.rateWindows.delete(keyId);
      } else if (active.length !== timestamps.length) {
        this.rateWindows.set(keyId, active);
      }
    }
  }

  checkAndUpdateRateLimit(identity: GatewayIdentity | undefined, now: number = Date.now()): void {
    this.pruneRateWindows(now);
    if (!identity || identity.rateLimitPerMinute === null) return;
    const activeSince = now - 60_000;
    const timestamps = this.rateWindows.get(identity.id) ?? [];
    const active = timestamps.filter((t) => t > activeSince && t <= now);
    if (active.length >= identity.rateLimitPerMinute) {
      throw new GatewayError(429, "api_key_rate_limit", "该调用密钥已达到每分钟请求上限。", undefined, "rate_limit_error");
    }
    active.push(now);
    this.rateWindows.set(identity.id, active);
  }

  getRateWindow(keyId: string): number[] | undefined {
    const now = Date.now();
    const timestamps = this.rateWindows.get(keyId);
    if (!timestamps) return undefined;
    const active = timestamps.filter((t) => t > now - 60_000 && t <= now);
    return active.length > 0 ? active : undefined;
  }

  async authenticateGateway(request: Request): Promise<GatewayIdentity> {
    const supplied = bearerToken(request);
    if (!supplied || (this.env.ADMIN_API_KEY && timingSafeEqual(supplied, this.env.ADMIN_API_KEY))) {
      throw new GatewayError(401, "invalid_api_key", "调用密钥无效。", undefined, "authentication_error");
    }
    if (this.env.GATEWAY_API_KEY && timingSafeEqual(supplied, this.env.GATEWAY_API_KEY)) {
      const identity = legacyKeyIdentity(await this.legacyPolicy());
      this.assertKeyUsable(identity);
      return identity;
    }
    const digest = await hashSecret(supplied);
    const found = (await this.storedApiKeys()).find((key) => key.digest === digest);
    if (!found) throw new GatewayError(401, "invalid_api_key", "调用密钥无效。", undefined, "authentication_error");
    const identity = storedKeyIdentity(found);
    this.assertKeyUsable(identity);
    return identity;
  }

  async listApiKeys(): Promise<Response> {
    const keys = (await this.storedApiKeys())
      .map(storedKeyIdentity)
      .sort((left, right) => right.createdAt - left.createdAt);
    const data = this.env.GATEWAY_API_KEY
      ? [legacyKeyIdentity(await this.legacyPolicy()), ...keys]
      : keys;
    return Response.json({ data: data.map(publicKey) }, { headers: { "Cache-Control": "no-store" } });
  }

  async createApiKey(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const allowed = ["name", "enabled", "expiresAt", "modelAccess", "rateLimitPerMinute", "concurrencyLimit"];
    if (Object.keys(body).some((key) => !allowed.includes(key))) {
      throw new GatewayError(400, "invalid_request", "创建 API 密钥包含不支持的字段。", "body");
    }
    const name = validateKeyName(body.name);
    const policy = validatePolicyPatch(body, DEFAULT_KEY_POLICY);
    const secret = randomSecret("oneapi_sk_");
    const createdAt = Date.now();
    const key: StoredApiKey = {
      id: crypto.randomUUID(),
      name,
      digest: await hashSecret(secret),
      masked: `oneapi_sk_••••${secret.slice(-4)}`,
      createdAt,
      ...policy
    };
    await this.storage.transaction(async (transaction) => {
      const keys = ((await transaction.get<StoredApiKey[]>(API_KEYS_KEY)) ?? []).slice(0, API_KEY_LIMIT);
      if (keys.length >= API_KEY_LIMIT) {
        throw new GatewayError(409, "api_key_limit_reached", `API 密钥数量上限为 ${API_KEY_LIMIT}。`, undefined, "invalid_request_error");
      }
      if (keys.some((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new GatewayError(409, "api_key_name_conflict", "API 密钥名称已存在。", "name");
      }
      await transaction.put(API_KEYS_KEY, [...keys, key]);
    });
    return Response.json({ ...publicKey(storedKeyIdentity(key)), key: secret }, {
      status: 201,
      headers: { "Cache-Control": "no-store" }
    });
  }

  async patchApiKey(request: Request, id: string): Promise<Response> {
    const body = await readJsonBody(request);
    const allowed = ["name", "enabled", "expiresAt", "modelAccess", "rateLimitPerMinute", "concurrencyLimit"];
    if (Object.keys(body).length === 0 || Object.keys(body).some((key) => !allowed.includes(key))) {
      throw new GatewayError(400, "invalid_request", "更新 API 密钥只接受支持的非空字段。", "body");
    }
    if (id === LEGACY_KEY_ID) {
      if ("name" in body) throw new GatewayError(400, "invalid_request", "旧环境调用密钥名称不可修改。", "name");
      const next = validatePolicyPatch(body, await this.legacyPolicy());
      await this.storage.put(LEGACY_POLICY_KEY, next);
      return Response.json(publicKey(legacyKeyIdentity(next)), { headers: { "Cache-Control": "no-store" } });
    }

    let updated: StoredApiKey | null = null;
    await this.storage.transaction(async (transaction) => {
      const keys = ((await transaction.get<StoredApiKey[]>(API_KEYS_KEY)) ?? []).slice(0, API_KEY_LIMIT);
      const index = keys.findIndex((key) => key.id === id);
      if (index < 0) throw new GatewayError(404, "api_key_not_found", "没有找到该 API 密钥。", "id");
      const current = keys[index]!;
      const name = "name" in body ? validateKeyName(body.name) : current.name;
      if (keys.some((candidate, candidateIndex) => candidateIndex !== index && candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new GatewayError(409, "api_key_name_conflict", "API 密钥名称已存在。", "name");
      }
      updated = { ...current, name, ...validatePolicyPatch(body, normalizePolicy(current)) };
      keys[index] = updated;
      await transaction.put(API_KEYS_KEY, keys);
    });
    return Response.json(publicKey(storedKeyIdentity(updated!)), { headers: { "Cache-Control": "no-store" } });
  }

  async deleteApiKey(request: Request, id: string): Promise<Response> {
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 0) {
      throw new GatewayError(400, "invalid_request", "撤销 API 密钥不接受参数。", "body");
    }
    this.rateWindows.delete(id);
    await this.storage.transaction(async (transaction) => {
      const keys = ((await transaction.get<StoredApiKey[]>(API_KEYS_KEY)) ?? []).slice(0, API_KEY_LIMIT);
      const remaining = keys.filter((key) => key.id !== id);
      if (remaining.length === keys.length) {
        throw new GatewayError(404, "api_key_not_found", "没有找到该 API 密钥。", "id");
      }
      if (remaining.length === 0) await transaction.delete(API_KEYS_KEY);
      else await transaction.put(API_KEYS_KEY, remaining);
      const rawRateWindows = (await transaction.get<Record<string, RateWindowRecord | number[]>>(RATE_WINDOWS_KEY)) ?? {};
      if (id in rawRateWindows) {
        delete rawRateWindows[id];
        if (Object.keys(rawRateWindows).length === 0) await transaction.delete(RATE_WINDOWS_KEY);
        else await transaction.put(RATE_WINDOWS_KEY, rawRateWindows);
      }
    });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
}
