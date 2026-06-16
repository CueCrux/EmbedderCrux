// M4 validation — embedder-pool-per-tenant-bundle ExecPlan.
// POST /embed/bundle accepts one large bundle, SPLITS it across the healthy
// backends, embeds the shards in PARALLEL, and REASSEMBLES the vectors in the
// original input order. This test proves the split happened (both backends
// served part of the bundle) AND that order is preserved end-to-end (each
// vector echoes its input index, so any mis-ordering would be visible).
// Run: node test/embed-bundle.test.mjs
import http from 'node:http';

let aTexts = 0;
let bTexts = 0;

// Each backend echoes `Number(input)` as a 1-d vector, so the reassembled
// bundle must be [[0],[1],...,[N-1]] iff ordering survived the split.
function echoBackend(onCount) {
  return http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
    if (req.url === '/embed' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const { inputs } = JSON.parse(body);
        onCount(inputs.length);
        const vecs = inputs.map(t => [Number(t)]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(vecs));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
}

const a = echoBackend(n => { aTexts += n; });
const b = echoBackend(n => { bTexts += n; });
await new Promise(r => a.listen(0, r));
await new Promise(r => b.listen(0, r));
const aUrl = `http://127.0.0.1:${a.address().port}`;
const bUrl = `http://127.0.0.1:${b.address().port}`;

const routerPort = 18097;
process.env.POOL_ROUTER_PORT = String(routerPort);
process.env.POOL_TARGETS = `${aUrl},${bUrl}`;
process.env.POOL_REMOTE_BATCH_ENABLED = 'false'; // bundle path, not the coalescer
process.env.POOL_HEALTH_INTERVAL_MS = '400';
process.env.POOL_DISCOVERY_TAG = '__none__';

await import('../src/pool-router.mjs');
await new Promise(r => setTimeout(r, 3200)); // router has a 2.5s startup delay before listen()

const N = 50;
const inputs = Array.from({ length: N }, (_, i) => String(i));
const r = await fetch(`http://127.0.0.1:${routerPort}/embed/bundle`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ inputs }),
});
const status = r.status;
const out = status === 200 ? await r.json() : await r.text();

// Order preserved: out[i] must echo i.
const ordered = Array.isArray(out) && out.length === N && out.every((v, i) => Array.isArray(v) && v[0] === i);
// Split happened: both backends served part of the bundle, and together exactly N.
const split = aTexts > 0 && bTexts > 0 && aTexts + bTexts === N;

console.log(`results: status=${status} len=${Array.isArray(out) ? out.length : 'n/a'} | aTexts=${aTexts} bTexts=${bTexts} ordered=${ordered} split=${split}`);
const pass = status === 200 && ordered && split;
console.log(pass
  ? 'PASS — bundle split across both backends, reassembled in order'
  : 'FAIL — see counts above');
process.exit(pass ? 0 : 1);
