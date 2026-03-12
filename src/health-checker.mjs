// EmbedderCrux Pool Router — Health Checker
// Periodically polls /healthz on each target, tracks latency EMA and health state.

/**
 * @typedef {import('./discovery.mjs').Target} Target
 *
 * @typedef {{
 *   url: string,
 *   hostname: string,
 *   healthy: boolean,
 *   latencyMs: number,
 *   avgLatencyMs: number,
 *   consecutiveFailures: number,
 *   lastCheckedAt: string | null,
 *   lastHealthyAt: string | null,
 * }} NodeStatus
 */

const DEFAULT_HEALTH_INTERVAL_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_UNHEALTHY_THRESHOLD = 3;
const EMA_ALPHA = 0.3;

export class HealthChecker {
  /** @type {Map<string, NodeStatus>} keyed by target.id */
  #nodes = new Map();
  #timer = null;
  #intervalMs;
  #timeoutMs;
  #unhealthyThreshold;
  /** @type {() => Target[]} */
  #getTargets;

  /**
   * @param {object} opts
   * @param {() => Target[]} opts.getTargets — function returning current target list
   * @param {number} [opts.intervalMs]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.unhealthyThreshold]
   */
  constructor(opts) {
    this.#getTargets = opts.getTargets;
    this.#intervalMs = opts.intervalMs ?? parseInt(process.env.POOL_HEALTH_INTERVAL_MS ?? '', 10) || DEFAULT_HEALTH_INTERVAL_MS;
    this.#timeoutMs = opts.timeoutMs ?? parseInt(process.env.POOL_HEALTH_TIMEOUT_MS ?? '', 10) || DEFAULT_HEALTH_TIMEOUT_MS;
    this.#unhealthyThreshold = opts.unhealthyThreshold ?? parseInt(process.env.POOL_UNHEALTHY_THRESHOLD ?? '', 10) || DEFAULT_UNHEALTHY_THRESHOLD;
  }

  start() {
    // Run first check immediately
    this.#pollAll();

    this.#timer = setInterval(() => this.#pollAll(), this.#intervalMs);
    this.#timer.unref();

    console.log(`[health] started — interval=${this.#intervalMs}ms timeout=${this.#timeoutMs}ms threshold=${this.#unhealthyThreshold}`);
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Returns healthy nodes sorted by avgLatencyMs (lowest first).
   * @returns {Array<{ id: string } & NodeStatus>}
   */
  getHealthyNodes() {
    const healthy = [];
    for (const [id, status] of this.#nodes) {
      if (status.healthy) {
        healthy.push({ id, ...status });
      }
    }
    healthy.sort((a, b) => a.avgLatencyMs - b.avgLatencyMs);
    return healthy;
  }

  /**
   * Returns full status of all nodes.
   * @returns {Array<{ id: string } & NodeStatus>}
   */
  getPoolStatus() {
    return [...this.#nodes.entries()].map(([id, s]) => ({ id, ...s }));
  }

  // ── Internal ──────────────────────────────────────────────────────────

  #pollAll() {
    const targets = this.#getTargets();

    // Prune nodes that are no longer in the target list
    const targetIds = new Set(targets.map(t => t.id));
    for (const id of this.#nodes.keys()) {
      if (!targetIds.has(id)) {
        console.log(`[health] pruned removed node: ${id}`);
        this.#nodes.delete(id);
      }
    }

    // Check each target concurrently
    for (const target of targets) {
      this.#checkOne(target).catch(() => {});
    }
  }

  /** @param {Target} target */
  async #checkOne(target) {
    // Ensure node entry exists
    if (!this.#nodes.has(target.id)) {
      this.#nodes.set(target.id, {
        url: target.url,
        hostname: target.hostname,
        healthy: false,
        latencyMs: 0,
        avgLatencyMs: 0,
        consecutiveFailures: 0,
        lastCheckedAt: null,
        lastHealthyAt: null,
      });
    }

    const node = this.#nodes.get(target.id);
    const now = new Date().toISOString();
    const start = performance.now();

    try {
      // Try /healthz first (gateway), fall back to /health (bare TEI)
      let res = await fetch(`${target.url}/healthz`, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      }).catch(() => null);

      if (!res || !res.ok) {
        res = await fetch(`${target.url}/health`, {
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      }

      const latency = performance.now() - start;
      node.latencyMs = Math.round(latency * 100) / 100;
      node.lastCheckedAt = now;

      if (res.ok) {
        const wasUnhealthy = !node.healthy;
        node.healthy = true;
        node.consecutiveFailures = 0;
        node.lastHealthyAt = now;
        node.avgLatencyMs = node.avgLatencyMs === 0
          ? node.latencyMs
          : EMA_ALPHA * node.latencyMs + (1 - EMA_ALPHA) * node.avgLatencyMs;
        node.avgLatencyMs = Math.round(node.avgLatencyMs * 100) / 100;

        if (wasUnhealthy) {
          console.log(`[health] ${target.hostname} (${target.url}) is now HEALTHY (${node.latencyMs}ms)`);
        }
      } else {
        this.#recordFailure(node, target, `HTTP ${res.status}`);
      }
    } catch (err) {
      node.lastCheckedAt = now;
      this.#recordFailure(node, target, err.message);
    }
  }

  /**
   * @param {NodeStatus} node
   * @param {Target} target
   * @param {string} reason
   */
  #recordFailure(node, target, reason) {
    node.consecutiveFailures++;
    const wasHealthy = node.healthy;

    if (node.consecutiveFailures >= this.#unhealthyThreshold) {
      node.healthy = false;
      if (wasHealthy) {
        console.warn(`[health] ${target.hostname} (${target.url}) is now UNHEALTHY after ${node.consecutiveFailures} failures: ${reason}`);
      }
    }
  }
}
