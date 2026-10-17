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
const Insights = require('./public/insights-core');
const schedule = require('./schedule');
const Deals = require('./public/deals-core');
const rewards = require('./rewards');
const inventory = require('./inventory');
const { run, get, all } = core;
const { requireVendor, requireRole, getSession, rateLimit } = auth;

const router = express.Router();
const ACTIVE = ['Preparing', 'Ready'];

/* ---------- shapes sent to browsers ---------- */
// The menu as it really is (sold out by hand, out of stock, or missing an ingredient). Owners get counts.
const publicMenu = (v) => inventory.menuFor(v);
const ownerMenu = async (vendorId) => inventory.menuFor(await get('SELECT * FROM vendors WHERE id = ?', [vendorId]), { owner: true });

const orderShape = core.orderShape;
// Who did it, for the service record: the crew member's name when they have their own PIN.
const actorOf = (req) => (req.session && req.session.staff_name ? req.session.staff_name : (req.session && req.session.role) || 'staff');

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

// Pro features stay on for everyone during the free beta.
const proOpen = (v, key) => !!core.features(v)[key] || process.env.FREE_BETA === 'true' || !(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
function vendorDeals(v) {
  if (!proOpen(v, 'deals')) return [];
  try { return Deals.normalize(JSON.parse(v.deals_json || '[]')); } catch (e) { return []; }
}
const localParts = (v) => Insights.parts(Date.now(), Insights.validTz(v.timezone));

async function nextStop(v) {
  try {
    const list = await schedule.upcoming(v.id, Insights.validTz(v.timezone), 30);
    const s = list[0];
    return s ? { day: s.day, start: s.start, end: s.end, location: s.location, startsAt: s.startsAt, endsAt: s.endsAt, more: list.length - 1 } : null;
  } catch (e) { return null; }
}

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
    menu: await publicMenu(v),
    state: await core.getState(v.id),
    showBranding: !f.removeBranding,
    pinOnly: !v.password_hash, // older accounts created before email logins existed
    hours: core.parseHours(v.hours_json),
    timezone: v.timezone || '',
    payMode: payments.effectivePayMode(v),         // window | both | online
    smsReady: sms.enabledFor(v) && !!v.sms_customer_ready, // show the "text me when it's ready" box
    cateringEnabled: await catering.isEnabled(v.id),   // show the Catering link
    nextStop: await nextStop(v),
    deals: vendorDeals(v).filter((d) => d.on),
    rewards: rewards.enabled(v) ? (({ name, every, capCents, minCents }) => ({ name, every, capCents, minCents }))(rewards.settings(v)) : null,          // happy hour: the page shows it, the server prices it                       // "Next: Fri 4 PM at Brewery Row" when closed
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
  const remove = core.sseAdd(v.id, res, !!s, s);
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

// The wait a customer is told: the honest kitchen number when there is one, otherwise the old
// sum-of-prep-times guess. Never shorter than what this order itself takes to cook.
function waitFor(state, prepMinutes) {
  const own = prepMinutes + (state.rush || 0);
  const live = state.wait && state.wait.minutes;
  return live ? Math.max(live, Math.min(prepMinutes, core.WAIT_MAX)) : own;
}

// Customers get a short window to cancel (or change: cancel and reorder) before the kitchen is
// committed. Only orders paid at the window: a paid order needs a refund, so that's done in person.
const CHANGE_WINDOW_MS = 2 * 60 * 1000;
const changeUntil = (o) => (o.payment_status === 'window' && o.status === 'Preparing' ? o.created_at + CHANGE_WINDOW_MS : 0);

router.post('/orders', limitOrders, requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  // Honeypot: real customers never see or fill the hidden "website" field; bots fill every field.
  if (b.website) return res.status(400).json({ error: 'Could not place your order. Please try again.' });
  const state = await core.getState(v.id);
  if (state.status === 'closed') return res.status(403).json({ error: 'Sorry, we are closed right now.' });
  if (state.paused) return res.status(403).json({ error: 'Online ordering is paused right now. Please order at the window.' });

  const menu = await inventory.menuFor(v, { owner: true });
  const byId = new Map(menu.map((m) => [m.id, m]));
  const lines = Array.isArray(b.items) ? b.items.slice(0, 30) : [];
  if (!lines.length) return res.status(400).json({ error: 'Your cart is empty.' });

  const items = [];
  let total = 0;
  let prepMinutes = 0;
  const dealsNow = Deals.active(vendorDeals(v), localParts(v));
  for (const l of lines) {
    const item = byId.get(parseInt(l && l.id, 10));
    const qty = parseInt(l && l.qty, 10);
    if (!item) return res.status(400).json({ error: 'An item in your cart is no longer on the menu.' });
    if (item.soldOut) return res.status(409).json({ error: `${item.name} is sold out.` });
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) return res.status(400).json({ error: 'Invalid quantity.' });
    const want = lines.reduce((n, x) => n + (parseInt(x && x.id, 10) === item.id ? parseInt(x.qty, 10) || 0 : 0), 0);
    if (item.left !== null && want > item.left) return res.status(409).json({ error: `Only ${item.left} ${item.name} left. Please lower the amount.`, stock: { itemId: item.id, left: item.left } });

    let label = item.name;
    let extra = 0;
    if (item.meats) {
      const choices = item.meats.split(',').map((m) => m.trim()).filter(Boolean);
      const idx = l.meat ? choices.indexOf(String(l.meat)) : 0;
      if (idx < 0) return res.status(400).json({ error: 'Invalid option selected.' });
      if (idx > 0) extra = item.premiumSurcharge;
      if (choices[idx]) label += ` (${choices[idx]})`;
    }
    // Lowest of regular, sale, or a deal running right now (never stacked).
    const priced = Deals.price(item, Math.round((item.price + extra) * 100), item.salePrice && item.salePrice > 0 ? Math.round((item.salePrice + extra) * 100) : null, dealsNow);
    let unit = priced.cents / 100;
    if (item.options.length && l.option) {
      if (!item.options.includes(String(l.option))) return res.status(400).json({ error: 'Invalid option selected.' });
      label += ` (${l.option})`;
    }
    unit = Math.round(unit * 100) / 100;
    items.push(Object.assign({ id: item.id, name: label, qty, price: unit }, priced.deal ? { deal: priced.deal } : {}));
    total += unit * qty;
    prepMinutes += item.prep * qty;
  }
  total = Math.round(total * 100) / 100;
  if (total > 5000) return res.status(400).json({ error: 'Order is too large. Please call us.' });
  // Punch card: what the free item would take off (nothing is spent until the order is really saved).
  const cardToken = String(b.cardToken || '');
  const useReward = b.useReward === true;
  const rp = await rewards.preview(v, { cardToken, useReward, items });
  if (rp.error) return res.status(rp.status).json({ error: rp.error, rewardGone: true });
  const due = Math.round(total * 100 - rp.rewardCents) / 100;
  // No surprises: if the price went up since the customer looked (a happy hour just ended), say so first.
  const seen = Number(b.seenTotal);
  if (Number.isFinite(seen) && due > seen + 0.004) {
    return res.status(409).json({ error: `Prices changed while you were ordering. Your total is now $${due.toFixed(2)}.`, priceChanged: true, total: due });
  }

  const name = String(b.customerName || '').trim().slice(0, 40) || 'Guest';
  const notes = String(b.notes || '').trim().slice(0, 300);
  const allergy = String(b.allergy || '').trim().slice(0, 120) || null;

  // How they're paying. Free trucks (and Pro trucks without Stripe connected) are window-only.
  const payMode = payments.effectivePayMode(v);
  const nothingDue = due <= 0; // a free item that covers the whole order: nothing to pay anywhere
  const payNow = b.payNow === true && !nothingDue;
  if (payNow && payMode === 'window') return res.status(400).json({ error: 'This truck takes payment at the window.' });
  if (!payNow && !nothingDue && payMode === 'online') return res.status(400).json({ error: 'This truck takes card payment when you order.' });

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
    res.status(200).json({ ticket: o.ticket_no, token: o.public_token, tag: core.orderTag(o.public_token), status: o.status, total: o.total, estimatedMinutes: waitFor(state, prepMinutes), changeUntil: changeUntil(o), now: Date.now(), repeat: true });
    return true;
  };
  if (await sameOrder()) return;

  // Now spend the reward for real (atomically) and give the customer a card if they don't have one yet.
  const rw = await rewards.atOrder(v, { cardToken, useReward, items });
  if (rw.error) return res.status(rw.status).json({ error: rw.error, rewardGone: true });
  total = Math.round(items.reduce((sum, it) => sum + Math.round(it.price * 100) * it.qty, 0)) / 100;
  // Take the stock last, all or nothing. If someone else just got the last one, say so plainly.
  const st = await inventory.take(v.id, items.map((it) => ({ id: it.id, qty: it.qty })));
  if (st.error) {
    await rewards.giveBack(rw.cardId, rw.rewardEvery);
    const it = byId.get(st.error.itemId);
    return res.status(409).json({ error: st.error.left ? `Only ${st.error.left} ${it.name} left. Please lower the amount.` : `${it.name} just sold out.`, stock: st.error });
  }
  const stockJson = Object.keys(st.taken).length ? JSON.stringify(st.taken) : null;

  // Atomic per-vendor ticket counter.
  const row = await get('UPDATE vendors SET next_ticket = COALESCE(next_ticket, 101) + 1 WHERE id = ? RETURNING next_ticket - 1 AS ticket', [v.id]);
  const now = Date.now();
  const token = core.randomToken(12);
  let r;
  try {
    r = await run(
      `INSERT INTO orders (vendor_id, ticket_no, public_token, customer_name, items_json, notes, total, status, payment_status, customer_phone, client_key, allergy, location, card_id, reward_cents, reward_every, stock_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [v.id, row.ticket, token, name, JSON.stringify(items), notes, total, payNow ? 'Pending' : 'Preparing', payNow ? 'pending' : 'window', phone, clientKey, allergy, state.location || null, rw.cardId || null, rw.rewardCents || 0, rw.rewardEvery || null, stockJson, now, now]
    );
  } catch (err) {
    await rewards.giveBack(rw.cardId, rw.rewardEvery); // the order wasn't saved, so the reward wasn't spent
    await inventory.giveBack(v.id, st.taken);         // …and neither was the stock
    // Two taps arrived at the same instant: the first one won, so answer with its order.
    if (err.code === 'SQLITE_CONSTRAINT' && clientKey && (await sameOrder())) return;
    throw err;
  }
  const orderRow = await get('SELECT * FROM orders WHERE id = ?', [r.lastID]);
  core.logOrderEvent(v.id, orderRow.id, 'placed', 'customer');
  if (stockJson) inventory.announce(v.id, Object.keys(st.taken)).catch(() => {});
  const reply = {
    ticket: orderRow.ticket_no,
    token,
    tag: core.orderTag(token),
    status: orderRow.status,
    total,
    estimatedMinutes: waitFor(state, prepMinutes),
    changeUntil: changeUntil(orderRow),
    now: Date.now(),
    rewardCents: rw.rewardCents,
  };
  if (rw.token) reply.cardToken = rw.token; // a new punch card, kept on the customer's phone

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
  core.refreshWait(v.id);
  res.status(201).json(reply);
});

// A customer's page asks for the current status of its own orders (by secret token).
router.get('/orders/track', requireVendor, async (req, res) => {
  const tokens = String(req.query.tokens || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20);
  if (!tokens.length) return res.json({ orders: [] });
  const rows = await all(
    `SELECT ticket_no, public_token, customer_name, status, payment_status, created_at FROM orders
     WHERE vendor_id = ? AND public_token IN (${tokens.map(() => '?').join(',')})`,
    [req.tenant.vendor.id, ...tokens]
  );
  res.json({
    now: Date.now(),
    orders: rows.map((o) => ({ ticket: o.ticket_no, token: o.public_token, name: o.customer_name, status: o.status, payment: o.payment_status, changeUntil: changeUntil(o) })),
  });
});

router.post('/orders/:token/cancel', limitOrders, requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const token = String(req.params.token || '');
  const now = Date.now();
  const row = await get(
    `UPDATE orders SET status = 'Canceled', updated_at = ?, customer_phone = NULL
     WHERE vendor_id = ? AND public_token = ? AND status = 'Preparing' AND payment_status = 'window' AND created_at > ? RETURNING *`,
    [now, v.id, token, now - CHANGE_WINDOW_MS]
  );
  if (!row) {
    const o = await get('SELECT status, payment_status FROM orders WHERE vendor_id = ? AND public_token = ?', [v.id, token]);
    if (!o) return res.status(404).json({ error: 'Order not found.' });
    if (o.status === 'Canceled') return res.json({ status: 'Canceled' });
    const msg = o.payment_status === 'paid' ? 'Paid orders can be changed at the window.' : o.status !== 'Preparing' ? 'Your order is already made.' : 'The kitchen has started on it. Please ask at the window.';
    return res.status(409).json({ error: msg, status: o.status });
  }
  core.logOrderEvent(v.id, row.id, 'canceled', 'customer');
  await core.orderClosed(v.id, row.id, 'canceled');
  core.broadcast(v.id, 'ORDER_UPDATE', Object.assign(orderShape(row), { byCustomer: true }), true);
  core.broadcast(v.id, 'ORDER_STATUS', { tag: core.orderTag(row.public_token), status: 'Canceled' });
  core.refreshWait(v.id);
  res.json({ status: 'Canceled' });
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
  // `now` lets the kitchen screen time orders by the server's clock, since tablet clocks drift.
  res.json({ orders: rows.map(orderShape), now: Date.now() });
});

router.patch('/owner/orders/:id', staffOrOwner, async (req, res) => {
  const v = req.tenant.vendor;
  const action = String((req.body || {}).action || '');
  // Allergies: the crew taps to confirm they saw it. Ready and Fulfill wait for that tap.
  if (action === 'ack-allergy') {
    const row = await get('UPDATE orders SET allergy_ack_at = ?, updated_at = ? WHERE id = ? AND vendor_id = ? AND allergy IS NOT NULL AND allergy_ack_at IS NULL RETURNING *',
      [Date.now(), Date.now(), parseInt(req.params.id, 10), v.id]);
    if (!row) return res.status(409).json({ error: 'That allergy was already confirmed.' });
    core.logOrderEvent(v.id, row.id, 'allergy-confirmed', actorOf(req));
    core.broadcast(v.id, 'ORDER_UPDATE', orderShape(row), true);
    return res.json({ order: orderShape(row) });
  }
  const next = { ready: 'Ready', fulfill: 'Fulfilled', cancel: 'Canceled' }[action];
  if (!next) return res.status(400).json({ error: 'Unknown action.' });
  // 'ready' is only valid from Preparing; fulfill/cancel from any open state.
  const from = action === 'ready' ? ['Preparing'] : ACTIVE;
  const id = parseInt(req.params.id, 10);
  const existing = await get(`SELECT * FROM orders WHERE id = ? AND vendor_id = ? AND status IN (${from.map(() => '?').join(',')})`, [id, v.id, ...from]);
  if (!existing) return res.status(409).json({ error: 'That order cannot be changed.' });
  if (action !== 'cancel' && existing.allergy && !existing.allergy_ack_at) {
    return res.status(409).json({ error: 'Confirm the allergy on this ticket first.', allergy: true });
  }

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
  core.logOrderEvent(v.id, row.id, next.toLowerCase(), actorOf(req));
  await core.orderClosed(v.id, row.id, next.toLowerCase()); // punch card, stock: one place reacts to every status change
  if (next === 'Ready') sms.notifyReady(v, existing).catch(() => {});
  const order = orderShape(row);
  core.broadcast(v.id, 'ORDER_UPDATE', order, true);
  // Customers match by a tag derived from their secret token — the token itself is never broadcast.
  core.broadcast(v.id, 'ORDER_STATUS', { tag: core.orderTag(order.token), status: order.status });
  core.refreshWait(v.id);
  res.json({ order });
});

router.get('/owner/state', staffOrOwner, async (req, res) => {
  const v = await get('SELECT crew_note, crew_note_at FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  res.json(Object.assign(await core.getState(req.tenant.vendor.id), { crewNote: (v && v.crew_note) || '', crewNoteAt: (v && v.crew_note_at) || 0 }));
});

// The owner's note to the crew, shown on every kitchen screen until it's changed or cleared.
router.put('/owner/crew-note', ownerOnly, async (req, res) => {
  const note = String((req.body || {}).note || '').trim().slice(0, 240);
  const at = note ? Date.now() : 0;
  await run('UPDATE vendors SET crew_note = ?, crew_note_at = ?, updated_at = ? WHERE id = ?', [note || null, at || null, Date.now(), req.tenant.vendor.id]);
  core.broadcast(req.tenant.vendor.id, 'CREW_NOTE', { note, at }, true);
  res.json({ note, at });
});

router.put('/owner/state', staffOrOwner, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  const role = req.session.role;
  if (b.status !== undefined) {
    if (!['open', 'closed'].includes(b.status)) return res.status(400).json({ error: 'Invalid status.' });
    const before = await core.getState(v.id);
    await run('UPDATE store_state SET status = ? WHERE vendor_id = ?', [b.status, v.id]);
    // Start of service: a fresh day. Yesterday's lock and pace don't carry over.
    if (b.status === 'open' && before.status !== 'open') {
      await run('UPDATE store_state SET service_started_at = ?, wait_lock = NULL WHERE vendor_id = ?', [Date.now(), v.id]);
      // Yesterday's "out of" list doesn't carry into a new day: restocked is the default.
      if (inventory.outList(await get('SELECT out_json FROM vendors WHERE id = ?', [v.id])).length) {
        await run("UPDATE vendors SET out_json = '[]' WHERE id = ?", [v.id]);
        await inventory.broadcastMenu(v.id);
      }
    }
    core.broadcast(v.id, 'STORE_STATUS', { status: b.status });
  }
  const waitNum = (x) => { const n = parseInt(x, 10); return Number.isInteger(n) && n >= 1 && n <= core.WAIT_MAX ? n : NaN; };
  if (b.waitStart !== undefined) {
    const n = b.waitStart === null ? null : waitNum(b.waitStart);
    if (Number.isNaN(n)) return res.status(400).json({ error: `Starting wait must be 1 to ${core.WAIT_MAX} minutes.` });
    await run('UPDATE store_state SET wait_start = ? WHERE vendor_id = ?', [n, v.id]);
  }
  if (b.waitLock !== undefined) {
    const n = b.waitLock === null ? null : waitNum(b.waitLock);
    if (Number.isNaN(n)) return res.status(400).json({ error: `Wait must be 1 to ${core.WAIT_MAX} minutes.` });
    await run('UPDATE store_state SET wait_lock = ? WHERE vendor_id = ?', [n, v.id]);
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
  await core.refreshWait(v.id);
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
  res.json({ menu: await ownerMenu(req.tenant.vendor.id), maxItems: core.MAX_ITEMS, out: inventory.outList(req.tenant.vendor) });
});

router.patch('/owner/menu/:id/soldout', staffOrOwner, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const menu = core.parseMenu(v.menu_data);
  const item = menu.find((m) => m.id === parseInt(req.params.id, 10));
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  item.soldOut = !!(req.body || {}).soldOut;
  await core.saveMenu(v.id, menu);
  await inventory.announce(v.id, [item.id]);
  res.json({ item: (await ownerMenu(v.id)).find((m) => m.id === item.id) });
});

// "40 left" (null stops counting). Crew can do this from the kitchen.
router.put('/owner/stock/:id', staffOrOwner, async (req, res) => {
  const v = req.tenant.vendor;
  const id = parseInt(req.params.id, 10);
  if (!core.parseMenu(v.menu_data).some((m) => m.id === id)) return res.status(404).json({ error: 'Item not found.' });
  const raw = (req.body || {}).left;
  if (raw === null || raw === '') {
    await run('DELETE FROM item_stock WHERE vendor_id = ? AND item_id = ?', [v.id, id]);
  } else {
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0 || n > 9999) return res.status(400).json({ error: 'Enter how many are left (0 to 9999), or leave it blank to stop counting.' });
    await run('INSERT INTO item_stock (vendor_id, item_id, left_count) VALUES (?, ?, ?) ON CONFLICT (vendor_id, item_id) DO UPDATE SET left_count = excluded.left_count', [v.id, id, n]);
  }
  await inventory.announce(v.id, [id]);
  res.json({ item: (await ownerMenu(v.id)).find((m) => m.id === id) });
});

// "Out of cilantro": every item with that ingredient sells out until it's back.
router.put('/owner/out', staffOrOwner, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const ing = String((req.body || {}).ingredient || '').trim().slice(0, 30);
  if (!ing) return res.status(400).json({ error: 'Which ingredient?' });
  const key = ing.toLowerCase();
  let out = inventory.outList(v).filter((x) => x.toLowerCase() !== key);
  if ((req.body || {}).out) out.push(ing);
  out = out.slice(0, 50);
  await run('UPDATE vendors SET out_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(out), Date.now(), v.id]);
  core.logOrderEvent(v.id, 0, `${(req.body || {}).out ? 'out-of' : 'back-in'}:${ing}`, actorOf(req));
  await inventory.broadcastMenu(v.id);
  core.broadcast(v.id, 'OUT_UPDATE', { out }, true);
  res.json({ out, menu: await ownerMenu(v.id) });
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
  await inventory.broadcastMenu(v.id);
  res.status(201).json({ item, menu: await ownerMenu(v.id) });
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
  await inventory.broadcastMenu(v.id);
  const om = await ownerMenu(v.id);
  res.json({ item: om[idx], menu: om });
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
  await inventory.broadcastMenu(v.id);
  res.json({ menu: await ownerMenu(v.id) });
});

router.delete('/owner/menu/:id', ownerOnly, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const menu = core.parseMenu(v.menu_data);
  const next = menu.filter((m) => m.id !== parseInt(req.params.id, 10));
  if (next.length === menu.length) return res.status(404).json({ error: 'Item not found.' });
  await core.saveMenu(v.id, next);
  await run('DELETE FROM item_stock WHERE vendor_id = ? AND item_id = ?', [v.id, parseInt(req.params.id, 10)]);
  await inventory.broadcastMenu(v.id);
  res.json({ menu: await ownerMenu(v.id) });
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
/* ----- Deals / happy hour (Pro; open to everyone during the free beta) ----- */
router.get('/owner/deals', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  res.json({ deals: vendorDeals(v), allowed: proOpen(v, 'deals'), max: Deals.MAX_DEALS, runningNow: Deals.active(vendorDeals(v), localParts(v)).map((d) => d.id) });
});
router.put('/owner/deals', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  if (!proOpen(v, 'deals')) return res.status(402).json({ error: 'Happy hour is part of Pro.', upgrade: true });
  const list = (req.body || {}).deals;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Nothing to save.' });
  if (list.length > Deals.MAX_DEALS) return res.status(400).json({ error: `Up to ${Deals.MAX_DEALS} deals.` });
  const deals = Deals.normalize(list);
  for (const d of deals) {
    if (d.on && !d.days.length) return res.status(400).json({ error: `Pick at least one day for “${d.name}”.` });
    if (d.start === d.end) return res.status(400).json({ error: `“${d.name}” needs an end time different from its start.` });
    if (d.on && d.scope !== 'all' && !(d.scope === 'categories' ? d.categories.length : d.items.length)) return res.status(400).json({ error: `Pick what “${d.name}” applies to.` });
  }
  await run('UPDATE vendors SET deals_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(deals), Date.now(), v.id]);
  const fresh = await get('SELECT * FROM vendors WHERE id = ?', [v.id]);
  core.broadcast(v.id, 'DEALS_UPDATE', { deals: vendorDeals(fresh).filter((d) => d.on) });
  res.json({ deals: vendorDeals(fresh), runningNow: Deals.active(vendorDeals(fresh), localParts(fresh)).map((d) => d.id) });
});

/* ----- Insights (Pro; open to everyone during the free beta) ----- */
const betaOpen = () => process.env.FREE_BETA === 'true' || !(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
const insightsOpen = (v) => core.features(v).insights || betaOpen();
const SOLD = "status IN ('Fulfilled','Ready') AND COALESCE(payment_status, 'window') != 'pending'";

async function salesRows(vendorId, from, to, location) {
  const params = [vendorId, from, to];
  let where = `vendor_id = ? AND ${SOLD} AND created_at >= ? AND created_at < ?`;
  if (location !== undefined) { where += " AND COALESCE(location, '') = ?"; params.push(location); }
  const rows = await all(`SELECT created_at, total, items_json, location FROM orders WHERE ${where}`, params);
  return rows.map((r) => {
    let items = [];
    try { items = JSON.parse(r.items_json) || []; } catch (e) {}
    return { t: r.created_at, cents: Math.round(r.total * 100), items, loc: r.location || '' };
  });
}

router.get('/owner/insights', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  if (!insightsOpen(v)) return res.status(402).json({ error: 'Insights are part of Pro.', upgrade: true });
  const tz = Insights.validTz(v.timezone);
  const range = ['day', 'week', 'month'].includes(req.query.range) ? req.query.range : 'day';
  const per = Insights.period(range, String(req.query.anchor || ''), tz);
  const loc = req.query.location === undefined || req.query.location === '*' ? undefined : String(req.query.location).slice(0, 80);
  const [rows, prev] = await Promise.all([salesRows(v.id, per.from, per.to, loc), salesRows(v.id, per.prevFrom, per.prevTo, loc)]);
  const out = Insights.summarize(rows, prev, per, tz);
  // Every location the truck has sold at, so the filter can list ones outside this period too.
  const names = await all(`SELECT DISTINCT COALESCE(location, '') AS name FROM orders WHERE vendor_id = ? AND ${SOLD}`, [v.id]);
  res.json(Object.assign(out, { timezone: tz, allLocations: names.map((n) => n.name) }));
});

router.get('/owner/insights/locations', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  if (!insightsOpen(v)) return res.status(402).json({ error: 'Insights are part of Pro.', upgrade: true });
  const tz = Insights.validTz(v.timezone);
  const days = [30, 90, 365].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 90;
  const rows = await salesRows(v.id, Date.now() - days * Insights.DAY, Date.now() + 1);
  res.json({ days, timezone: tz, locations: Insights.compareLocations(rows, tz) });
});

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
  // Screens opened with the old shared PIN stop working; crew signed in with their own PIN stay signed in.
  await run("DELETE FROM sessions WHERE vendor_id = ? AND role = 'staff' AND staff_id IS NULL", [req.tenant.vendor.id]);
  core.dropStreams(req.tenant.vendor.id, (c) => c.role === 'staff' && !c.staffId);
  res.json({ ok: true });
});
router.delete('/owner/staff-pin', ownerOnly, async (req, res) => {
  await run('UPDATE vendors SET staff_pin_hash = NULL, updated_at = ? WHERE id = ?', [Date.now(), req.tenant.vendor.id]);
  await run("DELETE FROM sessions WHERE vendor_id = ? AND role = 'staff' AND staff_id IS NULL", [req.tenant.vendor.id]);
  core.dropStreams(req.tenant.vendor.id, (c) => c.role === 'staff' && !c.staffId);
  res.json({ ok: true });
});

/* ----- Crew: each person their own PIN ----- */
const MAX_CREW = 30;
const crewShape = (m) => ({ id: m.id, name: m.name, createdAt: m.created_at, lastLoginAt: m.last_login_at || null });
async function crewList(vendorId) {
  const rows = await all('SELECT * FROM staff_members WHERE vendor_id = ? ORDER BY name COLLATE NOCASE', [vendorId]);
  const v = await get('SELECT staff_pin_hash FROM vendors WHERE id = ?', [vendorId]);
  const on = await all("SELECT staff_id, COUNT(*) AS n FROM sessions WHERE vendor_id = ? AND role = 'staff' AND expires_at > ? GROUP BY staff_id", [vendorId, Date.now()]);
  const live = Object.fromEntries(on.map((r) => [r.staff_id === null ? 'shared' : r.staff_id, r.n]));
  return { crew: rows.map((m) => Object.assign(crewShape(m), { screens: live[m.id] || 0 })), sharedPin: !!(v && v.staff_pin_hash), sharedScreens: live.shared || 0, max: MAX_CREW };
}
async function checkCrewPin(vendorId, pin, exceptId) {
  if (!/^[0-9]{4,8}$/.test(pin)) return 'A crew PIN is 4 to 8 numbers.';
  const clash = await get('SELECT id FROM staff_members WHERE vendor_id = ? AND pin_lookup = ?', [vendorId, await core.pinLookup(vendorId, pin)]);
  if (clash && clash.id !== exceptId) return 'Someone on your crew already has that PIN. Pick another.';
  return null;
}
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 30);

router.get('/owner/crew', ownerOnly, async (req, res) => res.json(await crewList(req.tenant.vendor.id)));
router.post('/owner/crew', ownerOnly, async (req, res) => {
  const vid = req.tenant.vendor.id;
  const name = cleanName((req.body || {}).name);
  const pin = String((req.body || {}).pin || '').trim();
  if (!name) return res.status(400).json({ error: 'Add their name.' });
  const n = await get('SELECT COUNT(*) AS n FROM staff_members WHERE vendor_id = ?', [vid]);
  if (n.n >= MAX_CREW) return res.status(400).json({ error: `Up to ${MAX_CREW} people.` });
  const bad = await checkCrewPin(vid, pin);
  if (bad) return res.status(400).json({ error: bad });
  try {
    await run('INSERT INTO staff_members (vendor_id, name, pin_lookup, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)', [vid, name, await core.pinLookup(vid, pin), await bcrypt.hash(pin, 10), Date.now()]);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT') return res.status(400).json({ error: 'Someone on your crew already has that PIN. Pick another.' });
    throw e;
  }
  res.status(201).json(await crewList(vid));
});
router.put('/owner/crew/:id', ownerOnly, async (req, res) => {
  const vid = req.tenant.vendor.id;
  const id = parseInt(req.params.id, 10);
  const m = await get('SELECT * FROM staff_members WHERE id = ? AND vendor_id = ?', [id, vid]);
  if (!m) return res.status(404).json({ error: 'That person is gone.' });
  const b = req.body || {};
  if (b.name !== undefined) {
    const name = cleanName(b.name);
    if (!name) return res.status(400).json({ error: 'Add their name.' });
    await run('UPDATE staff_members SET name = ? WHERE id = ?', [name, id]);
  }
  if (b.pin !== undefined) {
    const pin = String(b.pin || '').trim();
    const bad = await checkCrewPin(vid, pin, id);
    if (bad) return res.status(400).json({ error: bad });
    await run('UPDATE staff_members SET pin_lookup = ?, pin_hash = ? WHERE id = ?', [await core.pinLookup(vid, pin), await bcrypt.hash(pin, 10), id]);
    await run('DELETE FROM sessions WHERE staff_id = ?', [id]); // a new PIN signs them out everywhere
    core.dropStreams(vid, (c) => c.staffId === id);
  }
  res.json(await crewList(vid));
});
// Removing someone signs them out on every screen right away.
router.delete('/owner/crew/:id', ownerOnly, async (req, res) => {
  const vid = req.tenant.vendor.id;
  const id = parseInt(req.params.id, 10);
  const r = await run('DELETE FROM staff_members WHERE id = ? AND vendor_id = ?', [id, vid]);
  if (!r.changes) return res.status(404).json({ error: 'That person is gone.' });
  await run('DELETE FROM sessions WHERE staff_id = ?', [id]);
  core.dropStreams(vid, (c) => c.staffId === id);
  res.json(await crewList(vid));
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
