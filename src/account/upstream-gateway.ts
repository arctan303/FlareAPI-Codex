import { GatewayError } from "../errors";
import type {
  GatewayIdentity,
  ModelCapability,
  RequestLogUsage,
  UsageSnapshot
} from "../types";
import { mockUpstreamFetch } from "../codex/mock";
import {
  collectUpstreamDiagnostic,
  createModelsRequest,
  createResponseRequest,
  createUsageRequest,
  fetchModels,
  fetchResponseStream,
  fetchUsage,
  generationAbortError
} from "../codex/upstream";
import { CLIENT_VERSION } from "../codex/constants";
import { probeResponsesWebSocket } from "../codex/websocket-probe";
import { normalizeChat, normalizeResponses, readJsonBody, type NormalizedRequest } from "../protocol/requests";
import { chatEventStream, collectCompletedResponse, responseEventStream, responseToChat } from "../protocol/responses";
import {
  LOCAL_REQUEST_GROUP_HEADER,
  type AccountServiceConfig,
  type AccountServiceOptions,
  type AccountStorage
} from "../runtime/contracts";
import { modelAllowed } from "../controls";
import { StreamBodyCapture, usageFromResponse } from "../observability";
import { normalizeUsagePayload } from "../usage";
import {
  decodeRelayBody,
  decryptRelayResponse,
  encryptRelayRequest,
  fixedRelayGenerationBody,
  parseRelayKey,
  RELAY_REQUEST_ENVELOPE_MAX_BYTES,
  RELAY_RESPONSE_ENVELOPE_MAX_BYTES,
  relayEnvelopeBytes,
  type RelayOperation,
  type RelayRequest,
  type RelayResponse
} from "../relay-protocol";
import type { OutboundFetch } from "../codex/auth";
import type { AuthManager } from "./auth-manager";
import { CREDENTIAL_VERSION_KEY, GENERATION_KEY } from "./auth-manager";
import type { KeyManager } from "./key-manager";
import type { ActiveLog, AuditLogger } from "./audit-logger";
import { captureStreamBody, gatewayOutcome, gatewayStatus } from "./audit-logger";

export const MODEL_CACHE_KEY = "model-capabilities";
export const USAGE_CACHE_KEY = "usage-cache";
export const LEASES_KEY = "leases";

export const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
export const LEASE_LIMIT = 2;
export const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
export const USAGE_CACHE_MS = 30_000;
export const MODEL_CATALOG_CACHE_MS = 5 * 60 * 1000;
export const MODEL_CATALOG_CACHE_VERSION = 3;
export const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const REQUEST_GROUP_LIMIT = 256;
export const REQUEST_GROUP_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REQUEST_GROUP_TTL_MS = GENERATION_TIMEOUT_MS + 5_000;

export interface LeaseRecord {
  expiresAt: number;
  keyId: string | null;
}

export interface RequestGroupState {
  cancelled: boolean;
  leaseId: string | null;
  expiresAt: number;
}

export interface UsageCacheRecord {
  accountId: string;
  snapshot: UsageSnapshot;
}

export interface ModelCatalogCacheRecord {
  version: 3;
  accountId: string;
  generation: number;
  fetchedAt: number;
  models: ModelCapability[];
}

export interface ModelCatalogLoad {
  accountId: string;
  generation: number;
  promise: Promise<ModelCapability[]>;
}

export interface EgressObservation {
  status: number;
  ok: boolean;
  contentType: string;
  bodyBytes: number;
  bodySha256: string;
  diagnostic?: import("../errors").UpstreamDiagnostic;
  modelCount?: number;
  modelIds?: string[];
  usage?: UsageSnapshot["windows"] | RequestLogUsage;
  completed?: boolean;
  responseChars?: number;
}

async function responseFingerprint(response: Response): Promise<{ contentType: string; bodyBytes: number; bodySha256: string }> {
  const raw = new Uint8Array(await response.arrayBuffer());
  const bytes = new Uint8Array(new ArrayBuffer(raw.byteLength));
  bytes.set(raw);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer));
  return {
    contentType: (response.headers.get("content-type") ?? "").replace(/[^\x20-\x7E]/g, "?").slice(0, 100),
    bodyBytes: bytes.byteLength,
    bodySha256: Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("")
  };
}

export class UpstreamGateway {
  private readonly activeControllers = new Set<AbortController>();
  private readonly activeGenerations = new Map<string, { controller: AbortController; cancel: () => void; finish: () => Promise<void>; groupId?: string }>();
  private readonly requestGroups = new Map<string, RequestGroupState>();
  private readonly leases = new Map<string, LeaseRecord>();
  private modelCatalogLoad: ModelCatalogLoad | null = null;

