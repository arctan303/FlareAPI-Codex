import './webshare-tls-license.mjs';
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { makeTLSClient, setCryptoImplementation } from '../output/worker-webshare/tls-runtime/node_modules/@reclaimprotocol/tls/lib/index.js';
import { webcryptoCrypto } from '../output/worker-webshare/tls-runtime/node_modules/@reclaimprotocol/tls/lib/crypto/webcrypto.js';
import { AccountService } from '../src/account-core';
import { configuredOrigin, handleGatewayRequest } from '../src/gateway';
import { measureProxyTcp } from '../src/runtime/worker/webshare-latency';
import { persistentEncryptionKey } from '../src/runtime/worker/flareapi-key';
import type { AccountStorage } from '../src/runtime/contracts';
import type { Env } from '../src/types';
import { WebshareSettings } from '../src/webshare/settings';
import { createWebshareFetch } from './webshare-fetch.mjs';

declare const FLAREAPI_ORIGIN: string;
type FlareEnv = Pick<Env, 'ACCOUNT' | 'ASSETS' | 'ADMIN_API_KEY'> & { TOKEN_ENCRYPTION_KEY?: string };
setCryptoImplementation(webcryptoCrypto);
// Same class name/migration preserves the existing namespace. Only ADMIN_API_KEY is required.
export class WebshareAccount extends DurableObject<FlareEnv> {
  private service!: AccountService;
  private runtime!: Env;
  constructor(ctx: DurableObjectState, env: FlareEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const storage = ctx.storage as unknown as AccountStorage;
      const key = await persistentEncryptionKey(storage, env.TOKEN_ENCRYPTION_KEY);
      const origin = configuredOrigin(FLAREAPI_ORIGIN, 'Worker build origin')!;
      this.runtime = { ACCOUNT: env.ACCOUNT, ASSETS: env.ASSETS, ADMIN_API_KEY: env.ADMIN_API_KEY,
        GATEWAY_API_KEY: '', TOKEN_ENCRYPTION_KEY: key, PUBLIC_ORIGIN: origin, WORKER_ORIGIN: origin };
      const settings = new WebshareSettings(storage, key, {
        bootstrap: null, requireProxy: true,
        measureProxy: proxy => measureProxyTcp(proxy, connect),
        proxyFetch: (proxy, request) => createWebshareFetch({ proxy, connect, makeClient: makeTLSClient })(request),
        directFetch: request => fetch(request)
      });
      this.service = new AccountService(storage, this.runtime, {
        outboundFetch: request => settings.outboundFetch(request),
        adminExtension: request => settings.handle(request)
      });
      await this.service.ready;
    });
  }
  fetch(request: Request): Promise<Response> {
    return handleGatewayRequest(request, this.runtime, {
      accountFetch: forwarded => this.service.fetch(forwarded),
      staticFetch: forwarded => this.env.ASSETS.fetch(forwarded),
      cancelLease: async leaseId => {
        await this.service.fetch(new Request('https://oneapi.internal/__internal/cancel?lease_id=' + encodeURIComponent(leaseId), {
          method: 'POST', headers: { Authorization: 'Bearer ' + this.runtime.TOKEN_ENCRYPTION_KEY }
        }));
      },
      allowInternalControl: false,
      allowLoopbackWithoutPeer: true,
      getDynamicOrigins: () => this.service.getDynamicOrigins()
    });
  }
  alarm(): Promise<void> { return this.service.alarm(); }
}
export default {
  fetch(request: Request, env: FlareEnv): Promise<Response> {
    return env.ACCOUNT.get(env.ACCOUNT.idFromName('primary')).fetch(request);
  }
};