import { GatewayError } from "../errors";
import { configuredOrigin } from "../gateway";
import type { AccountStorage } from "../runtime/contracts";

export const CUSTOM_ORIGINS_KEY = "custom-origins";

export function validateCustomOrigins(origins: unknown): string[] {
  if (!Array.isArray(origins)) {
    throw new GatewayError(400, "invalid_request", "origins 必须是数组。", "origins");
  }
  if (origins.length > 20) {
    throw new GatewayError(400, "invalid_request", "最多允许配置 20 个自定义域名。", "origins");
  }
  const validatedOrigins: string[] = [];
  for (let i = 0; i < origins.length; i++) {
    const origin = origins[i];
    if (typeof origin !== "string") {
      throw new GatewayError(400, "invalid_origin", `第 ${i + 1} 个域名无效，必须为字符串。`, "origins");
    }
    const trimmed = origin.trim();
    if (!trimmed || trimmed !== origin || trimmed.length > 512) {
      throw new GatewayError(400, "invalid_origin", `域名 "${origin}" 格式无效，必须为 https:// 开头且不含空格。`, "origins");
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new GatewayError(400, "invalid_origin", `域名 "${origin}" 无法解析为有效 URL。`, "origins");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search ||
      parsed.hash ||
      (trimmed !== parsed.origin && trimmed !== parsed.origin + "/")
    ) {
      throw new GatewayError(400, "invalid_origin", `域名 "${origin}" 必须是无路径、端口、查询或凭据的 HTTPS origin（例如 https://api.arcinks.com）。`, "origins");
    }
    if (!validatedOrigins.includes(parsed.origin)) {
      validatedOrigins.push(parsed.origin);
    }
  }
  if (validatedOrigins.length > 20) {
    throw new GatewayError(400, "invalid_request", "最多允许配置 20 个自定义域名。", "origins");
  }
  return validatedOrigins;
}

export class CustomOriginsManager {
  private customOrigins = new Set<string>();

  constructor(
    private readonly storage: AccountStorage,
    private readonly env: { PUBLIC_ORIGIN?: string; WORKER_ORIGIN?: string }
  ) {}

  async loadCustomOrigins(): Promise<void> {
    const storedOrigins = await this.storage.get<string[]>(CUSTOM_ORIGINS_KEY);
    if (Array.isArray(storedOrigins)) {
      for (const origin of storedOrigins) {
        if (typeof origin === "string") {
          try {
            const parsed = new URL(origin.trim());
            if (
              parsed.protocol === "https:" &&
              !parsed.username &&
              !parsed.password &&
              !parsed.port &&
              (parsed.pathname === "" || parsed.pathname === "/") &&
              !parsed.search &&
              !parsed.hash
            ) {
              this.customOrigins.add(parsed.origin);
            }
          } catch {}
        }
      }
    }
  }

  getDynamicOrigins(): Set<string> {
    return this.customOrigins;
  }

  async getNetworkOrigins(): Promise<{ defaultOrigins: string[]; customOrigins: string[] }> {
    const defaultOrigins: string[] = [];
    if (this.env.PUBLIC_ORIGIN) {
      try {
        const origin = configuredOrigin(this.env.PUBLIC_ORIGIN, "PUBLIC_ORIGIN");
        if (origin && !defaultOrigins.includes(origin)) defaultOrigins.push(origin);
      } catch {}
    }
    if (this.env.WORKER_ORIGIN) {
      try {
        const origin = configuredOrigin(this.env.WORKER_ORIGIN, "WORKER_ORIGIN");
        if (origin && !defaultOrigins.includes(origin)) defaultOrigins.push(origin);
      } catch {}
    }
    return {
      defaultOrigins,
      customOrigins: Array.from(this.customOrigins)
    };
  }

  async updateCustomOrigins(origins: string[]): Promise<{ customOrigins: string[] }> {
    const validatedOrigins = validateCustomOrigins(origins);
    await this.storage.put(CUSTOM_ORIGINS_KEY, validatedOrigins);
    this.customOrigins = new Set(validatedOrigins);
    return { customOrigins: validatedOrigins };
  }
}
