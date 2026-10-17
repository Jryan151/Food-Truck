'use strict';
/**
 * core.js — database, migrations, plans, menu normalizer, live-sync hub.
 * Everything else (auth.js, api.js, billing.js, server.js) builds on this file.
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const ROOT_DOMAIN = (process.env.ROOT_DOMAIN || 'onlinekitchen.fyi').trim().toLowerCase();
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'database.sqlite');
// Menu photos are stored here and served at /uploads/... (include this folder in your backups).
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

const raw = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error('Error opening database:', err.message);
  else console.log('Connected to SQLite:', DB_FILE);
});

/* ---------- promise helpers ---------- */
const run = (sql, params = []) =>
  new Promise((resolve, reject) =>
    raw.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    })
  );
const get = (sql, params = []) =>
  new Promise((resolve, reject) => raw.get(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
const all = (sql, params = []) =>
  new Promise((resolve, reject) => raw.all(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
const exec = (sql) =>
  new Promise((resolve, reject) => raw.exec(sql, (e) => (e ? reject(e) : resolve())));

/* ---------- small utils ---------- */
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/**
 * Public "tag" for an order. Live updates are broadcast with this tag instead of the
 * secret token, so a visitor listening to the stream can't use it to look up other
 * customers' orders. Only the customer who placed the order knows which tag is theirs.
 */
const orderTag = (token) => sha256('order:' + token).slice(0, 24);

/* ---------- plans (add a plan = add an entry here) ---------- */
// One safety ceiling for every plan, so nobody can paste in a giant menu and slow the server.
const MAX_ITEMS = 200;

const PLANS = {
  free: { label: 'Free', customDomain: false, sms: false, removeBranding: false, onlinePayments: false },
  pro: { label: 'Pro', customDomain: true, sms: true, removeBranding: true, onlinePayments: true },
};
const GRACE_MS = 7 * 24 * 60 * 60 * 1000; // paid features stay on 7 days after a failed payment

function effectivePlan(v) {
  if (!v || v.plan !== 'pro') return 'free';
  if (v.plan_status === 'active') return 'pro';
  if (v.plan_status === 'past_due') {
    return Date.now() - (v.past_due_since || 0) < GRACE_MS ? 'pro' : 'free';
  }
  return 'free';
}
const features = (v) => PLANS[effectivePlan(v)];

/* ---------- slugs ---------- */
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'www', 'app', 'support', 'root', 'auth', 'help', 'onlinekitchen', 'online-kitchen', 'login', 'signup',
  'owner', 'customer', 'dashboard', 'billing', 'static', 'assets', 'mail', 'ftp', 'smtp', 'imap',
  'pop', 'ns1', 'ns2', 'cdn', 'status', 'blog', 'docs', 'dev', 'staging', 'test', 'demo', 'secure',
  'account', 'accounts', 'verify', 'reset', 'webhook', 'stripe', 'paypal', 'terms', 'privacy',
  // Email sending (Resend) lives on these subdomains; a truck with one of these names would break mail.
  'send', 'rsend', 'bounce', 'bounces', 'email', 'resend',
]);
const BLOCKED_SUBSTRINGS = ['paypal', 'stripe', 'venmo', 'cashapp', 'zelle', 'wellsfargo', 'bankofamerica', 'coinbase'];

function validateSlug(input) {
  const slug = String(input || '').toLowerCase().trim();
  if (slug.length < 3 || slug.length > 30) return { ok: false, error: 'Web address must be 3-30 characters.' };
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(slug)) return { ok: false, error: 'Use only letters, numbers and hyphens (no hyphen at the start or end).' };
  if (slug.includes('--')) return { ok: false, error: 'Please avoid double hyphens.' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: 'That web address is reserved.' };
  const squashed = slug.replace(/-/g, '');
  if (BLOCKED_SUBSTRINGS.some((b) => squashed.includes(b))) return { ok: false, error: 'That web address is not allowed.' };
  return { ok: true, slug };
}

/* ---------- menu item shape (one canonical shape for every page) ---------- */
// Sample menu for new signups who pick "Sample menu". The demo uses the same items (public/demo-shim.js).
const DEFAULT_MENU = [
  { category: 'Tacos & Mains', name: 'Street Tacos (3)', desc: 'Corn tortillas, onion, cilantro, salsa verde.', price: 9.0, prep: 4, meats: 'Asada, Pollo, Al Pastor, Veggie', premiumSurcharge: 0 },
  { category: 'Tacos & Mains', name: 'Loaded Quesadilla', desc: 'Flour tortilla, melted cheese, pico, crema.', price: 10.5, prep: 6, meats: 'Pollo, Asada, Veggie', premiumSurcharge: 1.0 },
  { category: 'Tacos & Mains', name: 'Burrito Bowl', desc: 'Rice, beans, your choice of protein, all the toppings.', price: 12.0, prep: 5, meats: 'Pollo, Asada, Veggie', premiumSurcharge: 1.0 },
  { category: 'Sides', name: 'Street Corn', desc: 'Grilled elote with cotija, chile and lime.', price: 5.0, salePrice: 4.0, prep: 3 },
  { category: 'Sides', name: 'Chips & Salsa', desc: 'House-made chips with roasted salsa.', price: 3.5, prep: 1 },
  { category: 'Drinks', name: 'Agua Fresca', desc: '24 oz, made fresh daily.', price: 4.0, prep: 1, options: ['Horchata', 'Jamaica', 'Tamarindo'] },
];

function num(v, d = 0) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : d;
}

