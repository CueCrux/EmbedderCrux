// EmbedderCrux Pool Router — Prometheus Metrics
// Tracks pool state, per-node health/latency, request distribution, and discovery stats.

/**
 * @typedef {{ node: string, route: string, status: string }} RequestLabels
 */

export class PoolMetrics {
  /** @type {Map<string, number>} keyed by label combo */
  #requestCounts = new Map();
  /** @type {Map<string, { sum: number, count: number }>} keyed by label combo */
  #requestDurations = new Map();
  /** @type {Map<string, number>} keyed by backend */
  #pinnedRequests = new Map();
  /** @type {Map<string, number>} keyed by reason */
  #pinned503 = new Map();
  #discoveryPeers = 0;
  #discoveryLastSuccess = 0;

  /**
   * Record a proxied request.
   * @param {string} node   — hostname of the backend node
   * @param {string} route  — e.g. "/embed", "/embed/sequence"
   * @param {string} status — e.g. "2xx", "5xx", "retry", "error"
   * @param {number} durationMs
   */
  recordRequest(node, route, status, durationMs) {
    const key = `${node}|${route}|${status}`;
    this.#requestCounts.set(key, (this.#requestCounts.get(key) ?? 0) + 1);

    const dur = this.#requestDurations.get(key) ?? { sum: 0, count: 0 };
    dur.sum += durationMs / 1000; // seconds
    dur.count += 1;
    this.#requestDurations.set(key, dur);
  }

  /** Record a request that explicitly pinned its backend. */
  recordPinnedRequest(backend) {
    this.#pinnedRequests.set(backend, (this.#pinnedRequests.get(backend) ?? 0) + 1);
  }

  /** Record a pinned request rejected with 503. */
  recordPinned503(reason) {
    this.#pinned503.set(reason, (this.#pinned503.get(reason) ?? 0) + 1);
  }

  /** Update discovery peer count. */
  setDiscoveryPeers(count) {
    this.#discoveryPeers = count;
    this.#discoveryLastSuccess = Date.now() / 1000;
  }

  /**
   * Render Prometheus text exposition format.
   * @param {() => Array<{ id: string, hostname: string, url: string, healthy: boolean, avgLatencyMs: number, inflight?: number }>} getPoolStatus
   * @returns {string}
   */
  render(getPoolStatus) {
    const lines = [];

    // ── Pool node gauges ──────────────────────────────────────────────
    const nodes = getPoolStatus();
    let healthyCount = 0;
    let unhealthyCount = 0;

    lines.push('# HELP embeddercrux_pool_node_healthy Whether this pool node is healthy (1) or not (0).');
    lines.push('# TYPE embeddercrux_pool_node_healthy gauge');
    for (const n of nodes) {
      const h = n.healthy ? 1 : 0;
      if (n.healthy) healthyCount++; else unhealthyCount++;
      lines.push(`embeddercrux_pool_node_healthy{node="${esc(n.hostname)}",url="${esc(n.url)}"} ${h}`);
    }

    lines.push('# HELP embeddercrux_pool_node_latency_ms Exponential moving average latency to this node in milliseconds.');
    lines.push('# TYPE embeddercrux_pool_node_latency_ms gauge');
    for (const n of nodes) {
      lines.push(`embeddercrux_pool_node_latency_ms{node="${esc(n.hostname)}"} ${n.avgLatencyMs}`);
    }

    lines.push('# HELP embeddercrux_pool_node_inflight Current in-flight requests to this node.');
    lines.push('# TYPE embeddercrux_pool_node_inflight gauge');
    for (const n of nodes) {
      lines.push(`embeddercrux_pool_node_inflight{node="${esc(n.hostname)}"} ${n.inflight ?? 0}`);
    }

    lines.push('# HELP embeddercrux_pool_nodes_total Total number of pool nodes by health status.');
    lines.push('# TYPE embeddercrux_pool_nodes_total gauge');
    lines.push(`embeddercrux_pool_nodes_total{status="healthy"} ${healthyCount}`);
    lines.push(`embeddercrux_pool_nodes_total{status="unhealthy"} ${unhealthyCount}`);

    // ── Request counters ──────────────────────────────────────────────
    lines.push('# HELP embeddercrux_pool_requests_total Total proxied requests by node, route, and status.');
    lines.push('# TYPE embeddercrux_pool_requests_total counter');
    for (const [key, count] of this.#requestCounts) {
      const [node, route, status] = key.split('|');
      lines.push(`embeddercrux_pool_requests_total{node="${esc(node)}",route="${esc(route)}",status="${esc(status)}"} ${count}`);
    }

    lines.push('# HELP embeddercrux_pool_request_duration_seconds Total duration of proxied requests (sum/count) by node and route.');
    lines.push('# TYPE embeddercrux_pool_request_duration_seconds summary');
    for (const [key, dur] of this.#requestDurations) {
      const [node, route] = key.split('|');
      const labelStr = `node="${esc(node)}",route="${esc(route)}"`;
      lines.push(`embeddercrux_pool_request_duration_seconds_sum{${labelStr}} ${dur.sum.toFixed(6)}`);
      lines.push(`embeddercrux_pool_request_duration_seconds_count{${labelStr}} ${dur.count}`);
    }

    lines.push('# HELP embeddercrux_pool_pinned_requests_total Requests routed by X-Pool-Pin-Backend.');
    lines.push('# TYPE embeddercrux_pool_pinned_requests_total counter');
    for (const [backend, count] of this.#pinnedRequests) {
      lines.push(`embeddercrux_pool_pinned_requests_total{backend="${esc(backend)}"} ${count}`);
    }

    lines.push('# HELP embeddercrux_pool_pinned_503_total Pinned requests rejected with 503 by reason.');
    lines.push('# TYPE embeddercrux_pool_pinned_503_total counter');
    for (const [reason, count] of this.#pinned503) {
      lines.push(`embeddercrux_pool_pinned_503_total{reason="${esc(reason)}"} ${count}`);
    }

    // ── Discovery ─────────────────────────────────────────────────────
    lines.push('# HELP embeddercrux_pool_discovery_peers_total Number of peers discovered via Tailscale.');
    lines.push('# TYPE embeddercrux_pool_discovery_peers_total gauge');
    lines.push(`embeddercrux_pool_discovery_peers_total ${this.#discoveryPeers}`);

    lines.push('# HELP embeddercrux_pool_discovery_last_success_timestamp Unix timestamp of last successful discovery poll.');
    lines.push('# TYPE embeddercrux_pool_discovery_last_success_timestamp gauge');
    lines.push(`embeddercrux_pool_discovery_last_success_timestamp ${this.#discoveryLastSuccess.toFixed(0)}`);

    return lines.join('\n') + '\n';
  }
}

/** Escape label values for Prometheus text format. */
function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
