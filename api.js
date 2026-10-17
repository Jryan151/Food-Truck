'use strict';
/**
 * api.js — public routes (menu, orders, live stream), owner/staff routes, admin routes.
 * The server is the single source of truth: prices are computed here, never trusted from the browser.
 */
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const auth = require('./auth');
const billing = require('./billing');
const payments = require('./payments');
const sms = require('./sms');
const catering = require('./catering');
const { run, get, all } = core;
const { requireVendor, requireRole, getSession, rateLimit } = auth;

const router = express.Router();
const ACTIVE = ['Preparing', 'Ready'];

/* ---------- shapes sent to browsers ---------- */
function publicMenu(v) {
  return core.parseMenu(v.menu_data);
}

const orderShape = core.orderShape;

/* =====================================================================
   PUBLIC
   ===================================================================== */
router.get('/plans', (req, res) => {
  res.json({
    plans: core.PLANS,
    maxItems: core.MAX_ITEMS,
    pro: { price: process.env.PRO_PRICE_DISPLAY || '$34.99/mo' },
    // Free beta: on until Pro billing is set up (or force it on with FREE_BETA=true).
    beta: process.env.FREE_BETA === 'true' || !(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
  });
});

// For an uptime monitor (e.g. UptimeRobot): 200 only when the app and its database answer.
router.get('/health', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await get('SELECT 1 AS ok');
    res.json({ ok: true, time: Date.now() });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'database' });
  }
});

router.get('/vendor-data', async (req, res) => {
  const t = req.tenant;
  res.set('Cache-Control', 'no-store');
  if (t.isRoot) return res.json({ isDemo: true, message: 'Welcome to root' });
  const v = t.vendor;
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  if (v.status !== 'active') return res.status(503).json({ error: 'This page is not active.' });
  const f = core.features(v);
  res.json({
    isDemo: false,
    businessName: v.business_name,
    slug: v.slug,
    customDomain: v.custom_domain,
    ownerIG: v.owner_ig || '',
    emoji: v.emoji || '',
    menu: publicMenu(v),
    state: await core.getState(v.id),
    showBranding: !f.removeBranding,
    pinOnly: !v.password_hash, // older accounts created before email logins existed
    hours: core.parseHours(v.hours_json),
    timezone: v.timezone || '',
    payMode: payments.effectivePayMode(v),         // window | both | online
    smsReady: sms.enabledFor(v) && !!v.sms_customer_ready, // show the "text me when it's ready" box
    cateringEnabled: await catering.isEnabled(v.id),   // show the Catering link
  });
});

// Caddy "ask" endpoint: only issue SSL certificates for real, active vendors.
router.get('/check-domain', async (req, res) => {
  const domain = String(req.query.domain || '').toLowerCase().trim();
  if (!domain) return res.sendStatus(400);
  const root = core.ROOT_DOMAIN;
  if (domain === root || domain === 'www.' + root) return res.sendStatus(200);
  if (domain.endsWith('.' + root)) {
    const slug = domain.slice(0, -(root.length + 1));
    const v = await get('SELECT status FROM vendors WHERE slug = ?', [slug]);
    return res.sendStatus(v && v.status === 'active' ? 200 : 404);
  }
  const v = await get('SELECT * FROM vendors WHERE custom_domain = ?', [domain]);
  res.sendStatus(v && v.status === 'active' && core.features(v).customDomain ? 200 : 404);
});

// Live updates. Everyone gets store/menu changes; only logged-in staff also get customer orders.
router.get('/live-stream', async (req, res) => {
  const v = req.tenant.vendor;
  if (!v || v.status !== 'active') return res.sendStatus(204); // 204 tells EventSource to stop retrying
  const s = await getSession(req);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const remove = core.sseAdd(v.id, res, !!s);
  // Send the current state immediately so a new visitor never sees stale open/closed info.
  res.write(`data: ${JSON.stringify({ type: 'STATE', payload: await core.getState(v.id) })}\n\n`);
  req.on('close', remove);
});

// Keyed per truck + IP: at a busy event many phones share one carrier IP, so a per-IP limit
// across all trucks would block real customers. 60 orders per 10 minutes per IP per truck.
const limitOrders = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  key: (req) => `${req.tenant && req.tenant.vendor ? req.tenant.vendor.id : 'root'}:${req.ip || 'unknown'}`,
});

