import assert from 'node:assert/strict';
import test from 'node:test';
import { handleProbe, parseHttpResponse, runProbe } from '../experiments/webshare-probe-core.mjs';
const enc = new TextEncoder();
const proxy = { host: '138.226.61.165', port: 6338, username: 'TEST_PROXY_USER', password: 'TEST_PROXY_PASSWORD' };
function fixture({ connectStatus = 200, tlsError, tlsReadError, response = 'HTTP/1.1 200 OK\r\nContent-Length: 25\r\n\r\n{"ip":"138.226.61.165"}', pending = false } = {}) {
  const state = { writes: [], tlsTargets: [], closes: 0, calls: 0 };
  const writable = () => new WritableStream({ write(bytes) { state.writes.push(new TextDecoder().decode(bytes)); } });
  const stream = text => new ReadableStream({ start(controller) { controller.enqueue(enc.encode(text)); controller.close(); } });
  const tls = { opened: Promise.resolve(), closed: Promise.resolve(), writable: writable(), readable: tlsReadError ? new ReadableStream({ start(controller) { controller.error(tlsReadError); } }) : stream(response), async close() { state.closes++; } };
  const socket = { opened: pending ? new Promise(() => {}) : Promise.resolve(), closed: Promise.resolve(), writable: writable(),
    readable: stream(`HTTP/1.1 ${connectStatus} Proxy status\r\n\r\n`),
    startTls(options) { state.tlsTargets.push(options.expectedServerHostname); if (tlsError) throw tlsError; return tls; },
    async close() { state.closes++; } };
  return { state, connect() { state.calls++; return socket; } };
}
test('auth, URL/body guards and proxy allowlist reject before dialing', async () => {
  let calls = 0;
  const connect = () => { calls++; throw new Error(); };
  const env = { PROBE_KEY: 'test-key', PROXY_CONFIG: JSON.stringify(proxy) };
  assert.equal((await handleProbe(new Request('https://test/probe', { method: 'POST', body: '{}' }), env, connect)).status, 401);
  for (const body of ['{"operation":"generate"}', '{"operation":"ip","url":"https://evil.test"}', 'x'.repeat(513)]) {
    const result = await handleProbe(new Request('https://test/probe', { method: 'POST', headers: { Authorization: 'Bearer test-key' }, body }), env, connect);
    assert.ok([400, 413].includes(result.status));
  }
  assert.equal((await handleProbe(new Request('https://test/probe?url=evil', { method: 'POST' }), env, connect)).status, 404);
  assert.equal((await handleProbe(new Request('https://test/probe', { method: 'POST', headers: { Authorization: 'Bearer test-key' }, body: '{"operation":"ip"}' }),
    { ...env, PROXY_CONFIG: JSON.stringify({ ...proxy, host: '127.0.0.1' }) }, connect)).status, 400);
  assert.equal(calls, 0);
});
test('ChatGPT test performs only CONNECT and validated target TLS, with no account auth or HTTP GET', async () => {
  const f = fixture(); const result = await runProbe(f.connect, proxy, 'chatgpt-tls');
  assert.equal(result.error, null); assert.equal(result.tlsOpened, true);
  assert.deepEqual(f.state.tlsTargets, ['chatgpt.com']); assert.equal(f.state.writes.length, 1);
  assert.match(f.state.writes[0], /^CONNECT chatgpt\.com:443 HTTP\/1\.1/);
  assert.equal(/(?:^|\r\n)Authorization:/i.test(f.state.writes[0]), false);
  assert.equal(/ChatGPT-Account-ID|GET /i.test(f.state.writes[0]), false);
  const output = JSON.stringify(result); assert.equal(output.includes(proxy.username), false); assert.equal(output.includes(proxy.password), false);
});
test('CONNECT authentication rejection stops before TLS and returns no proxy response body', async () => {
  const f = fixture({ connectStatus: 407 }); const result = await runProbe(f.connect, proxy, 'ip');
  assert.equal(result.proxyConnectStatus, 407); assert.equal(result.failedStage, 'proxy_connect');
  assert.equal(result.error, 'proxy_connect_rejected'); assert.deepEqual(f.state.tlsTargets, []); assert.equal(f.state.writes.length, 1);
});
test('TLS failure or unsupported hostname override stops before HTTPS and hides error details', async () => {
  for (const error of [new Error('certificate verification failed TEST_SECRET'), new Error('The expectedServerHostname option is not currently supported in startTls. TEST_SECRET')]) {
    const f = fixture({ tlsError: error }); const result = await runProbe(f.connect, proxy, 'ip');
    assert.equal(result.failedStage, 'tls'); assert.equal(result.tlsOpened, false); assert.equal(f.state.writes.length, 1);
    assert.equal(JSON.stringify(result).includes('TEST_SECRET'), false);
  }
});
test('IP HTTPS request has fixed path and no provenance/account/proxy headers; response parsing validates framing', async () => {
  const body = '{"ip":"138.226.61.165"}';
  const f = fixture({ response: `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}` });
  const result = await runProbe(f.connect, proxy, 'ip');
  assert.equal(result.error, null); assert.equal(result.exitIp, proxy.host); assert.deepEqual(f.state.tlsTargets, ['api.ipify.org']);
  assert.equal(f.state.writes.length, 2); assert.match(f.state.writes[1], /^GET \/\?format=json HTTP\/1\.1/);
  assert.equal(/Authorization|CF-Worker|ChatGPT-Account|Proxy-Authorization/i.test(f.state.writes[1]), false);
  assert.equal(parseHttpResponse(enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n')).body, '{}');
  assert.throws(() => parseHttpResponse(enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{}')), /body_length_invalid/);
  assert.throws(() => parseHttpResponse(enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n{}')), /chunk_truncated/);
});
test('total deadline stops a pending TCP connection without retries and initiates cleanup', async () => {
  const f = fixture({ pending: true }); const result = await runProbe(f.connect, proxy, 'ip', 20);
  assert.equal(result.error, 'probe_timeout'); assert.equal(result.failedStage, 'tcp');
  assert.equal(f.state.calls, 1); assert.equal(f.state.writes.length, 0); assert.ok(f.state.closes >= 1);
});

test('TLS read failure records zero application bytes and preserves secret redaction', async () => {
  for (const message of ['TLS handshake failed', 'TLS failure TEST_SECRET']) {
    const f = fixture({ tlsReadError: new Error(message) });
    const result = await runProbe(f.connect, proxy, 'ip');
    assert.equal(result.failedStage, 'https_read');
    assert.equal(result.responseBytesReceived, 0);
    assert.equal(result.httpStatus, undefined);
    assert.equal(JSON.stringify(result).includes('TEST_SECRET'), false);
    if (message === 'TLS handshake failed') assert.equal(result.error, 'tls_handshake_failed');
  }
});
