'use strict';
/* =====================================================================
   Load test before a big event: "200 orders in 10 minutes" on this server, before the festival.

     node scripts/load-test.js                       200 orders over 10 minutes (the real pace)
     node scripts/load-test.js --orders 300 --minutes 2   harder than any festival, faster
     node scripts/load-test.js --browsers 8          customers per order reloading the menu meanwhile

   It starts its own copy of the app on a spare port with an empty database in a temporary folder, so
   real trucks, orders and email are never touched; it measures this server's hardware and code. Each
   simulated customer has their own phone id and network address, and a simulated kitchen marks orders
   Ready and Fulfilled as they come in, like a real rush. At the end it prints how long orders took to
   place, how long they took to reach the kitchen screen, and any errors, with a plain verdict.
   ===================================================================== */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const ORDERS = arg('orders', 200);
const MINUTES = arg('minutes', 10);
const BROWSERS = arg('browsers', 4);
// --base http://host:port --root domain: test a copy that's already running (a staging copy, never the live site).
const BASE_ARG = (() => { const i = process.argv.indexOf('--base'); return i > 0 ? process.argv[i + 1] : ''; })();
const ROOT = (() => { const i = process.argv.indexOf('--root'); return i > 0 ? process.argv[i + 1] : 'okload.localhost'; })();
const APP = path.join(__dirname, '..');
let BASE = '';

function request(method, host, urlPath, { body, cookie, ip } = {}) {
  const u = new URL(BASE + urlPath);
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false,
      headers: Object.assign({ Host: host }, ip ? { 'X-Forwarded-For': ip } : {}, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, cookie ? { Cookie: cookie } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, ms: Date.now() - t0 });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message, ms: Date.now() - t0 }));
    if (data) req.write(data);
    req.end();
  });
}

