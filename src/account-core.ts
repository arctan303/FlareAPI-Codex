import { errorResponse, GatewayError } from "./errors";
import type { GatewayIdentity, StoredCredentials } from "./types";
import type { OutboundFetch } from "./codex/auth";
import { requireBearer } from "./security";
import { readJsonBody } from "./protocol/requests";
import type {
  AccountRequestContext,
  AccountServiceConfig,
  AccountServiceOptions,
  AccountStorage
} from "./runtime/contracts";
import { LEGACY_KEY_ID } from "./controls";

import { CustomOriginsManager, CUSTOM_ORIGINS_KEY } from "./account/custom-origins-manager";
import { AuthManager, type AdminAuthentication } from "./account/auth-manager";
import { KeyManager } from "./account/key-manager";
import { AuditLogger } from "./account/audit-logger";
import { REQUEST_GROUP_PATTERN, UpstreamGateway, type LeaseRecord } from "./account/upstream-gateway";

export { CUSTOM_ORIGINS_KEY };

export class AccountService {
  readonly env: AccountServiceConfig;
  private readonly customOriginsManager: CustomOriginsManager;
  private readonly authManager: AuthManager;
  private readonly keyManager: KeyManager;
  private readonly auditLogger: AuditLogger;
  private readonly upstreamGateway: UpstreamGateway;

  readonly ready: Promise<void>;

  constructor(
    private readonly storage: AccountStorage,
    env: AccountServiceConfig,
    private readonly options: AccountServiceOptions = {}
  ) {
    this.env = env;
    this.customOriginsManager = new CustomOriginsManager(storage, env);
    this.keyManager = new KeyManager(storage, env);
    this.auditLogger = new AuditLogger(storage);
    this.authManager = new AuthManager(storage, env, {
      timedFetch: (req, timeoutMs, maxResponseBytes) => this.upstreamGateway.timedFetch(req, timeoutMs, maxResponseBytes),
      onDisconnect: () => this.upstreamGateway.abortAllActive()
    });
    this.upstreamGateway = new UpstreamGateway(
      storage,
      env,
      options,
      this.authManager,
      this.keyManager,
      this.auditLogger
    );

    const auditLogger = this.auditLogger;
    const upstreamGateway = this.upstreamGateway;
    const customOriginsManager = this.customOriginsManager;
    this.ready = (async () => {
      await auditLogger.init();
      await upstreamGateway.init();
      await customOriginsManager.loadCustomOrigins();
    })();
  }

  getDynamicOrigins(): Set<string> {
    return this.customOriginsManager.getDynamicOrigins();
  }

  async getNetworkOrigins(): Promise<{ defaultOrigins: string[]; customOrigins: string[] }> {
    return this.customOriginsManager.getNetworkOrigins();
  }

  async updateCustomOrigins(origins: string[]): Promise<{ customOrigins: string[] }> {
    return this.customOriginsManager.updateCustomOrigins(origins);
  }

  async alarm(): Promise<void> {
    await this.ready;
    return this.auditLogger.alarm();
  }

  async dispose(): Promise<void> {
    await this.upstreamGateway.dispose();
    this.authManager.clearAccessVerifier();
  }

  get performFetch(): OutboundFetch {
    return this.upstreamGateway.performFetch;
  }

  set performFetch(fetcher: OutboundFetch) {
    this.upstreamGateway.performFetch = fetcher;
  }

  readCredentials(): Promise<StoredCredentials | null> {
    return this.authManager.readCredentials();
  }

  writeCredentials(value: StoredCredentials): Promise<void> {
    return this.authManager.writeCredentials(value);
  }

  diagnoseEgress(request: Request, requestId: string): Promise<Response> {
    return this.upstreamGateway.diagnoseEgress(request, requestId);
  }

