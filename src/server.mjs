import http from "node:http";
import { performance } from "node:perf_hooks";

const port = Number(process.env.EMBEDDER_PORT ?? 8080);
const teiBaseUrl = (process.env.TEI_BASE_URL ?? "http://tei:8080").replace(/\/+$/, "");
const requestTimeoutMs = Number(process.env.EMBEDDER_REQUEST_TIMEOUT_MS ?? 30_000);
const sequenceMode = String(process.env.EMBEDDER_SEQUENCE_MODE ?? "disabled").trim().toLowerCase();
const sequenceMaxTokens = Math.max(1, Number(process.env.EMBEDDER_SEQUENCE_MAX_TOKENS ?? 384));
const tokenBatchSize = Math.max(1, Number(process.env.EMBEDDER_TOKEN_BATCH_SIZE ?? 64));
const bodyLimitBytes = Math.max(1024, Number(process.env.EMBEDDER_BODY_LIMIT_BYTES ?? 8 * 1024 * 1024));

const counterStore = new Map();
const durationStore = new Map();

function metricKey(name, labels = {}) {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
  return `${name}|${parts.join(",")}`;
}

function labelsToText(labels = {}) {
  const entries = Object.entries(labels);
  if (!entries.length) return "";
  const rendered = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",");
  return `{${rendered}}`;
}

function incrementCounter(name, labels = {}, value = 1) {
  const key = metricKey(name, labels);
  const entry = counterStore.get(key) ?? { name, labels, value: 0 };
  entry.value += value;
  counterStore.set(key, entry);
}

function observeDuration(route, status, seconds) {
  const labels = { route, status: String(status) };
  const key = metricKey("embeddercrux_request_duration_seconds", labels);
  const entry = durationStore.get(key) ?? { labels, count: 0, sum: 0 };
  entry.count += 1;
  entry.sum += seconds;
  durationStore.set(key, entry);
}

function recordRequest(route, status, startedAt) {
  incrementCounter("embeddercrux_requests_total", { route, status: String(status) });
  observeDuration(route, status, Math.max(0, (performance.now() - startedAt) / 1000));
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > bodyLimitBytes) {
      throw new Error("request_body_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function fetchWithTimeout(url, init = {}) {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  return fetch(url, { ...init, signal });
}

async function fetchTeiHealth() {
  const response = await fetchWithTimeout(`${teiBaseUrl}/health`);
  const text = await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, text };
}

