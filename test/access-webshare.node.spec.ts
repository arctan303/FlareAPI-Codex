import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountService } from '../src/account-core';
import { SqliteAccountStorage } from '../src/runtime/node/sqlite-storage';
import { WebshareSettings } from '../src/webshare/settings';
import { validateTarget } from '../experiments/webshare-fetch.mjs';

const team = 'fixture.cloudflareaccess.com';
const aud = 'fixture-access-aud';
const encryptionKey = Buffer.alloc(32, 13).toString('base64');
const proxy = { id: 'fixture', host: '9.142.39.218', port: 7388, username: 'fixture-user', password: 'fixture-password', countryCode: 'US', valid: true };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(active = true) {
  const root = await mkdtemp(join(tmpdir(), 'flareapi-access-'));
  const storage = new SqliteAccountStorage(join(root, 'fixture.sqlite'));
  cleanups.push(async () => { await storage.close(); await rm(root, { recursive: true, force: true }); });
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'fixture', use: 'sig', alg: 'RS256' };
  const direct = vi.fn(async (_request: Request) => Response.json({ keys: [jwk] }));
  const proxied = vi.fn(async (_proxy: typeof proxy, request: Request) => { validateTarget(request); return new Response(null, { status: 401 }); });
  const settings = new WebshareSettings(storage, encryptionKey, { bootstrap: active ? proxy : null, requireProxy: true, proxyFetch: proxied, directFetch: direct });
  const service = new AccountService(storage, { ADMIN_API_KEY: 'fixture-admin', GATEWAY_API_KEY: '', TOKEN_ENCRYPTION_KEY: encryptionKey }, { outboundFetch: request => settings.outboundFetch(request) });
  await service.ready;
  await storage.put('access-config', { enabled: true, teamDomain: team, applicationAud: aud, updatedAt: Date.now(), revision: 1 });
  async function token(overrides: Record<string, unknown> = {}, corrupt = false) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'fixture' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'https://' + team, aud: [aud], nbf: now - 1, exp: now + 600, ...overrides })).toString('base64url');
    const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(header + '.' + payload)));
    if (corrupt) signature[0] ^= 1;
    return header + '.' + payload + '.' + Buffer.from(signature).toString('base64url');
  }
  const session = async (jwt: string) => service.fetch(new Request('https://fixture.example/admin/session', { headers: { 'Cf-Access-Jwt-Assertion': jwt } }));
  return { settings, service, direct, proxied, token, session };
}

describe('Access login with Webshare outbound routing', () => {
  it.each([true, false])('verifies Access and opens admin session with proxy active=%s', async active => {
    const f = await fixture(active);
    const jwt = await f.token();
    const response = await f.session(jwt);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authenticated: true, provider: 'access', logoutUrl: '/cdn-cgi/access/logout' });
    const admin = await f.service.fetch(new Request('https://fixture.example/admin/access', { headers: { 'Cf-Access-Jwt-Assertion': jwt } }));
    expect(admin.status).toBe(200);
    expect(f.direct).toHaveBeenCalledTimes(1);
    expect(f.direct.mock.calls[0][0].url).toBe('https://' + team + '/cdn-cgi/access/certs');
    expect(f.direct.mock.calls[0][0].redirect).toBe('manual');
    expect(f.proxied).not.toHaveBeenCalled();
  });
  it('continues rejecting wrong audience, expired tokens and forged signatures', async () => {
    const f = await fixture();
    for (const jwt of [await f.token({ aud: ['wrong'] }), await f.token({ exp: 1 }), await f.token({}, true)]) {
      const response = await f.session(jwt);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ authenticated: false });
      const admin = await f.service.fetch(new Request('https://fixture.example/admin/access', { headers: { 'Cf-Access-Jwt-Assertion': jwt } }));
      expect(admin.status).toBe(401);
    }
  });
  it('keeps Codex on the selected proxy and does not widen the direct route', async () => {
    const f = await fixture();
    await f.settings.outboundFetch(new Request('https://chatgpt.com/backend-api/wham/usage'));
    expect(f.proxied).toHaveBeenCalledTimes(1);
    for (const url of ['https://fixture.cloudflareaccess.com.evil.example/cdn-cgi/access/certs', 'https://nested.fixture.cloudflareaccess.com/cdn-cgi/access/certs', 'http://' + team + '/cdn-cgi/access/certs', 'https://' + team + '/cdn-cgi/access/certs?next=evil', 'https://' + team + '/other', 'https://' + team + ':444/cdn-cgi/access/certs']) {
      await expect(f.settings.outboundFetch(new Request(url))).rejects.toThrow('outbound_');
    }
    await expect(f.settings.outboundFetch(new Request('https://' + team + '/cdn-cgi/access/certs', { method: 'POST' }))).rejects.toThrow('outbound_');
    expect(f.direct).not.toHaveBeenCalled();
  });
  it('requests only public keys without forwarding secrets or following redirects', async () => {
    const f = await fixture();
    const controller = new AbortController();
    await f.settings.outboundFetch(new Request('https://' + team + '/cdn-cgi/access/certs', {
      headers: { Authorization: 'Bearer fixture-sensitive', Cookie: 'fixture-sensitive', 'Cf-Access-Jwt-Assertion': 'fixture-sensitive' },
      redirect: 'follow', signal: controller.signal
    }));
    const request = f.direct.mock.calls[0][0];
    expect([...request.headers]).toEqual([['accept', 'application/json']]);
    expect(request.redirect).toBe('manual');
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });
  it('fails closed when the public key server redirects or fails', async () => {
    const f = await fixture();
    f.direct.mockImplementation(async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }));
    const response = await f.session(await f.token());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'access_jwks_unavailable' } });
  });
});
