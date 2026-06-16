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

// Size/speed routing — when the request batch is large enough that
// inference dominates network round-trip, prefer the high-throughput
// backend (e.g. the 5090) even if it has higher network latency. Small
// queries keep the latency-weighted routing.
//
// `POOL_FAST_NODE_URLS` is a comma-separated allow-list of backend
// URLs that are known to be fast on heavy batches (5090, A100 etc.).
// `POOL_HEAVY_REQUEST_TOKENS` is the rough token-count threshold; we
// estimate tokens as `total_chars / 4` so batches over ~2048 tokens
// (~8 KB of input text) prefer the fast node by default.
const fastNodeUrls = new Set(
  String(process.env.POOL_FAST_NODE_URLS ?? '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
);
const heavyRequestTokens = Number(process.env.POOL_HEAVY_REQUEST_TOKENS ?? 2048);

// Remote-batch coalescer — aggregates small concurrent /embed requests
// into large batches before sending to the remote (high-throughput) GPU,
// amortising the Tailscale round-trip latency across many texts.
//
// Routing rule:
//   • Queue empty AND batch < TARGET_TEXTS  →  immediate local routing (zero latency added)
//   • Queue non-empty OR batch >= TARGET_TEXTS  →  accumulate + flush to remote GPU
//
// This means during idle / real-time query paths, every request still
// goes straight to the local RTX 4000 at ~5 ms. During bulk embed
// workloads (rebuild, batch ingest) requests pile up and the 5090 gets
// large consolidated batches that amortise the ~700 ms Tailscale RTT.
//
// Env:
//   POOL_REMOTE_BATCH_ENABLED=true          enable the coalescer (default off)
//   POOL_REMOTE_BATCH_NODE_URL              remote node to send batches to
//   POOL_REMOTE_BATCH_TARGET_TEXTS=64       flush when queue reaches this count
//   POOL_REMOTE_BATCH_WINDOW_MS=80          max wait before flushing partial batch
//   POOL_REMOTE_BATCH_MIN_TEXTS=16          min texts to bother sending to remote
const remoteBatchEnabled    = process.env.POOL_REMOTE_BATCH_ENABLED === 'true';
const remoteBatchNodeUrl    = (process.env.POOL_REMOTE_BATCH_NODE_URL ?? '').replace(/\/+$/, '');
const remoteBatchTarget     = Number(process.env.POOL_REMOTE_BATCH_TARGET_TEXTS ?? 64);
// Short window so even the first request waits briefly for others to arrive.
// 20 ms adds minimal latency to real-time queries while letting concurrent
// bulk requests accumulate into one large batch.
const remoteBatchWindowMs   = Number(process.env.POOL_REMOTE_BATCH_WINDOW_MS    ?? 20);
const remoteBatchMinTexts   = Number(process.env.POOL_REMOTE_BATCH_MIN_TEXTS    ?? 16);

// ── Modules ───────────────────────────────────────────────────────────

const discovery = new Discovery();
const healthChecker = new HealthChecker({ getTargets: () => discovery.getTargets() });
const metrics = new PoolMetrics();

// Update discovery peer count on change
discovery.on('change', ({ targets }) => {
  metrics.setDiscoveryPeers(targets.filter(t => t.source === 'tailscale').length);
});

// ── In-flight tracking & routing ──────────────────────────────────────

/** @type {Map<string, number>} in-flight request count per node id */
const inflight = new Map();
let rrCounter = 0;

/** Increment in-flight counter for a node. */
function inflightInc(nodeId) {
  inflight.set(nodeId, (inflight.get(nodeId) ?? 0) + 1);
}

/** Decrement in-flight counter for a node. */
function inflightDec(nodeId) {
  const n = (inflight.get(nodeId) ?? 1) - 1;
  if (n <= 0) inflight.delete(nodeId);
  else inflight.set(nodeId, n);
}

// ── Remote Batch Coalescer ────────────────────────────────────────────

/**
 * @typedef {{ texts: string[], resolve: Function, reject: Function }} BatchItem
 * @type {BatchItem[]}
 */
const batchQueue = [];
let batchFlushTimer = null;
// Max parallel in-flight flushes to the remote GPU.
// TEI grants 1 permit per text; with target=128 texts per flush,
// PARALLEL_FLUSHES=N requires max-concurrent-requests >= 128*N on the TEI.
// Default 1 (sequential). Raise only if TEI permits allow it.
const remoteBatchParallelFlushes = Number(process.env.POOL_REMOTE_BATCH_PARALLEL_FLUSHES ?? 1);
let activeFlushes = 0;

// `/info` passthrough cache. Backends rarely change served_model_name
// at runtime, so a one-minute cache is fine and avoids hammering them.
const INFO_CACHE_TTL_MS = 60_000;
let infoCache = null;
let infoCacheAt = 0;

function scheduleBatchFlush() {
  if (batchFlushTimer !== null) return;
  batchFlushTimer = setTimeout(() => { batchFlushTimer = null; maybeFlush(); }, remoteBatchWindowMs);
}

function maybeFlush() {
  while (activeFlushes < remoteBatchParallelFlushes && batchQueue.length > 0) {
    activeFlushes++;
    flushBatch().finally(() => { activeFlushes--; if (batchQueue.length > 0) maybeFlush(); });
  }
}

async function flushBatch() {
  // Take up to TARGET_TEXTS items — leaves the rest for the next parallel flush.
  const pending = batchQueue.splice(0, remoteBatchTarget);
  if (pending.length === 0) return;
  const allTexts = pending.flatMap(p => p.texts);

  // Build a failover-ordered candidate list: preferred (remote on big batches)
  // first, then the rest of the healthy pool. On a backend failure (5xx OR
  // thrown) we record the outcome (circuit-breaker) and fail over to the next
  // candidate instead of rejecting every caller — closes the 502 over-routing
  // pathology where one flaky backend torpedoed whole coalesced batches.
  const healthy = healthChecker.getHealthyNodes();
  const remoteNode = remoteBatchNodeUrl
    ? healthy.find(n => n.url.replace(/\/+$/, '') === remoteBatchNodeUrl)
    : null;
  const preferred = (remoteNode && allTexts.length >= remoteBatchMinTexts) ? remoteNode : null;
  const ordered = [];
  if (preferred) ordered.push(preferred);
  for (const n of healthy) {
    if (!preferred || n.id !== preferred.id) ordered.push(n);
  }

  if (ordered.length === 0) {
    const err = new Error('no_healthy_backends');
    for (const p of pending) p.reject(err);
    return;
  }

  const batchBody = Buffer.from(JSON.stringify({ inputs: allTexts }));
  const fwdHeaders = { 'content-type': 'application/json', 'content-length': String(batchBody.length) };
  const maxHops = Math.min(ordered.length, Number(process.env.POOL_BATCH_MAX_HOPS ?? 3));
  const tried = [];

  for (let hop = 0; hop < maxHops; hop++) {
    const target = ordered[hop];
    const label = (hop === 0 && target === preferred) ? 'remote-coalesced' : 'coalesced-failover';
    inflightInc(target.id);
    const start = performance.now();
    try {
      const result = await proxyTo(target.url, '/embed', 'POST', fwdHeaders, batchBody);
      metrics.recordRequest(target.hostname, '/embed', label, performance.now() - start);

      if (result.status !== 200) {
        healthChecker.recordTrafficOutcome(target.id, false);
        tried.push(`${target.hostname}:${result.status}`);
        continue; // fail over to the next backend
      }

      healthChecker.recordTrafficOutcome(target.id, true);
      // Split combined response back to individual callers
      const allVectors = JSON.parse(result.body.toString('utf8'));
      let offset = 0;
      for (const p of pending) {
        const slice = allVectors.slice(offset, offset + p.texts.length);
        const sliceBody = Buffer.from(JSON.stringify(slice));
        p.resolve({
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(sliceBody.length) },
          body: sliceBody,
        });
        offset += p.texts.length;
      }
      return; // success
    } catch (err) {
      metrics.recordRequest(target.hostname, '/embed', 'error', performance.now() - start);
      healthChecker.recordTrafficOutcome(target.id, false);
      tried.push(`${target.hostname}:${err.message}`);
    } finally {
      inflightDec(target.id);
    }
  }

  // Every candidate failed — only now reject the callers, with diagnostics.
  const err = new Error(`all_backends_failed: ${tried.join('; ')}`);
  for (const p of pending) p.reject(err);
}