router.post('/orders', limitOrders, requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  // Honeypot: real customers never see or fill the hidden "website" field; bots fill every field.
  if (b.website) return res.status(400).json({ error: 'Could not place your order. Please try again.' });
  const state = await core.getState(v.id);
  if (state.status === 'closed') return res.status(403).json({ error: 'Sorry, we are closed right now.' });
  if (state.paused) return res.status(403).json({ error: 'Online ordering is paused right now. Please order at the window.' });

  const menu = core.parseMenu(v.menu_data);
  const byId = new Map(menu.map((m) => [m.id, m]));
  const lines = Array.isArray(b.items) ? b.items.slice(0, 30) : [];
  if (!lines.length) return res.status(400).json({ error: 'Your cart is empty.' });

  const items = [];
  let total = 0;
  let prepMinutes = 0;
  for (const l of lines) {
    const item = byId.get(parseInt(l && l.id, 10));
    const qty = parseInt(l && l.qty, 10);
    if (!item) return res.status(400).json({ error: 'An item in your cart is no longer on the menu.' });
    if (item.soldOut) return res.status(409).json({ error: `${item.name} is sold out.` });
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) return res.status(400).json({ error: 'Invalid quantity.' });

    let label = item.name;
    let unit = item.salePrice && item.salePrice > 0 ? item.salePrice : item.price;
    if (item.meats) {
      const choices = item.meats.split(',').map((m) => m.trim()).filter(Boolean);
      const idx = l.meat ? choices.indexOf(String(l.meat)) : 0;
      if (idx < 0) return res.status(400).json({ error: 'Invalid option selected.' });
      if (idx > 0) unit += item.premiumSurcharge;
      if (choices[idx]) label += ` (${choices[idx]})`;
    }
    if (item.options.length && l.option) {
      if (!item.options.includes(String(l.option))) return res.status(400).json({ error: 'Invalid option selected.' });
      label += ` (${l.option})`;
    }
    unit = Math.round(unit * 100) / 100;
    items.push({ id: item.id, name: label, qty, price: unit });
    total += unit * qty;
    prepMinutes += item.prep * qty;
  }
  total = Math.round(total * 100) / 100;
  if (total > 5000) return res.status(400).json({ error: 'Order is too large. Please call us.' });

  const name = String(b.customerName || '').trim().slice(0, 40) || 'Guest';
  const notes = String(b.notes || '').trim().slice(0, 300);

  // How they're paying. Free trucks (and Pro trucks without Stripe connected) are window-only.
  const payMode = payments.effectivePayMode(v);
  const payNow = b.payNow === true;
  if (payNow && payMode === 'window') return res.status(400).json({ error: 'This truck takes payment at the window.' });
  if (!payNow && payMode === 'online') return res.status(400).json({ error: 'This truck takes card payment when you order.' });

  // "Text me when it's ready" — only with the box ticked, and only if the truck has texts on.
  let phone = null;
  if (b.customerPhone && b.smsConsent === true && sms.enabledFor(v) && v.sms_customer_ready) {
    phone = sms.normalizePhone(b.customerPhone);
    if (!phone) return res.status(400).json({ error: 'Please enter a 10-digit US mobile number, or leave it blank.' });
  }

  // Double-tap proof: the checkout sends its own key. If an order with that key already exists
  // (a second tap, or a retry after the signal dropped), send back that same order instead of a new one.
  const clientKey = /^[A-Za-z0-9_-]{8,64}$/.test(String(b.clientKey || '')) ? String(b.clientKey) : null;
  const sameOrder = async () => {
    const o = clientKey && (await get('SELECT * FROM orders WHERE vendor_id = ? AND client_key = ?', [v.id, clientKey]));
    if (!o) return false;
    if (o.payment_status === 'pending') {
      res.status(409).json({ error: 'This order is already waiting for payment. Finish paying in the other tab, or refresh the page.' });
      return true;
    }
    res.status(200).json({ ticket: o.ticket_no, token: o.public_token, tag: core.orderTag(o.public_token), status: o.status, total: o.total, estimatedMinutes: prepMinutes + (state.rush || 0), repeat: true });
    return true;
  };
  if (await sameOrder()) return;

  // Atomic per-vendor ticket counter.
  const row = await get('UPDATE vendors SET next_ticket = COALESCE(next_ticket, 101) + 1 WHERE id = ? RETURNING next_ticket - 1 AS ticket', [v.id]);
  const now = Date.now();
  const token = core.randomToken(12);
  let r;
  try {
    r = await run(
      `INSERT INTO orders (vendor_id, ticket_no, public_token, customer_name, items_json, notes, total, status, payment_status, customer_phone, client_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [v.id, row.ticket, token, name, JSON.stringify(items), notes, total, payNow ? 'Pending' : 'Preparing', payNow ? 'pending' : 'window', phone, clientKey, now, now]
    );
  } catch (err) {
    // Two taps arrived at the same instant: the first one won, so answer with its order.
    if (err.code === 'SQLITE_CONSTRAINT' && clientKey && (await sameOrder())) return;
    throw err;
  }
  const orderRow = await get('SELECT * FROM orders WHERE id = ?', [r.lastID]);
  core.logOrderEvent(v.id, orderRow.id, 'placed', 'customer');
  const reply = {
    ticket: orderRow.ticket_no,
    token,
    tag: core.orderTag(token),
    status: orderRow.status,
    total,
    estimatedMinutes: prepMinutes + (state.rush || 0),
  };

  if (payNow) {
    // Not shown in the kitchen until Stripe says it's paid.
    try {
      const session = await payments.createCheckout(v, orderRow, `${req.secure ? 'https' : 'http'}://${req.tenant.host}`);
      return res.status(201).json({ ...reply, checkoutUrl: session.url });
    } catch (e) {
      console.error('Checkout create failed:', e.message);
      await payments.cancelPending(orderRow, 'failed');
      return res.status(502).json({ error: 'Card payment is not available right now. Please try again or pay at the window.' });
    }
  }

  await sms.notifyNewOrder(v.id, orderShape(orderRow));
  res.status(201).json(reply);
});

