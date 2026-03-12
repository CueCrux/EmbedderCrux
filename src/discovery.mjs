// EmbedderCrux Pool Router — Tailscale Peer Discovery + Static Targets
// Zero external dependencies. Uses child_process to call `tailscale status --json`.

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * @typedef {{ id: string, url: string, hostname: string, source: 'tailscale' | 'static' }} Target
 */

const DEFAULT_DISCOVERY_INTERVAL_MS = 30_000;
const DEFAULT_DISCOVERY_TAG = 'tag:embedder';
const DEFAULT_EMBEDDER_PORT = 8080;

export class Discovery extends EventEmitter {
  /** @type {Map<string, Target>} */
  #targets = new Map();
  #timer = null;
  #intervalMs;
  #tag;
  #port;
  #staticTargets;

  /**
   * @param {object} opts
   * @param {number}  [opts.intervalMs]   — discovery poll interval
   * @param {string}  [opts.tag]          — Tailscale tag to filter peers
   * @param {number}  [opts.port]         — port each embedder gateway listens on
   * @param {string}  [opts.staticTargets] — comma-separated URLs (always included)
   */
  constructor(opts = {}) {
    super();
    this.#intervalMs = opts.intervalMs ?? parseInt(process.env.POOL_DISCOVERY_INTERVAL_MS ?? '', 10) || DEFAULT_DISCOVERY_INTERVAL_MS;
    this.#tag = opts.tag ?? process.env.POOL_DISCOVERY_TAG ?? DEFAULT_DISCOVERY_TAG;
    this.#port = opts.port ?? parseInt(process.env.POOL_DISCOVERY_PORT ?? '', 10) || DEFAULT_EMBEDDER_PORT;
    this.#staticTargets = parseStaticTargets(opts.staticTargets ?? process.env.POOL_TARGETS ?? '');
  }

  /** Start the discovery loop. Runs an initial poll synchronously-ish before returning. */
  async start() {
    // Seed with static targets immediately
    for (const t of this.#staticTargets) {
      this.#targets.set(t.id, t);
    }

    // First Tailscale poll (best-effort — don't block startup if TS unavailable)
    await this.#poll().catch(err => {
      console.warn('[discovery] initial Tailscale poll failed, using static targets only:', err.message);
    });

    this.#timer = setInterval(() => {
      this.#poll().catch(err => {
        console.warn('[discovery] Tailscale poll failed:', err.message);
      });
    }, this.#intervalMs);
    this.#timer.unref();

    console.log(`[discovery] started — tag=${this.#tag} interval=${this.#intervalMs}ms static=${this.#staticTargets.length}`);
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** @returns {Target[]} current target list */
  getTargets() {
    return [...this.#targets.values()];
  }

  // ── Internal ──────────────────────────────────────────────────────────

  async #poll() {
    const status = await tailscaleStatus();
    const discovered = extractEmbedderPeers(status, this.#tag, this.#port);

    // Build new map: static targets + discovered
    const next = new Map();
    for (const t of this.#staticTargets) next.set(t.id, t);
    for (const t of discovered) next.set(t.id, t);

    // Detect changes
    const prevIds = new Set(this.#targets.keys());
    const nextIds = new Set(next.keys());
    const added = [...nextIds].filter(id => !prevIds.has(id));
    const removed = [...prevIds].filter(id => !nextIds.has(id));

    this.#targets = next;

    if (added.length || removed.length) {
      for (const id of added) {
        const t = next.get(id);
        console.log(`[discovery] + ${t.hostname} (${t.url}) [${t.source}]`);
      }
      for (const id of removed) {
        console.log(`[discovery] - ${id}`);
      }
      this.emit('change', { added, removed, targets: this.getTargets() });
    }
  }
}

// ── Tailscale Local API ───────────────────────────────────────────────

/** Execute `tailscale status --json` and parse the result. */
function tailscaleStatus() {
  return new Promise((resolve, reject) => {
    execFile('tailscale', ['status', '--json'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        reject(new Error(`Failed to parse tailscale status JSON: ${parseErr.message}`));
      }
    });
  });
}

/**
 * Extract peers matching the given tag from tailscale status output.
 * @param {object} status — parsed `tailscale status --json`
 * @param {string} tag    — e.g. "tag:embedder"
 * @param {number} port   — embedder gateway port
 * @returns {Target[]}
 */
function extractEmbedderPeers(status, tag, port) {
  const peers = status.Peer ?? {};
  const results = [];

  for (const [key, peer] of Object.entries(peers)) {
    // Skip offline peers
    if (!peer.Online) continue;

    // Check tags (may be in Tags or TaggedOwners depending on TS version)
    const tags = peer.Tags ?? [];
    if (!tags.includes(tag)) continue;

    // Use first Tailscale IP (IPv4 preferred, but TS usually returns IPv4 first)
    const ip = (peer.TailscaleIPs ?? [])[0];
    if (!ip) continue;

    results.push({
      id: `ts:${peer.HostName}:${ip}`,
      url: `http://${ip}:${port}`,
      hostname: peer.HostName ?? key,
      source: 'tailscale',
    });
  }

  return results;
}

// ── Static Target Parsing ─────────────────────────────────────────────

/**
 * Parse comma-separated URLs into Target objects.
 * @param {string} raw — e.g. "http://100.111.227.102:8080,http://10.80.0.2:8080"
 * @returns {Target[]}
 */
function parseStaticTargets(raw) {
  if (!raw.trim()) return [];

  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(urlStr => {
      const u = new URL(urlStr);
      const hostname = u.hostname;
      return {
        id: `static:${hostname}:${u.port || '8080'}`,
        url: urlStr.replace(/\/+$/, ''),
        hostname,
        source: /** @type {const} */ ('static'),
      };
    });
}