/**
 * Route an embed request through the coalescer.
 * Returns a Promise<{ status, headers, body }> if the request was queued,
 * or null if it should fall through to immediate local routing.
 *
 * @param {string[]} texts
 * @returns {Promise<{ status: number, headers: Object, body: Buffer }> | null}
 */
function coalesceOrNull(texts) {
  if (!remoteBatchEnabled || texts.length === 0) return null;
  // Always queue when the coalescer is enabled. The window (default 20 ms)
  // is short enough that real-time queries see minimal added latency, while
  // concurrent bulk requests accumulate into a single large batch that
  // amortises the Tailscale RTT to the remote GPU.
  return new Promise((resolve, reject) => {
    batchQueue.push({ texts, resolve, reject });
    const totalQueued = batchQueue.reduce((s, p) => s + p.texts.length, 0);
    if (totalQueued >= remoteBatchTarget) {
      // Enough texts — flush immediately without waiting for the window.
      clearTimeout(batchFlushTimer);
      batchFlushTimer = null;
      maybeFlush();
    } else {
      scheduleBatchFlush();
    }
  });
}

/**
 * Select the best backend node using latency-weighted routing with
 * in-flight overflow.
 *
 * Strategy:
 *  1. Score each node: effective_ms = avgLatencyMs + (inflight * CONCURRENCY_PENALTY_MS)
 *  2. This naturally pushes work to faster nodes when idle, but overflows
 *     to slower nodes when the fast node is saturated.
 *  3. Nodes within `latencyBandMs` of the best score are round-robined.
 *
 * The concurrency penalty models the queuing delay: each in-flight request
 * on a node adds a virtual latency cost. For a fast vSwitch node (~10ms)
 * with 1 request in flight, score = 10 + 30 = 40ms. A slower Tailscale
 * node (~60ms) with 0 in-flight scores 60ms — so the second concurrent
 * request goes to the remote node, which is correct since both GPUs can
 * process in parallel.
 *
 * @returns {{ id: string, url: string, hostname: string } | null}
 */