// A customer's page asks for the current status of its own orders (by secret token).
router.get('/orders/track', requireVendor, async (req, res) => {
  const tokens = String(req.query.tokens || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20);
  if (!tokens.length) return res.json({ orders: [] });
  const rows = await all(
    `SELECT ticket_no, public_token, customer_name, status, payment_status FROM orders
     WHERE vendor_id = ? AND public_token IN (${tokens.map(() => '?').join(',')})`,
    [req.tenant.vendor.id, ...tokens]
  );
  res.json({ orders: rows.map((o) => ({ ticket: o.ticket_no, token: o.public_token, name: o.customer_name, status: o.status, payment: o.payment_status })) });
});

/* =====================================================================
   OWNER + STAFF  (staff = PIN login, kitchen screen)
   ===================================================================== */
const staffOrOwner = [requireVendor, requireRole('owner', 'staff')];
const ownerOnly = [requireVendor, requireRole('owner')];

router.get('/owner/orders', staffOrOwner, async (req, res) => {
  const filter = String(req.query.status || 'Active');
  const vid = req.tenant.vendor.id;
  let rows;
  if (filter === 'Fulfilled' || filter === 'Canceled') {
    rows = await all('SELECT * FROM orders WHERE vendor_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 100', [vid, filter]);
  } else {
    rows = await all("SELECT * FROM orders WHERE vendor_id = ? AND status IN ('Preparing','Ready') ORDER BY created_at ASC LIMIT 200", [vid]);
  }
  res.json({ orders: rows.map(orderShape) });
});

router.patch('/owner/orders/:id', staffOrOwner, async (req, res) => {
  const v = req.tenant.vendor;
  const action = String((req.body || {}).action || '');
  const next = { ready: 'Ready', fulfill: 'Fulfilled', cancel: 'Canceled' }[action];
  if (!next) return res.status(400).json({ error: 'Unknown action.' });
  // 'ready' is only valid from Preparing; fulfill/cancel from any open state.
  const from = action === 'ready' ? ['Preparing'] : ACTIVE;
  const id = parseInt(req.params.id, 10);
  const existing = await get(`SELECT * FROM orders WHERE id = ? AND vendor_id = ? AND status IN (${from.map(() => '?').join(',')})`, [id, v.id, ...from]);
  if (!existing) return res.status(409).json({ error: 'That order cannot be changed.' });

  // Canceling an order that was paid online refunds the card first. If the refund fails, nothing changes.
  if (action === 'cancel' && existing.payment_status === 'paid') {
    if (req.session.role !== 'owner') return res.status(403).json({ error: 'Only the owner can cancel a paid order (it refunds the card).' });
    const rf = await payments.refundOrder(v, existing);
    if (!rf.ok) return res.status(502).json({ error: rf.error });
  }
  const closing = next !== 'Ready';
  const row = await get(
    `UPDATE orders SET status = ?, updated_at = ?${closing ? ', customer_phone = NULL' : ''} WHERE id = ? AND vendor_id = ? AND status IN (${from.map(() => '?').join(',')}) RETURNING *`,
    [next, Date.now(), id, v.id, ...from]
  );
  if (!row) return res.status(409).json({ error: 'That order cannot be changed.' });
  core.logOrderEvent(v.id, row.id, next.toLowerCase(), req.session.role);
  if (next === 'Ready') sms.notifyReady(v, existing).catch(() => {});
  const order = orderShape(row);
  core.broadcast(v.id, 'ORDER_UPDATE', order, true);
  // Customers match by a tag derived from their secret token — the token itself is never broadcast.
  core.broadcast(v.id, 'ORDER_STATUS', { tag: core.orderTag(order.token), status: order.status });
  res.json({ order });
});

