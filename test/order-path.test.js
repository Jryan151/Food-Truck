'use strict';
/* =====================================================================
   The order path, end to end, through real HTTP: a truck signs up, opens, a customer orders, the
   kitchen hears it live, marks it Ready, the customer sees Ready, it's fulfilled; a double tap never
   makes two orders; a customer can cancel in the change window. Also the two performance budgets:
   an order reaches the kitchen screen in under 3 seconds, and the order page is light enough to load
   in under 2 seconds on weak 4G.

   Run: npm test   (scripts/deploy.sh runs it before every restart; a failure stops the deploy)
   It starts its own copy of the app on a spare port with an empty database in a temporary folder, so it
   never touches the real database, .env or email. To run it against a server already running instead:
   TEST_BASE=http://127.0.0.1:8770 TEST_ROOT=test.local npm test
   ===================================================================== */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP = path.join(__dirname, '..');
const ROOT = process.env.TEST_ROOT || 'okpath.localhost';
let BASE = process.env.TEST_BASE || '';
let child = null;
let tmp = null;

function request(method, host, urlPath, { body, cookie } = {}) {
  const u = new URL(BASE + urlPath);
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign({ Host: host }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length, Origin: 'http://' + host } : {}, cookie ? { Cookie: cookie } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Opens the live feed and records every event with the time it arrived. */
function live(host, cookie) {
  const u = new URL(BASE + '/api/live-stream');
  const events = [];
  const waiters = [];
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: Object.assign({ Host: host, Accept: 'text/event-stream' }, cookie ? { Cookie: cookie } : {}) }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try { const m = JSON.parse(line.slice(6)); m.at = Date.now(); events.push(m); } catch (e) { continue; }
        for (const w of waiters.slice()) if (w.test(events[events.length - 1])) { waiters.splice(waiters.indexOf(w), 1); w.resolve(events[events.length - 1]); }
      }
    });
  });
  req.end();
  return {
    events,
    next(test, ms = 5000) {
      const found = events.find(test);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { test, resolve };
        waiters.push(w);
        setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error('no live event in time')); } }, ms);
      });
    },
    close() { req.destroy(); },
  };
}

async function waitHealthy(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await request('GET', ROOT, '/api/health'); if (r.json && r.json.ok) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the app did not start');
}

test.before(async () => {
  if (BASE) return waitHealthy(5000);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-path-'));
  const port = 39000 + Math.floor(Math.random() * 2000);
  BASE = `http://127.0.0.1:${port}`;
  const env = Object.assign({}, process.env, {
    PORT: String(port), ROOT_DOMAIN: ROOT, DB_FILE: path.join(tmp, 'test.sqlite'), UPLOAD_DIR: path.join(tmp, 'uploads'),
    LIMP_DIR: path.join(tmp, 'limp'), BACKUP_DIR_LOCAL: path.join(tmp, 'backups'), CERT_WATCH: 'off', PUBLIC_SCHEME: 'http',
    // Never real email, payments or texts from a test run.
    RESEND_API_KEY: '', MAIL_FROM: '', STRIPE_SECRET_KEY: '', TWILIO_ACCOUNT_SID: '', ADMIN_EMAIL: '', SENTRY_DSN: '', REQUIRE_EMAIL_VERIFY: '',
  });
  // Run from the temporary folder, so the real .env is never read.
  child = spawn(process.execPath, [path.join(APP, 'server.js')], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => { if (process.env.TEST_VERBOSE) process.stderr.write(d); });
  await waitHealthy(15000);
});

