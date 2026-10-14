// YITOKEN changes: development-only, same-origin, fixed HTTPS gateway proxy.
import type { Plugin } from 'vite';

export function validateProxyTarget(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'yitoken.com.cn' || (url.port && url.port !== '443') || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /api.?key|token|secret/i.test(key))) throw new Error('Only the YITOKEN HTTPS API is allowed');
  return url.href;
}

export function validateProxyOrigin(origin: string | undefined, host: string): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:' && url.host === host && !url.username && !url.password;
  } catch { return false; }
}

export function filterProxyHeaders(headers: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => ['authorization', 'content-type', 'accept', 'x-request-id'].includes(name.toLowerCase()) && typeof value === 'string' && !/[\r\n]/.test(value)) as [string, string][]);
}

/** The same byte bound and abort deadline protect both directions of this local proxy. */
async function readBoundedProxyBody(read: () => Promise<{ done?: boolean; value?: Uint8Array | string }>, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error('Development proxy deadline exceeded'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('Development proxy deadline exceeded');
      const item = await Promise.race([read(), aborted]);
      if (item.done) return Buffer.concat(chunks, bytes);
      if (item.value === undefined) throw new Error('Invalid development proxy body chunk');
      bytes += typeof item.value === 'string' ? Buffer.byteLength(item.value) : item.value.byteLength;
      if (bytes > 64 * 1024 * 1024) throw new Error('Development proxy body exceeds size limit');
      chunks.push(Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value));
    }
  } finally { signal.removeEventListener('abort', onAbort); }
}

export function apiCorsProxyPlugin(): Plugin {
  return {
    name: 'yitoken-local-development-proxy',
    apply: 'serve',
    transformIndexHtml(html) {
      // React-refresh and the dev websocket are loopback-only. Never emitted by a production build.
      return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace('connect-src https:', 'connect-src https: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*');
    },
    configureServer(server) {
      server.middlewares.use('/__api_proxy', async (req, res) => {
        const originHeader = req.headers.origin;
        let origin = typeof originHeader === 'string' ? originHeader : undefined;
        if (!origin && req.headers['sec-fetch-site'] === 'same-origin' && typeof req.headers.referer === 'string') {
          try { origin = new URL(req.headers.referer).origin; } catch { /* Reject below. */ }
        }
        if (!validateProxyOrigin(origin, req.headers.host || '')) {
          res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"Local application origin required"}'); return;
        }
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        const controller = new AbortController();
        // One total deadline, including a stalled incoming body and upstream body.
        const deadline = setTimeout(() => controller.abort(), 120_000);
        let incomingComplete = false;
        let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const target = validateProxyTarget(new URL(req.url || '', 'http://localhost').searchParams.get('url') || '');
          const incoming = req[Symbol.asyncIterator]();
          const body = await readBoundedProxyBody(() => incoming.next(), controller.signal);
          incomingComplete = true;
          const raw = req.headers['x-proxy-headers'];
          const headers = typeof raw === 'string' ? filterProxyHeaders(JSON.parse(raw)) : {};
          if (controller.signal.aborted) throw new Error('Development proxy deadline exceeded');
          const response = await fetch(target, {
            method: req.method || 'GET', headers, redirect: 'error', signal: controller.signal,
            body: req.method !== 'GET' && req.method !== 'HEAD' && body.length ? body : undefined,
          });
          responseReader = response.body?.getReader();
          const content = responseReader ? await readBoundedProxyBody(() => responseReader!.read(), controller.signal) : Buffer.alloc(0);
          if (controller.signal.aborted) throw new Error('Development proxy deadline exceeded');
          const type = response.headers.get('content-type');
          // Never publish success headers or partial upstream bytes before validation.
          res.writeHead(response.status, type ? { 'Content-Type': type } : {});
          res.end(content);
        } catch {
          // Never include request headers, keys, provider body or upstream error details in proxy logs.
          controller.abort();
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
          if (!res.writableEnded) res.end('{"error":"YITOKEN development proxy request rejected or failed"}');
        } finally {
          clearTimeout(deadline);
          if (responseReader) {
            // Cancellation is best-effort cleanup, never a new unbounded wait.
            void responseReader.cancel().catch(() => {});
            responseReader.releaseLock();
          }
          if (!incomingComplete && !req.destroyed) req.destroy();
        }
      });
    },
  };
}