router.get('/owner/state', staffOrOwner, async (req, res) => {
  res.json(await core.getState(req.tenant.vendor.id));
});

router.put('/owner/state', staffOrOwner, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  const role = req.session.role;
  if (b.status !== undefined) {
    if (!['open', 'closed'].includes(b.status)) return res.status(400).json({ error: 'Invalid status.' });
    await run('UPDATE store_state SET status = ? WHERE vendor_id = ?', [b.status, v.id]);
    core.broadcast(v.id, 'STORE_STATUS', { status: b.status });
  }
  if (b.paused !== undefined) {
    const paused = b.paused ? 1 : 0;
    await run('UPDATE store_state SET paused = ? WHERE vendor_id = ?', [paused, v.id]);
    core.broadcast(v.id, 'PAUSED', { paused: !!paused });
  }
  if (b.rush !== undefined) {
    const rush = parseInt(b.rush, 10);
    if (![0, 15, 30].includes(rush)) return res.status(400).json({ error: 'Invalid rush value.' });
    await run('UPDATE store_state SET rush_minutes = ? WHERE vendor_id = ?', [rush, v.id]);
    core.broadcast(v.id, 'RUSH_MODE', { minutes: rush });
  }
  if (b.location !== undefined) {
    if (role !== 'owner') return res.status(403).json({ error: 'Owner access required.' });
    const loc = String(b.location || '').trim().slice(0, 80);
    if (loc) {
      const ok = await get('SELECT id FROM locations WHERE vendor_id = ? AND name = ? AND deleted = 0', [v.id, loc]);
      if (!ok) return res.status(400).json({ error: 'Unknown location.' });
    }
    await run('UPDATE store_state SET active_location = ? WHERE vendor_id = ?', [loc, v.id]);
    core.broadcast(v.id, 'LOCATION_UPDATE', { location: loc });
  }
  res.json(await core.getState(v.id));
});

/* ----- menu photos ----- */
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_PHOTO_FILES = 250; // per vendor, including ones not on the menu yet

function isImage(buf, ext) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (ext === 'jpg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === 'png') return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === 'webp') return buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
  return false;
}

async function vendorPhotoFiles(vendorId) {
  try {
    const names = await fs.promises.readdir(core.UPLOAD_DIR);
    return names.filter((n) => n.startsWith(vendorId + '-'));
  } catch (e) { return []; }
}

/** Deletes this vendor's photo files that no menu item uses (older than an hour, so a fresh upload isn't lost). */
async function cleanupPhotos(vendorId, menu, { all: removeAll = false } = {}) {
  const used = new Set((menu || []).map((m) => m.photo).filter(Boolean).map((p) => path.basename(p)));
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of await vendorPhotoFiles(vendorId)) {
    if (!removeAll && used.has(name)) continue;
    const file = path.join(core.UPLOAD_DIR, name);
    try {
      if (!removeAll && (await fs.promises.stat(file)).mtimeMs > cutoff) continue;
      await fs.promises.unlink(file);
    } catch (e) { /* already gone */ }
  }
}

// The browser shrinks photos to ~800px before uploading, so 2 MB is plenty.
router.post('/owner/upload', ownerOnly, express.raw({ type: Object.keys(PHOTO_TYPES), limit: '2mb' }), async (req, res) => {
  const v = req.tenant.vendor;
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = PHOTO_TYPES[type];
  if (!ext) return res.status(415).json({ error: 'Please upload a JPG, PNG or WebP photo.' });
  if (!isImage(req.body, ext)) return res.status(400).json({ error: 'That file does not look like a photo.' });
  if ((await vendorPhotoFiles(v.id)).length >= MAX_PHOTO_FILES) {
    await cleanupPhotos(v.id, core.parseMenu((await get('SELECT menu_data FROM vendors WHERE id = ?', [v.id])).menu_data));
    if ((await vendorPhotoFiles(v.id)).length >= MAX_PHOTO_FILES) return res.status(400).json({ error: 'Too many photos. Remove some from your menu first.' });
  }
  await fs.promises.mkdir(core.UPLOAD_DIR, { recursive: true });
  const name = `${v.id}-${core.randomToken(8)}.${ext}`;
  await fs.promises.writeFile(path.join(core.UPLOAD_DIR, name), req.body);
  res.status(201).json({ url: '/uploads/' + name });
});

