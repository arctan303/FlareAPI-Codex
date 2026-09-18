import { GatewayError } from "../errors";
import { isLoopbackHost } from "../../server/network-config.mjs";
import type {
  AccessConfig,
  EncryptedValue,
  LoginPrivateState,
  LoginPublicState,
  StoredAdminSession,
  StoredCredentials
} from "../types";
import {
  AccessTokenVerifier,
  DEFAULT_ACCESS_CONFIG,
  validateAccessConfig
} from "../access";
import {
  ADMIN_SESSION_COOKIE,
  accountIdFromIdToken,
  accountInfoFromIdToken,
  bearerToken,
  cookieValue,
  decryptJson,
  encryptJson,
  hashSecret,
  jwtExpirationMs,
  randomSecret,
  requireBearer,
  timingSafeEqual
} from "../security";
import { exchangeDeviceCode, pollDeviceCode, refreshOAuthTokens, requestDeviceCode } from "../codex/auth";
import { mockLoginStateDelayMs, mockPersistenceDelayMs } from "../codex/mock";
import { fetchModels } from "../codex/upstream";
import { readJsonBody } from "../protocol/requests";
import type { AccountRequestContext, AccountServiceConfig, AccountStorage } from "../runtime/contracts";

import { ACCOUNTS_KEY, ACTIVE_ACCOUNT_KEY, type SavedAccount, saveAccount, registerLegacyAccount, markActiveAccountUnavailable, removeActiveAccount } from "./account-registry";

export const LOGIN_GENERATION_KEY = "login-generation-v1";
export const CREDENTIALS_KEY = "credentials";
export const CREDENTIAL_VERSION_KEY = "credential-version";
export const LOGIN_PUBLIC_KEY = "login-public";
export const LOGIN_PRIVATE_KEY = "login-private";
export const GENERATION_KEY = "generation";
export const REAUTH_KEY = "reauth-required";
export const ADMIN_SESSIONS_KEY = "admin-sessions";
export const ADMIN_LOGIN_FAILURES_KEY = "admin-login-failures";
export const ACCESS_CONFIG_KEY = "access-config";

export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ADMIN_SESSION_LIMIT = 8;
export const ADMIN_LOGIN_FAILURE_LIMIT = 5;
export const ADMIN_LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_IMPORT_BYTES = 32 * 1024;
export const MAX_IMPORT_TOKEN_LENGTH = 12 * 1024;

export interface AdminAuthentication {
  kind: "bearer" | "session" | "access";
  sessionDigest?: string;
  expiresAt: number | null;
}

export interface AuthManagerDeps {
  timedFetch: (request: Request, timeoutMs?: number, maxResponseBytes?: number) => Promise<Response>;
  onDisconnect?: () => Promise<void> | void;
}