test.after(() => {
  if (child) child.kill('SIGTERM');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const slug = 'path-' + Math.random().toString(36).slice(2, 8);
const HOST = `${slug}.${ROOT}`;
const email = `${slug}@example.com`;
let owner = '';
let menu = [];

test('a truck signs up, logs in and opens', async () => {
  const s = await request('POST', ROOT, '/api/auth/signup/start', { body: { businessName: 'Path Test Tacos', slug, ownerName: 'Pat Test', email, password: 'a-long-password-1', acceptTerms: true } });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  const l = await request('POST', HOST, '/api/auth/login', { body: { email, password: 'a-long-password-1' } });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  owner = String([].concat(l.headers['set-cookie'] || [])[0] || '').split(';')[0];
  assert.match(owner, /^ft_session=/);
  const o = await request('PUT', HOST, '/api/owner/state', { cookie: owner, body: { status: 'open' } });
  assert.equal(o.status, 200, JSON.stringify(o.json));
  const v = await request('GET', HOST, '/api/vendor-data');
  menu = v.json.menu.filter((m) => !m.soldOut);
  assert.ok(menu.length > 0, 'the new truck has a menu');
  assert.equal(v.json.state.status, 'open');
});

test('order → kitchen hears it in under 3 s → Ready → customer sees it → Fulfilled', async () => {
  const kitchen = live(HOST, owner);
  await kitchen.next((m) => m.type === 'STATE');
  const key = 'path-key-' + Date.now();
  const t0 = Date.now();
  const r = await request('POST', HOST, '/api/orders', { body: { customerName: 'Ana', items: [{ id: menu[0].id, qty: 2 }], clientKey: key, device: 'pathtestdevice00001' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const heard = await kitchen.next((m) => m.type === 'ORDER_NEW' && m.payload.ticket === r.json.ticket, 3000);
  const ms = heard.at - t0;
  assert.ok(ms < 3000, `an order reaches the kitchen in under 3 s (took ${ms} ms)`);
  // a second tap with the same key is the same order
  const again = await request('POST', HOST, '/api/orders', { body: { customerName: 'Ana', items: [{ id: menu[0].id, qty: 2 }], clientKey: key, device: 'pathtestdevice00001' } });
  assert.equal(again.json.ticket, r.json.ticket);
  assert.equal(again.json.repeat, true);
  const list = await request('GET', HOST, '/api/owner/orders?status=Active', { cookie: owner });
  const mine = list.json.orders.filter((o) => o.ticket === r.json.ticket);
  assert.equal(mine.length, 1, 'exactly one ticket in the kitchen');
  const ready = await request('PATCH', HOST, `/api/owner/orders/${mine[0].id}`, { cookie: owner, body: { action: 'ready' } });
  assert.equal(ready.status, 200);
  const track = await request('GET', HOST, `/api/orders/track?tokens=${r.json.token}`);
  assert.equal(track.json.orders[0].status, 'Ready', 'the customer sees Ready');
  await kitchen.next((m) => m.type === 'ORDER_STATUS' && m.payload.tag === r.json.tag && m.payload.status === 'Ready', 3000);
  const done = await request('PATCH', HOST, `/api/owner/orders/${mine[0].id}`, { cookie: owner, body: { action: 'fulfill' } });
  assert.equal(done.json.order.status, 'Fulfilled');
  const hist = await request('GET', HOST, `/api/owner/orders/${mine[0].id}/history`, { cookie: owner });
  assert.deepEqual(hist.json.events.map((e) => e.event), ['placed', 'ready', 'fulfilled'], 'the service record has every step');
  kitchen.close();
});

test('a customer can cancel in the change window, and the kitchen is told', async () => {
  const kitchen = live(HOST, owner);
  await kitchen.next((m) => m.type === 'STATE');
  const r = await request('POST', HOST, '/api/orders', { body: { customerName: 'Sam', items: [{ id: menu[0].id, qty: 1 }], device: 'pathtestdevice00002' } });
  assert.equal(r.status, 201);
  const c = await request('POST', HOST, `/api/orders/${r.json.token}/cancel`, { body: {} });
  assert.equal(c.json.status, 'Canceled');
  const told = await kitchen.next((m) => m.type === 'ORDER_UPDATE' && m.payload.ticket === r.json.ticket && m.payload.byCustomer, 3000);
  assert.equal(told.payload.status, 'Canceled');
  kitchen.close();
});

test('customers never get kitchen-only details on the live feed', async () => {
  const guest = live(HOST, '');
  await guest.next((m) => m.type === 'STATE');
  await request('POST', HOST, '/api/orders', { body: { customerName: 'Lu Private', items: [{ id: menu[0].id, qty: 1 }], device: 'pathtestdevice00003' } });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!JSON.stringify(guest.events).includes('Lu Private'), 'no names or orders on the public feed');
  guest.close();
});

test('the order page is light enough for weak 4G (under 2 s)', async () => {
  const page = await request('GET', HOST, '/');
  assert.equal(page.status, 200);
  const html = page.raw.toString('utf8');
  const assets = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  let raw = page.raw.length, gz = zlib.gzipSync(page.raw).length;
  for (const a of assets) {
    const r = await request('GET', HOST, a);
    assert.equal(r.status, 200, a);
    raw += r.raw.length; gz += zlib.gzipSync(r.raw).length;
  }
  // Weak 4G ≈ 1.6 Mbit/s with ~300 ms of round trips: about 300 KB fits in 2 s once compressed.
  const seconds = 0.3 * 2 + (gz * 8) / 1.6e6;
  if (process.env.TEST_VERBOSE) console.log(`order page: ${Math.round(raw / 1024)} KB, ${Math.round(gz / 1024)} KB compressed, ~${seconds.toFixed(2)} s on weak 4G`);
  assert.ok(seconds < 2, `order page ≈ ${seconds.toFixed(2)} s on weak 4G (${Math.round(gz / 1024)} KB compressed)`);
});
