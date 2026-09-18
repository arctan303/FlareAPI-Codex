const enc = new TextEncoder();
const dec = new TextDecoder();
const PROXIES = new Map([['9.142.39.218', 7388], ['138.226.61.165', 6338], ['9.249.18.109', 7343]]);
export function validateProxy(proxy) {
  if (!proxy || PROXIES.get(proxy.host) !== proxy.port || typeof proxy.username !== 'string' || typeof proxy.password !== 'string'
      || !/^[\x21-\x7e]{1,200}$/.test(proxy.username) || !/^[\x21-\x7e]{1,200}$/.test(proxy.password)) throw new Error('proxy_config_invalid');
  return proxy;
}
export function parseHttpResponse(bytes) {
  const crlf = (offset) => { for (let i = offset; i + 1 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10) return i; return -1; };
  let separator = -1;
  for (let i = 0; i + 3 < bytes.length && i <= 16384; i++) if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) { separator = i; break; }
  if (separator < 0) throw new Error('http_headers_invalid');
  const head = dec.decode(bytes.subarray(0, separator));
  const status = /^HTTP\/1\.[01] ([1-5]\d\d)(?: |\r\n)/.exec(head);
  if (!status) throw new Error('http_status_invalid');
  const headers = new Headers();
  for (const line of head.split('\r\n').slice(1)) {
    const colon = line.indexOf(':'); if (colon < 1) throw new Error('http_headers_invalid');
    headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  let bodyData = bytes.subarray(separator + 4);
  const transfer = headers.get('transfer-encoding');
  if (transfer) {
    if (transfer.toLowerCase() !== 'chunked' || headers.has('content-length')) throw new Error('http_framing_invalid');
    const chunks = []; let cursor = separator + 4; let length = 0; let count = 0;
    while (true) {
      if (++count > 4096) throw new Error('chunk_limit');
      const end = crlf(cursor); if (end < 0 || end - cursor > 1024) throw new Error('chunk_invalid');
      const size = dec.decode(bytes.subarray(cursor, end));
      if (!/^[0-9a-f]+(?:;[^\r\n]*)?$/i.test(size)) throw new Error('chunk_invalid');
      const n = parseInt(size, 16); cursor = end + 2;
      if (!Number.isSafeInteger(n) || n > 2 * 1024 * 1024) throw new Error('chunk_limit');
      if (n === 0) {
        const start = cursor;
        while (true) {
          const end = crlf(cursor); if (end < 0 || end - start > 16384) throw new Error('chunk_truncated');
          if (end === cursor) { cursor = end + 2; break; }
          cursor = end + 2;
        }
        if (cursor !== bytes.length) throw new Error('http_trailing_data'); break;
      }
      if (cursor + n + 2 > bytes.length) throw new Error('chunk_truncated');
      if (bytes[cursor + n] !== 13 || bytes[cursor + n + 1] !== 10) throw new Error('chunk_invalid');
      chunks.push(bytes.subarray(cursor, cursor + n)); length += n; cursor += n + 2;
    }
    bodyData = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bodyData.set(chunk, offset); offset += chunk.length; }
  } else if (headers.has('content-length')) {
    const length = headers.get('content-length');
    if (!/^\d+$/.test(length) || Number(length) !== bodyData.length) throw new Error('body_length_invalid');
  }
  return { status: Number(status[1]), body: dec.decode(bodyData), bodyData, headers };
}
function validateModelAuth(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'accountId,authorization,marker'
    || typeof value.authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{16,8192}$/.test(value.authorization)
    || typeof value.accountId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.accountId)
    || typeof value.marker !== 'boolean') throw new Error('model_auth_invalid');
  return value;
}
export function modelRequestText(authValue) {
  const auth = validateModelAuth(authValue);
  const headers = { Host: 'chatgpt.com', Authorization: auth.authorization, 'ChatGPT-Account-ID': auth.accountId,
    Accept: 'application/json', 'Content-Type': 'application/json', originator: 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs/0.153.4 (Cloudflare Workers; JavaScript) OneAPI/0.1.0', version: '0.153.4',
    'Accept-Encoding': 'identity', Connection: 'close' };
  if (auth.marker) headers['CF-Worker'] = 'oneapi.12213443th.workers.dev';
  return 'GET /backend-api/codex/models?client_version=0.153.4 HTTP/1.1\r\n'
    + Object.entries(headers).map(([k,v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n';
}
export async function runProbe(connect, proxyValue, operation, timeoutMs = 20000, tlsUpgrade, modelAuth) {
  const proxy = validateProxy(proxyValue);
  if (!['ip', 'chatgpt-tls', 'models'].includes(operation)) throw new Error('operation_invalid');
  const target = operation === 'ip' ? 'api.ipify.org' : 'chatgpt.com';
  if (operation === 'models') { validateModelAuth(modelAuth); if (!tlsUpgrade) throw new Error('verified_tls_required'); }
  const report = { operation, proxy: { host: proxy.host, port: proxy.port }, target,
    tcpOpened: false, proxyConnectStatus: null, tlsOpened: false, expectedServerHostname: target, error: null };
  let socket; let reader; let writer; let stage = 'tcp'; let expired = false; let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    expired = true; if (socket) void socket.close().catch(() => {});
    reject(new Error('probe_timeout'));
  }, timeoutMs); });
  const step = async promise => { if (expired) throw new Error('probe_timeout'); const value = await Promise.race([promise, timeout]); if (expired) throw new Error('probe_timeout'); return value; };
  try {
    socket = connect({ hostname: proxy.host, port: proxy.port }, { secureTransport: 'starttls', allowHalfOpen: false });
    void socket.closed.catch(() => {});
    await step(socket.opened); report.tcpOpened = true; stage = 'proxy_connect';
    writer = socket.writable.getWriter(); reader = socket.readable.getReader();
    const credentials = btoa(`${proxy.username}:${proxy.password}`);
    await step(writer.write(enc.encode(`CONNECT ${target}:443 HTTP/1.1\r\nHost: ${target}:443\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`)));
    let headers = '';
    while (!headers.includes('\r\n\r\n')) {
      const chunk = await step(reader.read());
      if (chunk.done) throw new Error('proxy_closed_before_headers');
      headers += dec.decode(chunk.value);
      if (headers.length > 16384) throw new Error('proxy_headers_too_large');
    }
    const status = /^HTTP\/1\.[01] (\d{3})(?: |\r\n)/.exec(headers);
    if (!status) throw new Error('proxy_status_invalid');
    report.proxyConnectStatus = Number(status[1]);
    if (report.proxyConnectStatus !== 200) throw new Error('proxy_connect_rejected');
    if (headers.indexOf('\r\n\r\n') + 4 !== headers.length) throw new Error('proxy_unexpected_payload');
    reader.releaseLock(); reader = undefined; writer.releaseLock(); writer = undefined;
    stage = 'tls'; socket = tlsUpgrade ? tlsUpgrade(socket, target, report) : socket.startTls({ expectedServerHostname: target });
    void socket.closed.catch(() => {}); await step(socket.opened); report.tlsOpened = true;
    if (operation === 'chatgpt-tls') return report;
    if (operation === 'models' && report.tlsHandshakeVerified !== true) throw new Error('verified_tls_required');
    stage = 'https_write'; writer = socket.writable.getWriter(); reader = socket.readable.getReader();
    if (operation === 'models') report.modelRequestAttempted = true;
    await step(writer.write(enc.encode(operation === 'models' ? modelRequestText(modelAuth) : `GET /?format=json HTTP/1.1\r\nHost: ${target}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`)));
    if (operation === 'models') report.modelRequestWriteCompleted = true;
    stage = 'https_read'; report.responseBytesReceived = 0; const chunks = []; let length = 0;
    while (true) {
      const chunk = await step(reader.read()); if (chunk.done) break;
      length += chunk.value.byteLength; report.responseBytesReceived = length; if (length > (operation === 'models' ? 2 * 1024 * 1024 : 65536)) throw new Error('http_response_too_large'); chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    stage = 'http_parse'; const response = parseHttpResponse(bytes); report.httpStatus = response.status; report.bodyBytes = response.bodyData.length;
    report.bodySha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', response.bodyData))].map(v => v.toString(16).padStart(2, '0')).join('');
    const type = response.headers.get('content-type') ?? '';
    report.contentType = /^(?:application\/json|text\/html)(?:;\s*charset=[a-z0-9-]+)?$/i.test(type) ? type : null;
    const ray = response.headers.get('cf-ray') ?? ''; report.cfRay = /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray) ? ray : null;
    report.cfMitigated = response.headers.get('cf-mitigated') === 'challenge' ? 'challenge' : null;
    report.bodyFormat = /^\s*(?:<!doctype html|<html)/i.test(response.body) ? 'html' : 'other';
    if (operation === 'models' && response.status === 200 && /^application\/json/i.test(type)) {
      try { const parsed = JSON.parse(response.body); report.jsonValid = true; report.modelsArrayPresent = Array.isArray(parsed?.models); } catch { report.jsonValid = false; }
    }
    if (operation === 'ip' && response.status === 200 && report.bodyBytes <= 1024) {
      const ip = JSON.parse(response.body).ip;
      if (typeof ip !== 'string' || !/^[0-9a-f.:]{3,45}$/i.test(ip)) throw new Error('exit_ip_invalid'); report.exitIp = ip;
    }
    return report;
  } catch (error) {
    report.failedStage = stage;
    report.errorName = ['Error', 'TypeError', 'RangeError', 'DOMException'].includes(error?.name) ? error.name : 'Error';
    const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
    report.errorTags = ['closed', 'disconnected', 'network', 'certificate', 'tls', 'locked', 'broken', 'write', 'read', 'reset', 'unsupported', 'aborted', 'proxy', 'stream', 'handshake', 'hostname', 'peer', 'alert', 'eof', 'trust'].filter(tag => message.includes(tag));
    if (/^tls (?:handshake )?failed[.!]?$/.test(message)) report.error = 'tls_handshake_failed';
    else if (error?.message?.includes('expectedServerHostname option is not currently supported')) report.error = 'tls_hostname_override_unsupported';
    else report.error = typeof error?.message === 'string' && /^[a-z_]{3,60}$/.test(error.message) ? error.message : `${stage}_failed`;
    return report;
  } finally {
    clearTimeout(timer);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (writer) writer.releaseLock();
    if (socket) void socket.close().catch(() => {});
  }
}
export async function runModelsPair(connect, proxy, body, tlsUpgrade) {
  if (Object.keys(body).sort().join(',') !== 'accountId,authorization,operation,runId' || body.operation !== 'models-pair') throw new Error('model_request_invalid');
  const base = validateModelAuth({ accountId: body.accountId, authorization: body.authorization, marker: false });
  const result = { operation: 'models-pair', withoutMarker: null, withMarker: null, modelRequestAttempts: 0, modelRequestWritesCompleted: 0, generationRequests: 0, refreshRequests: 0, automaticRetries: 0 };
  for (const [field, marker] of [['withoutMarker', false], ['withMarker', true]]) {
    const report = await runProbe(connect, proxy, 'models', 20000, tlsUpgrade, { ...base, marker });
    result[field] = report;
    if (report.modelRequestAttempted) result.modelRequestAttempts++;
    if (report.modelRequestWriteCompleted) result.modelRequestWritesCompleted++;
    if (report.error || report.httpStatus === 401 || (report.httpStatus >= 300 && report.httpStatus < 400)) break;
  }
  return result;
}
let modelStarted = false;
export async function handleProbe(request, env, connect, tlsUpgrade) {
  const url = new URL(request.url);
  const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  if (request.method === 'GET' && url.pathname === '/health' && !url.search) return json({ ok: true, service: 'oneapi-webshare-probe', profile: tlsUpgrade ? 'strict-tls13-cv-v1' : 'native-tls', modelProbeEnabled: Boolean(env.MODEL_RUN_ID && Number.isFinite(Number(env.MODEL_PROBE_DEADLINE)) && Number(env.MODEL_PROBE_DEADLINE) > Date.now() && Number(env.MODEL_PROBE_DEADLINE) - Date.now() <= 30 * 60 * 1000 && !modelStarted) });
  if (url.pathname !== '/probe' || url.search || request.method !== 'POST') return json({ error: 'not_found' }, 404);
  if (!env.PROBE_KEY || request.headers.get('Authorization') !== `Bearer ${env.PROBE_KEY}`) return json({ error: 'unauthorized' }, 401);
  if (!env.PROXY_CONFIG) return json({ error: 'probe_disabled' }, 503);
  let reader; let total = 0; let text = ''; let bodyTimer;
  const bodyTimeout = new Promise((_, reject) => { bodyTimer = setTimeout(() => reject(new Error('request_timeout')), 5000); });
  try {
    reader = request.body?.getReader(); if (!reader) return json({ error: 'invalid_request' }, 400);
    while (true) {
      const chunk = await Promise.race([reader.read(), bodyTimeout]); if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > 16384) { void reader.cancel().catch(() => {}); return json({ error: 'request_too_large' }, 413); }
      text += dec.decode(chunk.value);
    }
    const body = JSON.parse(text); clearTimeout(bodyTimer);
    if (body?.operation === 'models-pair') {
      if (!env.MODEL_RUN_ID || body.runId !== env.MODEL_RUN_ID || !env.MODEL_PROBE_DEADLINE || Date.now() >= Number(env.MODEL_PROBE_DEADLINE)) return json({ error: 'model_probe_disabled' }, 503);
      if (!Number.isFinite(Number(env.MODEL_PROBE_DEADLINE)) || Number(env.MODEL_PROBE_DEADLINE) - Date.now() > 30 * 60 * 1000) return json({ error: 'model_probe_deadline_invalid' }, 503);
      if (modelStarted) return json({ error: 'model_probe_already_started' }, 409);
      validateModelAuth({ accountId: body.accountId, authorization: body.authorization, marker: false });
      if (Object.keys(body).sort().join(',') !== 'accountId,authorization,operation,runId') return json({ error: 'invalid_request' }, 400);
      if (!tlsUpgrade) return json({ error: 'verified_tls_required' }, 503);
      const proxy = validateProxy(JSON.parse(env.PROXY_CONFIG));
      modelStarted = true;
      return json(await runModelsPair(connect, proxy, body, tlsUpgrade));
    }
    if (!body || total > 512 || Object.keys(body).length !== 1 || !['ip', 'chatgpt-tls'].includes(body.operation)) return json({ error: 'invalid_request' }, 400);
    const proxy = validateProxy(JSON.parse(env.PROXY_CONFIG));
    return json(await runProbe(connect, proxy, body.operation, 20000, tlsUpgrade));
  } catch { return json({ error: 'probe_request_invalid' }, 400); }
  finally { clearTimeout(bodyTimer); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
}
