// Strict checks supplement the TLS library's chain/signature/Finished verification.
export function assertStrictCertificates(certificates, host) {
  if (!Array.isArray(certificates) || certificates.length < 1 || certificates.length > 8) throw new Error('certificate_chain_invalid');
  const leaf = certificates[0];
  const names = leaf.getAlternativeDNSNames();
  const expected = host.toLowerCase().split('.');
  if (!names.some(name => {
    const parts = name.toLowerCase().split('.');
    return parts.length === expected.length && parts.every((part, index) => part === expected[index] || (index === 0 && part === '*' && parts.length >= 3));
  })) throw new Error('certificate_hostname_invalid');
  const allowedCritical = new Set(['2.5.29.14', '2.5.29.15', '2.5.29.17', '2.5.29.19', '2.5.29.32', '2.5.29.35', '2.5.29.37']);
  for (let i = 0; i < certificates.length; i++) {
    const cert = certificates[i];
    if (!cert.isWithinValidity()) throw new Error('certificate_expired');
    if (cert.internal.extensions.some(e => e.critical && !allowedCritical.has(e.type))) throw new Error('certificate_critical_extension_unsupported');
    // Name constraints cannot safely be ignored, even when non-critical.
    if (cert.internal.getExtension('2.5.29.30')) throw new Error('certificate_name_constraints_unsupported');
    const basic = cert.internal.getExtension('2.5.29.19');
    const usage = cert.internal.getExtension('2.5.29.15');
    const eku = cert.internal.getExtension('2.5.29.37');
    if (eku && !eku.usages.includes('1.3.6.1.5.5.7.3.1') && !eku.usages.includes('2.5.29.37.0')) throw new Error('certificate_server_usage_invalid');
    if (i === 0) {
      if (basic?.ca || (usage && !(usage.usages & 1))) throw new Error('certificate_leaf_usage_invalid');
    } else {
      if (!basic?.ca || (usage && !(usage.usages & 32))) throw new Error('certificate_issuer_usage_invalid');
      if (basic.pathLength !== undefined && i - 1 > basic.pathLength) throw new Error('certificate_path_length_invalid');
    }
  }
}
export function createVerifiedTlsSocket(socket, host, report, makeClient, limits = {}) {
  void socket.closed?.catch(() => {});
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let appController; let resolveHandshake; let rejectHandshake; let ended = false; let verified = false;
  let applicationBytes = 0; let wireBytes = 0;
  let resumePump;
  const wake = () => { resumePump?.(); resumePump = undefined; };
  const opened = new Promise((resolve, reject) => { resolveHandshake = resolve; rejectHandshake = reject; });
  void opened.catch(() => {});
  const readable = new ReadableStream({ start(c) { appController = c; }, pull() { wake(); }, cancel() { return close(); } });
  function fail(error) {
    if (ended) return; ended = true; wake();
    rejectHandshake(error); appController.error(error);
    void socket.close().catch(() => {});
  }
  const progress = new Set();
  const logger = Object.fromEntries(['info', 'debug', 'warn', 'error', 'trace'].map(level => [level, (...args) => {
    for (const label of ['processed server hello', 'verified certificate chain', 'server finish verified']) {
      if (args.includes(label)) { progress.add(label); report.tlsProgress = [...progress]; }
    }
  }]));
  const tls = makeClient({ host, verifyServerCertificate: true,
    supportedProtocolVersions: ['TLS1_3'], namedCurves: ['SECP256R1', 'SECP384R1'],
    cipherSuites: ['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384'], applicationLayerProtocols: ['http/1.1'], logger,
    // Do not let certificates expand the probe's fixed network destinations.
    async fetchCertificateBytes() { throw new Error('certificate_missing_intermediate'); },
    async write({ header, content }) {
      if (ended) throw new Error('tls_closed');
      const bytes = new Uint8Array(header.length + content.length); bytes.set(header); bytes.set(content, header.length);
      await writer.write(bytes);
    },
    onRecvCertificates({ certificates }) {
      try { assertStrictCertificates(certificates, host); verified = true; report.certificateChecksPassed = true; } catch (error) { fail(error); throw error; }
    },
    onHandshake() {
      if (ended) return;
      if (!verified) { fail(new Error('tls_finished_without_certificate')); return; }
      const metadata = tls.getMetadata();
      try { assertTlsMetadata(metadata); } catch (error) { fail(error); return; }
      report.tlsHandshakeVerified = true; report.tlsVersion = metadata.version; report.tlsCipherSuite = metadata.cipherSuite;
      resolveHandshake();
    },
    onApplicationData(bytes) {
      if (ended) return;
      if (!verified || !report.tlsHandshakeVerified) { fail(new Error('tls_data_before_verification')); return; }
      applicationBytes += bytes.byteLength;
      if (applicationBytes > (limits.applicationBytes ?? 2 * 1024 * 1024)) { fail(new Error('http_response_too_large')); return; }
      appController.enqueue(bytes);
    },
    onTlsEnd(error) {
      if (ended) return;
      if (error) { fail(error); return; }
      if (!report.tlsHandshakeVerified) { fail(new Error('tls_closed_before_handshake')); return; }
      ended = true; wake(); appController.close();
    }
  });
  const pump = (async () => {
    try {
      while (!ended) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (!report.tlsHandshakeVerified) fail(new Error('tls_closed_before_handshake'));
          else if (!ended) { ended = true; wake(); appController.close(); }
          break;
        }
        wireBytes += chunk.value.byteLength; report.tlsWireBytesReceived = wireBytes;
        if (wireBytes > (limits.wireBytes ?? 3 * 1024 * 1024)) throw new Error('tls_wire_limit');
        for (let offset = 0; offset < chunk.value.length && !ended; offset += 32768) {
          await tls.handleReceivedBytes(chunk.value.subarray(offset, offset + 32768));
          while (!ended && appController.desiredSize <= 0) await new Promise(resolve => { resumePump = resolve; });
        }
      }
    } catch (error) { fail(error); }
  })();
  void pump.catch(fail);
  void tls.startHandshake().catch(fail);
  async function close() {
      if (!ended) { ended = true; wake(); rejectHandshake(new Error('tls_closed')); try { appController.close(); } catch {} }
      void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch {} try { writer.releaseLock(); } catch {}
      await socket.close();
    }
  return { opened, closed: socket.closed, readable,
    writable: new WritableStream({ async write(bytes) { await opened; if (ended) throw new Error('tls_closed'); await tls.write(bytes); } }),
    close
  };
}
export function assertTlsMetadata(metadata) {
  if (metadata.version !== 'TLS1_3' || !['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384'].includes(metadata.cipherSuite) || (metadata.selectedAlpn && metadata.selectedAlpn !== 'http/1.1')) throw new Error('tls_negotiation_not_allowed');
}