function normalizeItem(i, id) {
  i = i && typeof i === 'object' ? i : {};
  const sale = num(i.salePrice, 0);
  const prep = parseInt(i.prep, 10);
  return {
    id,
    name: String(i.name || 'Item').trim().slice(0, 80) || 'Item',
    desc: String(i.desc ?? i.description ?? '').trim().slice(0, 300),
    price: Math.round(Math.max(0, Math.min(10000, num(i.price))) * 100) / 100,
    salePrice: sale > 0 ? Math.round(Math.min(10000, sale) * 100) / 100 : null,
    prep: Number.isFinite(prep) ? Math.max(1, Math.min(120, prep)) : 3,
    meats: i.meats ? String(i.meats).trim().slice(0, 200) : '',
    premiumSurcharge: Math.round(Math.max(0, Math.min(1000, num(i.premiumSurcharge ?? i.premiumUpcharge))) * 100) / 100,
    options: normalizeOptions(i.options),
    category: String(i.category || '').trim().slice(0, 40),
    photo: PHOTO_RE.test(String(i.photo || '')) ? String(i.photo) : '',
    soldOut: !!(i.soldOut ?? i.soldout),
  };
}

// Only photos we stored ourselves (see POST /api/owner/upload) are allowed on menu items.
const PHOTO_RE = /^\/uploads\/\d+-[a-f0-9]{16}\.(jpg|png|webp)$/;

/** Options can arrive as an array or a comma-separated string from the editor. */
function normalizeOptions(o) {
  const list = Array.isArray(o) ? o : typeof o === 'string' ? o.split(',') : [];
  return list.map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 20);
}

/* ---------- posted hours (display only — the Open/Closed switch is still what controls ordering) ---------- */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 7 entries, Sunday first: { closed, open: 'HH:MM', close: 'HH:MM' }. Returns null if nothing usable. */
function normalizeHours(h) {
  if (!Array.isArray(h) || h.length !== 7) return null;
  return h.map((d) => {
    d = d && typeof d === 'object' ? d : {};
    const open = TIME_RE.test(d.open) ? d.open : '11:00';
    const close = TIME_RE.test(d.close) ? d.close : '15:00';
    return { closed: !!d.closed, open, close };
  });
}
function parseHours(json) {
  try { return normalizeHours(JSON.parse(json || 'null')); } catch (e) { return null; }
}
function validTimezone(tz) {
  tz = String(tz || '').trim();
  if (!tz || tz.length > 64) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return ''; }
}