/* ----- menu ----- */
router.get('/owner/menu', staffOrOwner, async (req, res) => {
  res.json({ menu: core.parseMenu(req.tenant.vendor.menu_data), maxItems: core.MAX_ITEMS });
});

router.patch('/owner/menu/:id/soldout', staffOrOwner, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const menu = core.parseMenu(v.menu_data);
  const item = menu.find((m) => m.id === parseInt(req.params.id, 10));
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  item.soldOut = !!(req.body || {}).soldOut;
  await core.saveMenu(v.id, menu);
  core.broadcast(v.id, 'SOLD_OUT', { itemId: item.id, soldOut: item.soldOut });
  res.json({ item });
});

router.post('/owner/menu', ownerOnly, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const menu = core.parseMenu(v.menu_data);
  if (menu.length >= core.MAX_ITEMS) {
    return res.status(400).json({ error: `Menus can have up to ${core.MAX_ITEMS} items. Remove one to add another.` });
  }
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Item name is required.' });
  if (b.photo && !String(b.photo).startsWith(`/uploads/${v.id}-`)) delete b.photo;
  const nextId = menu.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  const item = core.normalizeItem({ ...b, soldOut: false }, nextId);
  menu.push(item);
  await core.saveMenu(v.id, menu);
  core.broadcast(v.id, 'MENU_UPDATE', { menu });
  res.status(201).json({ item, menu });
});

router.put('/owner/menu/:id', ownerOnly, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const menu = core.parseMenu(v.menu_data);
  const idx = menu.findIndex((m) => m.id === parseInt(req.params.id, 10));
  if (idx < 0) return res.status(404).json({ error: 'Item not found.' });
  const b = req.body || {};
  // A photo can only be one this vendor uploaded.
  if (b.photo && !String(b.photo).startsWith(`/uploads/${v.id}-`)) delete b.photo;
  menu[idx] = core.normalizeItem({ ...menu[idx], ...b, id: menu[idx].id, soldOut: menu[idx].soldOut }, menu[idx].id);
  await core.saveMenu(v.id, menu);
  core.broadcast(v.id, 'MENU_UPDATE', { menu });
  res.json({ item: menu[idx], menu });
  cleanupPhotos(v.id, menu).catch(() => {});
});

// Reorder: body { ids: [3, 1, 2, ...] } — must contain every item exactly once.
router.put('/owner/menu-order', ownerOnly, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const menu = core.parseMenu(v.menu_data);
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map((x) => parseInt(x, 10)) : [];
  const byId = new Map(menu.map((m) => [m.id, m]));
  if (ids.length !== menu.length || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
    return res.status(409).json({ error: 'Your menu changed on another screen. Refresh and try again.' });
  }
  const next = ids.map((id) => byId.get(id));
  await core.saveMenu(v.id, next);
  core.broadcast(v.id, 'MENU_UPDATE', { menu: next });
  res.json({ menu: next });
});

router.delete('/owner/menu/:id', ownerOnly, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const menu = core.parseMenu(v.menu_data);
  const next = menu.filter((m) => m.id !== parseInt(req.params.id, 10));
  if (next.length === menu.length) return res.status(404).json({ error: 'Item not found.' });
  await core.saveMenu(v.id, next);
  core.broadcast(v.id, 'MENU_UPDATE', { menu: next });
  res.json({ menu: next });
  cleanupPhotos(v.id, next).catch(() => {});
});

/* ----- posted hours ----- */
router.put('/owner/hours', ownerOnly, async (req, res) => {
  const b = req.body || {};
  const hours = core.normalizeHours(b.hours);
  if (!hours) return res.status(400).json({ error: 'Please fill in all seven days.' });
  const tz = core.validTimezone(b.timezone);
  if (!tz) return res.status(400).json({ error: 'Unknown time zone.' });
  await run('UPDATE vendors SET hours_json = ?, timezone = ?, updated_at = ? WHERE id = ?', [JSON.stringify(hours), tz, Date.now(), req.tenant.vendor.id]);
  core.broadcast(req.tenant.vendor.id, 'HOURS_UPDATE', { hours, timezone: tz });
  res.json({ hours, timezone: tz });
});