  constructor(
    private readonly storage: AccountStorage,
    private readonly env: AccountServiceConfig,
    private readonly options: AccountServiceOptions,
    private readonly authManager: AuthManager,
    private readonly keyManager: KeyManager,
    private readonly auditLogger: AuditLogger
  ) {}

  async init(): Promise<void> {
    this.leases.clear();
    await this.storage.delete(LEASES_KEY);
  }

  performFetch: OutboundFetch = async (request) => {
    if (this.env.MOCK_UPSTREAM === "true") return mockUpstreamFetch(request);
    return this.options.outboundFetch ? this.options.outboundFetch(request) : fetch(request);
  };

  async timedFetch(request: Request, timeoutMs = 10_000, maxResponseBytes = MAX_CONTROL_RESPONSE_BYTES): Promise<Response> {
    if (this.env.MOCK_UPSTREAM === "true") timeoutMs = Math.min(timeoutMs, 100);
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs);
    this.activeControllers.add(controller);
    try {
      const response = await this.performFetch(new Request(request, { signal: controller.signal }));
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) > maxResponseBytes) {
        throw new GatewayError(502, "upstream_response_too_large", "认证或模型响应超过服务端限制。", undefined, "server_error");
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxResponseBytes) {
          controller.abort(new Error("control response too large"));
          throw new GatewayError(502, "upstream_response_too_large", "认证或模型响应超过服务端限制。", undefined, "server_error");
        }
        chunks.push(next.value);
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (controller.signal.aborted) throw new GatewayError(504, "upstream_timeout", "上游请求超时或已取消。", undefined, "timeout_error");
      throw new GatewayError(502, "upstream_network_error", "无法连接上游服务。", undefined, "server_error");
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      this.activeControllers.delete(controller);
    }
  }

  abortAllActive(): void {
    for (const controller of this.activeControllers) controller.abort(new Error("account disconnected"));
  }

  async dispose(): Promise<void> {
    for (const controller of this.activeControllers) controller.abort(new Error("runtime disposed"));
    const generations = [...this.activeGenerations.values()];
    for (const generation of generations) generation.cancel();
    await Promise.allSettled(generations.map((generation) => generation.finish()));
    this.requestGroups.clear();
    this.leases.clear();
  }

  async usage(force: boolean, includeDiagnostic = false): Promise<Response> {
    const connected = await this.authManager.readCredentials();
    const fetchedAt = Date.now();
    if (!connected) {
      await this.storage.delete(USAGE_CACHE_KEY);
      return Response.json({
        available: false,
        fetchedAt,
        lastSuccessAt: null,
        error: { code: "account_not_connected", message: "尚未连接 Codex 账户。" },
        windows: { fiveHour: null, sevenDay: null },
        additional: []
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const cached = await this.storage.get<UsageCacheRecord>(USAGE_CACHE_KEY);
    const sameAccountCache = cached?.accountId === connected.accountId ? cached : null;
    if (!force && sameAccountCache && sameAccountCache.snapshot.fetchedAt > fetchedAt - USAGE_CACHE_MS) {
      return Response.json(sameAccountCache.snapshot, { headers: { "Cache-Control": "no-store" } });
    }
    try {
      let credentials = await this.authManager.refreshCredentials();
      let expectedGeneration = await this.authManager.currentGeneration();
      let response: Response;
      try {
        response = await fetchUsage((request) => this.timedFetch(request, 5000), credentials);
      } catch (error) {
        if (!(error instanceof GatewayError) || error.code !== "account_reauthentication_required") throw error;
        credentials = await this.authManager.refreshCredentials(true);
        expectedGeneration = await this.authManager.currentGeneration();
        const retryVersion = credentials.version;
        try {
          response = await fetchUsage((request) => this.timedFetch(request, 5000), credentials);
        } catch (retryError) {
          if (retryError instanceof GatewayError && retryError.code === "account_reauthentication_required") {
            await this.authManager.disableRejectedCredentials(expectedGeneration, retryVersion);
          }
          throw retryError;
        }
      }
      const raw = await response.json() as unknown;
      const snapshot = normalizeUsagePayload(raw, fetchedAt);
      const current = await this.authManager.readCredentials();
      if (!current || current.accountId !== credentials.accountId || await this.authManager.currentGeneration() !== expectedGeneration) {
        throw new GatewayError(409, "usage_superseded", "额度响应到达时账户已变更，旧结果未保存。", undefined, "invalid_request_error");
      }
      await this.storage.put(USAGE_CACHE_KEY, { accountId: credentials.accountId, snapshot } satisfies UsageCacheRecord);
      return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const known = error instanceof GatewayError
        ? error
        : new GatewayError(502, "usage_unavailable", "无法读取官方额度。", undefined, "server_error");
      return Response.json({
        available: false,
        fetchedAt,
        lastSuccessAt: sameAccountCache?.snapshot.lastSuccessAt ?? null,
        error: {
          code: known.code,
          message: known.message,
          ...(includeDiagnostic && known.diagnostic ? { diagnostic: known.diagnostic } : {})
        },
        windows: { fiveHour: null, sevenDay: null },
        additional: []
      }, { headers: { "Cache-Control": "no-store" } });
    }
  }

  parseModelCatalog(body: Record<string, unknown>): ModelCapability[] {
    if (!Array.isArray(body.models)) {
      throw new GatewayError(502, "invalid_models_response", "上游模型目录缺少 models 数组。", undefined, "server_error");
    }
    const capabilities: ModelCapability[] = [];
    for (const raw of body.models) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const model = raw as Record<string, unknown>;
      if (typeof model.slug !== "string" || model.visibility === "hide") continue;
      let supportedEfforts: string[] | null = null;
      if (Array.isArray(model.supported_reasoning_levels)) {
        const parsed: string[] = [];
        let valid = true;
        for (const rawLevel of model.supported_reasoning_levels) {
          if (!rawLevel || typeof rawLevel !== "object" || Array.isArray(rawLevel)) {
            valid = false;
            break;
          }
          const effort = (rawLevel as Record<string, unknown>).effort;
          if (typeof effort !== "string" || !REASONING_EFFORT_PATTERN.test(effort)) {
            valid = false;
            break;
          }
          if (!parsed.includes(effort)) parsed.push(effort);
        }
        if (valid) supportedEfforts = parsed;
      }
      const rawDefault = model.default_reasoning_level;
      const defaultEffort = typeof rawDefault === "string"
        && supportedEfforts !== null
        && supportedEfforts.includes(rawDefault)
        ? rawDefault
        : null;
      capabilities.push({ id: model.slug, codex: model, reasoning: { supportedEfforts, defaultEffort } });
    }
    return capabilities;
  }

  async fetchModelCatalog(): Promise<ModelCapability[]> {
    let credentials = await this.authManager.refreshCredentials();
    let expectedGeneration = await this.authManager.currentGeneration();
    let response: Response;
    try {
      response = await fetchModels((request) => this.timedFetch(request, 5000), credentials);
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== "account_reauthentication_required") throw error;
      credentials = await this.authManager.refreshCredentials(true);
      expectedGeneration = await this.authManager.currentGeneration();
      try {
        response = await fetchModels((request) => this.timedFetch(request, 5000), credentials);
      } catch (retryError) {
        if (retryError instanceof GatewayError && retryError.code === "account_reauthentication_required") {
          await this.authManager.disableRejectedCredentials(expectedGeneration, credentials.version);
        }
        throw retryError;
      }
    }
    let body: Record<string, unknown>;
    try {
      const parsed = await response.json() as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new GatewayError(502, "invalid_models_response", "上游模型目录不是 JSON 对象。", undefined, "server_error");
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(502, "invalid_models_response", "上游模型目录不是有效 JSON。", undefined, "server_error");
    }
    const models = this.parseModelCatalog(body);
    const cache: ModelCatalogCacheRecord = {
      version: MODEL_CATALOG_CACHE_VERSION,
      accountId: credentials.accountId,
      generation: expectedGeneration,
      fetchedAt: Date.now(),
      models
    };
    await this.storage.transaction(async (transaction) => {
      const currentGeneration = (await transaction.get<number>(GENERATION_KEY)) ?? 0;
      const currentVersion = await transaction.get<number>(CREDENTIAL_VERSION_KEY);
      if (currentGeneration !== expectedGeneration || currentVersion !== credentials.version) {
        throw new GatewayError(409, "models_superseded", "模型目录响应到达时账户已变更，旧结果未保存。", undefined, "invalid_request_error");
      }
      await transaction.put(MODEL_CACHE_KEY, cache);
    });
    return models;
  }

  private validModelCatalogCache(
    value: unknown,
    accountId: string,
    generation: number
  ): value is ModelCatalogCacheRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const cache = value as Partial<ModelCatalogCacheRecord>;
    return cache.version === MODEL_CATALOG_CACHE_VERSION
      && cache.accountId === accountId
      && cache.generation === generation
      && typeof cache.fetchedAt === "number"
      && Number.isFinite(cache.fetchedAt)
      && cache.fetchedAt <= Date.now()
      && cache.fetchedAt > Date.now() - MODEL_CATALOG_CACHE_MS
      && Array.isArray(cache.models)
      && cache.models.every((model) => {
        if (!model || typeof model.id !== "string" || !model.reasoning) return false;
        if (!model.codex || typeof model.codex !== "object" || Array.isArray(model.codex)) return false;
        if (model.codex.slug !== model.id || model.codex.visibility === "hide") return false;
        const supported = model.reasoning.supportedEfforts;
        if (supported !== null && (!Array.isArray(supported) || !supported.every((effort) => typeof effort === "string" && REASONING_EFFORT_PATTERN.test(effort)))) return false;
        return model.reasoning.defaultEffort === null
          || (typeof model.reasoning.defaultEffort === "string" && supported !== null && supported.includes(model.reasoning.defaultEffort));
      });
  }

  async loadModelCatalog(): Promise<ModelCapability[]> {
    const credentials = await this.authManager.readCredentials();
    if (!credentials) {
      throw new GatewayError(503, "account_not_connected", "尚未连接 Codex 账户。", undefined, "authentication_error");
    }
    const generation = await this.authManager.currentGeneration();
    const cached = await this.storage.get<unknown>(MODEL_CACHE_KEY);
    if (this.validModelCatalogCache(cached, credentials.accountId, generation)) return cached.models;
    if (this.modelCatalogLoad?.accountId === credentials.accountId && this.modelCatalogLoad.generation === generation) {
      return this.modelCatalogLoad.promise;
    }
    const load: ModelCatalogLoad = {
      accountId: credentials.accountId,
      generation,
      promise: this.fetchModelCatalog()
    };
    this.modelCatalogLoad = load;
    try {
      return await load.promise;
    } finally {
      if (this.modelCatalogLoad === load) this.modelCatalogLoad = null;
    }
  }

  private modelListResponse(capabilities: ModelCapability[], identity?: GatewayIdentity, codexNative = false): Response {
    const visible = identity ? capabilities.filter((model) => modelAllowed(identity, model.id)) : capabilities;
    const data = visible.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "openai",
      capabilities: {
        reasoning: {
          supported_efforts: model.reasoning.supportedEfforts,
          default_effort: model.reasoning.defaultEffort
        }
      }
    }));
    return Response.json({
      object: "list",
      data,
      ...(codexNative ? { models: visible.map((model) => model.codex) } : {})
    }, { headers: { "Cache-Control": "no-store" } });
  }

  async listModels(identity?: GatewayIdentity, codexNative = false): Promise<Response> {
    return this.modelListResponse(await this.fetchModelCatalog(), identity, codexNative);
  }

  async validateReasoning(request: NormalizedRequest, chat: boolean): Promise<void> {
    const reasoning = request.upstream.reasoning;
    if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return;
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort !== "string") return;
    const param = chat ? "reasoning_effort" : "reasoning.effort";
    const model = (await this.loadModelCatalog()).find((entry) => entry.id === request.model);
    if (!model || model.reasoning.supportedEfforts === null) {
      throw new GatewayError(
        400,
        "reasoning_capability_unavailable",
        "当前官方模型目录未提供模型 " + request.model + " 的 reasoning effort 能力，无法确认显式档位 " + effort + "。",
        param
      );
    }
    if (!model.reasoning.supportedEfforts.includes(effort)) {
      throw new GatewayError(
        400,
        "unsupported_reasoning_effort",
        "模型 " + request.model + " 不支持 reasoning effort " + effort + "；当前目录支持：" + (model.reasoning.supportedEfforts.join(", ") || "无") + "。",
        param
      );
    }
  }

  private pruneLeases(now = Date.now()): void {
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(id);
      }
    }
  }

  acquireLease(identity?: GatewayIdentity): string {
    const now = Date.now();
    this.pruneLeases(now);
    if (this.leases.size >= LEASE_LIMIT) {
      throw new GatewayError(429, "local_concurrency_limit", `本地并发生成上限为 ${LEASE_LIMIT}。`, undefined, "rate_limit_error");
    }
    if (identity && identity.concurrencyLimit !== null) {
      let activeForKey = 0;
      for (const lease of this.leases.values()) {
        if (lease.keyId === identity.id) activeForKey++;
      }
      this.keyManager.checkConcurrencyLimit(identity, activeForKey);
    }
    this.keyManager.checkAndUpdateRateLimit(identity, now);
    const id = crypto.randomUUID();
    this.leases.set(id, { expiresAt: now + GENERATION_TIMEOUT_MS + 5000, keyId: identity?.id ?? null });
    return id;
  }

  releaseLease(id: string): void {
    this.leases.delete(id);
  }

  getLeases(): Map<string, LeaseRecord> {
    return new Map(this.leases);
  }

  async cancelGeneration(leaseId: string): Promise<void> {
    const generation = this.activeGenerations.get(leaseId);
    if (!generation) return;
    generation.cancel();
    await generation.finish();
  }

  private pruneRequestGroups(now = Date.now()): void {
    for (const [groupId, state] of this.requestGroups) {
      if (state.expiresAt <= now && state.leaseId === null) this.requestGroups.delete(groupId);
    }
  }

  openRequestGroup(groupId: string): void {
    const now = Date.now();
    this.pruneRequestGroups(now);
    const current = this.requestGroups.get(groupId);
    if (current) {
      current.expiresAt = now + REQUEST_GROUP_TTL_MS;
      return;
    }
    if (this.requestGroups.size >= REQUEST_GROUP_LIMIT) {
      throw new GatewayError(503, "request_group_capacity", "本地请求组容量已满。", undefined, "server_error");
    }
    this.requestGroups.set(groupId, { cancelled: false, leaseId: null, expiresAt: now + REQUEST_GROUP_TTL_MS });
  }

  bindRequestGroup(groupId: string | undefined, leaseId: string): boolean {
    if (!groupId) return false;
    const state = this.requestGroups.get(groupId);
    if (!state) return false;
    state.leaseId = leaseId;
    state.expiresAt = Date.now() + REQUEST_GROUP_TTL_MS;
    return state.cancelled;
  }

  unbindRequestGroup(groupId: string | undefined, leaseId: string): void {
    if (!groupId) return;
    const state = this.requestGroups.get(groupId);
    if (state?.leaseId === leaseId) state.leaseId = null;
  }

  async cancelRequestGroup(groupId: string): Promise<void> {
    const now = Date.now();
    this.pruneRequestGroups(now);
    const state = this.requestGroups.get(groupId);
    if (!state) return;
    state.cancelled = true;
    state.expiresAt = now + REQUEST_GROUP_TTL_MS;
    if (state.leaseId) await this.cancelGeneration(state.leaseId);
  }

  closeRequestGroup(groupId: string): void {
    this.requestGroups.delete(groupId);
  }

  async handleGeneration(request: Request, chat: boolean, identity: GatewayIdentity | undefined, requestId: string): Promise<Response> {
    const body = await readJsonBody(request);
    const normalized = chat ? normalizeChat(body) : normalizeResponses(body);
    const ignoredHeader: Record<string, string> = normalized.ignoredParameters.length > 0
      ? { "X-OneAPI-Ignored-Parameters": normalized.ignoredParameters.join(", ") }
      : {};
    const requestGroupId = request.headers.get(LOCAL_REQUEST_GROUP_HEADER) ?? undefined;
    const generationFetch: OutboundFetch = (upstreamRequest) => this.env.MOCK_UPSTREAM === "true"
      ? mockUpstreamFetch(upstreamRequest)
      : this.options.outboundFetch ? this.options.outboundFetch(upstreamRequest, requestGroupId) : fetch(upstreamRequest);
    const activeLog: ActiveLog | null = identity
      ? await this.auditLogger.startRequestLog(identity, chat ? "chat" : "responses", normalized.model, requestId, body, normalized.ignoredParameters)
      : null;
    let leaseId: string | null = null;
    let controller: AbortController | null = null;
    let finished = false;

    const errorBody = (error: unknown): Record<string, unknown> => {
      const known = error instanceof GatewayError
        ? error
        : new GatewayError(500, "internal_error", "网关发生内部错误。", undefined, "server_error");
      return { error: { message: known.message, type: known.type, code: known.code, ...(known.param ? { param: known.param } : {}) } };
    };
    const finish = async (responseBody?: unknown) => {
      if (finished) return;
      finished = true;
      if (controller) {
        clearTimeout(timeout);
        request.signal.removeEventListener("abort", clientAbort);
        this.activeControllers.delete(controller);
      }
      if (leaseId) {
        this.activeGenerations.delete(leaseId);
        this.unbindRequestGroup(requestGroupId, leaseId);
        this.releaseLease(leaseId);
      }
      await this.auditLogger.finishRequestLog(activeLog, responseBody);
    };
    let timeout: ReturnType<typeof setTimeout>;
    const clientAbort = () => controller?.abort(request.signal.reason);

    try {
      this.keyManager.validateModelAccess(identity, normalized.model);
      await this.validateReasoning(normalized, chat);
      leaseId = this.acquireLease(identity);
      controller = new AbortController();
      const generationTimeoutMs = this.env.MOCK_UPSTREAM === "true" ? 100 : GENERATION_TIMEOUT_MS;
      timeout = setTimeout(() => controller?.abort(new Error("generation timeout")), generationTimeoutMs);
      request.signal.addEventListener("abort", clientAbort, { once: true });
      this.activeControllers.add(controller);
      const generation = {
        controller,
        cancel: () => {
          if (activeLog) {
            if (activeLog.outcome === "incomplete") activeLog.outcome = "cancelled";
            activeLog.httpStatus ??= 499;
          }
          controller?.abort(new Error("client cancelled"));
        },
        finish,
        ...(requestGroupId ? { groupId: requestGroupId } : {})
      };
      this.activeGenerations.set(leaseId, generation);
      if (this.bindRequestGroup(requestGroupId, leaseId)) {
        generation.cancel();
        throw generationAbortError(controller.signal);
      }

      let credentials = await this.authManager.refreshCredentials();
      let upstream: Response;
      try {
        upstream = await fetchResponseStream(generationFetch, credentials, normalized.upstream, controller.signal, normalized.codexNative ? request.headers : undefined);
      } catch (error) {
        if (!(error instanceof GatewayError) || error.code !== "account_reauthentication_required") throw error;
        credentials = await this.authManager.refreshCredentials(true);
        const retryGeneration = await this.authManager.currentGeneration();
        try {
          upstream = await fetchResponseStream(generationFetch, credentials, normalized.upstream, controller.signal, normalized.codexNative ? request.headers : undefined);
        } catch (retryError) {
          if (retryError instanceof GatewayError && retryError.code === "account_reauthentication_required") {
            await this.authManager.disableRejectedCredentials(retryGeneration, credentials.version);
          }
          throw retryError;
        }
      }
      if (!upstream.body) throw new GatewayError(502, "upstream_stream_missing", "上游未返回响应流。", undefined, "server_error");

      if (!normalized.stream) {
        const completed = await collectCompletedResponse(upstream.body);
        const value = chat ? responseToChat(completed, normalized.model) : completed;
        if (activeLog) {
          activeLog.httpStatus = 200;
          activeLog.outcome = "completed";
          activeLog.usage = usageFromResponse(value);
        }
        await finish(value);
        return Response.json(value, { headers: { "Cache-Control": "no-store", ...ignoredHeader } });
      }

      if (activeLog) {
        activeLog.httpStatus = 200;
        activeLog.responseCapture = activeLog.settings.captureBodies
          ? new StreamBodyCapture(activeLog.settings.maxBodyBytes, "sse")
          : null;
      }
      const lifecycle = {
        abort: () => {
          if (activeLog?.outcome === "incomplete") activeLog.outcome = "cancelled";
          controller?.abort(new Error("client cancelled"));
        },
        finish,
        failure: () => controller?.signal.aborted ? generationAbortError(controller.signal) : undefined,
        failed: (error: unknown) => {
          if (activeLog) activeLog.outcome = gatewayOutcome(error);
        },
        terminal: (type: string, payload: Record<string, unknown>) => {
          if (!activeLog) return;
          const response = payload.response;
          if (type === "response.completed") {
            activeLog.outcome = "completed";
            activeLog.usage = usageFromResponse(response);
          } else if (type === "response.incomplete") {
            activeLog.outcome = "incomplete";
            activeLog.usage = usageFromResponse(response);
          } else {
            activeLog.outcome = "error";
            activeLog.usage = usageFromResponse(response);
          }
        }
      };
      const adapted = chat
        ? chatEventStream(upstream.body, normalized.model, normalized.chat?.includeUsage ?? false, lifecycle)
        : responseEventStream(upstream.body, lifecycle);
      const stream = activeLog?.responseCapture ? captureStreamBody(adapted, activeLog.responseCapture) : adapted;
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-OneAPI-Internal-Lease": leaseId,
          ...ignoredHeader
        }
      });
    } catch (error) {
      let failure = error;
      if (controller?.signal.aborted) failure = generationAbortError(controller.signal);
      if (activeLog) {
        activeLog.httpStatus ??= gatewayStatus(failure);
        activeLog.outcome = gatewayOutcome(failure);
      }
      controller?.abort(failure);
      await finish(errorBody(failure));
      throw failure;
    }
  }

  private relayConfiguration(): { origin: string; key: string } {
    const origin = this.env.ONEAPI_RELAY_ORIGIN ?? "";
    const key = this.env.ONEAPI_RELAY_KEY ?? "";
    if (!origin || !key) {
      throw new GatewayError(503, "egress_diagnostic_disabled", "出站对照诊断未启用。", undefined, "server_error");
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
      parseRelayKey(key);
    } catch {
      throw new GatewayError(500, "invalid_egress_diagnostic_config", "出站对照诊断配置无效。", undefined, "server_error");
    }
    if (
      origin.length > 512 || origin !== parsed.origin || parsed.protocol !== "https:" ||
      parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash
    ) {
      throw new GatewayError(500, "invalid_egress_diagnostic_config", "出站对照诊断配置无效。", undefined, "server_error");
    }
    return { origin, key };
  }

  private relayRequest(request: Request, operation: RelayOperation, requestId: string): Promise<RelayRequest> {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return (async () => ({
      requestId,
      issuedAt: Date.now(),
      operation,
      headers,
      ...(operation === "models" ? { clientVersion: CLIENT_VERSION } : {}),
      ...(operation === "generate" ? { bodyText: await request.clone().text() } : {})
    }))();
  }

  private async fetchThroughRelay(
    upstreamRequest: Request,
    operation: RelayOperation,
    requestId: string,
    timeoutMs: number
  ): Promise<{ response: Response; protocol: RelayResponse }> {
    const { origin, key } = this.relayConfiguration();
    const envelope = await encryptRelayRequest(key, await this.relayRequest(upstreamRequest, operation, requestId));
    if (relayEnvelopeBytes(envelope) > RELAY_REQUEST_ENVELOPE_MAX_BYTES) {
      throw new GatewayError(500, "relay_request_too_large", "加密 relay 请求超过限制。", undefined, "server_error");
    }
    const relayResponse = await this.timedFetch(new Request(`${origin}/relay`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
      redirect: "manual"
    }), timeoutMs, RELAY_RESPONSE_ENVELOPE_MAX_BYTES);
    if (!relayResponse.ok) {
      throw new GatewayError(502, "relay_http_error", "诊断 relay 拒绝了加密请求。", undefined, "server_error");
    }
    let encrypted: unknown;
    try {
      encrypted = await relayResponse.json();
    } catch {
      throw new GatewayError(502, "invalid_relay_response", "诊断 relay 返回了无效加密响应。", undefined, "server_error");
    }
    let protocol: RelayResponse;
    try {
      protocol = await decryptRelayResponse(key, encrypted);
    } catch {
      throw new GatewayError(502, "invalid_relay_response", "诊断 relay 返回了无效加密响应。", undefined, "server_error");
    }
    if (protocol.requestId !== requestId) {
      throw new GatewayError(502, "relay_response_mismatch", "诊断 relay 响应与当前请求不匹配。", undefined, "server_error");
    }
    const responseBody = decodeRelayBody(protocol);
    const response = new Response(responseBody.byteLength === 0 ? null : responseBody, {
      status: protocol.status,
      headers: protocol.headers
    });
    return { response, protocol };
  }

  private async egressObservation(
    response: Response,
    targetUrl: string,
    operation: Exclude<RelayOperation, "ping">
  ): Promise<EgressObservation> {
    const fingerprint = await responseFingerprint(response.clone());
    const observation: EgressObservation = {
      status: response.status,
      ok: response.ok,
      ...fingerprint
    };
    if (!response.ok) {
      observation.diagnostic = await collectUpstreamDiagnostic(response.clone(), targetUrl);
      return observation;
    }
    if (operation === "models") {
      let raw: unknown;
      try {
        raw = await response.clone().json();
      } catch {
        throw new GatewayError(502, "invalid_models_response", "relay 模型目录不是有效 JSON。", undefined, "server_error");
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new GatewayError(502, "invalid_models_response", "relay 模型目录不是 JSON 对象。", undefined, "server_error");
      }
      const models = this.parseModelCatalog(raw as Record<string, unknown>);
      observation.modelCount = models.length;
      observation.modelIds = models.map((model) => model.id);
    } else if (operation === "usage") {
      let raw: unknown;
      try {
        raw = await response.clone().json();
      } catch {
        throw new GatewayError(502, "invalid_usage_response", "relay 额度响应不是有效 JSON。", undefined, "server_error");
      }
      observation.usage = normalizeUsagePayload(raw).windows;
    } else {
      if (!response.body) throw new GatewayError(502, "upstream_stream_missing", "relay 生成响应没有响应流。", undefined, "server_error");
      const completed = await collectCompletedResponse(response.body);
      observation.completed = completed.status === "completed";
      observation.responseChars = typeof completed.output_text === "string" ? completed.output_text.length : 0;
      observation.usage = usageFromResponse(completed);
    }
    return observation;
  }

  async diagnoseEgress(request: Request, outerRequestId: string): Promise<Response> {
    const body = await readJsonBody(request);
    if (
      typeof body.operation !== "string" ||
      !["ping", "models", "usage", "generate"].includes(body.operation) ||
      Object.keys(body).some((key) => key !== "operation")
    ) {
      throw new GatewayError(400, "invalid_request", "egress 诊断只接受 operation=ping|models|usage|generate。", "operation");
    }
    const operation = body.operation as RelayOperation;
    this.relayConfiguration();
    if (operation === "ping") {
      const pingRequest = new Request("https://oneapi.invalid/ping", { headers: {} });
      const relay = await this.fetchThroughRelay(pingRequest, operation, outerRequestId, 30_000);
      if (relay.protocol.service !== "oneapi-egress-relay") {
        throw new GatewayError(502, "invalid_relay_identity", "诊断 relay 身份无效。", undefined, "server_error");
      }
      return Response.json({
        operation,
        relay: {
          status: relay.protocol.status,
          ok: relay.protocol.status >= 200 && relay.protocol.status < 300,
          service: relay.protocol.service,
          requestIdBound: true
        }
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const credentials = await this.authManager.readCredentials();
    if (!credentials) {
      throw new GatewayError(503, "account_not_connected", "尚未连接 Codex 账户。", undefined, "authentication_error");
    }
    if (operation === "generate") {
      const normalized = normalizeResponses({
        model: "gpt-5.5",
        input: "Reply only EGRESS_OK"
      });
      if (JSON.stringify(normalized.upstream) !== JSON.stringify(fixedRelayGenerationBody())) {
        throw new GatewayError(500, "relay_generation_contract_mismatch", "固定生成诊断契约与当前规范化逻辑不一致。", undefined, "server_error");
      }
      const upstreamRequest = createResponseRequest(credentials, normalized.upstream);
      const relayed = await this.fetchThroughRelay(upstreamRequest, operation, outerRequestId, 60_000);
      return Response.json({
        operation,
        relay: await this.egressObservation(relayed.response, upstreamRequest.url, operation),
        sameCredential: true
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const upstreamRequest = operation === "models" ? createModelsRequest(credentials) : createUsageRequest(credentials);
    const direct = await this.timedFetch(new Request(upstreamRequest), 30_000, 2 * 1024 * 1024);
    const relayed = await this.fetchThroughRelay(upstreamRequest, operation, outerRequestId, 30_000);
    return Response.json({
      operation,
      direct: await this.egressObservation(direct, upstreamRequest.url, operation),
      relay: await this.egressObservation(relayed.response, upstreamRequest.url, operation),
      sameCredential: true
    }, { headers: { "Cache-Control": "no-store" } });
  }

  async diagnoseWebSocket(request: Request): Promise<Response> {
    if (this.env.ONEAPI_WS_DIAGNOSTIC !== "true") {
      throw new GatewayError(503, "websocket_diagnostic_disabled", "WebSocket 诊断未启用。", undefined, "server_error");
    }
    const url = new URL(request.url);
    if (url.search) throw new GatewayError(400, "invalid_request", "WebSocket 诊断不接受 query。", "query");
    const body = await readJsonBody(request);
    if (Object.keys(body).length !== 0) {
      throw new GatewayError(400, "invalid_request", "WebSocket 诊断只接受空 JSON 对象。", "body");
    }
    const credentials = await this.authManager.readCredentials();
    if (!credentials) {
      throw new GatewayError(503, "account_not_connected", "尚未连接 Codex 账户。", undefined, "authentication_error");
    }
    const result = await probeResponsesWebSocket(credentials, (outbound) => this.performFetch(outbound));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  }
}
