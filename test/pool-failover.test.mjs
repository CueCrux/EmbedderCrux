// M1 validation — embedder-pool-per-tenant-bundle ExecPlan.
// A backend that passes /healthz but 502s every /embed (the flaky-5090 case)
// must NOT torpedo callers: the router fails over to a healthy peer and ejects
// the flaky backend (circuit-break). Run: node test/pool-failover.test.mjs
import http from 'node:http';

let healthyEmbed = 0;
let flakyEmbed = 0;

function mockBackend(onEmbed) {
  return http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
    if (req.url === '/embed' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => onEmbed(res, body));
      return;
    }
    res.writeHead(404); res.end();
  });
}

const healthy = mockBackend((res, body) => {
  healthyEmbed++;
  const { inputs } = JSON.parse(body);
  const vecs = inputs.map(() => [0.1, 0.2, 0.3]);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(vecs));
});
// Flaky: /healthz is 200 (looks healthy) but /embed always 502.
const flaky = mockBackend((res) => { flakyEmbed++; res.writeHead(502); res.end('bad gateway'); });

await new Promise(r => healthy.listen(0, r));
await new Promise(r => flaky.listen(0, r));
const healthyUrl = `http://127.0.0.1:${healthy.address().port}`;
const flakyUrl = `http://127.0.0.1:${flaky.address().port}`;

const routerPort = 18099;
// Flaky listed first AND set as the coalescer's preferred remote → reproduces
// the 502 over-routing pathology the hardening must absorb.
process.env.POOL_ROUTER_PORT = String(routerPort);
process.env.POOL_TARGETS = `${flakyUrl},${healthyUrl}`;
process.env.POOL_REMOTE_BATCH_ENABLED = 'true';
process.env.POOL_REMOTE_BATCH_NODE_URL = flakyUrl;
process.env.POOL_REMOTE_BATCH_MIN_TEXTS = '1';
process.env.POOL_REMOTE_BATCH_TARGET_TEXTS = '4';
process.env.POOL_REMOTE_BATCH_WINDOW_MS = '10';
process.env.POOL_HEALTH_INTERVAL_MS = '400';
process.env.POOL_TRAFFIC_EJECT_THRESHOLD = '2';
process.env.POOL_EJECT_COOLDOWN_MS = '5000';
process.env.POOL_DISCOVERY_TAG = '__none__';

await import('../src/pool-router.mjs'); // starts the router server
await new Promise(r => setTimeout(r, 3200)); // router has a 2.5s startup delay before listen()

// diagnostics
const ps = await (await fetch(`http://127.0.0.1:${routerPort}/pool/status`)).json();
console.log('DIAG pool/status healthy=', ps.healthy, 'nodes=', ps.nodes.map(n => `${n.hostname}:${n.url.split(':').pop()} healthy=${n.healthy} ejectedUntil=${n.ejectedUntil}`));
const r0 = await fetch(`http://127.0.0.1:${routerPort}/embed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inputs: ['a', 'b', 'c', 'd'] }) });
console.log('DIAG first /embed status=', r0.status, 'body=', (await r0.text()).slice(0, 150));

let ok = 0, errs = 0;
for (let i = 0; i < 10; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${routerPort}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: ['a', 'b', 'c', 'd'] }),
    });
    if (r.status === 200) {
      const v = await r.json();
      if (Array.isArray(v) && v.length === 4) ok++; else errs++;
    } else errs++;
  } catch { errs++; }
  await new Promise(r => setTimeout(r, 120));
}

console.log(`results: ok=${ok}/10 errs=${errs} | flakyEmbed_hits=${flakyEmbed} healthyEmbed_hits=${healthyEmbed}`);
const pass =
  errs === 0 &&           // no caller ever saw an error (failover absorbed the 502s)
  ok === 10 &&            // all succeeded
  flakyEmbed >= 1 &&      // flaky was tried...
  flakyEmbed <= 4 &&      // ...then ejected (didn't keep getting all 10)
  healthyEmbed >= 8;      // healthy served the bulk after ejection
console.log(pass
  ? 'PASS — 0 caller errors; flaky tried then ejected; healthy served the rest'
  : 'FAIL — see counts above');
process.exit(pass ? 0 : 1);