/** Accepts any older menu shape and returns the canonical one with stable integer ids. */
function normalizeMenu(arr) {
  if (!Array.isArray(arr)) return [];
  const used = new Set();
  let next = 1;
  for (const it of arr) if (it && Number.isInteger(it.id) && it.id > 0) next = Math.max(next, it.id + 1);
  return arr.slice(0, MAX_ITEMS).map((it) => {
    let id = it && Number.isInteger(it.id) && it.id > 0 && !used.has(it.id) ? it.id : next++;
    used.add(id);
    return normalizeItem(it, id);
  });
}

function parseMenu(menuData) {
  try {
    return normalizeMenu(JSON.parse(menuData || '[]'));
  } catch (e) {
    return [];
  }
}

const saveMenu = (vendorId, menu) =>
  run('UPDATE vendors SET menu_data = ?, updated_at = ? WHERE id = ?', [JSON.stringify(menu), Date.now(), vendorId]);

/* ---------- store state (open/closed, rush, location, wait) ---------- */
async function getState(vendorId) {
  let s = await get('SELECT status, rush_minutes, active_location, paused, wait_start, wait_lock, service_started_at FROM store_state WHERE vendor_id = ?', [vendorId]);
  if (!s) {
    await run('INSERT OR IGNORE INTO store_state (vendor_id) VALUES (?)', [vendorId]);
    s = { status: 'open', rush_minutes: 0, active_location: '', paused: 0 };
  }
  // paused = open for walk-ups, but not taking online orders right now
  return {
    status: s.status, rush: s.rush_minutes, location: s.active_location || '', paused: !!s.paused,
    wait: await computeWait(vendorId, s),
  };
}

/* ---------- honest wait time ----------
   What a customer ordering right now should expect, from how the kitchen is actually doing:
   - the middle (median) time from order to Ready over the last hour's tickets, once there are 3;
   - before that, the starting wait the owner set when they opened;
   - never less than the oldest ticket still cooking has already waited (the line is real);
   - plus the owner's Busy minutes.
   The owner can lock a number instead; the live suggestion is still worked out so they can take it. */
const WAIT_SAMPLES_NEEDED = 3;
const WAIT_LOOKBACK_MS = 60 * 60 * 1000;
const WAIT_MAX = 90;

