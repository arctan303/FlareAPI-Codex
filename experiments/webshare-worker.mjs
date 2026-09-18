import './webshare-tls-license.mjs';
import { connect } from 'cloudflare:sockets';
import { makeTLSClient, setCryptoImplementation } from '../output/worker-webshare/tls-runtime/node_modules/@reclaimprotocol/tls/lib/index.js';
import { webcryptoCrypto } from '../output/worker-webshare/tls-runtime/node_modules/@reclaimprotocol/tls/lib/crypto/webcrypto.js';
import { createVerifiedTlsSocket } from './webshare-tls-transport.mjs';
import { handleProbe } from './webshare-probe-core.mjs';
setCryptoImplementation(webcryptoCrypto);
export default { fetch(request, env) {
  return handleProbe(request, env, connect, (socket, host, report) => createVerifiedTlsSocket(socket, host, report, makeTLSClient));
} };
