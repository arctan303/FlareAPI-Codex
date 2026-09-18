import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServerRuntime } from "../src/runtime/node/runtime";

const encryptionKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const adminKey = "node-admin-key-for-tests-only-00000001";
const gatewayKey = "node-gateway-key-for-tests-only-0001";

const config = {
  ADMIN_API_KEY: adminKey,
  GATEWAY_API_KEY: gatewayKey,
  TOKEN_ENCRYPTION_KEY: encryptionKey
};

const adminAuth = {
  Authorization: `Bearer ${adminKey}`,
  "Content-Type": "application/json"
};

async function tempPath(name: string): Promise<{ root: string; database: string; publicDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "oneapi-origins-test-"));
  const publicDir = join(root, "public");
  await mkdir(publicDir);
  await Promise.all([
    writeFile(join(publicDir, "index.html"), "<!doctype html><title>OneAPI</title>"),
    writeFile(join(publicDir, "app.js"), "console.log(\"ok\")"),
    writeFile(join(publicDir, "styles.css"), "body{}")
  ]);
  return { root, database: join(root, name), publicDir };
}

describe("Dynamic custom origins and network settings", () => {
  it("strictly validates custom origin formats and rejects invalid inputs with 400", async () => {
    const { root, database, publicDir } = await tempPath("validation.sqlite");
    const runtime = await createServerRuntime({ databasePath: database, publicDir, config, logger: () => undefined });
    await runtime.ready;

    try {
      const loopback = { remoteAddress: "127.0.0.1" };

      // Helper to post origins
      const postOrigins = async (body: unknown) => {
        return runtime.fetch(new Request("http://127.0.0.1/admin/network/origins", {
          method: "POST",
          headers: adminAuth,
          body: JSON.stringify(body)
        }), loopback);
      };

      // 1. Non-array origins
      const res1 = await postOrigins({ origins: "https://api.arcinks.com" });
      expect(res1.status).toBe(400);
      const err1 = (await res1.json()) as { error?: { code?: string } };
      expect(err1.error?.code).toBe("invalid_request");

      // 2. Extra unexpected keys in body
      const res2 = await postOrigins({ origins: [], unexpected: true });
      expect(res2.status).toBe(400);

      // 3. HTTP instead of HTTPS
      const res3 = await postOrigins({ origins: ["http://api.arcinks.com"] });
      expect(res3.status).toBe(400);
      const err3 = (await res3.json()) as { error?: { code?: string } };
      expect(err3.error?.code).toBe("invalid_origin");

      // 4. Contains path
      const res4 = await postOrigins({ origins: ["https://api.arcinks.com/v1"] });
      expect(res4.status).toBe(400);

      // 5. Contains port
      const res5 = await postOrigins({ origins: ["https://api.arcinks.com:8443"] });
      expect(res5.status).toBe(400);

      // 6. Contains query parameters
      const res6 = await postOrigins({ origins: ["https://api.arcinks.com?query=1"] });
      expect(res6.status).toBe(400);

      // 7. Contains hash
      const res7 = await postOrigins({ origins: ["https://api.arcinks.com#fragment"] });
      expect(res7.status).toBe(400);

      // 8. Contains credentials
      const res8 = await postOrigins({ origins: ["https://user:pass@api.arcinks.com"] });
      expect(res8.status).toBe(400);

      // 9. Leading/trailing whitespace
      const res9 = await postOrigins({ origins: [" https://api.arcinks.com "] });
      expect(res9.status).toBe(400);

      // 10. Empty string or non-string
      const res10 = await postOrigins({ origins: [""] });
      expect(res10.status).toBe(400);
      const res11 = await postOrigins({ origins: [12345] });
      expect(res11.status).toBe(400);

      // 11. Over limit (> 20 origins)
      const tooMany = Array.from({ length: 21 }, (_, i) => `https://domain${i}.example.com`);
      const res12 = await postOrigins({ origins: tooMany });
      expect(res12.status).toBe(400);
      const err12 = (await res12.json()) as { error?: { code?: string } };
      expect(err12.error?.code).toBe("invalid_request");

      // 12. Valid origins with trailing slash and deduplication
      const resValid = await postOrigins({
        origins: ["https://api.arcinks.com/", "https://api.arcinks.com", "https://sub.example.com"]
      });
      expect(resValid.status).toBe(200);
      const dataValid = (await resValid.json()) as { customOrigins: string[] };
      expect(dataValid.customOrigins).toEqual(["https://api.arcinks.com", "https://sub.example.com"]);
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("persists custom origins across runtime restarts", async () => {
    const { root, database, publicDir } = await tempPath("persistence.sqlite");
    let runtime = await createServerRuntime({ databasePath: database, publicDir, config, logger: () => undefined });
    await runtime.ready;

    const loopback = { remoteAddress: "127.0.0.1" };

    try {
      // Initially customOrigins is empty
      const initRes = await runtime.fetch(new Request("http://127.0.0.1/admin/network/origins", {
        headers: adminAuth
      }), loopback);
      expect(initRes.status).toBe(200);
      const initData = (await initRes.json()) as { customOrigins: string[] };
      expect(initData.customOrigins).toEqual([]);

      // Save custom origin https://api.arcinks.com
      const saveRes = await runtime.fetch(new Request("http://127.0.0.1/admin/network/origins", {
        method: "POST",
        headers: adminAuth,
        body: JSON.stringify({ origins: ["https://api.arcinks.com"] })
      }), loopback);
      expect(saveRes.status).toBe(200);
      const saveData = (await saveRes.json()) as { customOrigins: string[] };
      expect(saveData.customOrigins).toEqual(["https://api.arcinks.com"]);

      // Dispose runtime
      await runtime.dispose();

      // Create new runtime instance reusing the same database
      runtime = await createServerRuntime({ databasePath: database, publicDir, config, logger: () => undefined });
      await runtime.ready;

      // Check that customOrigins was loaded from storage upon startup
      const reloadedRes = await runtime.fetch(new Request("http://127.0.0.1/admin/network/origins", {
        headers: adminAuth
      }), loopback);
      expect(reloadedRes.status).toBe(200);
      const reloadedData = (await reloadedRes.json()) as { customOrigins: string[] };
      expect(reloadedData.customOrigins).toEqual(["https://api.arcinks.com"]);
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("intercepts unallowed origins with 403 host_not_allowed and allows requests through dynamic custom origins", async () => {
    const { root, database, publicDir } = await tempPath("gateway-access.sqlite");
    const runtime = await createServerRuntime({ databasePath: database, publicDir, config, logger: () => undefined });
    await runtime.ready;

    const loopback = { remoteAddress: "127.0.0.1" };
    // Non-loopback client requesting over public internet / reverse proxy
    const externalClient = { remoteAddress: "198.51.100.25" };

    try {
      // 1. Before configuring custom origin, requests to https://api.arcinks.com are rejected
      const blockedHealth = await runtime.fetch(new Request("https://api.arcinks.com/health"), externalClient);
      expect(blockedHealth.status).toBe(403);
      const blockedHealthBody = (await blockedHealth.json()) as { error?: { code?: string } };
      expect(blockedHealthBody.error?.code).toBe("host_not_allowed");

      const blockedLogin = await runtime.fetch(new Request("https://api.arcinks.com/admin/login"), externalClient);
      expect(blockedLogin.status).toBe(403);
      const blockedLoginBody = (await blockedLogin.json()) as { error?: { code?: string } };
      expect(blockedLoginBody.error?.code).toBe("host_not_allowed");

      // 2. Add https://api.arcinks.com to dynamic custom origins
      const addRes = await runtime.fetch(new Request("http://127.0.0.1/admin/network/origins", {
        method: "POST",
        headers: adminAuth,
        body: JSON.stringify({ origins: ["https://api.arcinks.com"] })
      }), loopback);
      expect(addRes.status).toBe(200);

      // 3. Now requests to https://api.arcinks.com are allowed!
      const allowedHealth = await runtime.fetch(new Request("https://api.arcinks.com/health"), externalClient);
      expect(allowedHealth.status).toBe(200);
      const allowedHealthBody = (await allowedHealth.json()) as { ok?: boolean };
      expect(allowedHealthBody.ok).toBe(true);

      const allowedLogin = await runtime.fetch(new Request("https://api.arcinks.com/admin/login"), externalClient);
      expect(allowedLogin.status).toBe(200);
      const allowedLoginHtml = await allowedLogin.text();
      expect(allowedLoginHtml).toContain("OneAPI");

      // 4. Other domains not in custom origins are still blocked
      const stillBlocked = await runtime.fetch(new Request("https://other.example.com/health"), externalClient);
      expect(stillBlocked.status).toBe(403);
      const stillBlockedBody = (await stillBlocked.json()) as { error?: { code?: string } };
      expect(stillBlockedBody.error?.code).toBe("host_not_allowed");

      // 5. Remove custom origin
      const removeRes = await runtime.fetch(new Request("http://127.0.0.1/admin/network/origins", {
        method: "POST",
        headers: adminAuth,
        body: JSON.stringify({ origins: [] })
      }), loopback);
      expect(removeRes.status).toBe(200);

      // Now https://api.arcinks.com is immediately blocked again
      const reBlocked = await runtime.fetch(new Request("https://api.arcinks.com/health"), externalClient);
      expect(reBlocked.status).toBe(403);
      const reBlockedBody = (await reBlocked.json()) as { error?: { code?: string } };
      expect(reBlockedBody.error?.code).toBe("host_not_allowed");
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