/* ----- order export (CSV for bookkeeping) ----- */
// Spreadsheet apps run cells that start with = + - @ as formulas; prefix those so a customer
// name can't become a formula on the owner's computer.
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

router.get('/owner/orders/export.csv', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const now = Date.now();
  const from = parseInt(req.query.from, 10) || now - 30 * 24 * 60 * 60 * 1000;
  const to = parseInt(req.query.to, 10) || now;
  const tz = core.validTimezone(req.query.tz) || v.timezone || 'UTC';
  const rows = await all('SELECT * FROM orders WHERE vendor_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC LIMIT 50000', [v.id, from, to]);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const lines = [['Ticket', 'Date & time (' + tz + ')', 'Customer', 'Items', 'Notes', 'Total', 'Status'].map(csvCell).join(',')];
  for (const r of rows) {
    const o = orderShape(r);
    lines.push([o.ticket, fmt.format(new Date(o.createdAt)).replace(',', ''), o.name, o.summary, o.notes, o.total.toFixed(2), o.status].map(csvCell).join(','));
  }
  const day = new Date().toISOString().slice(0, 10);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${v.slug}-orders-${day}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.send('\ufeff' + lines.join('\r\n') + '\r\n'); // BOM so Excel reads accents correctly
});

/* ----- locations ----- */
router.get('/owner/locations', ownerOnly, async (req, res) => {
  const rows = await all('SELECT id, name, deleted FROM locations WHERE vendor_id = ? ORDER BY id', [req.tenant.vendor.id]);
  res.json({
    active: rows.filter((r) => !r.deleted).map((r) => ({ id: r.id, name: r.name })),
    deleted: rows.filter((r) => r.deleted).map((r) => ({ id: r.id, name: r.name })),
  });
});

router.post('/owner/locations', ownerOnly, async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Location name is required.' });
  const count = await get('SELECT COUNT(*) AS n FROM locations WHERE vendor_id = ? AND deleted = 0', [req.tenant.vendor.id]);
  if (count.n >= 50) return res.status(400).json({ error: 'Location limit reached.' });
  const r = await run('INSERT INTO locations (vendor_id, name) VALUES (?, ?)', [req.tenant.vendor.id, name]);
  res.status(201).json({ id: r.lastID, name });
});

router.delete('/owner/locations/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const id = parseInt(req.params.id, 10);
  const row = await get('SELECT name FROM locations WHERE id = ? AND vendor_id = ?', [id, v.id]);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  await run('UPDATE locations SET deleted = 1 WHERE id = ? AND vendor_id = ?', [id, v.id]);
  const st = await core.getState(v.id);
  if (st.location === row.name) {
    await run("UPDATE store_state SET active_location = '' WHERE vendor_id = ?", [v.id]);
    core.broadcast(v.id, 'LOCATION_UPDATE', { location: '' });
  }
  res.json({ ok: true });
});