const median = (xs) => {
  const a = xs.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

async function computeWait(vendorId, s) {
  const now = Date.now();
  const since = Math.max(now - WAIT_LOOKBACK_MS, s.service_started_at || 0);
  const rows = await all(
    `SELECT e.at - o.created_at AS ms FROM order_events e JOIN orders o ON o.id = e.order_id
     WHERE e.vendor_id = ? AND e.event = 'ready' AND e.at > ? AND o.created_at >= ? ORDER BY e.at DESC LIMIT 12`,
    [vendorId, since, since]
  );
  const samples = rows.map((r) => r.ms).filter((ms) => ms > 0);
  const oldest = await get("SELECT MIN(created_at) AS at FROM orders WHERE vendor_id = ? AND status = 'Preparing'", [vendorId]);
  const queueMin = oldest && oldest.at ? Math.round((now - oldest.at) / 60000) : 0;

  let base = null;
  let basis = null;
  if (samples.length >= WAIT_SAMPLES_NEEDED) { base = Math.ceil(median(samples) / 60000); basis = 'pace'; }
  else if (s.wait_start) { base = s.wait_start; basis = 'start'; }
  if (queueMin > (base || 0) && (base !== null || queueMin >= 5)) { base = queueMin; basis = 'queue'; }
  const suggested = base === null ? null : Math.min(WAIT_MAX, Math.max(1, base + (s.rush_minutes || 0)));

  const locked = s.wait_lock ? Math.min(WAIT_MAX, Math.max(1, s.wait_lock)) : null;
  return {
    minutes: locked || suggested,      // what customers see (null = not enough to go on yet)
    mode: locked ? 'locked' : 'auto',
    basis,                             // pace | start | queue | null
    samples: samples.length,
    suggested,
    start: s.wait_start || null,
  };
}

// Tells open pages when the wait changes. Remembers the last number sent so quiet periods stay quiet.
const lastWait = new Map();
async function refreshWait(vendorId) {
  try {
    const st = await getState(vendorId);
    const key = JSON.stringify([st.wait.minutes, st.wait.mode, st.wait.suggested]);
    if (lastWait.get(vendorId) === key) return st.wait;
    lastWait.set(vendorId, key);
    broadcast(vendorId, 'WAIT', st.wait);
    return st.wait;
  } catch (e) {
    console.error('wait:', e.message);
    return null;
  }
}
/** Once a minute: the line keeps aging even when nobody taps anything. Only trucks with a page open. */
async function refreshAllWaits() {
  for (const vendorId of [...clients.keys()]) await refreshWait(vendorId);
}

/** Adds a line to an order's service record. Never throws: the record must not block the kitchen. */
function logOrderEvent(vendorId, orderId, event, actor) {
  return run('INSERT INTO order_events (vendor_id, order_id, event, actor, at) VALUES (?, ?, ?, ?, ?)', [vendorId, orderId, event, actor, Date.now()]).catch((e) => console.error('order_events:', e.message));
}

/* ---------- one-time tokens (email verify, password reset, login handoff) ---------- */
async function createToken(vendorId, kind, ttlMs) {
  const t = randomToken(24);
  await run('INSERT INTO tokens (token_hash, vendor_id, kind, expires_at, used) VALUES (?, ?, ?, ?, 0)', [
    sha256(t), vendorId, kind, Date.now() + ttlMs,
  ]);
  return t;
}
/** Atomically uses a token. Returns vendor_id or null. */
async function consumeToken(rawToken, kind) {
  if (!rawToken) return null;
  const row = await get(
    'UPDATE tokens SET used = 1 WHERE token_hash = ? AND kind = ? AND used = 0 AND expires_at > ? RETURNING vendor_id',
    [sha256(rawToken), kind, Date.now()]
  );
  return row ? row.vendor_id : null;
}

/* ---------- live sync hub (SSE) ---------- */
const clients = new Map(); // vendorId -> Set<{res, staff}>

function sseAdd(vendorId, res, staff) {
  if (!clients.has(vendorId)) clients.set(vendorId, new Set());
  const c = { res, staff: !!staff };
  clients.get(vendorId).add(c);
  return () => {
    const set = clients.get(vendorId);
    if (set) {
      set.delete(c);
      if (set.size === 0) clients.delete(vendorId);
    }
  };
}

/** staffOnly=true sends only to logged-in owner/staff screens (new orders contain customer names). */
function broadcast(vendorId, type, payload, staffOnly = false) {
  const set = clients.get(vendorId);
  if (!set) return 0;
  const msg = `data: ${JSON.stringify({ type, payload })}\n\n`;
  let n = 0;
  for (const c of set) {
    if (staffOnly && !c.staff) continue;
    try { c.res.write(msg); n++; } catch (e) { /* closed socket, cleaned up on 'close' */ }
  }
  return n;
}

/** Closes every live connection for a vendor (used when an account is deleted). */
function disconnectVendor(vendorId) {
  const set = clients.get(vendorId);
  if (!set) return;
  for (const c of set) { try { c.res.end(); } catch (e) {} }
  clients.delete(vendorId);
}

/** Ends every live connection (used when the server stops, so screens reconnect to the new one). */
function closeAllStreams() {
  for (const set of clients.values()) for (const c of set) { try { c.res.end(); } catch (e) {} }
  clients.clear();
}

setInterval(() => {
  for (const set of clients.values()) for (const c of set) { try { c.res.write(': ping\n\n'); } catch (e) {} }
}, 25000).unref();

/* ---------- schema + migrations (safe to run on every start) ---------- */
async function addColumn(table, col, def) {
  const cols = await all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === col)) await run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

