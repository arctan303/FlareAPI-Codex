import './webshare-tls-license.mjs';
import { createVerifiedTlsSocket } from './webshare-tls-transport.mjs';
const encoder = new TextEncoder();
const decoder = new TextDecoder('latin1');
const CONTROL_LIMIT = 2 * 1024 * 1024;
const STREAM_LIMIT = 64 * 1024 * 1024;
const forbiddenHeaders = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'accept-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'cf-worker', 'cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']);
export function validateTarget(request) {
  const u = new URL(request.url);
  if (u.protocol !== 'https:' || u.port && u.port !== '443' || u.username || u.password || u.hash) throw new Error('outbound_target_rejected');
  const paths = u.hostname === 'chatgpt.com'
    ? { '/backend-api/codex/models': 'GET', '/backend-api/wham/usage': 'GET', '/backend-api/codex/responses': 'POST' }
    : u.hostname === 'auth.openai.com'
      ? { '/api/accounts/deviceauth/usercode': 'POST', '/api/accounts/deviceauth/token': 'POST', '/oauth/token': 'POST' } : {};
  if (paths[u.pathname] !== request.method) throw new Error('outbound_target_rejected');
  if (u.pathname.endsWith('/models') ? u.search !== '?client_version=0.153.4' : u.search !== '') throw new Error('outbound_query_rejected');
  return u;
}
export class ByteReader {
  constructor(reader, signal, limit) { this.reader = reader; this.signal = signal; this.limit = limit; this.bytes = 0; this.buffer = new Uint8Array(); this.eof = false; }
  async more() {
    this.signal?.throwIfAborted();
    const result = await this.reader.read();
    this.signal?.throwIfAborted();
    if (result.done) { this.eof = true; return false; }
    this.bytes += result.value.byteLength;
    if (this.bytes > this.limit) throw new Error('http_response_too_large');
    const next = new Uint8Array(this.buffer.length + result.value.length);
    next.set(this.buffer); next.set(result.value, this.buffer.length); this.buffer = next;
    return true;
  }
  async line(max = 8192) {
    for (;;) {
      for (let i = 0; i + 1 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10) {
          if (i > max) throw new Error('http_line_too_large');
          const line = decoder.decode(this.buffer.subarray(0, i)); this.buffer = this.buffer.slice(i + 2); return line;
        }
      }
      if (this.buffer.length > max + 1 || !await this.more()) throw new Error('http_line_invalid');
    }
  }
  async take(max) {
    while (!this.buffer.length && !this.eof) await this.more();
    if (!this.buffer.length) return null;
    const result = this.buffer.slice(0, max); this.buffer = this.buffer.slice(result.length); return result;
  }
}
export async function readHead(bytes) {
  const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: [\x20-\x7e]*)?$/.exec(await bytes.line());
  if (!status) throw new Error('http_status_invalid');
  const headers = new Headers(); let size = 0; let length; let transfer;
  for (;;) {
    const line = await bytes.line(); size += line.length + 2;
    if (size > 32768) throw new Error('http_headers_too_large');
    if (!line) break;
    const match = /^([!#$%&'*+.^_\x60|~0-9A-Za-z-]+):[ \t]*([\x20-\x7e\t]*)$/.exec(line);
    if (!match) throw new Error('http_header_invalid');
    const name = match[1].toLowerCase(), value = match[2].trim();
    if (name === 'content-length') {
      if (length !== undefined || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('http_length_invalid');
      length = Number(value);
    }
    if (name === 'transfer-encoding') {
      if (transfer !== undefined || value.toLowerCase() !== 'chunked') throw new Error('http_transfer_invalid');
      transfer = value;
    }
    headers.append(name, value);
  }
  if (length !== undefined && transfer !== undefined) throw new Error('http_framing_ambiguous');
  if (Number(status[1]) < 200) throw new Error('http_interim_unsupported');
  return { status: Number(status[1]), headers, length, chunked: transfer !== undefined };
}
export function bodyStream(bytes, head, finish, signal, limit) {
  let remaining = head.length; let chunk = 0; let total = 0; let finished = false;
  const complete = () => { if (!finished) { finished = true; finish(); } };
  return new ReadableStream({
    async pull(controller) {
      try {
        signal?.throwIfAborted();
        if (head.chunked && chunk === 0) {
          const line = await bytes.line();
          // Extensions are unnecessary for these fixed endpoints; reject rather than interpret loosely.
          if (!/^[0-9a-fA-F]{1,12}$/.test(line)) throw new Error('http_chunk_invalid');
          chunk = Number.parseInt(line, 16);
          if (chunk > limit - total) throw new Error('http_response_too_large');
          if (chunk === 0) {
            let trailers = 0;
            for (;;) {
              const trailer = await bytes.line(); trailers += trailer.length + 2;
              if (trailers > 16384 || trailer && !/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+:[\x20-\x7e\t]*$/.test(trailer)) throw new Error('http_trailer_invalid');
              if (!trailer) break;
            }
            controller.close(); complete(); return;
          }
        }
        if (!head.chunked && remaining === 0) { controller.close(); complete(); return; }
        const value = await bytes.take(Math.min(32768, head.chunked ? chunk : remaining ?? 32768));
        if (value === null) {
          if (head.chunked || remaining > 0) throw new Error('http_body_truncated');
          controller.close(); complete(); return;
        }
        total += value.length;
        if (total > limit) throw new Error('http_response_too_large');
        if (head.chunked) {
          chunk -= value.length;
          if (chunk === 0 && await bytes.line(0) !== '') throw new Error('http_chunk_terminator_invalid');
        } else if (remaining !== undefined) remaining -= value.length;
        controller.enqueue(value);
      } catch { controller.error(new Error('webshare_response_failed')); complete(); }
    },
    cancel() { complete(); }
  }, { highWaterMark: 0 });
}
export function createWebshareFetch({ proxy, connect, makeClient, upgrade = createVerifiedTlsSocket }) {
  return async request => {
    const target = validateTarget(request);
    const generation = target.pathname === '/backend-api/codex/responses';
    const limit = generation ? STREAM_LIMIT : CONTROL_LIMIT;
    const controller = new AbortController(); let socket; let secure; let reader; let writer; let finished = false;
    const relay = () => controller.abort(new Error('outbound_aborted'));
    request.signal.addEventListener('abort', relay, { once: true });
    if (request.signal.aborted) relay();
    let abortReject;
    const aborted = new Promise((_, reject) => { abortReject = reject; });
    void aborted.catch(() => {});
    const finish = () => {
      if (finished) return; finished = true;
      clearTimeout(deadline); clearTimeout(setupDeadline);
      request.signal.removeEventListener('abort', relay);
      controller.signal.removeEventListener('abort', onAbort);
      void reader?.cancel().catch(() => {});
      try { reader?.releaseLock(); } catch {}
      try { writer?.releaseLock(); } catch {}
      void (secure ?? socket)?.close().catch(() => {});
    };
    const onAbort = () => { abortReject(new Error('webshare_request_aborted')); finish(); };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => controller.abort(), generation ? 300000 : 20000);
    const setupDeadline = setTimeout(() => controller.abort(), 20000);
    const bounded = promise => Promise.race([promise, aborted]);
    try {
      controller.signal.throwIfAborted();
      // Bound caller body before forwarding any account information.
      let body = new Uint8Array();
      if (request.body) {
        const bodyReader = request.body.getReader(); const chunks = []; let size = 0;
        try {
          for (;;) {
            const part = await bounded(bodyReader.read()); if (part.done) break;
            size += part.value.length; if (size > CONTROL_LIMIT) throw new Error('outbound_body_too_large');
            chunks.push(part.value);
          }
          body = new Uint8Array(size); let offset = 0;
          for (const part of chunks) { body.set(part, offset); offset += part.length; }
        } finally { void bodyReader.cancel().catch(() => {}); bodyReader.releaseLock(); }
      }
      socket = connect({ hostname: proxy.host, port: proxy.port }, { secureTransport: 'off', allowHalfOpen: false });
      void socket.closed?.catch(() => {});
      await bounded(socket.opened);
      writer = socket.writable.getWriter(); reader = socket.readable.getReader();
      const auth = btoa(proxy.username + ':' + proxy.password);
      await bounded(writer.write(encoder.encode('CONNECT ' + target.hostname + ':443 HTTP/1.1\r\nHost: ' + target.hostname + ':443\r\nProxy-Authorization: Basic ' + auth + '\r\n\r\n')));
      const proxyBytes = new ByteReader(reader, controller.signal, 16384);
      const proxyHead = await bounded(readHead(proxyBytes));
      if (proxyHead.status !== 200 || proxyBytes.buffer.length) throw new Error('proxy_connect_failed');
      reader.releaseLock(); writer.releaseLock(); reader = undefined; writer = undefined;
      const report = {};
      secure = upgrade(socket, target.hostname, report, makeClient, { applicationBytes: limit + 65536, wireBytes: limit + 8 * 1024 * 1024 });
      await bounded(secure.opened);
      if (!report.tlsHandshakeVerified) throw new Error('tls_not_verified');
      let header = request.method + ' ' + target.pathname + target.search + ' HTTP/1.1\r\nHost: ' + target.hostname + '\r\nConnection: close\r\nAccept-Encoding: identity\r\n';
      let headerBytes = 0;
      for (const [key, value] of request.headers) {
        if (forbiddenHeaders.has(key) || key.startsWith('cf-') || key.startsWith('x-oneapi-')) continue;
        if (!/^[\x20-\x7e\t]*$/.test(value)) throw new Error('outbound_header_invalid');
        headerBytes += key.length + value.length;
        if (headerBytes > 32768) throw new Error('outbound_headers_too_large');
        header += key + ': ' + value + '\r\n';
      }
      if (request.method === 'POST') header += 'Content-Length: ' + body.length + '\r\n';
      writer = secure.writable.getWriter(); reader = secure.readable.getReader();
      await bounded(writer.write(encoder.encode(header + '\r\n')));
      if (body.length) await bounded(writer.write(body));
      const bytes = new ByteReader(reader, controller.signal, limit + 65536);
      const head = await bounded(readHead(bytes));
      clearTimeout(setupDeadline);
      if (head.length > limit) throw new Error('http_response_too_large');
      // There is no redirect following; callers receive the actual upstream status.
      const responseHeaders = new Headers(head.headers);
      for (const key of ['connection', 'keep-alive', 'transfer-encoding', 'trailer', 'upgrade', 'proxy-authenticate']) responseHeaders.delete(key);
      if ([204, 205, 304].includes(head.status)) { finish(); return new Response(null, { status: head.status, headers: responseHeaders }); }
      let stream = bodyStream(bytes, head, finish, controller.signal, limit);
      const encoding = responseHeaders.get('content-encoding');
      if (encoding && encoding !== 'identity') {
        if (!['gzip', 'deflate'].includes(encoding)) throw new Error('http_encoding_unsupported');
        let decodedBytes = 0;
        stream = stream.pipeThrough(new DecompressionStream(encoding)).pipeThrough(new TransformStream({ transform(chunk, c) { decodedBytes += chunk.byteLength; if (decodedBytes > limit) throw new Error('http_decoded_response_too_large'); c.enqueue(chunk); } }));
        responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length');
      }
      return new Response(stream, { status: head.status, headers: responseHeaders });
    } catch { finish(); throw new Error('webshare_request_failed'); }
  };
}
