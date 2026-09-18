import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountService } from "../src/account-core";
import { SqliteAccountStorage } from "../src/runtime/node/sqlite-storage";
import { encryptJson, hashSecret } from "../src/security";
import { handleGatewayRequest } from "../src/gateway";
import { mockUpstreamFetch } from "../src/codex/mock";
import type { StoredCredentials, LoginPublicState } from "../src/types";
import type { SavedAccount } from "../src/account/account-registry";

const config = { ADMIN_API_KEY: "fixture-admin-00000000000000000000001", GATEWAY_API_KEY: "fixture-gateway-000000000000000000001", TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 41).toString("base64") };
const jwt = (payload: unknown) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`;
function credentials(id: string, expired = false): StoredCredentials {
  const exp = Math.floor(Date.now() / 1000) + (expired ? -1 : 3600);
  return { accountId: id, idToken: jwt({ email: `${id}@example.test`, "https://api.openai.com/auth": { chatgpt_account_id: id, chatgpt_plan_type: "plus" } }), accessToken: jwt({ exp, sub: id }), refreshToken: `fixture-refresh-${id}`, expiresAt: exp * 1000, lastRefreshAt: Date.now(), version: 1 };
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(legacy = true, corrupt = false) {
  const root = await mkdtemp(join(tmpdir(), "flareapi-multi-"));
  let storage = new SqliteAccountStorage(join(root, "account.sqlite"));
  if (legacy) await storage.put({ credentials: await encryptJson(credentials("a"), config.TOKEN_ENCRYPTION_KEY, "oneapi:credentials:v1"), "credential-version": 1, generation: 3 });
  if (corrupt) { const value = await storage.get<any>("credentials"); await storage.put("credentials", { ...value, ciphertext: "broken" }); }
  let authorized = "b", refreshFailure = false, refreshMismatch = false;
  let generationGate: ReturnType<typeof deferred> | null = null, refreshGate: ReturnType<typeof deferred> | null = null;
  let entered = deferred();
  const calls: { path: string; account: string | null; authorization: string | null }[] = [];
  const outboundFetch = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    calls.push({ path, account: req.headers.get("chatgpt-account-id"), authorization: req.headers.get("authorization") });
    if (path.endsWith("/usercode")) return Response.json({ device_auth_id: "fixture-device", user_code: "FIXTURE", interval: 1 });
    if (path.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "fixture-code", code_challenge: "fixture-challenge", code_verifier: "fixture-verifier" });
    if (path === "/oauth/token") {
      const refresh = req.headers.get("content-type")?.includes("json");
      if (refresh) { entered.release(); if (refreshGate) await refreshGate.promise; if (refreshFailure) return Response.json({ error: "invalid_grant" }, { status: 400 }); }
      const body = refresh ? await req.json() as any : null;
      const id = refresh ? String(body.refresh_token).includes("-b") ? "b" : "a" : authorized;
      const value = credentials(refresh && refreshMismatch ? "foreign" : id);
      return Response.json({ id_token: value.idToken, access_token: value.accessToken, refresh_token: `fixture-refresh-${id}-rotated` });
    }
    if (path.endsWith("/models")) return Response.json({ models: [{ slug: `gpt-${req.headers.get("chatgpt-account-id")}`, visibility: "list", supported_reasoning_levels: [{ effort: "low" }], default_reasoning_level: "low" }] });
    if (path.endsWith("/usage")) return Response.json({ rate_limit: { primary_window: { used_percent: req.headers.get("chatgpt-account-id") === "a" ? 10 : 80, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 100 } } });
    if (path.endsWith("/responses")) {
      entered.release();
      const upstream = await mockUpstreamFetch(req);
      if (!generationGate || !upstream.body) return upstream;
      const reader = upstream.body.getReader(), gate = generationGate;
      return new Response(new ReadableStream({ async pull(controller) { await gate.promise; const next = await reader.read(); if (next.done) controller.close(); else controller.enqueue(next.value); }, cancel(reason) { return reader.cancel(reason); } }), { headers: upstream.headers });
    }
    throw new Error("unexpected fixture route");
  };
  let service = new AccountService(storage, config, { outboundFetch });
  await service.ready;
  cleanups.push(async () => { generationGate?.release(); refreshGate?.release(); await service.dispose(); await storage.close(); await rm(root, { recursive: true, force: true }); });
  const call = (path: string, method = "GET", body?: unknown, key: string | null = config.ADMIN_API_KEY, extra: Record<string, string> = {}) => {
    const req = new Request("https://fixture.test" + path, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return handleGatewayRequest(req, { ...config, PUBLIC_ORIGIN: "https://fixture.test" }, { accountFetch: req => service.fetch(req), staticFetch: async () => new Response(null, { status: 404 }) });
  };
  const list = async () => (await (await call("/admin/accounts")).json()) as { activeAccountId: string | null; accounts: (Omit<SavedAccount, "credentials"> & { connected: boolean; isDefault: boolean })[] };
  const add = async (id = "b", expected = 200) => {
    authorized = id;
    const started = await call("/admin/device/start", "POST", {}); expect(started.status).toBe(200);
    const login = await started.json() as LoginPublicState;
    await storage.put("login-public", { ...login, nextPollAt: 0 });
    const result = await call("/admin/device/poll", "POST", { login_id: login.id }); expect(result.status).toBe(expected);
  };
  return { call, list, add, calls, get storage() { return storage; }, get service() { return service; },
    async restart() { await service.dispose(); await storage.close(); storage = new SqliteAccountStorage(join(root, "account.sqlite")); service = new AccountService(storage, config, { outboundFetch }); await service.ready; },
    refresh(force = false) { return (service as unknown as { authManager: { refreshCredentials(force: boolean): Promise<StoredCredentials> } }).authManager.refreshCredentials(force); },
    async expire() { const value = await service.readCredentials(); await service.writeCredentials({ ...value!, expiresAt: 0 }); },
    holdGeneration() { generationGate = deferred(); entered = deferred(); return { entered: entered.promise, release: generationGate.release }; },
    holdRefresh() { refreshGate = deferred(); entered = deferred(); return { entered: entered.promise, release: refreshGate.release }; },
    failRefresh() { refreshFailure = true; }, mismatchRefresh() { refreshMismatch = true; }
  };
}

describe("MULTI-ACCOUNT-001 saved accounts", () => {
  it("registers the legacy account without reencrypting and preserves both accounts/default through restart", async () => {
    const f = await fixture(); const encrypted = await f.storage.get("credentials");
    let state = await f.list(); expect(state.accounts).toHaveLength(1); expect(state.accounts[0]).toMatchObject({ email: "a@example.test", isDefault: true });
    await f.add(); state = await f.list(); expect(state.accounts).toHaveLength(2); expect(state.activeAccountId).toBe(await hashSecret("a")); expect(await f.storage.get("credentials")).toEqual(encrypted);
    await f.add(); expect((await f.list()).accounts).toHaveLength(2);
    const selected = await f.call(`/admin/accounts/${await hashSecret("b")}/activate`, "POST", {}); expect(selected.status).toBe(200);
    await f.restart(); expect((await f.list()).activeAccountId).toBe(await hashSecret("b")); expect((await f.service.readCredentials())?.accountId).toBe("b");
    const serialized = JSON.stringify(await f.list()); for (const value of [credentials("a").refreshToken, credentials("b").refreshToken, "ciphertext", "accessToken", "idToken"]) expect(serialized).not.toContain(value);
  });
  it("uses the selected account for models, quota, and both generation protocols with the same existing API key", async () => {
    const f = await fixture(); await f.add();
    const created = await f.call("/admin/api-keys", "POST", { name: "same client" }); const key = (await created.json() as any).key;
    for (const id of ["a", "b", "a"]) {
      expect((await f.call(`/admin/accounts/${await hashSecret(id)}/activate`, "POST", {})).status).toBe(200);
      const models = await (await f.call("/v1/models", "GET", undefined, key)).json() as any; expect(models.data[0].id).toBe(`gpt-${id}`);
      const usage = await (await f.call("/admin/usage")).json() as any; expect(usage.windows.fiveHour.usedPercent).toBe(id === "a" ? 10 : 80);
      for (const chat of [false, true]) {
        const result = await f.call(chat ? "/v1/chat/completions" : "/v1/responses", "POST", chat ? { model: `gpt-${id}`, messages: [{ role: "user", content: "hello" }] } : { model: `gpt-${id}`, input: "hello" }, key);
        expect(result.status).toBe(200); await result.json();
        expect(f.calls.filter(c => c.path.endsWith("/responses")).at(-1)?.account).toBe(id);
      }
    }
  });
  it("keeps a streaming generation running and rejects switching/removal until it finishes", async () => {
    const f = await fixture(); await f.add(); const gate = f.holdGeneration();
    const responsePromise = f.call("/v1/responses", "POST", { model: "gpt-a", input: "hello", stream: true }, config.GATEWAY_API_KEY);
    await gate.entered; const response = await responsePromise; expect(response.status).toBe(200);
    for (const [id, method, suffix] of [["b", "POST", "/activate"], ["a", "DELETE", ""]]) {
      const rejected = await f.call(`/admin/accounts/${await hashSecret(id!)}${suffix}`, method, {}); expect(rejected.status).toBe(409); expect((await rejected.json() as any).error.code).toBe("account_busy");
    }
    gate.release(); expect(await response.text()).toContain("response.completed");
    expect((await f.call(`/admin/accounts/${await hashSecret("b")}/activate`, "POST", {})).status).toBe(200);
  });
  it("blocks selection during refresh and persists the rotated refresh token before switching away and back", async () => {
    const f = await fixture(); await f.add(); await f.expire(); const gate = f.holdRefresh();
    const pending = f.call("/v1/models", "GET", undefined, config.GATEWAY_API_KEY); await gate.entered;
    expect((await f.call(`/admin/accounts/${await hashSecret("b")}/activate`, "POST", {})).status).toBe(409);
    gate.release(); expect((await pending).status).toBe(200);
    for (const id of ["b", "a"]) expect((await f.call(`/admin/accounts/${await hashSecret(id)}/activate`, "POST", {})).status).toBe(200);
    expect((await f.service.readCredentials())?.refreshToken).toBe("fixture-refresh-a-rotated");
  });
  it.each([false, true])("refresh failure or foreign identity only disables that account (mismatch=%s)", async mismatch => {
    const f = await fixture(); await f.add(); await f.expire(); if (mismatch) f.mismatchRefresh(); else f.failRefresh();
    expect((await f.call("/v1/models", "GET", undefined, config.GATEWAY_API_KEY)).status).toBe(503);
    const state = await f.list(); expect(state.accounts.find(a => a.id === state.activeAccountId)?.reauthenticationReason).toBe("account_reauthentication_required"); expect(state.accounts.find(a => a.email === "b@example.test")?.connected).toBe(true);
    expect((await f.call(`/admin/accounts/${await hashSecret("b")}/activate`, "POST", {})).status).toBe(200);
  });
  it("requires explicit default selection after removal and preserves the other saved account", async () => {
    const f = await fixture(); await f.add(); expect((await f.call("/admin/disconnect", "POST", {})).status).toBe(204);
    let state = await f.list(); expect(state.activeAccountId).toBeNull(); expect(state.accounts).toHaveLength(1); expect((await f.call("/v1/models", "GET", undefined, config.GATEWAY_API_KEY)).status).toBe(503);
    expect((await f.call(`/admin/accounts/${state.accounts[0]!.id}/activate`, "POST", {})).status).toBe(200);
    expect((await f.call(`/admin/accounts/${state.accounts[0]!.id}`, "DELETE", {})).status).toBe(200); expect((await f.list()).accounts).toHaveLength(0);
  });
  it("rejects anonymous/API-key management and cross-site mutations, and pending authorization preserves selection", async () => {
    const f = await fixture(); await f.add(); const id = await hashSecret("b");
    for (const key of [null, config.GATEWAY_API_KEY]) expect((await f.call("/admin/accounts", "GET", undefined, key)).status).toBe(401);
    expect((await f.call(`/admin/accounts/${id}/activate`, "POST", {}, config.ADMIN_API_KEY, { Origin: "https://attacker.test" })).status).toBe(403);
    const login = await (await f.call("/admin/device/start", "POST", {})).json() as any;
    expect((await f.call(`/admin/accounts/${id}/activate`, "POST", {})).status).toBe(409);
    expect((await f.list()).activeAccountId).toBe(await hashSecret("a"));
    expect((await f.call("/admin/device/cancel", "POST", { login_id: login.id })).status).toBe(204);
    expect((await f.call(`/admin/accounts/${id}/activate`, "POST", { extra: true })).status).toBe(400);
    expect((await f.call(`/admin/accounts/${"0".repeat(43)}/activate`, "POST", {})).status).toBe(404);
  });
  it("can recover corrupt legacy credentials without disabling management", async () => {
    const f = await fixture(true, true); expect((await f.call("/admin/accounts")).status).toBe(200);
    expect((await f.call("/admin/status")).status).toBe(503);
    await f.add("a"); expect((await f.list()).accounts).toHaveLength(1); expect((await f.service.readCredentials())?.accountId).toBe("a");
  });
  it("does not overwrite accounts at capacity, and allows existing-account reauthorization", async () => {
    const f = await fixture(); for (let i = 0; i < 31; i++) await f.service.writeCredentials(credentials(`saved-${i}`));
    expect((await f.call(`/admin/accounts/${await hashSecret("a")}/activate`, "POST", {})).status).toBe(200);
    await f.add("b", 409); expect((await f.list()).accounts).toHaveLength(32); expect((await f.service.readCredentials())?.accountId).toBe("a");
    await f.add("a"); expect((await f.list()).accounts).toHaveLength(32);
  });
  it("shares one rotated-token refresh between concurrent model and quota requests", async () => {
    const f = await fixture(); await f.expire(); const gate = f.holdRefresh();
    const before = f.calls.filter(c => c.path === "/oauth/token").length;
    const generationGate = deferred(), generationEntered = deferred();
    const get = f.storage.get.bind(f.storage);
    f.storage.get = async <T>(key: string): Promise<T | undefined> => {
      if (key === "generation") { generationEntered.release(); await generationGate.promise; }
      return get<T>(key);
    };
    const models = f.call("/v1/models", "GET", undefined, config.GATEWAY_API_KEY);
    const usage = f.call("/admin/usage");
    // Hold the first generation read so both callers reach the old check-before-await window.
    await generationEntered.promise;
    await new Promise(resolve => setTimeout(resolve, 25));
    generationGate.release();
    await gate.entered;
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(f.calls.filter(c => c.path === "/oauth/token")).toHaveLength(before + 1);
    gate.release(); expect((await models).status).toBe(200); expect((await usage).status).toBe(200);
    expect((await f.service.readCredentials())?.version).toBe(2);
  });
  it("imports all saved accounts and the default into an empty Node storage", async () => {
    const f = await fixture(); await f.add(); await f.call(`/admin/accounts/${await hashSecret("b")}/activate`, "POST", {});
    const root = await mkdtemp(join(tmpdir(), "flareapi-multi-import-"));
    const target = new SqliteAccountStorage(join(root, "target.sqlite"));
    cleanups.push(async () => { await target.close(); await rm(root, { recursive: true, force: true }); });
    const values: Record<string, unknown> = {};
    for (const key of ["credentials", "credential-version", "generation", "saved-accounts-v1", "active-account-v1"]) values[key] = await f.storage.get(key);
    await target.importEntries(values, []);
    const copied = new AccountService(target, config); await copied.ready;
    expect((await copied.readCredentials())?.accountId).toBe("b");
    const state = await (await copied.fetch(new Request("https://fixture.test/admin/accounts", { headers: { Authorization: `Bearer ${config.ADMIN_API_KEY}` } }))).json() as any;
    expect(state.accounts).toHaveLength(2); expect(state.activeAccountId).toBe(await hashSecret("b")); await copied.dispose();
  });
  it("honors forced refresh concurrent with a normal unexpired read, and shares concurrent forced requests", async () => {
    const f = await fixture();
    const normal = f.refresh(false), forced = f.refresh(true), secondForced = f.refresh(true);
    const results = await Promise.all([normal, forced, secondForced]);
    expect(f.calls.filter(c => c.path === "/oauth/token")).toHaveLength(1);
    expect(results[1]?.version).toBe(2); expect(results[2]?.version).toBe(2);
    expect((await f.service.readCredentials())?.refreshToken).toBe("fixture-refresh-a-rotated");
  });
  it("first device authorization becomes default on an empty instance", async () => {
    const f = await fixture(false); await f.add("a"); expect((await f.list()).activeAccountId).toBe(await hashSecret("a"));
  });
});
