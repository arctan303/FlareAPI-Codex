import './webshare-tls-license.mjs';
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { makeTLSClient, setCryptoImplementation } from '../output/worker-webshare/tls-runtime/node_modules/@reclaimprotocol/tls/lib/index.js';
import { webcryptoCrypto } from '../output/worker-webshare/tls-runtime/node_modules/@reclaimprotocol/tls/lib/crypto/webcrypto.js';
import gateway from '../src/index';
import { AccountService } from '../src/account-core';
import type { AccountStorage } from '../src/runtime/contracts';
import type { Env } from '../src/types';
import { createWebshareFetch } from './webshare-fetch.mjs';
import { validateProxy } from './webshare-probe-core.mjs';
import { WebshareSettings } from '../src/webshare/settings';

setCryptoImplementation(webcryptoCrypto);
type WebshareEnv = Env & { PROXY_CONFIG: string };
export class WebshareAccount extends DurableObject<WebshareEnv> {
  private readonly service: AccountService;
  constructor(ctx: DurableObjectState, env: WebshareEnv) {
    super(ctx, env);
    const proxy = validateProxy(JSON.parse(env.PROXY_CONFIG));
    const storage = ctx.storage as unknown as AccountStorage;
    const settings = new WebshareSettings(storage, env.TOKEN_ENCRYPTION_KEY, {
      bootstrap: { ...proxy, id: 'bootstrap', valid: true, countryCode: 'US' },
      proxyFetch: (selected, request) => createWebshareFetch({ proxy: selected, connect, makeClient: makeTLSClient })(request),
      directFetch: request => fetch(request)
    });
    this.service = new AccountService(storage, env, {
      outboundFetch: request => settings.outboundFetch(request),
      adminExtension: request => settings.handle(request)
    });
    ctx.blockConcurrencyWhile(() => this.service.ready);
  }
  fetch(request: Request): Promise<Response> { return this.service.fetch(request); }
  alarm(): Promise<void> { return this.service.alarm(); }
}
export default gateway;