export function sessionCookie(value: string, requestUrl: string, maxAgeSeconds: number, trustedLanHttp = false): string {
  const url = new URL(requestUrl);
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || trustedLanHttp))) {
    throw new GatewayError(403, "secure_session_required", "管理会话只允许 HTTPS，或本机 loopback HTTP。", undefined, "permission_error");
  }
  return [
    `${ADMIN_SESSION_COOKIE}=${value}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(url.protocol === "https:" ? ["Secure"] : [])
  ].join("; ");
}

export class AuthManager {
  private startPromise: Promise<LoginPublicState> | null = null;
  private pollPromise: Promise<LoginPublicState> | null = null;
  private refreshTask: { promise: Promise<StoredCredentials>; state: { refreshed: boolean } } | null = null;
  private readonly accessVerifier = new AccessTokenVerifier();

  constructor(
    private readonly storage: AccountStorage,
    private readonly env: AccountServiceConfig,
    private readonly deps: AuthManagerDeps
  ) {}

  async initAccounts(): Promise<void> {
    try { await this.storage.transaction(tx => registerLegacyAccount(tx, this.env.TOKEN_ENCRYPTION_KEY)); }
    catch (error) {
      // Keep management available so corrupt legacy credentials can be replaced by explicit authorization.
      if (!(error instanceof GatewayError) || error.code !== "credential_decryption_failed") throw error;
    }
  }

  get refreshing(): boolean { return this.refreshTask !== null; }

  async loginGeneration(): Promise<number> {
    return (await this.storage.get<number>(LOGIN_GENERATION_KEY)) ?? (await this.currentGeneration());
  }

  async listAccounts(): Promise<Response> {
    const snapshot = await this.storage.transaction(async tx => ({
      rows: (await tx.get<SavedAccount[]>(ACCOUNTS_KEY)) ?? [],
      activeId: (await tx.get<string>(ACTIVE_ACCOUNT_KEY)) ?? null
    }));
    return Response.json({ activeAccountId: snapshot.activeId, accounts: snapshot.rows.map(({ credentials, ...row }) => ({
      ...row, connected: credentials !== null, isDefault: row.id === snapshot.activeId,
      reauthenticationRequired: row.reauthenticationReason !== null
    })) }, { headers: { "Cache-Control": "no-store" } });
  }

  async changeAccount(id: string, remove = false): Promise<Response> {
    await this.storage.transaction(async tx => {
      const login = await tx.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
      if (login?.status === "pending" && login.expiresAt > Date.now()) throw new GatewayError(409, "account_login_pending", "请先完成或取消正在进行的账号授权。", undefined, "invalid_request_error");
      const rows = (await tx.get<SavedAccount[]>(ACCOUNTS_KEY)) ?? [];
      const row = rows.find(item => item.id === id);
      if (!row) throw new GatewayError(404, "account_not_found", "没有找到该保存账号。", undefined, "invalid_request_error");
      const activeId = await tx.get<string>(ACTIVE_ACCOUNT_KEY);
      if (remove) {
        await tx.put(ACCOUNTS_KEY, rows.filter(item => item.id !== id));
        if (activeId !== id) return;
        await tx.delete([ACTIVE_ACCOUNT_KEY, CREDENTIALS_KEY, CREDENTIAL_VERSION_KEY, REAUTH_KEY]);
      } else {
        if (!row.credentials) throw new GatewayError(503, "account_reauthentication_required", "该账号需要重新授权后才能使用。", undefined, "authentication_error");
        if (activeId === id) return;
        const value = await decryptJson<StoredCredentials>(row.credentials, this.env.TOKEN_ENCRYPTION_KEY, "oneapi:credentials:v1");
        if (await hashSecret(value.accountId) !== row.id) throw new GatewayError(503, "account_state_corrupt", "保存账号状态不一致。", undefined, "server_error");
        await tx.put({ [ACTIVE_ACCOUNT_KEY]: id, [CREDENTIALS_KEY]: row.credentials, [CREDENTIAL_VERSION_KEY]: value.version });
        await tx.delete(REAUTH_KEY);
      }
      await tx.put(GENERATION_KEY, ((await tx.get<number>(GENERATION_KEY)) ?? 0) + 1);
      await tx.delete([LOGIN_PUBLIC_KEY, LOGIN_PRIVATE_KEY, "model-capabilities", "usage-cache"]);
    });
    return this.listAccounts();
  }

  async currentGeneration(): Promise<number> {
    return (await this.storage.get<number>(GENERATION_KEY)) ?? 0;
  }

  async nextGeneration(): Promise<number> {
    return this.storage.transaction(async (transaction) => {
      const value = ((await transaction.get<number>(GENERATION_KEY)) ?? 0) + 1;
      await transaction.put(GENERATION_KEY, value);
      return value;
    });
  }

  async readCredentials(): Promise<StoredCredentials | null> {
    const encrypted = await this.storage.get<EncryptedValue>(CREDENTIALS_KEY);
    if (!encrypted) return null;
    return decryptJson<StoredCredentials>(encrypted, this.env.TOKEN_ENCRYPTION_KEY, "oneapi:credentials:v1");
  }

  async prepareCredentials(value: StoredCredentials): Promise<EncryptedValue> {
    const encrypted = await encryptJson(value, this.env.TOKEN_ENCRYPTION_KEY, "oneapi:credentials:v1");
    const delayMs = this.env.MOCK_UPSTREAM === "true" ? mockPersistenceDelayMs() : 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return encrypted;
  }

  async writeCredentials(value: StoredCredentials): Promise<void> {
    const encrypted = await this.prepareCredentials(value);
    await this.storage.transaction(async (transaction) => {
      await saveAccount(transaction, value, encrypted, true);
      await transaction.put({ [CREDENTIALS_KEY]: encrypted, [CREDENTIAL_VERSION_KEY]: value.version });
      await transaction.delete(REAUTH_KEY);
    });
  }

  async loginStateBarrier(): Promise<void> {
    const delayMs = this.env.MOCK_UPSTREAM === "true" ? mockLoginStateDelayMs() : 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  async activeAdminSessions(now = Date.now()): Promise<StoredAdminSession[]> {
    const stored = (await this.storage.get<StoredAdminSession[]>(ADMIN_SESSIONS_KEY)) ?? [];
    const active = stored.filter((session) => session.expiresAt > now).slice(-ADMIN_SESSION_LIMIT);
    if (active.length !== stored.length) {
      if (active.length === 0) await this.storage.delete(ADMIN_SESSIONS_KEY);
      else await this.storage.put(ADMIN_SESSIONS_KEY, active);
    }
    return active;
  }

  async accessConfig(): Promise<AccessConfig> {
    const stored = await this.storage.get<AccessConfig>(ACCESS_CONFIG_KEY);
    if (!stored || typeof stored !== "object") return { ...DEFAULT_ACCESS_CONFIG };
    return {
      enabled: stored.enabled === true,
      teamDomain: typeof stored.teamDomain === "string" ? stored.teamDomain : null,
      applicationAud: typeof stored.applicationAud === "string" ? stored.applicationAud : null,
      updatedAt: typeof stored.updatedAt === "number" ? stored.updatedAt : 0,
      revision: typeof stored.revision === "number" ? stored.revision : 0
    };
  }

  async accessAuthentication(request: Request): Promise<AdminAuthentication> {
    const config = await this.accessConfig();
    const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!assertion) throw new GatewayError(401, "invalid_access_token", "缺少 Cloudflare Access 登录令牌。", undefined, "authentication_error");
    const identity = await this.accessVerifier.verify(assertion, config, (outbound) => this.deps.timedFetch(outbound, 5000, 64 * 1024));
    const latest = await this.accessConfig();
    if (
      latest.revision !== config.revision || latest.enabled !== config.enabled ||
      latest.teamDomain !== config.teamDomain || latest.applicationAud !== config.applicationAud
    ) {
      throw new GatewayError(401, "access_config_changed", "Cloudflare Access 配置已变更，请重新验证登录。", undefined, "authentication_error");
    }
    return { kind: "access", expiresAt: identity.expiresAt };
  }

  async sessionAuthentication(request: Request): Promise<AdminAuthentication | null> {
    const secret = cookieValue(request, ADMIN_SESSION_COOKIE);
    if (!secret) return null;
    const digest = await hashSecret(secret);
    const session = (await this.activeAdminSessions()).find((candidate) => candidate.digest === digest);
    return session ? { kind: "session", sessionDigest: digest, expiresAt: session.expiresAt } : null;
  }

  async authenticateAdmin(request: Request): Promise<AdminAuthentication> {
    if (bearerToken(request) !== null) {
      requireBearer(request, this.env.ADMIN_API_KEY, "admin");
      return { kind: "bearer", expiresAt: null };
    }
    let accessFailure: unknown = null;
    if (request.headers.has("Cf-Access-Jwt-Assertion")) {
      try {
        return await this.accessAuthentication(request);
      } catch (error) {
        accessFailure = error;
      }
    }
    const session = await this.sessionAuthentication(request);
    if (!session) {
      if (accessFailure) throw accessFailure;
      throw new GatewayError(401, "invalid_admin_session", "管理员登录已失效，请重新登录。", undefined, "authentication_error");
    }
    return session;
  }

  async adminSessionStatus(request: Request): Promise<Response> {
    if (bearerToken(request) !== null) {
      requireBearer(request, this.env.ADMIN_API_KEY, "admin");
      return Response.json({ authenticated: true, expiresAt: null, provider: "bearer", logoutUrl: null }, { headers: { "Cache-Control": "no-store" } });
    }
    let authentication: AdminAuthentication | null = null;
    try {
      authentication = await this.authenticateAdmin(request);
    } catch (error) {
      if (!(error instanceof GatewayError) || error.status !== 401) throw error;
    }
    return Response.json({
      authenticated: Boolean(authentication),
      expiresAt: authentication?.expiresAt ?? null,
      provider: authentication?.kind ?? null,
      logoutUrl: authentication?.kind === "access" ? "/cdn-cgi/access/logout" : null
    }, { headers: { "Cache-Control": "no-store" } });
  }

  async getAccessConfig(): Promise<Response> {
    const { enabled, teamDomain, applicationAud, updatedAt } = await this.accessConfig();
    return Response.json({ enabled, teamDomain, applicationAud, updatedAt }, { headers: { "Cache-Control": "no-store" } });
  }

  async publicAccessStatus(): Promise<Response> {
    const config = await this.accessConfig();
    let enabled = false;
    if (config.enabled && config.teamDomain && config.applicationAud) {
      try {
        const checked = validateAccessConfig({
          enabled: true,
          teamDomain: config.teamDomain,
          applicationAud: config.applicationAud
        }, config.revision);
        enabled = checked.teamDomain === config.teamDomain && checked.applicationAud === config.applicationAud;
      } catch {
        enabled = false;
      }
    }
    return Response.json({ enabled }, { headers: { "Cache-Control": "no-store" } });
  }

  async patchAccessConfig(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const current = await this.accessConfig();
    const next = validateAccessConfig(body, current.revision);
    await this.storage.put(ACCESS_CONFIG_KEY, next);
    this.accessVerifier.clear();
    const { enabled, teamDomain, applicationAud, updatedAt } = next;
    return Response.json({ enabled, teamDomain, applicationAud, updatedAt }, { headers: { "Cache-Control": "no-store" } });
  }

  async createAdminSession(request: Request, context: AccountRequestContext): Promise<Response> {
    const body = await readJsonBody(request);
    if (typeof body.password !== "string" || body.password.length > 1024 || Object.keys(body).some((key) => key !== "password")) {
      throw new GatewayError(400, "invalid_request", "登录只接受管理员口令。", "password");
    }
    const now = Date.now();
    const passwordMatches = Boolean(this.env.ADMIN_API_KEY) && timingSafeEqual(body.password, this.env.ADMIN_API_KEY);
    let rateLimited = false;
    await this.storage.transaction(async (transaction) => {
      const failures = ((await transaction.get<number[]>(ADMIN_LOGIN_FAILURES_KEY)) ?? [])
        .filter((timestamp) => timestamp > now - ADMIN_LOGIN_FAILURE_WINDOW_MS)
        .slice(-ADMIN_LOGIN_FAILURE_LIMIT);
      if (failures.length >= ADMIN_LOGIN_FAILURE_LIMIT) {
        rateLimited = true;
        return;
      }
      if (passwordMatches) await transaction.delete(ADMIN_LOGIN_FAILURES_KEY);
      else await transaction.put(ADMIN_LOGIN_FAILURES_KEY, [...failures, now]);
    });
    if (rateLimited) {
      throw new GatewayError(429, "admin_login_rate_limited", "管理员登录失败次数过多，请稍后重试。", undefined, "rate_limit_error");
    }
    if (!passwordMatches) {
      throw new GatewayError(401, "invalid_admin_password", "管理员口令无效。", undefined, "authentication_error");
    }
    const secret = randomSecret();
    const digest = await hashSecret(secret);
    const expiresAt = now + ADMIN_SESSION_TTL_MS;
    await this.storage.transaction(async (transaction) => {
      const sessions = ((await transaction.get<StoredAdminSession[]>(ADMIN_SESSIONS_KEY)) ?? [])
        .filter((session) => session.expiresAt > now)
        .slice(-(ADMIN_SESSION_LIMIT - 1));
      await transaction.put(ADMIN_SESSIONS_KEY, [...sessions, { digest, createdAt: now, expiresAt }]);
    });
    return Response.json({ authenticated: true, expiresAt }, {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": sessionCookie(secret, request.url, Math.floor(ADMIN_SESSION_TTL_MS / 1000), context.trustedLanHttp === true)
      }
    });
  }

  async deleteAdminSession(request: Request, authentication: AdminAuthentication, context: AccountRequestContext): Promise<Response> {
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 0) {
      throw new GatewayError(400, "invalid_request", "退出后台不接受参数。", "body");
    }
    if (authentication.kind === "session" && authentication.sessionDigest) {
      await this.storage.transaction(async (transaction) => {
        const sessions = (await transaction.get<StoredAdminSession[]>(ADMIN_SESSIONS_KEY)) ?? [];
        const remaining = sessions.filter((session) => session.digest !== authentication.sessionDigest);
        if (remaining.length === 0) await transaction.delete(ADMIN_SESSIONS_KEY);
        else await transaction.put(ADMIN_SESSIONS_KEY, remaining);
      });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": sessionCookie("", request.url, 0, context.trustedLanHttp === true),
        ...(authentication.kind === "access" ? { "X-OneAPI-Access-Logout": "/cdn-cgi/access/logout" } : {})
      }
    });
  }

  async importCredentials(request: Request): Promise<Response> {
    if (new URL(request.url).protocol !== "https:") {
      throw new GatewayError(403, "tls_required", "账户导入只允许通过 HTTPS。", undefined, "permission_error");
    }
    requireBearer(request, this.env.ADMIN_API_KEY, "admin");
    const configuredSecret = this.env.ACCOUNT_IMPORT_SECRET ?? "";
    const suppliedSecret = request.headers.get("X-OneAPI-Import-Secret") ?? "";
    if (configuredSecret.length < 32 || configuredSecret.length > 1024) {
      throw new GatewayError(404, "account_import_disabled", "账户导入未启用。", undefined, "permission_error");
    }
    if (suppliedSecret.length > 1024 || !timingSafeEqual(suppliedSecret, configuredSecret)) {
      throw new GatewayError(401, "invalid_import_secret", "账户导入功能密钥无效。", undefined, "authentication_error");
    }
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_IMPORT_BYTES)) {
      throw new GatewayError(413, "request_too_large", "账户导入请求超过 32 KiB 限制。", "body");
    }
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.byteLength;
          if (total > MAX_IMPORT_BYTES) {
            await reader.cancel("request too large").catch(() => undefined);
            throw new GatewayError(413, "request_too_large", "账户导入请求超过 32 KiB 限制。", "body");
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let body: Record<string, unknown>;
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
      body = value as Record<string, unknown>;
    } catch {
      throw new GatewayError(400, "invalid_json", "账户导入请求必须是有效 UTF-8 JSON 对象。", "body");
    }
    if (
      Object.keys(body).some((key) => !["idToken", "accessToken", "refreshToken"].includes(key)) ||
      !["idToken", "accessToken", "refreshToken"].every((key) => {
        const value = body[key];
        return typeof value === "string" && value.length >= 16 && value.length <= MAX_IMPORT_TOKEN_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(value);
      })
    ) {
      throw new GatewayError(400, "invalid_oauth_import", "账户导入只接受有效的 idToken、accessToken 和 refreshToken。", "body");
    }
    const existing = await this.readCredentials();
    if (existing) throw new GatewayError(409, "account_already_connected", "当前 Worker 已连接账户，不能导入覆盖。", undefined, "invalid_request_error");
    const idToken = body.idToken as string;
    const accessToken = body.accessToken as string;
    const refreshToken = body.refreshToken as string;
    const accountId = accountIdFromIdToken(idToken);
    if (!accountId) throw new GatewayError(400, "invalid_oauth_import", "导入的 idToken 不含有效账户标识。", "idToken");
    const credentials: StoredCredentials = {
      idToken,
      accessToken,
      refreshToken,
      accountId,
      expiresAt: jwtExpirationMs(accessToken),
      lastRefreshAt: Date.now(),
      version: 1
    };
    await fetchModels((outbound) => this.deps.timedFetch(outbound, 5000), credentials);
    const encrypted = await this.prepareCredentials(credentials);
    await this.storage.transaction(async (transaction) => {
      if (await transaction.get(CREDENTIALS_KEY)) {
        throw new GatewayError(409, "account_already_connected", "当前 Worker 已连接账户，不能导入覆盖。", undefined, "invalid_request_error");
      }
      await saveAccount(transaction, credentials, encrypted, true);
      const generation = ((await transaction.get<number>(GENERATION_KEY)) ?? 0) + 1;
      await transaction.put({
        [GENERATION_KEY]: generation,
        [CREDENTIALS_KEY]: encrypted,
        [CREDENTIAL_VERSION_KEY]: credentials.version
      });
      await transaction.delete([LOGIN_PUBLIC_KEY, LOGIN_PRIVATE_KEY, "model-capabilities", "leases", REAUTH_KEY, "usage-cache"]);
    });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  async status(): Promise<Response> {
    const credentials = await this.readCredentials();
    let login = await this.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
    if (login?.status === "pending" && login.expiresAt <= Date.now()) {
      const observedId = login.id;
      await this.storage.transaction(async (transaction) => {
        const current = await transaction.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
        if (current?.id === observedId && current.status === "pending" && current.expiresAt <= Date.now()) {
          login = { ...current, status: "expired", userCode: "", error: { code: "device_auth_expired", message: "设备码已过期，请重新发起。" } };
          await transaction.put(LOGIN_PUBLIC_KEY, login);
          await transaction.delete(LOGIN_PRIVATE_KEY);
        } else {
          login = current;
        }
      });
    }
    const reauthentication = await this.storage.get<boolean | { code: string; at: number }>(REAUTH_KEY);
    return Response.json({
      connected: Boolean(credentials),
      account: credentials ? {
        id: credentials.accountId,
        idHint: `…${credentials.accountId.slice(-6)}`,
        ...accountInfoFromIdToken(credentials.idToken),
        tokenExpiresAt: credentials.expiresAt,
        lastRefreshAt: credentials.lastRefreshAt
      } : null,
      login: login ? {
        id: login.id,
        status: login.status,
        verificationUrl: login.verificationUrl,
        userCode: login.userCode,
        expiresAt: login.expiresAt,
        nextPollAt: login.nextPollAt,
        intervalMs: login.intervalMs,
        ...(login.error ? { error: login.error } : {})
      } : null,
      reauthenticationRequired: Boolean(reauthentication),
      ...(reauthentication && typeof reauthentication === "object" ? { reauthenticationReason: reauthentication.code } : {})
    }, { headers: { "Cache-Control": "no-store" } });
  }

  async startLogin(): Promise<LoginPublicState> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        const existing = await this.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
        if (existing?.status === "pending" && existing.expiresAt > Date.now()) return existing;
        const generation = await this.storage.transaction(async tx => {
          const value = ((await tx.get<number>(LOGIN_GENERATION_KEY)) ?? (await tx.get<number>(GENERATION_KEY)) ?? 0) + 1;
          await tx.put(LOGIN_GENERATION_KEY, value);
          return value;
        });
        const result = await requestDeviceCode((request) => this.deps.timedFetch(request));
        if (await this.loginGeneration() !== generation) throw new GatewayError(409, "login_superseded", "登录请求已被取消或替代。", undefined, "invalid_request_error");
        const intervalMs = this.env.MOCK_UPSTREAM === "true" ? 25 : result.intervalMs;
        const publicState: LoginPublicState = {
          id: crypto.randomUUID(),
          status: "pending",
          verificationUrl: result.verificationUrl,
          userCode: result.userCode,
          expiresAt: result.expiresAt,
          nextPollAt: Date.now() + intervalMs,
          intervalMs,
          generation
        };
        const privateState = await encryptJson({ deviceAuthId: result.deviceAuthId } satisfies LoginPrivateState, this.env.TOKEN_ENCRYPTION_KEY, `oneapi:login:${generation}`);
        await this.loginStateBarrier();
        await this.storage.transaction(async (transaction) => {
          const transactionGeneration = (await transaction.get<number>(LOGIN_GENERATION_KEY)) ?? 0;
          if (transactionGeneration !== generation) throw new GatewayError(409, "login_superseded", "登录请求已被取消或替代。", undefined, "invalid_request_error");
          await transaction.put({ [LOGIN_PUBLIC_KEY]: publicState, [LOGIN_PRIVATE_KEY]: privateState });
        });
        return publicState;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  async pollLogin(loginId: string): Promise<LoginPublicState> {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = (async () => {
      try {
        const current = await this.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
        if (!current || current.id !== loginId) throw new GatewayError(404, "login_not_found", "没有找到该登录请求。", "login_id");
        if (current.status !== "pending") return current;
        if (current.expiresAt <= Date.now()) {
          return this.storage.transaction(async (transaction) => {
            const latest = await transaction.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
            if (!latest || latest.id !== current.id || latest.status !== "pending") {
              throw new GatewayError(409, "login_superseded", "登录查询已被取消或替代。", undefined, "invalid_request_error");
            }
            const expired = { ...latest, status: "expired" as const, userCode: "", error: { code: "device_auth_expired", message: "设备码已过期，请重新发起。" } };
            await transaction.put(LOGIN_PUBLIC_KEY, expired);
            await transaction.delete(LOGIN_PRIVATE_KEY);
            return expired;
          });
        }
        if (current.nextPollAt > Date.now()) {
          throw new GatewayError(429, "poll_too_soon", "设备码查询过于频繁，请等待 nextPollAt。", undefined, "rate_limit_error");
        }
        const encrypted = await this.storage.get<EncryptedValue>(LOGIN_PRIVATE_KEY);
        if (!encrypted) throw new GatewayError(503, "login_state_corrupt", "登录内部状态缺失，请取消后重试。", undefined, "server_error");
        const privateState = await decryptJson<LoginPrivateState>(encrypted, this.env.TOKEN_ENCRYPTION_KEY, `oneapi:login:${current.generation}`);
        const waiting = { ...current, nextPollAt: Date.now() + current.intervalMs };
        await this.loginStateBarrier();
        await this.storage.transaction(async (transaction) => {
          const generation = (await transaction.get<number>(LOGIN_GENERATION_KEY)) ?? 0;
          const login = await transaction.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
          if (generation !== current.generation || !login || login.id !== current.id || login.status !== "pending") {
            throw new GatewayError(409, "login_superseded", "登录查询已被取消或替代。", undefined, "invalid_request_error");
          }
          await transaction.put(LOGIN_PUBLIC_KEY, waiting);
        });
        const poll = await pollDeviceCode((request) => this.deps.timedFetch(request), privateState.deviceAuthId, current.userCode);
        if (poll.status === "pending") return waiting;
        const tokens = await exchangeDeviceCode((request) => this.deps.timedFetch(request), poll.authorizationCode, poll.codeVerifier);
        const latest = await this.storage.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
        if (!latest || latest.generation !== current.generation || latest.status !== "pending" || await this.loginGeneration() !== current.generation) {
          throw new GatewayError(409, "login_superseded", "登录响应到达时请求已被取消或替代，未保存凭据。", undefined, "invalid_request_error");
        }
        const accountId = accountIdFromIdToken(tokens.idToken);
        if (!accountId) throw new GatewayError(502, "account_id_missing", "可信 OAuth 响应未包含 ChatGPT account id，未保存凭据。", undefined, "authentication_error");
        const credentials: StoredCredentials = {
          idToken: tokens.idToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accountId,
          expiresAt: jwtExpirationMs(tokens.accessToken),
          lastRefreshAt: Date.now(),
          version: 1
        };
        const encryptedCredentials = await this.prepareCredentials(credentials);
        let connected: LoginPublicState | undefined;
        await this.storage.transaction(async (transaction) => {
          const transactionGeneration = (await transaction.get<number>(LOGIN_GENERATION_KEY)) ?? 0;
          const transactionLogin = await transaction.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
          if (transactionGeneration !== current.generation || !transactionLogin || transactionLogin.generation !== current.generation || transactionLogin.status !== "pending") {
            throw new GatewayError(409, "login_superseded", "登录响应到达时请求已被取消或替代，未保存凭据。", undefined, "invalid_request_error");
          }
          connected = { ...transactionLogin, status: "connected", userCode: "", nextPollAt: 0 };
          const activeId = await transaction.get<string>(ACTIVE_ACCOUNT_KEY);
          const id = await hashSecret(credentials.accountId);
          const activate = !activeId || activeId === id;
          await saveAccount(transaction, credentials, encryptedCredentials, activate);
          await transaction.put(LOGIN_PUBLIC_KEY, connected);
          await transaction.delete(LOGIN_PRIVATE_KEY);
          if (activate) {
            await transaction.put({ [CREDENTIALS_KEY]: encryptedCredentials, [CREDENTIAL_VERSION_KEY]: credentials.version,
              [GENERATION_KEY]: ((await transaction.get<number>(GENERATION_KEY)) ?? 0) + 1 });
            await transaction.delete([REAUTH_KEY, "model-capabilities", "usage-cache"]);
          }
        });
        if (!connected) throw new GatewayError(500, "credential_commit_failed", "凭据事务未完成。", undefined, "server_error");
        return connected;
      } finally {
        this.pollPromise = null;
      }
    })();
    return this.pollPromise;
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<LoginPublicState>(LOGIN_PUBLIC_KEY);
      if (!current || current.id !== loginId) throw new GatewayError(404, "login_not_found", "没有找到该登录请求。", "login_id");
      const generation = ((await transaction.get<number>(LOGIN_GENERATION_KEY)) ?? 0) + 1;
      await transaction.put({
        [LOGIN_GENERATION_KEY]: generation,
        [LOGIN_PUBLIC_KEY]: { ...current, status: "cancelled", userCode: "", nextPollAt: 0 }
      });
      await transaction.delete(LOGIN_PRIVATE_KEY);
    });
  }

  async disconnect(): Promise<void> {
    if (this.deps.onDisconnect) {
      await this.deps.onDisconnect();
    }
    await this.storage.transaction(async (transaction) => {
      const generation = ((await transaction.get<number>(GENERATION_KEY)) ?? 0) + 1;
      await removeActiveAccount(transaction);
      await transaction.put({ [GENERATION_KEY]: generation, [LOGIN_GENERATION_KEY]: ((await transaction.get<number>(LOGIN_GENERATION_KEY)) ?? generation) + 1 });
      await transaction.delete([CREDENTIALS_KEY, CREDENTIAL_VERSION_KEY, LOGIN_PUBLIC_KEY, LOGIN_PRIVATE_KEY, "model-capabilities", "leases", REAUTH_KEY, "usage-cache"]);
    });
  }

  async disableRejectedCredentials(expectedGeneration: number, expectedVersion: number): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      const version = await transaction.get<number>(CREDENTIAL_VERSION_KEY);
      if (generation !== expectedGeneration || version !== expectedVersion) return;
      await transaction.delete([CREDENTIALS_KEY, CREDENTIAL_VERSION_KEY, "usage-cache"]);
      await markActiveAccountUnavailable(transaction, "refreshed_token_rejected");
      await transaction.put(REAUTH_KEY, { code: "refreshed_token_rejected", at: Date.now() });
    });
  }

  async refreshCredentials(force = false): Promise<StoredCredentials> {
    const existing = this.refreshTask;
    if (existing) {
      const credentials = await existing.promise;
      if (!force || existing.state.refreshed) return credentials;
      // A shared fresh-token read did no OAuth work: force must start or join a real refresh.
      if (this.refreshTask === existing) this.refreshTask = null;
      return this.refreshCredentials(true);
    }
    // Establish the shared task before the first await, including credential and generation reads.
    const state = { refreshed: false };
    const running = (async () => {
      const credentials = await this.readCredentials();
      if (!credentials) throw new GatewayError(503, "account_not_connected", "尚未连接 Codex 账户。", undefined, "authentication_error");
      const due = credentials.expiresAt !== null
        ? credentials.expiresAt <= Date.now() + 5 * 60 * 1000
        : credentials.lastRefreshAt <= Date.now() - 8 * 24 * 60 * 60 * 1000;
      if (!force && !due) return credentials;
      const expectedGeneration = await this.currentGeneration();
      state.refreshed = true;
      try {
        const updated = await refreshOAuthTokens((request) => this.deps.timedFetch(request), credentials.refreshToken);
        const current = await this.readCredentials();
        if (!current || current.version !== credentials.version || await this.currentGeneration() !== expectedGeneration) {
          throw new GatewayError(409, "refresh_superseded", "账户在刷新期间已变更，旧刷新结果未写回。", undefined, "invalid_request_error");
        }
        if (updated.idToken && accountIdFromIdToken(updated.idToken) !== current.accountId) throw new GatewayError(503, "account_reauthentication_required", "刷新响应的账号身份不一致，请重新授权。", undefined, "authentication_error");
        const next: StoredCredentials = {
          ...current,
          idToken: updated.idToken ?? current.idToken,
          accessToken: updated.accessToken ?? current.accessToken,
          refreshToken: updated.refreshToken ?? current.refreshToken,
          accountId: updated.idToken ? accountIdFromIdToken(updated.idToken) ?? current.accountId : current.accountId,
          expiresAt: updated.accessToken ? jwtExpirationMs(updated.accessToken) : current.expiresAt,
          lastRefreshAt: Date.now(),
          version: current.version + 1
        };
        const encrypted = await this.prepareCredentials(next);
        await this.storage.transaction(async (transaction) => {
          const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
          const version = await transaction.get<number>(CREDENTIAL_VERSION_KEY);
          if (generation !== expectedGeneration || version !== credentials.version) {
            throw new GatewayError(409, "refresh_superseded", "账户在刷新期间已变更，旧刷新结果未写回。", undefined, "invalid_request_error");
          }
          await saveAccount(transaction, next, encrypted, true);
          await transaction.put({ [CREDENTIALS_KEY]: encrypted, [CREDENTIAL_VERSION_KEY]: next.version });
          await transaction.delete(REAUTH_KEY);
        });
        return next;
      } catch (error) {
        if (error instanceof GatewayError && error.code === "refresh_superseded") throw error;
        if (await this.currentGeneration() !== expectedGeneration) {
          throw new GatewayError(409, "refresh_superseded", "账户在刷新期间已断开或变更，旧刷新结果未写回。", undefined, "invalid_request_error");
        }
        const explicit = error instanceof GatewayError && error.code === "account_reauthentication_required";
        const reason = explicit ? "account_reauthentication_required" : "refresh_result_uncertain";
        let superseded = false;
        await this.storage.transaction(async (transaction) => {
          const generation = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
          const version = await transaction.get<number>(CREDENTIAL_VERSION_KEY);
          if (generation !== expectedGeneration || version !== credentials.version) {
            superseded = true;
            return;
          }
          await transaction.delete([CREDENTIALS_KEY, CREDENTIAL_VERSION_KEY, "usage-cache"]);
          await markActiveAccountUnavailable(transaction, reason);
          await transaction.put(REAUTH_KEY, { code: reason, at: Date.now() });
        });
        if (superseded) throw new GatewayError(409, "refresh_superseded", "账户在刷新期间已断开或变更，旧刷新结果未写回。", undefined, "invalid_request_error");
        if (explicit) throw error;
        throw new GatewayError(
          503,
          "refresh_result_uncertain",
          "Codex token 刷新结果不确定；为避免重复使用 refresh token，凭据已停用，请重新连接账户。",
          undefined,
          "authentication_error"
        );
      }
    })();
    const task = { promise: running, state };
    this.refreshTask = task;
    try { return await running; }
    finally { if (this.refreshTask === task) this.refreshTask = null; }
  }

  clearAccessVerifier(): void {
    this.accessVerifier.clear();
  }
}
