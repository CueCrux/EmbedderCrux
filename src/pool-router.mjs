// EmbedderCrux Pool Router — HTTP server with load-balanced proxying
// Routes /embed and /embed/sequence to the best healthy backend node.
// Zero external dependencies.

import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { Discovery } from './discovery.mjs';
import { HealthChecker } from './health-checker.mjs';
import { PoolMetrics } from './pool-metrics.mjs';

// ── Config ────────────────────────────────────────────────────────────

const port = Number(process.env.POOL_ROUTER_PORT ?? 8079);
const requestTimeoutMs = Number(process.env.POOL_REQUEST_TIMEOUT_MS ?? 30_000);
const latencyBandMs = Number(process.env.POOL_LATENCY_BAND_MS ?? 20);
const bodyLimitBytes = Math.max(1024, Number(process.env.POOL_BODY_LIMIT_BYTES ?? 8 * 1024 * 1024));

// ── Modules ───────────────────────────────────────────────────────────

const discovery = new Discovery();
const healthChecker = new HealthChecker({ getTargets: () => discovery.getTargets() });
const metrics = new PoolMetrics();

// Update discovery peer count on change
discovery.on('change', ({ targets }) => {
  metrics.setDiscoveryPeers(targets.filter(t => t.source === 'tailscale').length);
});

// ── Round-robin state ─────────────────────────────────────────────────

let rrCounter = 0;

/**
 * Select the best backend node.
 * Picks the lowest-latency node; if multiple are within `latencyBandMs`, round-robin among them.
 * @returns {{ id: string, url: string, hostname: string } | null}
 */
function selectNode(exclude = null) {
  const healthy = healthChecker.getHealthyNodes(); // sorted by avgLatencyMs asc
  const candidates = exclude
    ? healthy.filter(n => n.id !== exclude)
    : healthy;

  if (candidates.length === 0) return null;

  // Group nodes within the latency band of the best node
  const bestLatency = candidates[0].avgLatencyMs;
  const band = candidates.filter(n => n.avgLatencyMs <= bestLatency + latencyBandMs);

  // Round-robin within the band
  const idx = rrCounter++ % band.length;
  return band[idx];
}

// ── Request Proxy ─────────────────────────────────────────────────────

/**
 * Read the full request body (up to bodyLimitBytes).
 * @param {http.IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > bodyLimitBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Proxy a request to a specific backend node.
 * @param {string} baseUrl
 * @param {string} path
 * @param {string} method
 * @param {http.IncomingHttpHeaders} headers
 * @param {Buffer} body
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer }>}
 */
async function proxyTo(baseUrl, path, method, headers, body) {
  const url = `${baseUrl}${path}`;
  const fwdHeaders = { ...headers };
  // Remove hop-by-hop headers
  delete fwdHeaders.host;
  delete fwdHeaders.connection;
  delete fwdHeaders['transfer-encoding'];

  const res = await fetch(url, {
    method,
    headers: fwdHeaders,
    body: method === 'POST' ? body : undefined,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  const resBody = Buffer.from(await res.arrayBuffer());
  const resHeaders = {};
  res.headers.forEach((v, k) => { resHeaders[k] = v; });
  delete resHeaders['transfer-encoding']; // we send content-length

  return { status: res.status, headers: resHeaders, body: resBody };
}

/**
 * Handle a proxied embed request with retry-on-different-node.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} route
 */
async function handleProxy(req, res, route) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'request_body_too_large' });
    return;
  }

  const node = selectNode();
  if (!node) {
    sendJson(res, 503, { error: 'no_healthy_backends', pool_size: discovery.getTargets().length });
    return;
  }

  const start = performance.now();
  try {
    const result = await proxyTo(node.url, route, req.method, req.headers, body);
    const durationMs = performance.now() - start;
    const statusBucket = `${Math.floor(result.status / 100)}xx`;
    metrics.recordRequest(node.hostname, route, statusBucket, durationMs);

    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  } catch (err) {
    const durationMs = performance.now() - start;
    metrics.recordRequest(node.hostname, route, 'error', durationMs);
    console.warn(`[proxy] ${node.hostname} failed for ${route}: ${err.message} — attempting retry`);
  }

  // Retry on a different node
  const retryNode = selectNode(node.id);
  if (!retryNode) {
    sendJson(res, 502, { error: 'backend_unavailable', tried: node.hostname });
    return;
  }

  const retryStart = performance.now();
  try {
    const result = await proxyTo(retryNode.url, route, req.method, req.headers, body);
    const durationMs = performance.now() - retryStart;
    const statusBucket = `${Math.floor(result.status / 100)}xx`;
    metrics.recordRequest(retryNode.hostname, route, statusBucket, durationMs);
    metrics.recordRequest(retryNode.hostname, route, 'retry', 0); // tag this was a retry

    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (retryErr) {
    const durationMs = performance.now() - retryStart;
    metrics.recordRequest(retryNode.hostname, route, 'error', durationMs);
    sendJson(res, 502, { error: 'all_backends_failed', tried: [node.hostname, retryNode.hostname] });
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname;

  // ── Health probes ─────────────────────────────────────────────────
  if (path === '/livez' && req.method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if ((path === '/healthz' || path === '/readyz') && req.method === 'GET') {
    const healthy = healthChecker.getHealthyNodes();
    if (healthy.length > 0) {
      sendJson(res, 200, { ok: true, healthy_backends: healthy.length });
    } else {
      sendJson(res, 503, { ok: false, healthy_backends: 0, total: discovery.getTargets().length });
    }
    return;
  }

  // ── Pool status ───────────────────────────────────────────────────
  if (path === '/pool/status' && req.method === 'GET') {
    const status = healthChecker.getPoolStatus();
    const targets = discovery.getTargets();
    sendJson(res, 200, {
      pool_size: targets.length,
      healthy: status.filter(n => n.healthy).length,
      unhealthy: status.filter(n => !n.healthy).length,
      nodes: status,
    });
    return;
  }

  // ── Metrics ───────────────────────────────────────────────────────
  if (path === '/metrics' && req.method === 'GET') {
    const body = metrics.render(() => healthChecker.getPoolStatus());
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  // ── Proxy routes ──────────────────────────────────────────────────
  if (path === '/embed' && req.method === 'POST') {
    await handleProxy(req, res, '/embed');
    return;
  }

  if (path === '/embed/sequence' && req.method === 'POST') {
    await handleProxy(req, res, '/embed/sequence');
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────
  sendJson(res, 404, { error: 'not_found', path });
});

// ── Startup ───────────────────────────────────────────────────────────

async function main() {
  console.log('EmbedderCrux Pool Router starting...');

  await discovery.start();
  healthChecker.start();

  // Wait briefly for first health checks to settle
  await new Promise(r => setTimeout(r, 2_500));

  server.listen(port, () => {
    const healthy = healthChecker.getHealthyNodes();
    const targets = discovery.getTargets();
    console.log(`[pool-router] listening on :${port} — ${healthy.length}/${targets.length} backends healthy`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

// Graceful shutdown
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[pool-router] ${sig} received, shutting down...`);
    discovery.stop();
    healthChecker.stop();
    server.close(() => process.exit(0));
    // Force exit after 5s
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