const pct = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-load-'));
  const port = BASE_ARG ? Number(new URL(BASE_ARG).port) : 41000 + Math.floor(Math.random() * 2000);
  BASE = BASE_ARG || `http://127.0.0.1:${port}`;
  const env = Object.assign({}, process.env, {
    PORT: String(port), ROOT_DOMAIN: ROOT, DB_FILE: path.join(tmp, 'load.sqlite'), UPLOAD_DIR: path.join(tmp, 'uploads'),
    LIMP_DIR: path.join(tmp, 'limp'), BACKUP_DIR_LOCAL: path.join(tmp, 'backups'), CERT_WATCH: 'off', PUBLIC_SCHEME: 'http',
    RESEND_API_KEY: '', MAIL_FROM: '', STRIPE_SECRET_KEY: '', TWILIO_ACCOUNT_SID: '', ADMIN_EMAIL: '', SENTRY_DSN: '', REQUIRE_EMAIL_VERIFY: '',
  });
  const child = BASE_ARG ? null : spawn(process.execPath, [path.join(APP, 'server.js')], { cwd: tmp, env, stdio: 'ignore' });
  const stop = () => { try { if (child) child.kill('SIGTERM'); } catch (e) {} fs.rmSync(tmp, { recursive: true, force: true }); };
  process.on('SIGINT', () => { stop(); process.exit(130); });
  for (let i = 0; i < 75; i++) { const r = await request('GET', ROOT, '/api/health'); if (r.json && r.json.ok) break; await sleep(200); }

  // A truck, open for business.
  const slug = 'load-test';
  const HOST = `${slug}.${ROOT}`;
  await request('POST', ROOT, '/api/auth/signup/start', { body: { businessName: 'Load Test Tacos', slug, ownerName: 'Load Test', email: 'load@example.com', password: 'a-long-password-1', acceptTerms: true } });
  const login = await request('POST', HOST, '/api/auth/login', { body: { email: 'load@example.com', password: 'a-long-password-1' } });
  const owner = String([].concat(login.headers['set-cookie'] || [])[0] || '').split(';')[0];
  await request('PUT', HOST, '/api/owner/state', { cookie: owner, body: { status: 'open' } });
  const menu = (await request('GET', HOST, '/api/vendor-data')).json.menu.filter((m) => !m.soldOut);
  if (!menu.length || !owner) { console.error('Could not set up the test truck.'); stop(); process.exit(1); }

  // The kitchen screen: live feed, time each order from "placed" to "on the screen".
  const placedAt = new Map();
  const toKitchen = [];
  const feed = http.request({ hostname: '127.0.0.1', port, path: '/api/live-stream', headers: { Host: HOST, Cookie: owner } }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: ')); buf = buf.slice(i + 2);
        if (!line) continue;
        try { const m = JSON.parse(line.slice(6)); if (m.type === 'ORDER_NEW' && placedAt.has(m.payload.ticket)) toKitchen.push(Date.now() - placedAt.get(m.payload.ticket)); } catch (e) {}
      }
    });
  });
  feed.end();

  console.log(`Load test: ${ORDERS} orders over ${MINUTES} minute${MINUTES === 1 ? '' : 's'}, ${BROWSERS} menu reloads per order, ${BASE_ARG ? 'against ' + BASE_ARG : "on this server's own copy of the app"}…`);
  const spanMs = MINUTES * 60000;
  const placeMs = [], readMs = [], errors = {};
  const note = (what) => { errors[what] = (errors[what] || 0) + 1; };
  const kitchenTaps = [];
  const started = Date.now();
  const jobs = [];
  for (let n = 0; n < ORDERS; n++) {
    // Arrivals bunch up like a real rush: more in the middle of the window.
    const at = spanMs * (0.5 + Math.asin(2 * ((n + Math.random()) / ORDERS) - 1) / Math.PI);
    jobs.push((async () => {
      await sleep(at);
      const ip = `10.${(n >> 8) & 255}.${n & 255}.${7 + (n % 200)}`;
      for (let b = 0; b < BROWSERS; b++) {
        const r = await request('GET', HOST, '/api/vendor-data', { ip });
        if (r.status === 200) readMs.push(r.ms); else note('menu ' + r.status);
      }
      const item = menu[n % menu.length];
      const t = Date.now();
      const r = await request('POST', HOST, '/api/orders', { ip, body: { customerName: 'Guest ' + n, items: [{ id: item.id, qty: 1 + (n % 3) }], clientKey: `load-${n}-${t}`, device: `loaddevice${String(n).padStart(8, '0')}` } });
      if (r.status !== 201) { note('order ' + r.status + (r.json && r.json.error ? ': ' + r.json.error : '')); return; }
      placedAt.set(r.json.ticket, t);
      placeMs.push(r.ms);
      // The kitchen: Ready a little later, then Fulfilled.
      kitchenTaps.push((async () => {
        await sleep(Math.min(20000, spanMs / 20) * Math.random());
        const list = await request('GET', HOST, '/api/owner/orders?status=Active', { cookie: owner });
        const o = list.json && list.json.orders.find((x) => x.ticket === r.json.ticket);
        if (!o) return;
        const a = await request('PATCH', HOST, `/api/owner/orders/${o.id}`, { cookie: owner, body: { action: 'ready' } });
        if (a.status !== 200) note('ready ' + a.status);
        const f = await request('PATCH', HOST, `/api/owner/orders/${o.id}`, { cookie: owner, body: { action: 'fulfill' } });
        if (f.status !== 200) note('fulfill ' + f.status);
      })());
    })());
  }
  const tick = setInterval(() => process.stdout.write(`\r  ${placeMs.length} placed · ${Math.round((Date.now() - started) / 1000)} s `), 1000);
  await Promise.all(jobs);
  await Promise.all(kitchenTaps);
  await sleep(1000);
  clearInterval(tick);
  feed.destroy();
  stop();

  const errCount = Object.values(errors).reduce((a, b) => a + b, 0);
  console.log('\n');
  console.log(`Orders placed:        ${placeMs.length} of ${ORDERS}`);
  console.log(`Placing an order:     typical ${pct(placeMs, 50)} ms · slow (95%) ${pct(placeMs, 95)} ms · slowest ${pct(placeMs, 100)} ms`);
  console.log(`Reaching the kitchen: typical ${pct(toKitchen, 50)} ms · slow (95%) ${pct(toKitchen, 95)} ms · slowest ${pct(toKitchen, 100)} ms (${toKitchen.length} heard)`);
  console.log(`Menu loads:           ${readMs.length} · typical ${pct(readMs, 50)} ms · slow (95%) ${pct(readMs, 95)} ms`);
  console.log(`Errors:               ${errCount ? Object.entries(errors).map(([k, v]) => `${v}× ${k}`).join(', ') : 'none'}`);
  const good = placeMs.length === ORDERS && !errCount && pct(toKitchen, 95) < 3000 && pct(placeMs, 95) < 1500;
  console.log('\n' + (good
    ? 'Ready for the event: every order went through and reached the kitchen well inside 3 seconds.'
    : 'NOT ready: see the numbers above. Orders must all go through, and reach the kitchen in under 3 seconds.'));
  process.exit(good ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