function selectNode(exclude = null, opts = {}) {
  const { preferFast = false } = opts;
  const healthy = healthChecker.getHealthyNodes(); // sorted by avgLatencyMs asc
  const candidates = exclude
    ? healthy.filter(n => n.id !== exclude)
    : healthy;

  if (candidates.length === 0) return null;

  // Heavy-request short-circuit: when the batch is large enough that
  // the fast GPU's higher throughput beats the slower node's lower
  // network latency, route to a "fast" node (allow-listed via
  // POOL_FAST_NODE_URLS). Falls back to standard routing if no fast
  // node is healthy.
  if (preferFast && fastNodeUrls.size > 0) {
    const fast = candidates.filter(n => fastNodeUrls.has(n.url.replace(/\/+$/, '')));
    if (fast.length > 0) {
      // Within fast nodes, still respect concurrency penalty.
      const concurrencyPenaltyMs = Number(process.env.POOL_CONCURRENCY_PENALTY_MS ?? 30);
      const scored = fast.map(n => ({
        ...n,
        inflight: inflight.get(n.id) ?? 0,
        score: n.avgLatencyMs + (inflight.get(n.id) ?? 0) * concurrencyPenaltyMs,
      }));
      scored.sort((a, b) => a.score - b.score);
      return scored[0];
    }
    // No healthy fast node — log + fall through to default.
  }

  // Score each candidate: latency + concurrency penalty
  const concurrencyPenaltyMs = Number(process.env.POOL_CONCURRENCY_PENALTY_MS ?? 30);
  const scored = candidates.map(n => ({
    ...n,
    inflight: inflight.get(n.id) ?? 0,
    score: n.avgLatencyMs + (inflight.get(n.id) ?? 0) * concurrencyPenaltyMs,
  }));
  scored.sort((a, b) => a.score - b.score);

  // Group nodes within the latency band of the best score
  const bestScore = scored[0].score;
  const band = scored.filter(n => n.score <= bestScore + latencyBandMs);

  // Round-robin within the band
  const idx = rrCounter++ % band.length;
  return band[idx];
}