async function proxyToTei(req, res, path, bodyBuffer = null) {
  const startedAt = performance.now();
  try {
    const headers = {};
    if (bodyBuffer) {
      headers["content-type"] = req.headers["content-type"] ?? "application/json";
      headers["content-length"] = String(bodyBuffer.length);
    }
    const response = await fetchWithTimeout(`${teiBaseUrl}${path}`, {
      method: req.method,
      headers,
      body: bodyBuffer,
    });
    const arrayBuffer = await response.arrayBuffer();
    const payload = Buffer.from(arrayBuffer);
    recordRequest(path, response.status, startedAt);
    res.writeHead(response.status, {
      "content-type": response.headers.get("content-type") ?? "application/octet-stream",
      "content-length": String(payload.length),
      "cache-control": "no-store",
    });
    res.end(payload);
  } catch (error) {
    recordRequest(path, 502, startedAt);
    writeJson(res, 502, {
      error: "tei_unavailable",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function tokenize(text) {
  const tokens = [];
  const offsets = [];
  const regex = /\S+/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tokens.push(match[0]);
    offsets.push({ start: match.index, end: match.index + match[0].length });
  }
  return { tokens, offsets };
}

async function embedInputs(inputs) {
  const response = await fetchWithTimeout(`${teiBaseUrl}/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`tei_embed_failed:${response.status}:${detail}`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("tei_embed_invalid_response");
  }
  return data;
}

function renderMetrics(customMetricsText = "") {
  const lines = [
    "# HELP embeddercrux_info Static service info.",
    "# TYPE embeddercrux_info gauge",
    `embeddercrux_info${labelsToText({ sequence_mode: sequenceMode, backend: teiBaseUrl })} 1`,
    "# HELP embeddercrux_requests_total HTTP requests handled by route and status.",
    "# TYPE embeddercrux_requests_total counter",
  ];

  for (const entry of counterStore.values()) {
    lines.push(`${entry.name}${labelsToText(entry.labels)} ${entry.value}`);
  }

  lines.push("# HELP embeddercrux_request_duration_seconds Request duration by route and status.");
  lines.push("# TYPE embeddercrux_request_duration_seconds summary");
  for (const entry of durationStore.values()) {
    lines.push(`embeddercrux_request_duration_seconds_sum${labelsToText(entry.labels)} ${entry.sum}`);
    lines.push(`embeddercrux_request_duration_seconds_count${labelsToText(entry.labels)} ${entry.count}`);
  }

  if (customMetricsText.trim().length > 0) {
    lines.push("");
    lines.push(customMetricsText.trim());
  }

  return `${lines.join("\n")}\n`;
}

async function handleSequence(req, res) {
  const startedAt = performance.now();
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw.toString("utf8"));
    const text = typeof body?.text === "string" ? body.text : "";

    if (!text.trim()) {
      recordRequest("/embed/sequence", 400, startedAt);
      writeJson(res, 400, { error: "bad_request", detail: "text is required" });
      return;
    }

    if (sequenceMode !== "synthetic") {
      incrementCounter("embeddercrux_sequence_fallback_total", { reason: "disabled" });
      recordRequest("/embed/sequence", 501, startedAt);
      writeJson(res, 501, {
        error: "sequence_embeddings_not_enabled",
        detail: "Token-level sequence outputs are disabled on this node. Engine should fall back to per-chunk embeddings.",
        sequence_mode: sequenceMode,
      });
      return;
    }

    const { tokens, offsets } = tokenize(text);
    if (!tokens.length) {
      recordRequest("/embed/sequence", 400, startedAt);
      writeJson(res, 400, { error: "bad_request", detail: "text must contain at least one token" });
      return;
    }

    if (tokens.length > sequenceMaxTokens) {
      incrementCounter("embeddercrux_sequence_fallback_total", { reason: "too_many_tokens" });
      recordRequest("/embed/sequence", 501, startedAt);
      writeJson(res, 501, {
        error: "sequence_embeddings_too_large",
        detail: `Synthetic sequence embeddings are capped at ${sequenceMaxTokens} tokens on this node.`,
        token_count: tokens.length,
        max_tokens: sequenceMaxTokens,
      });
      return;
    }

    const [pooledEmbedding] = await embedInputs([text]);
    const tokenEmbeddings = [];
    for (let index = 0; index < tokens.length; index += tokenBatchSize) {
      const batch = tokens.slice(index, index + tokenBatchSize);
      const batchEmbeddings = await embedInputs(batch);
      tokenEmbeddings.push(...batchEmbeddings);
    }

    recordRequest("/embed/sequence", 200, startedAt);
    writeJson(res, 200, {
      embedding: pooledEmbedding,
      pooled_embedding: pooledEmbedding,
      token_embeddings: tokenEmbeddings,
      token_offsets: offsets,
      tokens,
      model: body?.model ?? process.env.MODEL_ID ?? "unknown",
      dim: Array.isArray(pooledEmbedding) ? pooledEmbedding.length : null,
      sequence_mode: "synthetic",
    });
  } catch (error) {
    recordRequest("/embed/sequence", 500, startedAt);
    writeJson(res, 500, {
      error: "sequence_embeddings_failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    writeJson(res, 400, { error: "bad_request" });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/livez") {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && (path === "/healthz" || path === "/readyz")) {
    const startedAt = performance.now();
    try {
      const tei = await fetchTeiHealth();
      recordRequest(path, tei.ok ? 200 : 503, startedAt);
      writeJson(res, tei.ok ? 200 : 503, {
        ok: tei.ok,
        tei: {
          ok: tei.ok,
          status: tei.status,
        },
        sequence_mode: sequenceMode,
      });
    } catch (error) {
      recordRequest(path, 503, startedAt);
      writeJson(res, 503, {
        ok: false,
        error: "tei_unavailable",
        detail: error instanceof Error ? error.message : String(error),
        sequence_mode: sequenceMode,
      });
    }
    return;
  }

  if (req.method === "GET" && path === "/health") {
    await proxyToTei(req, res, "/health");
    return;
  }

  if (req.method === "GET" && path === "/metrics") {
    const startedAt = performance.now();
    let teiMetrics = "";
    try {
      const response = await fetchWithTimeout(`${teiBaseUrl}/metrics`);
      teiMetrics = response.ok ? await response.text() : "";
      recordRequest("/metrics", response.ok ? 200 : response.status, startedAt);
    } catch (error) {
      incrementCounter("embeddercrux_sequence_fallback_total", { reason: "metrics_proxy_failed" });
      recordRequest("/metrics", 200, startedAt);
      teiMetrics = `# tei metrics unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    const metrics = renderMetrics(teiMetrics);
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "content-length": String(Buffer.byteLength(metrics)),
      "cache-control": "no-store",
    });
    res.end(metrics);
    return;
  }

  if (req.method === "POST" && path === "/embed") {
    const body = await readBody(req).catch((error) => {
      writeJson(res, 413, {
        error: error instanceof Error ? error.message : "request_body_too_large",
      });
      return null;
    });
    if (body === null) {
      return;
    }
    await proxyToTei(req, res, "/embed", body);
    return;
  }

  if (req.method === "POST" && path === "/embed/sequence") {
    await handleSequence(req, res);
    return;
  }

  writeJson(res, 404, { error: "not_found" });
});

server.listen(port, () => {
  console.log(
    JSON.stringify(
      {
        service: "embeddercrux-gateway",
        port,
        teiBaseUrl,
        sequenceMode,
        sequenceMaxTokens,
      },
      null,
      2,
    ),
  );
});