async function ensureSchema() {
  await run('PRAGMA journal_mode = WAL').catch(() => {});
  await run('PRAGMA busy_timeout = 5000').catch(() => {});

  // Original table (unchanged), so existing databases keep working.
  await exec(`CREATE TABLE IF NOT EXISTS vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    business_name TEXT NOT NULL,
    menu_data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    custom_domain TEXT
  )`);

  const vendorCols = [
    ['hashed_pin', 'TEXT'],            // legacy column used by the old onboarding route
    ['staff_pin_hash', 'TEXT'],
    ['owner_name', 'TEXT'],
    ['owner_ig', 'TEXT'],
    ['email', 'TEXT'],
    ['password_hash', 'TEXT'],
    ['email_verified', 'INTEGER DEFAULT 0'],
    ['status', "TEXT DEFAULT 'active'"], // active | pending | suspended
    ['plan', "TEXT DEFAULT 'free'"],
    ['plan_status', "TEXT DEFAULT 'active'"],
    ['past_due_since', 'INTEGER'],
    ['stripe_customer_id', 'TEXT'],
    ['stripe_subscription_id', 'TEXT'],
    ['emoji', 'TEXT'],
    ['theme_color', 'TEXT'],
    ['next_ticket', 'INTEGER DEFAULT 101'],
    ['updated_at', 'INTEGER'],
    ['terms_accepted_at', 'INTEGER'],
    ['hours_json', 'TEXT'],
    ['timezone', 'TEXT'],
    // Phase 3: online payments (Stripe Connect) and text alerts (Twilio)
    ['stripe_account_id', 'TEXT'],
    ['connect_charges_enabled', 'INTEGER DEFAULT 0'],
    ['pay_mode', "TEXT DEFAULT 'both'"],          // window | both | online (only used when online payments are on)
    ['owner_phone', 'TEXT'],
    ['owner_phone_pending', 'TEXT'],
    ['owner_phone_verified', 'INTEGER DEFAULT 0'],
    ['sms_owner_mode', "TEXT DEFAULT 'idle'"],     // off | idle (only when no kitchen screen is open) | always
    ['sms_customer_ready', 'INTEGER DEFAULT 1'],
    // Kitchen: a note the owner leaves for the crew ("no cilantro today"), shown on the kitchen screen.
    ['crew_note', 'TEXT'],
    ['crew_note_at', 'INTEGER'],
  ];
  for (const [c, d] of vendorCols) await addColumn('vendors', c, d);

  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_email ON vendors(email)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_domain ON vendors(custom_domain)');
  await run('CREATE INDEX IF NOT EXISTS idx_vendors_stripe_customer ON vendors(stripe_customer_id)');

  await exec(`CREATE TABLE IF NOT EXISTS store_state (
    vendor_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'open',
    rush_minutes INTEGER NOT NULL DEFAULT 0,
    active_location TEXT NOT NULL DEFAULT ''
  )`);
  await addColumn('store_state', 'paused', 'INTEGER NOT NULL DEFAULT 0');
  // Honest wait: the owner's starting number for the day, an optional locked number, and when service began.
  await addColumn('store_state', 'wait_start', 'INTEGER');
  await addColumn('store_state', 'wait_lock', 'INTEGER');
  await addColumn('store_state', 'service_started_at', 'INTEGER');
  await exec(`CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_locations_vendor ON locations(vendor_id)');

  await exec(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL,
    ticket_no INTEGER NOT NULL,
    public_token TEXT UNIQUE NOT NULL,
    customer_name TEXT NOT NULL,
    items_json TEXT NOT NULL,
    notes TEXT,
    total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'Preparing',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_orders_vendor_status ON orders(vendor_id, status, created_at)');
  const orderCols = [
    ['payment_status', "TEXT DEFAULT 'window'"],  // window | pending | paid | refunded | expired
    ['stripe_session_id', 'TEXT'],
    ['stripe_payment_intent', 'TEXT'],
    ['customer_phone', 'TEXT'],                    // only kept until the order is closed
    ['client_key', 'TEXT'],                        // the checkout's own key: a double tap can't make two orders
    ['allergy', 'TEXT'],                           // what the customer is allergic to (shown in red in the kitchen)
    ['allergy_ack_at', 'INTEGER'],                 // when the crew confirmed they saw it (needed before Ready)
  ];
  for (const [c, d] of orderCols) await addColumn('orders', c, d);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_key ON orders(vendor_id, client_key) WHERE client_key IS NOT NULL');
  await exec(`CREATE TABLE IF NOT EXISTS sms_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await run('CREATE INDEX IF NOT EXISTS idx_sms_vendor_time ON sms_log(vendor_id, created_at)');

  await exec(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    vendor_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    vendor_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS stripe_events (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`);
  // Service record: every change to an order, who made it and when ("what happened to order 42?").
  await exec(`CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    event TEXT NOT NULL,               -- placed, ready, fulfilled, canceled, paid, refunded, expired
    actor TEXT NOT NULL,               -- customer, owner, staff, system
    at INTEGER NOT NULL
  )`);
  await exec('CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events (order_id)');
  await exec('CREATE INDEX IF NOT EXISTS idx_order_events_kind ON order_events (vendor_id, event, at)');

  // Catering: one playbook per truck (JSON, cleaned by public/catering-quote.js) and its bookings.
  await exec(`CREATE TABLE IF NOT EXISTS catering_settings (
    vendor_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS catering_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id INTEGER NOT NULL,
    public_token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,              -- requested, accepted, declined, canceled, expired
    event_date TEXT NOT NULL,          -- YYYY-MM-DD in the truck's time zone
    start_time TEXT NOT NULL,          -- HH:MM
    guests INTEGER NOT NULL,
    package_id TEXT NOT NULL,
    details TEXT NOT NULL,             -- JSON: package snapshot, choices, vegetarian, site answers, address, notes
    quote TEXT NOT NULL,               -- JSON: the itemized quote as accepted by the host (locked)
    total_cents INTEGER NOT NULL,
    host_name TEXT NOT NULL,
    host_email TEXT NOT NULL,
    host_phone TEXT,
    company TEXT,
    hold_expires_at INTEGER NOT NULL,
    expiry_notified INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await exec('CREATE INDEX IF NOT EXISTS idx_catering_vendor_date ON catering_bookings (vendor_id, event_date)');

  // Signups waiting for their 6-digit email code. Nothing (not even the web address) is claimed
  // until the code is entered; then the vendor row is created. One row per email.
  await exec(`CREATE TABLE IF NOT EXISTS pending_signups (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    data TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);

  // Existing vendors: carry their old PIN over as the staff PIN, and give them a state row.
  await run('UPDATE vendors SET staff_pin_hash = hashed_pin WHERE staff_pin_hash IS NULL AND hashed_pin IS NOT NULL');
  await run('INSERT OR IGNORE INTO store_state (vendor_id) SELECT id FROM vendors');
}

/* ---------- housekeeping ---------- */
// Orders nobody finished: "Ready" ones were almost certainly picked up, so they close as Fulfilled
// (keeping their original time, so they count toward the right day's sales). "Preparing" ones that
// are half a day old were never made, so they close as Canceled.
const READY_AUTO_CLOSE_MS = 3 * 60 * 60 * 1000;
const PREPARING_AUTO_CLOSE_MS = 12 * 60 * 60 * 1000;

const PENDING_PAYMENT_MS = 60 * 60 * 1000; // a card checkout nobody finished

async function autoCloseOrders() {
  const now = Date.now();
  const closed = [];
  closed.push(...(await all("UPDATE orders SET status = 'Fulfilled', customer_phone = NULL WHERE status = 'Ready' AND updated_at < ? RETURNING id, vendor_id, 'fulfilled' AS event", [now - READY_AUTO_CLOSE_MS])));
  // Paid orders are never auto-canceled (that would keep the money without making the food look like a refund);
  // they close as Fulfilled, and the owner can refund from their Stripe Dashboard if something went wrong.
  closed.push(...(await all("UPDATE orders SET status = 'Fulfilled', customer_phone = NULL WHERE status = 'Preparing' AND payment_status = 'paid' AND created_at < ? RETURNING id, vendor_id, 'fulfilled' AS event", [now - PREPARING_AUTO_CLOSE_MS])));
  closed.push(...(await all("UPDATE orders SET status = 'Canceled', customer_phone = NULL, updated_at = ? WHERE status = 'Preparing' AND payment_status != 'paid' AND created_at < ? RETURNING id, vendor_id, 'canceled' AS event", [now, now - PREPARING_AUTO_CLOSE_MS])));
  closed.push(...(await all("UPDATE orders SET status = 'Canceled', payment_status = 'expired', customer_phone = NULL, updated_at = ? WHERE status = 'Pending' AND created_at < ? RETURNING id, vendor_id, 'expired' AS event", [now, now - PENDING_PAYMENT_MS])));
  for (const o of closed) logOrderEvent(o.vendor_id, o.id, o.event, 'system');
  return closed.length;
}

/* ---------- nightly checks ---------- */
/** SQLite's own check of the database file. Returns 'ok' or a description of the damage. */
async function integrityCheck() {
  const rows = await all('PRAGMA quick_check');
  const msgs = rows.map((r) => Object.values(r)[0]);
  return msgs.length === 1 && msgs[0] === 'ok' ? 'ok' : msgs.slice(0, 10).join('; ');
}

// Less stored means less to protect. Old orders keep their items and totals (for sales history),
// but the customer's name and notes are cleared; old service-record lines are removed.
const RETENTION_MS = 400 * 24 * 60 * 60 * 1000; // about 13 months, so last year's same week still compares
async function applyRetention() {
  const cutoff = Date.now() - RETENTION_MS;
  const a = await run("UPDATE orders SET customer_name = 'Guest', notes = NULL, customer_phone = NULL WHERE created_at < ? AND (customer_name != 'Guest' OR notes IS NOT NULL OR customer_phone IS NOT NULL)", [cutoff]);
  const b = await run('DELETE FROM order_events WHERE at < ?', [cutoff]);
  return { ordersCleared: a.changes, eventsRemoved: b.changes };
}

/* ---------- order shape sent to the kitchen screen ---------- */
function orderShape(o) {
  let items = [];
  try { items = JSON.parse(o.items_json); } catch (e) {}
  return {
    id: o.id,
    ticket: o.ticket_no,
    token: o.public_token,
    name: o.customer_name,
    items,
    summary: items.map((i) => `${i.qty}x ${i.name}`).join(', '),
    notes: o.notes || '',
    total: o.total,
    status: o.status,
    payment: o.payment_status || 'window',
    textMe: !!o.customer_phone,
    allergy: o.allergy || '',
    allergyAck: !!o.allergy_ack_at,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

setInterval(() => {
  run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]).catch(() => {});
  run('DELETE FROM tokens WHERE expires_at < ?', [Date.now()]).catch(() => {});
  run('DELETE FROM pending_signups WHERE expires_at < ?', [Date.now()]).catch(() => {});
}, 60 * 60 * 1000).unref();
setInterval(() => { autoCloseOrders().catch((e) => console.error('Auto-close failed:', e.message)); }, 15 * 60 * 1000).unref();

module.exports = {
  ROOT_DOMAIN, UPLOAD_DIR, raw, run, get, all, exec,
  sha256, randomToken, orderTag, logOrderEvent,
  MAX_ITEMS, PLANS, effectivePlan, features,
  RESERVED_SLUGS, validateSlug,
  DEFAULT_MENU, normalizeItem, normalizeMenu, normalizeOptions, parseMenu, saveMenu, num, PHOTO_RE,
  normalizeHours, parseHours, validTimezone,
  getState,
  refreshWait,
  refreshAllWaits,
  WAIT_MAX,
  createToken, consumeToken,
  sseAdd, broadcast, disconnectVendor, closeAllStreams,
  ensureSchema, autoCloseOrders, orderShape, integrityCheck, applyRetention,
};
