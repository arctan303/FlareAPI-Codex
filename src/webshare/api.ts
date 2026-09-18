import { GatewayError } from "../errors";
export interface WebshareProxy { id: string; host: string; port: number; username: string; password: string; valid: boolean; countryCode: string; }
export type WebshareApiFetch = (request: Request) => Promise<Response>;
export function isPublicProxyIPv4(host: string): boolean {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(host)) return false;
  const parts = host.split(".").map(Number);
  if (parts.some(p => p > 255)) return false;
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
export function validateWebshareProxy(value: unknown): WebshareProxy {
  const p = value as WebshareProxy;
  if (!p || typeof p.id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(p.id)
    || typeof p.host !== "string" || !isPublicProxyIPv4(p.host) || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535 || p.port === 25
    || typeof p.username !== "string" || !/^[\x21-\x39\x3b-\x7e]{1,200}$/.test(p.username)
    || typeof p.password !== "string" || !/^[\x21-\x7e]{1,200}$/.test(p.password)
    || typeof p.valid !== "boolean" || !/^[A-Z]{2}$/.test(p.countryCode)) {
    throw new GatewayError(502, "invalid_webshare_response", "Webshare 返回了不支持的固定节点数据。", undefined, "server_error");
  }
  return p;
}
export function validateWebshareApiKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,512}$/.test(value)) throw new GatewayError(400, "invalid_webshare_api_key", "请输入有效的 Webshare API key。", "apiKey");
  return value;
}
export function validateWebsharePlanId(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new GatewayError(400, "invalid_webshare_plan_id", "Plan ID 必须是正整数，留空使用 Webshare 默认套餐。", "planId");
  return value;
}
export async function fetchWebshareNodes(apiKey: string, planId: number | null, fetcher: WebshareApiFetch = request => fetch(request)): Promise<WebshareProxy[]> {
  validateWebshareApiKey(apiKey); validateWebsharePlanId(planId);
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 20000);
  const nodes: WebshareProxy[] = []; const ids = new Set<string>(); let expectedCount: number | undefined;
  try {
    for (let page = 1; page <= 10; page++) {
      const url = new URL("https://proxy.webshare.io/api/v2/proxy/list/");
      url.searchParams.set("mode", "direct"); url.searchParams.set("page", String(page)); url.searchParams.set("page_size", "25");
      if (planId !== null) url.searchParams.set("plan_id", String(planId));
      const response = await fetcher(new Request(url, { headers: { Authorization: "Token " + apiKey, Accept: "application/json" }, redirect: "manual", signal: abort.signal }));
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const code = response.status === 401 || response.status === 403 ? "webshare_api_key_rejected" : response.status === 429 ? "webshare_rate_limited" : "webshare_api_failed";
        throw new GatewayError(502, code, "无法获取 Webshare 节点，请检查 API key、套餐或稍后重试。", undefined, "server_error");
      }
      const reader = response.body?.getReader(); if (!reader) throw new Error("empty_api_response");
      let size = 0; const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength; if (size > 256 * 1024) throw new Error("api_response_limit"); chunks.push(part.value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
      if (!Array.isArray(data.results) || data.results.length > 25 || !Number.isSafeInteger(data.count) || (data.count as number) < 0 || data.next !== null && typeof data.next !== "string") throw new Error("invalid_api_response");
      const count = data.count as number;
      if (count > 250) throw new GatewayError(502, "webshare_node_limit", "当前最多支持同步250个固定节点。", undefined, "server_error");
      if (expectedCount === undefined) expectedCount = count;
      if (count !== expectedCount || nodes.length + data.results.length > count) throw new Error("inconsistent_api_count");
      for (const item of data.results) {
        const p = item as Record<string, unknown>;
        const proxy = validateWebshareProxy({ id: p.id, host: p.proxy_address, port: p.port, username: p.username, password: p.password, valid: p.valid, countryCode: p.country_code });
        if (ids.has(proxy.id)) throw new Error("duplicate_proxy");
        ids.add(proxy.id); nodes.push(proxy);
      }
      if (data.next === null) { if (nodes.length !== expectedCount) throw new Error("incomplete_api_list"); return nodes; }
      // Rebuild page URLs at the official origin; never follow the supplied next URL.
      if (data.results.length === 0) throw new Error("empty_page");
    }
    throw new GatewayError(502, "webshare_node_limit", "当前最多支持同步250个固定节点，请使用较小的固定节点套餐。", undefined, "server_error");
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(502, "webshare_api_failed", "Webshare 节点同步失败，请稍后重试。", undefined, "server_error");
  } finally { clearTimeout(timer); }
}