  async fetch(request: Request, context: AccountRequestContext = {}): Promise<Response> {
    await this.ready;
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    let adminAuthentication: AdminAuthentication | null = null;
    try {
      if (url.pathname === "/__internal/cancel") {
        requireBearer(request, this.env.TOKEN_ENCRYPTION_KEY, "internal");
        if (request.method !== "POST") throw new GatewayError(405, "method_not_allowed", "内部取消接口只接受 POST。", undefined, "invalid_request_error");
        const leaseId = url.searchParams.get("lease_id");
        if (!leaseId) throw new GatewayError(400, "invalid_request", "缺少内部 lease_id。", "lease_id");
        await this.upstreamGateway.cancelGeneration(leaseId);
        return new Response(null, { status: 204 });
      }
      const groupControl = /^\/__internal\/request-groups\/(open|cancel|close)$/.exec(url.pathname);
      if (groupControl) {
        requireBearer(request, this.env.TOKEN_ENCRYPTION_KEY, "internal");
        if (request.method !== "POST") throw new GatewayError(405, "method_not_allowed", "内部请求组接口只接受 POST。", undefined, "invalid_request_error");
        if ([...url.searchParams.keys()].some((key) => key !== "group_id")) {
          throw new GatewayError(400, "invalid_request", "内部请求组接口只接受 group_id。", "group_id");
        }
        const groupId = url.searchParams.get("group_id")?.toLowerCase() ?? "";
        if (!REQUEST_GROUP_PATTERN.test(groupId)) throw new GatewayError(400, "invalid_request", "内部请求组标识无效。", "group_id");
        if (groupControl[1] === "open") this.upstreamGateway.openRequestGroup(groupId);
        else if (groupControl[1] === "cancel") await this.upstreamGateway.cancelRequestGroup(groupId);
        else this.upstreamGateway.closeRequestGroup(groupId);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET" && url.pathname === "/access/status") {
        return await this.authManager.publicAccessStatus();
      }
      if (request.method === "POST" && url.pathname === "/admin/account/import") {
        return await this.authManager.importCredentials(request);
      }
      let gatewayIdentity: GatewayIdentity | null = null;
      if (url.pathname.startsWith("/admin/")) {
        if (request.method === "POST" && url.pathname === "/admin/session") return await this.authManager.createAdminSession(request, context);
        if (request.method === "GET" && url.pathname === "/admin/session") return await this.authManager.adminSessionStatus(request);
        adminAuthentication = await this.authManager.authenticateAdmin(request);
        if (request.method === "DELETE" && url.pathname === "/admin/session") {
          return await this.authManager.deleteAdminSession(request, adminAuthentication, context);
        }
      } else if (url.pathname.startsWith("/v1/")) {
        gatewayIdentity = await this.keyManager.authenticateGateway(request);
      } else {
        throw new GatewayError(404, "not_found", "接口不存在。", undefined, "invalid_request_error");
      }

      if (adminAuthentication && this.options.adminExtension) {
        const extension = await this.options.adminExtension(request);
        if (extension) return extension;
      }
      if (request.method === "GET" && url.pathname === "/admin/status") return await this.authManager.status();
      if (request.method === "GET" && url.pathname === "/admin/network/origins") {
        return Response.json(await this.getNetworkOrigins(), { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/admin/network/origins") {
        const body = await readJsonBody(request);
        if (Object.keys(body).some((key) => key !== "origins")) {
          throw new GatewayError(400, "invalid_request", "network/origins 只接受 origins 参数。", "body");
        }
        if (!Array.isArray(body.origins)) {
          throw new GatewayError(400, "invalid_request", "origins 必须是数组。", "origins");
        }
        return Response.json(await this.updateCustomOrigins(body.origins as string[]), { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "GET" && url.pathname === "/admin/access") return await this.authManager.getAccessConfig();
      if (request.method === "PATCH" && url.pathname === "/admin/access") return await this.authManager.patchAccessConfig(request);
      if (request.method === "GET" && url.pathname === "/admin/access/login") {
        const access = await this.authManager.accessAuthentication(request);
        if (access.kind !== "access") throw new GatewayError(401, "invalid_access_token", "Cloudflare Access 登录无效。", undefined, "authentication_error");
        return Response.redirect(new URL("/", request.url).href, 303);
      }
      if (request.method === "GET" && url.pathname === "/admin/usage") {
        if ([...url.searchParams.keys()].some((key) => key !== "refresh") || !["", "true", "false"].includes(url.searchParams.get("refresh") ?? "")) {
          throw new GatewayError(400, "invalid_request", "usage 只接受 refresh=true|false。", "refresh");
        }
        return await this.upstreamGateway.usage(url.searchParams.get("refresh") === "true", adminAuthentication !== null);
      }
      if (request.method === "GET" && url.pathname === "/admin/api-keys") return await this.keyManager.listApiKeys();
      if (request.method === "POST" && url.pathname === "/admin/api-keys") return await this.keyManager.createApiKey(request);
      const apiKeyMatch = /^\/admin\/api-keys\/(legacy|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.pathname);
      if (request.method === "PATCH" && apiKeyMatch) return await this.keyManager.patchApiKey(request, apiKeyMatch[1]!);
      if (request.method === "DELETE" && apiKeyMatch && apiKeyMatch[1] !== LEGACY_KEY_ID) return await this.keyManager.deleteApiKey(request, apiKeyMatch[1]!);
      if (request.method === "GET" && url.pathname === "/admin/log-settings") return await this.auditLogger.getLogSettings();
      if (request.method === "PATCH" && url.pathname === "/admin/log-settings") return await this.auditLogger.patchLogSettings(request);
      if (request.method === "GET" && url.pathname === "/admin/logs") return await this.auditLogger.listLogs(url);
      const logMatch = /^\/admin\/logs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.pathname);
      if (request.method === "GET" && logMatch) return await this.auditLogger.getLog(logMatch[1]!);
      if (request.method === "POST" && url.pathname === "/admin/device/start") {
        const body = await readJsonBody(request);
        if (Object.keys(body).length !== 0) throw new GatewayError(400, "invalid_request", "device/start 不接受参数。", "body");
        return Response.json(await this.authManager.startLogin(), { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/admin/device/poll") {
        const body = await readJsonBody(request);
        if (typeof body.login_id !== "string" || Object.keys(body).some((key) => key !== "login_id")) throw new GatewayError(400, "invalid_request", "poll 只接受 login_id。", "login_id");
        return Response.json(await this.authManager.pollLogin(body.login_id), { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/admin/device/cancel") {
        const body = await readJsonBody(request);
        if (typeof body.login_id !== "string" || Object.keys(body).some((key) => key !== "login_id")) throw new GatewayError(400, "invalid_request", "cancel 只接受 login_id。", "login_id");
        await this.authManager.cancelLogin(body.login_id);
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/admin/disconnect") {
        const body = await readJsonBody(request);
        if (Object.keys(body).length !== 0) throw new GatewayError(400, "invalid_request", "disconnect 不接受参数。", "body");
        await this.authManager.disconnect();
        return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/admin/diagnostics/egress") {
        return await this.upstreamGateway.diagnoseEgress(request, requestId);
      }
      if (request.method === "POST" && url.pathname === "/admin/diagnostics/websocket") {
        return await this.upstreamGateway.diagnoseWebSocket(request);
      }
      if (request.method === "GET" && url.pathname === "/admin/test/models") return await this.upstreamGateway.listModels();
      if (request.method === "POST" && url.pathname === "/admin/test/responses") return await this.upstreamGateway.handleGeneration(request, false, undefined, requestId);
      if (request.method === "POST" && url.pathname === "/admin/test/chat/completions") return await this.upstreamGateway.handleGeneration(request, true, undefined, requestId);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        const clientVersion = url.searchParams.get("client_version");
        if (clientVersion !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(clientVersion)) {
          throw new GatewayError(400, "invalid_request", "client_version 格式无效。", "client_version");
        }
        return await this.upstreamGateway.listModels(gatewayIdentity!, clientVersion !== null);
      }
      if (request.method === "POST" && url.pathname === "/v1/responses") return await this.upstreamGateway.handleGeneration(request, false, gatewayIdentity!, requestId);
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") return await this.upstreamGateway.handleGeneration(request, true, gatewayIdentity!, requestId);
      throw new GatewayError(405, "method_not_allowed", "请求方法或接口不受支持。", undefined, "invalid_request_error");
    } catch (error) {
      return errorResponse(error, requestId, adminAuthentication !== null);
    }
  }

  getRateWindow(keyId: string): number[] | undefined {
    return this.keyManager.getRateWindow(keyId);
  }

  getLeases(): Map<string, LeaseRecord> {
    return this.upstreamGateway.getLeases();
  }
}