function normalizeBackendPin(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

function backendRefs(node) {
  const url = new URL(node.url);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return new Set([
    url.host,
    `${url.hostname}:${port}`,
    `${node.hostname}:${port}`,
  ]);
}

function selectPinnedNode(pinBackend) {
  const pin = normalizeBackendPin(pinBackend);
  if (!pin) return { node: null, reason: null };

  const all = healthChecker.getPoolStatus();
  const match = all.find(n => backendRefs(n).has(pin));
  if (!match) {
    return { node: null, reason: 'unknown_backend' };
  }
  if (!match.healthy) {
    return { node: null, reason: 'unhealthy' };
  }
  return { node: match, reason: null };
}

/**
 * Estimate the request weight in tokens.
 * `body` is the raw request bytes; we parse JSON best-effort and sum
 * the lengths of each `inputs` entry. Tokens ≈ chars / 4 (rough but
 * good enough for routing). Returns 0 on parse failure.
 *
 * @param {Buffer} body
 * @returns {number}
 */
function estimateRequestTokens(body) {
  try {
    const obj = JSON.parse(body.toString('utf8'));
    const inputs = obj?.inputs;
    let chars = 0;
    if (Array.isArray(inputs)) {
      for (const it of inputs) {
        if (typeof it === 'string') chars += it.length;
      }
    } else if (typeof inputs === 'string') {
      chars = inputs.length;
    }
    return Math.ceil(chars / 4);
  } catch {
    return 0;
  }
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

  const pinBackend = normalizeBackendPin(req.headers['x-pool-pin-backend']);
  if (pinBackend) {
    const { node, reason } = selectPinnedNode(pinBackend);
    if (!node) {
      const rejectReason = reason ?? 'unknown_backend';
      metrics.recordPinned503(rejectReason);
      sendJson(res, 503, { error: 'pinned_backend_unavailable', reason: rejectReason, backend: pinBackend });
      return;
    }

    inflightInc(node.id);
    const start = performance.now();
    try {
      const result = await proxyTo(node.url, route, req.method, req.headers, body);
      const durationMs = performance.now() - start;
      const statusBucket = `${Math.floor(result.status / 100)}xx`;
      metrics.recordRequest(node.hostname, route, statusBucket, durationMs);
      metrics.recordPinnedRequest(pinBackend);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      const durationMs = performance.now() - start;
      metrics.recordRequest(node.hostname, route, 'error', durationMs);
      sendJson(res, 502, { error: 'pinned_backend_failed', backend: pinBackend, message: err.message });
    } finally {
      inflightDec(node.id);
    }
    return;
  }

  // Coalescer path: accumulate concurrent requests and send as one large batch
  // to the remote GPU. Falls through to immediate routing when queue is empty
  // and this batch is small (real-time query path, zero latency added).
  if (route === '/embed') {
    let texts;
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      if (Array.isArray(parsed?.inputs)) texts = parsed.inputs.filter(t => typeof t === 'string');
    } catch { /* ignore, fall through */ }

    if (texts && texts.length > 0) {
      const coalesced = coalesceOrNull(texts);
      if (coalesced !== null) {
        try {
          const result = await coalesced;
          res.writeHead(result.status, result.headers);
          res.end(result.body);
        } catch (err) {
          sendJson(res, 502, { error: 'coalesced_batch_failed', message: err.message });
        }
        return;
      }
    }
  }

  const tokens = estimateRequestTokens(body);
  const preferFast = tokens >= heavyRequestTokens;
  const node = selectNode(null, { preferFast });
  if (!node) {
    sendJson(res, 503, { error: 'no_healthy_backends', pool_size: discovery.getTargets().length });
    return;
  }
  if (preferFast) {
    metrics.recordRequest(node.hostname, route, 'fast-pref', 0);
  }

  inflightInc(node.id);
  const start = performance.now();
  try {
    const result = await proxyTo(node.url, route, req.method, req.headers, body);
    const durationMs = performance.now() - start;
    const statusBucket = `${Math.floor(result.status / 100)}xx`;
    metrics.recordRequest(node.hostname, route, statusBucket, durationMs);

    // A 5xx STATUS is a backend failure too (not just a thrown error) — the
    // flaky-5090 returned 502 *responses*. Record it for the circuit-breaker
    // and fall through to retry on a different node.
    if (result.status < 500) {
      healthChecker.recordTrafficOutcome(node.id, true);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }
    healthChecker.recordTrafficOutcome(node.id, false);
    console.warn(`[proxy] ${node.hostname} returned ${result.status} for ${route} — attempting retry`);
  } catch (err) {
    const durationMs = performance.now() - start;
    metrics.recordRequest(node.hostname, route, 'error', durationMs);
    healthChecker.recordTrafficOutcome(node.id, false);
    console.warn(`[proxy] ${node.hostname} failed for ${route}: ${err.message} — attempting retry`);
  } finally {
    inflightDec(node.id);
  }

  // Retry on a different node — keep the same fast-preference so a
  // heavy batch that lost its primary fast node still tries the other
  // fast node first if there is one, before falling through.
  const retryNode = selectNode(node.id, { preferFast });
  if (!retryNode) {
    sendJson(res, 502, { error: 'backend_unavailable', tried: node.hostname });
    return;
  }

  inflightInc(retryNode.id);
  const retryStart = performance.now();
  try {
    const result = await proxyTo(retryNode.url, route, req.method, req.headers, body);
    const durationMs = performance.now() - retryStart;
    const statusBucket = `${Math.floor(result.status / 100)}xx`;
    metrics.recordRequest(retryNode.hostname, route, statusBucket, durationMs);
    metrics.recordRequest(retryNode.hostname, route, 'retry', 0); // tag this was a retry
    healthChecker.recordTrafficOutcome(retryNode.id, result.status < 500);

    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (retryErr) {
    const durationMs = performance.now() - retryStart;
    metrics.recordRequest(retryNode.hostname, route, 'error', durationMs);
    healthChecker.recordTrafficOutcome(retryNode.id, false);
    sendJson(res, 502, { error: 'all_backends_failed', tried: [node.hostname, retryNode.hostname] });
  } finally {
    inflightDec(retryNode.id);
  }
}

// ── Bundle distribution (M4) ──────────────────────────────────────────

/**
 * Embed one shard of texts against the healthy pool with circuit-breaker
 * failover. Tries `preferredNode` first (when still healthy), then the rest of
 * the pool by latency. Returns the parsed vectors array (length === texts
 * length) or throws after exhausting hops. Mirrors `flushBatch`'s failover
 * loop — a 5xx response is a failure (records the outcome + fails over), so a
 * flaky backend never torpedoes a shard that another backend could serve.
 *
 * @param {string[]} texts
 * @param {{id:string,url:string,hostname:string}|null} preferredNode
 * @returns {Promise<Array>}
 */
async function embedShardWithFailover(texts, preferredNode) {
  const healthy = healthChecker.getHealthyNodes();
  const ordered = [];
  if (preferredNode && healthy.some(n => n.id === preferredNode.id)) {
    ordered.push(healthy.find(n => n.id === preferredNode.id));
  }
  for (const n of healthy) {
    if (!ordered.some(o => o.id === n.id)) ordered.push(n);
  }
  if (ordered.length === 0) throw new Error('no_healthy_backends');

  const body = Buffer.from(JSON.stringify({ inputs: texts }));
  const fwdHeaders = { 'content-type': 'application/json', 'content-length': String(body.length) };
  const maxHops = Math.min(ordered.length, Number(process.env.POOL_BATCH_MAX_HOPS ?? 3));
  const tried = [];

  for (let hop = 0; hop < maxHops; hop++) {
    const target = ordered[hop];
    inflightInc(target.id);
    const start = performance.now();
    try {
      const result = await proxyTo(target.url, '/embed', 'POST', fwdHeaders, body);
      metrics.recordRequest(target.hostname, '/embed', 'bundle-shard', performance.now() - start);
      if (result.status !== 200) {
        healthChecker.recordTrafficOutcome(target.id, false);
        tried.push(`${target.hostname}:${result.status}`);
        continue; // fail over to the next backend
      }
      healthChecker.recordTrafficOutcome(target.id, true);
      return JSON.parse(result.body.toString('utf8'));
    } catch (err) {
      metrics.recordRequest(target.hostname, '/embed', 'error', performance.now() - start);
      healthChecker.recordTrafficOutcome(target.id, false);
      tried.push(`${target.hostname}:${err.message}`);
    } finally {
      inflightDec(target.id);
    }
  }
  throw new Error(`all_backends_failed: ${tried.join('; ')}`);
}

/**
 * POST /embed/bundle — accept one large `{inputs:[...]}` bundle, SPLIT it
 * across the healthy backends proportional to capacity (latency-EMA: a faster
 * backend gets a larger shard; equal split until latency is measured), embed
 * each shard in PARALLEL with per-shard failover, and REASSEMBLE the vectors in
 * original input order. The pool owns distribution + retries + ordering, so the
 * builder submits one bundle instead of N sequential sub-batch posts.
 *
 * Response shape matches `/embed`: a single JSON array of vectors, one per
 * input, in order.
 */
async function handleEmbedBundle(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'request_body_too_large' });
    return;
  }
  let inputs;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (Array.isArray(parsed?.inputs)) inputs = parsed.inputs.filter(t => typeof t === 'string');
  } catch {
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }
  if (!inputs || inputs.length === 0) {
    sendJson(res, 400, { error: 'empty_inputs' });
    return;
  }

  const healthy = healthChecker.getHealthyNodes();
  if (healthy.length === 0) {
    sendJson(res, 503, { error: 'no_healthy_backends', pool_size: discovery.getTargets().length });
    return;
  }

  // Capacity-proportional shard sizes. Weight by inverse latency-EMA (faster →
  // bigger shard); avgLatencyMs===0 (unmeasured) yields equal weights. The last
  // shard absorbs any rounding remainder so every input is always covered.
  const weights = healthy.map(n => 1 / ((n.avgLatencyMs ?? 0) + 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const shards = [];
  let cursor = 0;
  for (let i = 0; i < healthy.length && cursor < inputs.length; i++) {
    const isLast = i === healthy.length - 1;
    const want = Math.round((inputs.length * weights[i]) / totalWeight);
    const end = isLast ? inputs.length : Math.min(inputs.length, cursor + Math.max(0, want));
    if (end > cursor) {
      shards.push({ node: healthy[i], start: cursor, end });
      cursor = end;
    }
  }
  // Rounding can leave a tail if no shard was marked last (all earlier shards
  // under-filled and we ran out of nodes): give the remainder to the fastest.
  if (cursor < inputs.length) {
    if (shards.length === 0) shards.push({ node: healthy[0], start: cursor, end: inputs.length });
    else shards[shards.length - 1].end = inputs.length;
  }

  const out = new Array(inputs.length);
  try {
    await Promise.all(shards.map(async (sh) => {
      const vecs = await embedShardWithFailover(inputs.slice(sh.start, sh.end), sh.node);
      const want = sh.end - sh.start;
      if (!Array.isArray(vecs) || vecs.length !== want) {
        throw new Error(`shard length mismatch: got ${vecs?.length} want ${want}`);
      }
      for (let j = 0; j < vecs.length; j++) out[sh.start + j] = vecs[j];
    }));
  } catch (err) {
    sendJson(res, 502, { error: 'bundle_failed', message: err.message });
    return;
  }
  sendJson(res, 200, out);
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
    const status = healthChecker.getPoolStatus().map(n => ({
      ...n,
      inflight: inflight.get(n.id) ?? 0,
    }));
    const targets = discovery.getTargets();
    const queuedTexts = batchQueue.reduce((s, p) => s + p.texts.length, 0);
    sendJson(res, 200, {
      pool_size: targets.length,
      healthy: status.filter(n => n.healthy).length,
      unhealthy: status.filter(n => !n.healthy).length,
      nodes: status,
      ...(remoteBatchEnabled && {
        remote_batch: {
          enabled: true,
          remote_node: remoteBatchNodeUrl || null,
          queue_depth: batchQueue.length,
          queued_texts: queuedTexts,
          target_texts: remoteBatchTarget,
          window_ms: remoteBatchWindowMs,
          parallel_flushes_enabled: true,
        },
      }),
    });
    return;
  }

  // ── Batch status ──────────────────────────────────────────────────
  if (path === '/pool/batch-status' && req.method === 'GET') {
    const queuedTexts = batchQueue.reduce((s, p) => s + p.texts.length, 0);
    sendJson(res, 200, {
      enabled: remoteBatchEnabled,
      remote_node: remoteBatchNodeUrl || null,
      queue_depth: batchQueue.length,
      queued_texts: queuedTexts,
      target_texts: remoteBatchTarget,
      window_ms: remoteBatchWindowMs,
      min_texts: remoteBatchMinTexts,
          active_flushes: activeFlushes,
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

  // ── Backend info passthrough ──────────────────────────────────────
  // Lets seal-time code (corecrux-storage / corecruxctl) ask the pool
  // which model is actually being served, instead of stamping a
  // hardcoded literal into .ccxe headers. Picks any healthy node and
  // proxies its /info; result is cached for 60 s. If no backend is
  // healthy, returns 503 so the caller can stamp "unknown-embedder"
  // rather than a misleading default.
  if (path === '/info' && req.method === 'GET') {
    const now = Date.now();
    if (infoCache && now - infoCacheAt < INFO_CACHE_TTL_MS) {
      sendJson(res, 200, infoCache);
      return;
    }
    const healthy = healthChecker.getHealthyNodes();
    if (healthy.length === 0) {
      sendJson(res, 503, { error: 'no_healthy_backends' });
      return;
    }
    try {
      const proxied = await proxyTo(healthy[0].url, '/info', 'GET', {}, null);
      if (proxied.status === 200) {
        try {
          const parsed = JSON.parse(proxied.body.toString('utf8'));
          infoCache = parsed;
          infoCacheAt = now;
          sendJson(res, 200, parsed);
          return;
        } catch {
          // fall through and write raw
        }
      }
      res.writeHead(proxied.status, proxied.headers);
      res.end(proxied.body);
    } catch (err) {
      sendJson(res, 502, { error: 'info_proxy_failed', message: String(err?.message ?? err) });
    }
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

  // M4 — bundle distribution: split one large bundle across backends.
  if (path === '/embed/bundle' && req.method === 'POST') {
    await handleEmbedBundle(req, res);
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