router.post('/owner/locations/:id/restore', ownerOnly, async (req, res) => {
  const r = await run('UPDATE locations SET deleted = 0 WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), req.tenant.vendor.id]);
  if (!r.changes) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

/* ----- analytics (client passes the start of its local day) ----- */
router.get('/owner/analytics', ownerOnly, async (req, res) => {
  const since = parseInt(req.query.since, 10) || Date.now() - 24 * 60 * 60 * 1000;
  const rows = await all("SELECT items_json, total FROM orders WHERE vendor_id = ? AND status = 'Fulfilled' AND updated_at >= ?", [req.tenant.vendor.id, since]);
  const revenue = rows.reduce((s, r) => s + r.total, 0);
  const counts = new Map();
  for (const r of rows) {
    try {
      for (const i of JSON.parse(r.items_json)) {
        const base = String(i.name).replace(/ \(.*\)$/, '');
        counts.set(base, (counts.get(base) || 0) + i.qty);
      }
    } catch (e) {}
  }
  let top = null;
  for (const [k, n] of counts) if (!top || n > top.qty) top = { name: k, qty: n };
  res.json({
    revenue: Math.round(revenue * 100) / 100,
    orders: rows.length,
    avgOrder: rows.length ? Math.round((revenue / rows.length) * 100) / 100 : 0,
    topItem: top ? top.name : null,
  });
});

// The service record for one order: every change, who made it, and when.
router.get('/owner/orders/:id/history', staffOrOwner, async (req, res) => {
  const v = req.tenant.vendor;
  const id = parseInt(req.params.id, 10);
  const o = await get('SELECT id, ticket_no, created_at FROM orders WHERE id = ? AND vendor_id = ?', [id, v.id]);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  const events = await all('SELECT event, actor, at FROM order_events WHERE order_id = ? AND vendor_id = ? ORDER BY at, id', [id, v.id]);
  res.json({ ticket: o.ticket_no, events: events.length ? events : [{ event: 'placed', actor: 'customer', at: o.created_at }] });
});

router.delete('/owner/orders', ownerOnly, async (req, res) => {
  await run("DELETE FROM orders WHERE vendor_id = ? AND status IN ('Fulfilled','Canceled')", [req.tenant.vendor.id]);
  res.json({ ok: true });
});

/* ----- profile + security ----- */
router.put('/owner/profile', ownerOnly, async (req, res) => {
  const b = req.body || {};
  const v = req.tenant.vendor;
  const name = b.businessName !== undefined ? String(b.businessName).trim() : v.business_name;
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Business name must be 2-60 characters.' });
  await run('UPDATE vendors SET business_name = ?, owner_ig = ?, emoji = ?, owner_name = ?, updated_at = ? WHERE id = ?', [
    name,
    b.ownerIG !== undefined ? auth.cleanIG(b.ownerIG) : v.owner_ig,
    b.emoji !== undefined ? String(b.emoji).slice(0, 8) : v.emoji,
    b.ownerName !== undefined ? String(b.ownerName).trim().slice(0, 60) : v.owner_name,
    Date.now(), v.id,
  ]);
  res.json({ ok: true });
});

router.put('/owner/staff-pin', ownerOnly, async (req, res) => {
  const pin = String((req.body || {}).pin || '').trim();
  if (!auth.PIN_RE.test(pin)) return res.status(400).json({ error: 'PIN must be 4-8 letters or numbers.' });
  await run('UPDATE vendors SET staff_pin_hash = ?, updated_at = ? WHERE id = ?', [await bcrypt.hash(pin, 10), Date.now(), req.tenant.vendor.id]);
  await run("DELETE FROM sessions WHERE vendor_id = ? AND role = 'staff'", [req.tenant.vendor.id]); // old staff logins stop working
  res.json({ ok: true });
});

router.put('/owner/password', ownerOnly, async (req, res) => {
  const b = req.body || {};
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const next = String(b.newPassword || '');
  if (next.length < 8 || next.length > 72) return res.status(400).json({ error: 'New password must be 8-72 characters.' });
  if (v.password_hash && !(await bcrypt.compare(String(b.currentPassword || '').slice(0, 72), v.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!v.password_hash) {
    // Legacy PIN-only vendor adding an email + password for the first time.
    const email = String(b.email || '').trim().toLowerCase();
    if (!auth.EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
    try { await run('UPDATE vendors SET email = ? WHERE id = ?', [email, v.id]); }
    catch (e) { return res.status(409).json({ error: 'That email is already used.' }); }
  }
  await run('UPDATE vendors SET password_hash = ?, updated_at = ? WHERE id = ?', [await bcrypt.hash(next, 10), Date.now(), v.id]);
  // Sign out every other owner login (like a password reset does), but keep this device signed in.
  // Staff kitchen logins use the PIN, not the password, so they stay signed in.
  await run("DELETE FROM sessions WHERE vendor_id = ? AND role = 'owner' AND token_hash != ?", [
    v.id, core.sha256(auth.requestToken(req)),
  ]);
  res.json({ ok: true, signedOutOthers: true });
});

const limitSensitive = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// Change login email. Needs the current password; the old address gets a heads-up email.
router.put('/owner/email', ownerOnly, limitSensitive, async (req, res) => {
  const b = req.body || {};
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  if (!v.password_hash) return res.status(400).json({ error: 'Set a password first (below), then you can change your email.' });
  if (!(await bcrypt.compare(String(b.currentPassword || '').slice(0, 72), v.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const email = String(b.newEmail || '').trim().toLowerCase();
  if (!auth.EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (email === v.email) return res.status(400).json({ error: 'That is already your email.' });
  try {
    await run('UPDATE vendors SET email = ?, email_verified = 0, updated_at = ? WHERE id = ?', [email, Date.now(), v.id]);
  } catch (e) {
    return res.status(409).json({ error: 'That email is already used by another account.' });
  }
  if (v.email) {
    await auth.sendMail({
      to: v.email,
      subject: 'Your login email was changed',
      text: `The login email for ${v.business_name} was changed to ${email}. If you didn't do this, reply to this email right away.`,
      html: `<p>The login email for <b>${auth.escHtml(v.business_name)}</b> was changed to <b>${auth.escHtml(email)}</b>.</p><p>If you didn't do this, reply to this email right away.</p>`,
    });
  }
  res.json({ ok: true, email });
});

// Permanently delete the account and everything in it. Cancels Pro first so they aren't billed again.
router.post('/owner/account/delete', ownerOnly, limitSensitive, async (req, res) => {
  const b = req.body || {};
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  if (String(b.confirm || '') !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
  if (v.password_hash) {
    if (!(await bcrypt.compare(String(b.password || '').slice(0, 72), v.password_hash))) {
      return res.status(401).json({ error: 'Password is incorrect.' });
    }
  }
  const c = await billing.cancelSubscription(v);
  if (!c.ok) return res.status(502).json({ error: c.error });

  // The vendor row goes first so the page stops working immediately; the rest is cleanup.
  // (No BEGIN/COMMIT: the app shares one SQLite connection, so a transaction here could swallow
  // other customers' requests. Every delete below is safe to repeat.)
  await run('DELETE FROM vendors WHERE id = ?', [v.id]);
  for (const t of ['sessions', 'tokens', 'orders', 'locations', 'store_state']) {
    await run(`DELETE FROM ${t} WHERE vendor_id = ?`, [v.id]);
  }
  core.disconnectVendor(v.id);
  cleanupPhotos(v.id, [], { all: true }).catch(() => {});
  auth.clearSessionCookie(res);
  if (v.email) {
    await auth.sendMail({
      to: v.email,
      subject: 'Your account was deleted',
      text: `${v.business_name} and all of its data have been deleted. Thanks for trying us out.`,
      html: `<p><b>${auth.escHtml(v.business_name)}</b> and all of its data have been deleted. Thanks for trying us out.</p>`,
    });
  }
  res.json({ ok: true, redirect: `${process.env.PUBLIC_SCHEME || 'https'}://${core.ROOT_DOMAIN}/` });
});

/* =====================================================================
   ADMIN (you). Set ADMIN_TOKEN in .env to enable. Send it as the x-admin-token header.
   ===================================================================== */
function requireAdmin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(404).json({ error: 'Not found' });
  const given = String(req.headers['x-admin-token'] || '');
  const a = Buffer.from(given), b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.get('/admin/vendors', requireAdmin, async (req, res) => {
  const rows = await all(
    'SELECT id, slug, business_name, email, status, plan, plan_status, email_verified, custom_domain, created_at FROM vendors ORDER BY id DESC LIMIT 500'
  );
  res.json({ vendors: rows });
});

router.post('/admin/vendors/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const sets = [], params = [];
  if (b.status !== undefined) {
    if (!['active', 'pending', 'suspended'].includes(b.status)) return res.status(400).json({ error: 'Bad status.' });
    sets.push('status = ?'); params.push(b.status);
  }
  if (b.plan !== undefined) {
    if (!core.PLANS[b.plan]) return res.status(400).json({ error: 'Bad plan.' });
    sets.push('plan = ?', "plan_status = 'active'"); params.push(b.plan);
  }
  if (b.customDomain !== undefined) {
    // "" or null removes it. Otherwise a bare hostname like order.mytruck.com (no https://, no path).
    let d = b.customDomain == null ? '' : String(b.customDomain).toLowerCase().trim().replace(/\.$/, '');
    if (d && (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d) || d === core.ROOT_DOMAIN || d.endsWith('.' + core.ROOT_DOMAIN))) {
      return res.status(400).json({ error: 'Use a bare hostname like order.mytruck.com that is not on ' + core.ROOT_DOMAIN + '.' });
    }
    if (d) {
      const taken = await get('SELECT id FROM vendors WHERE custom_domain = ? AND id != ?', [d, parseInt(req.params.id, 10)]);
      if (taken) return res.status(409).json({ error: 'Another truck already uses that domain.' });
    }
    sets.push('custom_domain = ?'); params.push(d || null);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  params.push(parseInt(req.params.id, 10));
  const r = await run(`UPDATE vendors SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ ok: r.changes > 0 });
});

module.exports = { router, orderShape };
