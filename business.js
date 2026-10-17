'use strict';
/* =====================================================================
   Business tools (the Business plan; open to everyone during the free beta):
   - Event tracker: applications, fees and deadlines, then what each event earned against its fee.
   - Ingredient prices and recipes: plate cost per item, flagged when a price jump hurts a margin,
     with a suggested new price.
   - Sales tax by location: sales and tax by city for any period, ready for filing.
   - Maintenance log: generator hours, propane, oil changes, with reminders before they're due.
   - Accountant export: daily sales, fees and tax as a spreadsheet, and as journal entries for QuickBooks.
   ===================================================================== */
const express = require('express');
const core = require('./core');
const auth = require('./auth');
const Insights = require('./public/insights-core');
const { run, get, all } = core;
const { requireVendor, requireRole } = auth;

const router = express.Router();
const betaOpen = () => process.env.FREE_BETA === 'true' || !(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
const bizOpen = (v) => !!core.features(v).business || betaOpen();
const gate = (req, res, next) => (bizOpen(req.tenant.vendor) ? next() : res.status(402).json({ error: 'This is part of the Business plan.', upgrade: true }));
const ownerOnly = [requireVendor, requireRole('owner'), gate];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOLD = "status IN ('Fulfilled','Ready') AND COALESCE(payment_status, 'window') != 'pending'";
const tzOf = (v) => Insights.validTz(v.timezone);
const today = (v) => Insights.dateKey(Insights.parts(Date.now(), tzOf(v)));
const cleanText = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const cents = (x) => { const n = Math.round(Number(x) * 100); return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : null; };
function dayBounds(day, tz) { const [y, m, d] = day.split('-').map(Number); return [Insights.zonedStart(y, m, d, tz), Insights.zonedStart(y, m, d + 1, tz)]; }
function addDays(day, n) { const [y, m, d] = day.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
function daysBetween(a, b) { const f = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((f(b) - f(a)) / 864e5); }
const csvCell = (x) => { let s = String(x == null ? '' : x); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
function sendCsv(res, name, rows) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.send(csv(rows));
}
async function salesBetween(vendorId, from, to, location) {
  const params = [vendorId, from, to];
  let where = `vendor_id = ? AND ${SOLD} AND created_at >= ? AND created_at < ?`;
  if (location) { where += ' AND location = ?'; params.push(location); }
  return all(`SELECT created_at, total, items_json, location, payment_status, status FROM orders WHERE ${where}`, params);
}
const parse = (j) => { try { return JSON.parse(j || '[]') || []; } catch (e) { return []; } };

/* =========================== Event tracker =========================== */
const EVENT_STATUS = ['idea', 'applied', 'accepted', 'declined', 'done'];
async function eventResult(v, e) {
  if (!e.start_day || !DAY_RE.test(e.start_day)) return null;
  const tz = tzOf(v);
  const end = e.end_day && DAY_RE.test(e.end_day) && e.end_day >= e.start_day ? e.end_day : e.start_day;
  if (e.start_day > today(v)) return null; // hasn't happened yet
  const [from] = dayBounds(e.start_day, tz), [, to] = dayBounds(end, tz);
  const rows = await salesBetween(v.id, from, to, e.location || null);
  let online = 0, food = 0, costed = 0;
  for (const r of rows) {
    online += Math.round(r.total * 100);
    for (const i of parse(r.items_json)) if (i.cost !== undefined && i.cost !== null) { food += Math.round(i.cost * 100) * i.qty; costed += Math.round(i.price * 100) * i.qty; }
  }
  const revenue = online + (e.walkup_cents || 0);
  // Food cost from items with a cost set; the rest of the sales assume the same food-cost share.
  const foodShare = costed ? food / costed : null;
  const foodCents = foodShare === null ? null : Math.round(revenue * foodShare);
  const profit = revenue - (e.fee_cents || 0) - (foodCents || 0);
  return {
    orders: rows.length, onlineCents: online, walkupCents: e.walkup_cents || 0, revenueCents: revenue, feeCents: e.fee_cents || 0,
    foodCents, profitCents: profit, days: daysBetween(e.start_day, end) + 1,
    perDollarFee: e.fee_cents ? Math.round((revenue / e.fee_cents) * 10) / 10 : null,
  };
}
function eventShape(e) {
  return { id: e.id, name: e.name, organizer: e.organizer || '', contact: e.contact || '', url: e.url || '', location: e.location || '', startDay: e.start_day || '', endDay: e.end_day || '', deadlineDay: e.deadline_day || '', feeCents: e.fee_cents || 0, walkupCents: e.walkup_cents || 0, status: e.status, notes: e.notes || '' };
}
function readEvent(b, old) {
  const e = Object.assign({}, old || {});
  if (b.name !== undefined) e.name = cleanText(b.name, 80);
  for (const [k, col, n] of [['organizer', 'organizer', 80], ['contact', 'contact', 120], ['url', 'url', 300], ['location', 'location', 80], ['notes', 'notes', 1000]]) if (b[k] !== undefined) e[col] = cleanText(b[k], n);
  for (const [k, col] of [['startDay', 'start_day'], ['endDay', 'end_day'], ['deadlineDay', 'deadline_day']]) {
    if (b[k] === undefined) continue;
    if (b[k] && !DAY_RE.test(String(b[k]))) return { error: 'Dates look like 2026-10-24.' };
    e[col] = b[k] || null;
  }
  for (const [k, col] of [['fee', 'fee_cents'], ['walkup', 'walkup_cents']]) {
    if (b[k] === undefined) continue;
    const c = b[k] === '' || b[k] === null ? 0 : cents(b[k]);
    if (c === null) return { error: 'Amounts are dollars, like 150 or 87.50.' };
    e[col] = c;
  }
  if (b.status !== undefined) { if (!EVENT_STATUS.includes(b.status)) return { error: 'Unknown status.' }; e.status = b.status; }
  if (!e.name) return { error: 'Give the event a name.' };
  if (e.end_day && e.start_day && e.end_day < e.start_day) return { error: 'The event ends before it starts.' };
  return { e };
}

router.get('/events', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const rows = await all('SELECT * FROM biz_events WHERE vendor_id = ? ORDER BY COALESCE(start_day, deadline_day, \'9999\') DESC, id DESC', [v.id]);
  const t = today(v);
  const events = [];
  for (const e of rows) events.push(Object.assign(eventShape(e), { result: ['accepted', 'done'].includes(e.status) ? await eventResult(v, e) : null }));
  // What's due soon: applications not sent with a deadline in the next 14 days.
  const due = events.filter((e) => ['idea'].includes(e.status) && e.deadlineDay && e.deadlineDay >= t && daysBetween(t, e.deadlineDay) <= 14)
    .map((e) => ({ id: e.id, name: e.name, deadlineDay: e.deadlineDay, inDays: daysBetween(t, e.deadlineDay) }));
  const done = events.filter((e) => e.result);
  res.json({ events, due, today: t, totals: { events: done.length, revenueCents: done.reduce((n, e) => n + e.result.revenueCents, 0), feeCents: done.reduce((n, e) => n + e.result.feeCents, 0), profitCents: done.reduce((n, e) => n + e.result.profitCents, 0) } });
});
router.post('/events', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const r = readEvent(req.body || {}, { status: 'idea' });
  if (r.error) return res.status(400).json({ error: r.error });
  const e = r.e, now = Date.now();
  const x = await run(`INSERT INTO biz_events (vendor_id, name, organizer, contact, url, location, start_day, end_day, deadline_day, fee_cents, walkup_cents, status, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [v.id, e.name, e.organizer || null, e.contact || null, e.url || null, e.location || null, e.start_day || null, e.end_day || null, e.deadline_day || null, e.fee_cents || 0, e.walkup_cents || 0, e.status, e.notes || null, now, now]);
  res.status(201).json({ id: x.lastID });
});
router.put('/events/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const old = await get('SELECT * FROM biz_events WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), v.id]);
  if (!old) return res.status(404).json({ error: 'Event not found.' });
  const r = readEvent(req.body || {}, old);
  if (r.error) return res.status(400).json({ error: r.error });
  const e = r.e;
  await run(`UPDATE biz_events SET name = ?, organizer = ?, contact = ?, url = ?, location = ?, start_day = ?, end_day = ?, deadline_day = ?, fee_cents = ?, walkup_cents = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?`,
    [e.name, e.organizer || null, e.contact || null, e.url || null, e.location || null, e.start_day || null, e.end_day || null, e.deadline_day || null, e.fee_cents || 0, e.walkup_cents || 0, e.status, e.notes || null, Date.now(), old.id]);
  res.json({ ok: true, event: Object.assign(eventShape(Object.assign(old, e)), { result: ['accepted', 'done'].includes(e.status) ? await eventResult(v, Object.assign(old, e)) : null }) });
});
router.delete('/events/:id', ownerOnly, async (req, res) => {
  await run('DELETE FROM biz_events WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), req.tenant.vendor.id]);
  res.json({ ok: true });
});

/* ====================== Ingredient prices and recipes ====================== */
const TARGET_MARGIN = 65; // percent; below this a plate is flagged
const roundUp25 = (c) => Math.ceil(c / 25) * 25;
async function ingredientsOf(vendorId) {
  const list = await all('SELECT * FROM ingredients WHERE vendor_id = ? ORDER BY name COLLATE NOCASE', [vendorId]);
  const hist = await all('SELECT ingredient_id, price_cents, at, receipt_url FROM ingredient_prices WHERE vendor_id = ? ORDER BY at DESC', [vendorId]);
  return list.map((i) => {
    const h = hist.filter((x) => x.ingredient_id === i.id);
    const prev = h[1] ? h[1].price_cents : null;
    return { id: i.id, name: i.name, unit: i.unit, priceCents: i.price_cents, updatedAt: i.updated_at, prevCents: prev, changePct: prev ? Math.round(((i.price_cents - prev) / prev) * 1000) / 10 : null, history: h.slice(0, 6).map((x) => ({ priceCents: x.price_cents, at: x.at, receipt: x.receipt_url || null })) };
  });
}
function plateCents(recipe, prices) {
  let c = 0;
  for (const r of recipe || []) { const p = prices.get(r.ingredientId); if (p === undefined) return null; c += p * r.qty; }
  return Math.round(c);
}
/** Recomputes the food cost of every item with a recipe from today's prices, and saves it. */
async function refreshCosts(vendorId) {
  const v = await get('SELECT menu_data FROM vendors WHERE id = ?', [vendorId]);
  const menu = core.parseMenu(v.menu_data);
  const prices = new Map((await all('SELECT id, price_cents FROM ingredients WHERE vendor_id = ?', [vendorId])).map((i) => [i.id, i.price_cents]));
  let changed = false;
  for (const m of menu) {
    if (!m.recipe || !m.recipe.length) continue;
    const pc = plateCents(m.recipe, prices);
    if (pc === null) continue;
    const cost = Math.round(pc) / 100;
    if (m.cost !== cost) { m.cost = cost; changed = true; }
  }
  if (changed) await core.saveMenu(vendorId, menu);
  return menu;
}
async function costsView(vendorId, before) {
  const ings = await ingredientsOf(vendorId);
  const prices = new Map(ings.map((i) => [i.id, i.priceCents]));
  const menu = core.parseMenu((await get('SELECT menu_data FROM vendors WHERE id = ?', [vendorId])).menu_data);
  const items = menu.map((m) => {
    const price = Math.round((m.salePrice && m.salePrice > 0 ? m.salePrice : m.price) * 100);
    const pc = m.recipe && m.recipe.length ? plateCents(m.recipe, prices) : (m.cost !== null && m.cost !== undefined ? Math.round(m.cost * 100) : null);
    const margin = pc !== null && price ? Math.round(((price - pc) / price) * 1000) / 10 : null;
    const was = before && before.get(m.id);
    let flag = null;
    if (margin !== null && was && was.margin !== null && margin < was.margin - 2 && (margin < TARGET_MARGIN || was.margin - margin >= 5)) {
      // Suggest the price that keeps the margin it had before the price jump.
      const suggest = roundUp25(pc / (1 - was.margin / 100));
      // …and the smaller step back up to the target margin, when that's lower.
      const atTarget = was.margin > TARGET_MARGIN ? roundUp25(pc / (1 - TARGET_MARGIN / 100)) : null;
      flag = { fromMargin: was.margin, toMargin: margin, suggestedCents: suggest, targetCents: atTarget && atTarget < suggest && atTarget > price ? atTarget : null };
    }
    return { id: m.id, name: m.name, priceCents: price, plateCents: pc, marginPct: margin, low: margin !== null && margin < TARGET_MARGIN, recipe: m.recipe || [], flag };
  });
  return { ingredients: ings, items, targetMargin: TARGET_MARGIN };
}
const marginsMap = (view) => new Map(view.items.map((i) => [i.id, { margin: i.marginPct }]));

router.get('/costs', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  // Flags compare with the previous price of each ingredient.
  const view = await costsView(v.id);
  const ings = view.ingredients.filter((i) => i.prevCents);
  if (ings.length) {
    const prevPrices = new Map(view.ingredients.map((i) => [i.id, i.prevCents || i.priceCents]));
    const menu = core.parseMenu((await get('SELECT menu_data FROM vendors WHERE id = ?', [v.id])).menu_data);
    const before = new Map(menu.map((m) => {
      const price = Math.round((m.salePrice && m.salePrice > 0 ? m.salePrice : m.price) * 100);
      const pc = m.recipe && m.recipe.length ? plateCents(m.recipe, prevPrices) : null;
      return [m.id, { margin: pc !== null && price ? Math.round(((price - pc) / price) * 1000) / 10 : null }];
    }));
    return res.json(await costsView(v.id, before));
  }
  res.json(view);
});
const UNITS = ['lb', 'oz', 'kg', 'g', 'each', 'dozen', 'gal', 'qt', 'l', 'case', 'bag', 'pack'];
router.post('/ingredients', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  const name = cleanText(b.name, 40), unit = String(b.unit || '');
  const price = cents(b.price);
  if (!name) return res.status(400).json({ error: 'Name the ingredient, like “Beef chuck”.' });
  if (!UNITS.includes(unit)) return res.status(400).json({ error: 'Pick how it’s sold (lb, each, case…).' });
  if (price === null || price === 0) return res.status(400).json({ error: 'What does one ' + unit + ' cost? Like 4.20.' });
  if (await get('SELECT 1 FROM ingredients WHERE vendor_id = ? AND name = ? COLLATE NOCASE', [v.id, name])) return res.status(409).json({ error: 'You already have that one. Update its price instead.' });
  const now = Date.now();
  const x = await run('INSERT INTO ingredients (vendor_id, name, unit, price_cents, updated_at) VALUES (?, ?, ?, ?, ?)', [v.id, name, unit, price, now]);
  await run('INSERT INTO ingredient_prices (vendor_id, ingredient_id, price_cents, at) VALUES (?, ?, ?, ?)', [v.id, x.lastID, price, now]);
  res.status(201).json({ id: x.lastID });
});
// A new price (from a receipt): recorded, plate costs follow, and margins that suffer are flagged.
router.put('/ingredients/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  const ing = await get('SELECT * FROM ingredients WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), v.id]);
  if (!ing) return res.status(404).json({ error: 'Ingredient not found.' });
  const price = cents(b.price);
  if (price === null || price === 0) return res.status(400).json({ error: 'Enter the new price, like 5.10.' });
  const receipt = b.receipt && core.PHOTO_RE.test(String(b.receipt)) && String(b.receipt).startsWith(`/uploads/${v.id}-`) ? String(b.receipt) : null;
  const before = marginsMap(await costsView(v.id));
  const now = Date.now();
  await run('UPDATE ingredients SET price_cents = ?, updated_at = ? WHERE id = ?', [price, now, ing.id]);
  await run('INSERT INTO ingredient_prices (vendor_id, ingredient_id, price_cents, receipt_url, at) VALUES (?, ?, ?, ?, ?)', [v.id, ing.id, price, receipt, now]);
  await refreshCosts(v.id);
  const view = await costsView(v.id, before);
  res.json(Object.assign(view, { flagged: view.items.filter((i) => i.flag) }));
});
router.delete('/ingredients/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, id = parseInt(req.params.id, 10);
  const menu = core.parseMenu((await get('SELECT menu_data FROM vendors WHERE id = ?', [v.id])).menu_data);
  if (menu.some((m) => (m.recipe || []).some((r) => r.ingredientId === id))) return res.status(409).json({ error: 'A recipe uses it. Take it out of those recipes first.' });
  await run('DELETE FROM ingredients WHERE id = ? AND vendor_id = ?', [id, v.id]);
  await run('DELETE FROM ingredient_prices WHERE ingredient_id = ? AND vendor_id = ?', [id, v.id]);
  res.json({ ok: true });
});
router.put('/recipes/:itemId', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const menu = core.parseMenu((await get('SELECT menu_data FROM vendors WHERE id = ?', [v.id])).menu_data);
  const item = menu.find((m) => m.id === parseInt(req.params.itemId, 10));
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  const ids = new Set((await all('SELECT id FROM ingredients WHERE vendor_id = ?', [v.id])).map((i) => i.id));
  const recipe = core.normalizeItem({ recipe: (req.body || {}).recipe }, 1).recipe.filter((r) => ids.has(r.ingredientId));
  item.recipe = recipe; // with no recipe, the cost typed by hand in the item editor stays
  await core.saveMenu(v.id, menu);
  await refreshCosts(v.id);
  res.json(await costsView(v.id));
});

/* =========================== Sales tax by location =========================== */
function periodOf(q, v) {
  const tz = tzOf(v);
  const from = DAY_RE.test(String(q.from || '')) ? String(q.from) : today(v).slice(0, 8) + '01';
  const to = DAY_RE.test(String(q.to || '')) ? String(q.to) : today(v);
  return { from, to, a: dayBounds(from, tz)[0], b: dayBounds(to, tz)[1] };
}
async function taxReport(v, q) {
  const per = periodOf(q, v);
  const locs = await all('SELECT name, city, tax_rate, tax_included FROM locations WHERE vendor_id = ?', [v.id]);
  const byName = new Map(locs.map((l) => [l.name, l]));
  const rows = await salesBetween(v.id, per.a, per.b, null);
  const groups = new Map();
  for (const r of rows) {
    const l = byName.get(r.location || '') || null;
    const key = l && l.city ? l.city : r.location || 'No location set';
    const g = groups.get(key) || { city: l && l.city ? l.city : null, locations: new Set(), rate: l && l.tax_rate !== null ? l.tax_rate : null, included: l ? !!l.tax_included : true, grossCents: 0, orders: 0 };
    if (r.location) g.locations.add(r.location);
    g.grossCents += Math.round(r.total * 100); g.orders++;
    groups.set(key, g);
  }
  const lines = [...groups.entries()].map(([key, g]) => {
    const rate = g.rate === null ? null : g.rate / 100;
    // Prices that include tax: tax = gross − gross ÷ (1 + rate). Otherwise tax was added on top at the window.
    const tax = rate === null ? null : g.included ? Math.round(g.grossCents - g.grossCents / (1 + rate)) : Math.round(g.grossCents * rate);
    return { place: key, city: g.city, locations: [...g.locations], ratePct: g.rate, included: g.included, orders: g.orders, grossCents: g.grossCents, taxCents: tax, netCents: tax === null ? null : g.included ? g.grossCents - tax : g.grossCents };
  }).sort((a, b) => b.grossCents - a.grossCents);
  // Catering: the tax is on each locked quote.
  const cat = await all("SELECT quote, event_date FROM catering_bookings WHERE vendor_id = ? AND status = 'accepted' AND event_date >= ? AND event_date <= ?", [v.id, per.from, per.to]).catch(() => []);
  let catGross = 0, catTax = 0;
  for (const b of cat) { const qq = (() => { try { return JSON.parse(b.quote); } catch (e) { return {}; } })(); catGross += qq.totalCents || 0; catTax += qq.taxCents || 0; }
  if (cat.length) lines.push({ place: 'Catering', city: null, locations: [], ratePct: null, included: false, orders: cat.length, grossCents: catGross, taxCents: catTax, netCents: catGross - catTax });
  return { from: per.from, to: per.to, lines, missing: lines.filter((l) => l.taxCents === null).map((l) => l.place), totals: { grossCents: lines.reduce((n, l) => n + l.grossCents, 0), taxCents: lines.reduce((n, l) => n + (l.taxCents || 0), 0) } };
}
router.get('/tax', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const locations = (await all('SELECT id, name, city, tax_rate, tax_included FROM locations WHERE vendor_id = ? AND deleted = 0 ORDER BY name', [v.id]))
    .map((l) => ({ id: l.id, name: l.name, city: l.city || '', ratePct: l.tax_rate, included: !!l.tax_included }));
  res.json(Object.assign(await taxReport(v, req.query || {}), { locationsSetup: locations }));
});
router.put('/tax/locations/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, b = req.body || {};
  const l = await get('SELECT id FROM locations WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), v.id]);
  if (!l) return res.status(404).json({ error: 'Location not found.' });
  const rate = b.ratePct === '' || b.ratePct === null || b.ratePct === undefined ? null : Number(b.ratePct);
  if (rate !== null && !(rate >= 0 && rate <= 20)) return res.status(400).json({ error: 'A sales tax rate is a percent between 0 and 20, like 8.6.' });
  await run('UPDATE locations SET city = ?, tax_rate = ?, tax_included = ? WHERE id = ?', [cleanText(b.city, 60) || null, rate, b.included === false ? 0 : 1, l.id]);
  res.json({ ok: true });
});
router.get('/tax.csv', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const t = await taxReport(v, req.query || {});
  const rows = [['City or place', 'Spots', 'Tax rate %', 'Prices include tax', 'Orders', 'Gross sales', 'Taxable sales', 'Sales tax']];
  for (const l of t.lines) rows.push([l.place, l.locations.join('; '), l.ratePct === null ? 'not set' : l.ratePct, l.included ? 'yes' : 'no', l.orders, (l.grossCents / 100).toFixed(2), l.netCents === null ? '' : (l.netCents / 100).toFixed(2), l.taxCents === null ? '' : (l.taxCents / 100).toFixed(2)]);
  rows.push(['Total', '', '', '', '', (t.totals.grossCents / 100).toFixed(2), '', (t.totals.taxCents / 100).toFixed(2)]);
  sendCsv(res, `${v.slug}-sales-tax-${t.from}-to-${t.to}.csv`, rows);
});

/* =========================== Maintenance log =========================== */
const MAINT_UNITS = ['hours', 'miles', 'days'];
function maintShape(m, todayKey) {
  let left = null, dueDay = null;
  if (m.unit === 'days') {
    dueDay = m.last_day ? addDays(m.last_day, m.every) : null;
    left = dueDay ? daysBetween(todayKey, dueDay) : null;
  } else if (m.last_reading !== null && m.reading_now !== null) left = m.last_reading + m.every - m.reading_now;
  const soon = left !== null && left <= (m.unit === 'days' ? 7 : Math.max(10, Math.round(m.every * 0.1)));
  return { id: m.id, name: m.name, unit: m.unit, every: m.every, lastReading: m.last_reading, lastDay: m.last_day, readingNow: m.reading_now, left, dueDay, status: left === null ? 'unknown' : left < 0 ? 'overdue' : soon ? 'soon' : 'ok' };
}
router.get('/maint', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, t = today(v);
  const items = (await all('SELECT * FROM maint_items WHERE vendor_id = ? ORDER BY name', [v.id])).map((m) => maintShape(m, t));
  const logs = await all('SELECT l.*, i.name FROM maint_logs l JOIN maint_items i ON i.id = l.item_id WHERE l.vendor_id = ? ORDER BY l.day DESC, l.id DESC LIMIT 60', [v.id]);
  res.json({ items, logs: logs.map((l) => ({ id: l.id, itemId: l.item_id, name: l.name, day: l.day, reading: l.reading, costCents: l.cost_cents, note: l.note || '' })), today: t,
    spentCents: logs.filter((l) => l.day >= t.slice(0, 4) + '-01-01').reduce((n, l) => n + l.cost_cents, 0) });
});
router.post('/maint', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, b = req.body || {};
  const name = cleanText(b.name, 60), unit = String(b.unit || ''), every = parseInt(b.every, 10);
  if (!name) return res.status(400).json({ error: 'What needs looking after? Like “Generator oil change”.' });
  if (!MAINT_UNITS.includes(unit)) return res.status(400).json({ error: 'Every how many hours, miles or days?' });
  if (!(every > 0 && every <= 100000)) return res.status(400).json({ error: 'How often, as a number.' });
  const reading = b.lastReading === '' || b.lastReading === undefined ? null : parseInt(b.lastReading, 10);
  const lastDay = DAY_RE.test(String(b.lastDay || '')) ? String(b.lastDay) : unit === 'days' ? today(v) : null;
  const x = await run('INSERT INTO maint_items (vendor_id, name, unit, every, last_reading, last_day, reading_now, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [v.id, name, unit, every, Number.isInteger(reading) ? reading : null, lastDay, Number.isInteger(reading) ? reading : null, Date.now()]);
  res.status(201).json({ id: x.lastID });
});
// A reading (the generator's hour meter now), or "done" (serviced today at this reading).
router.post('/maint/:id/log', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, b = req.body || {};
  const m = await get('SELECT * FROM maint_items WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), v.id]);
  if (!m) return res.status(404).json({ error: 'Not found.' });
  const reading = b.reading === '' || b.reading === undefined || b.reading === null ? null : parseInt(b.reading, 10);
  if (reading !== null && !(reading >= 0 && reading < 10000000)) return res.status(400).json({ error: 'The reading is a number, like 1240.' });
  if (reading !== null && m.reading_now !== null && reading < m.reading_now && !b.done) return res.status(400).json({ error: `That’s lower than the last reading (${m.reading_now}).` });
  const day = DAY_RE.test(String(b.day || '')) ? String(b.day) : today(v);
  if (b.done) {
    const cost = b.cost === undefined || b.cost === '' ? 0 : cents(b.cost);
    if (cost === null) return res.status(400).json({ error: 'Cost is dollars, like 45.' });
    await run('INSERT INTO maint_logs (vendor_id, item_id, day, reading, cost_cents, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [v.id, m.id, day, reading, cost, cleanText(b.note, 300) || null, Date.now()]);
    await run('UPDATE maint_items SET last_reading = COALESCE(?, reading_now, last_reading), reading_now = COALESCE(?, reading_now), last_day = ? WHERE id = ?', [reading, reading, day, m.id]);
  } else {
    if (reading === null) return res.status(400).json({ error: 'Enter the reading.' });
    await run('UPDATE maint_items SET reading_now = ? WHERE id = ?', [reading, m.id]);
  }
  res.json(maintShape(await get('SELECT * FROM maint_items WHERE id = ?', [m.id]), today(v)));
});
router.delete('/maint/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, id = parseInt(req.params.id, 10);
  await run('DELETE FROM maint_items WHERE id = ? AND vendor_id = ?', [id, v.id]);
  await run('DELETE FROM maint_logs WHERE item_id = ? AND vendor_id = ?', [id, v.id]);
  res.json({ ok: true });
});

/* =========================== Accountant export =========================== */
// Card fees aren't known until the payout; the estimate uses the standard online rate, and says so.
const FEE_PCT = 0.029, FEE_FIXED = 30;
async function booksDays(v, q) {
  const tz = tzOf(v), per = periodOf(q, v);
  const rows = await all(`SELECT created_at, total, payment_status, status, location FROM orders WHERE vendor_id = ? AND created_at >= ? AND created_at < ? AND status != 'Pending'`, [v.id, per.a, per.b]);
  const locs = new Map((await all('SELECT name, tax_rate, tax_included FROM locations WHERE vendor_id = ?', [v.id])).map((l) => [l.name, l]));
  const days = new Map();
  for (const r of rows) {
    const k = Insights.dateKey(Insights.parts(r.created_at, tz));
    const d = days.get(k) || { day: k, orders: 0, grossCents: 0, taxCents: 0, onlineCents: 0, windowCents: 0, refundCents: 0, feeCents: 0 };
    const c = Math.round(r.total * 100);
    if (r.payment_status === 'refunded') { d.refundCents += c; days.set(k, d); continue; }
    if (!['Ready', 'Fulfilled'].includes(r.status)) continue;
    d.orders++; d.grossCents += c;
    const l = locs.get(r.location || '');
    if (l && l.tax_rate !== null) d.taxCents += l.tax_included ? Math.round(c - c / (1 + l.tax_rate / 100)) : Math.round(c * l.tax_rate / 100);
    if (r.payment_status === 'paid') { d.onlineCents += c; d.feeCents += Math.round(c * FEE_PCT + FEE_FIXED); } else d.windowCents += c;
    days.set(k, d);
  }
  return { from: per.from, to: per.to, days: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)) };
}
const $ = (c) => (c / 100).toFixed(2);
router.get('/books', ownerOnly, async (req, res) => res.json(await booksDays(req.tenant.vendor, req.query || {})));
router.get('/books.csv', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, b = await booksDays(v, req.query || {});
  const rows = [['Date', 'Orders', 'Gross sales', 'Sales tax (from your rates)', 'Net sales', 'Paid at the window', 'Paid online', 'Card fees (estimate)', 'Refunds']];
  for (const d of b.days) rows.push([d.day, d.orders, $(d.grossCents), $(d.taxCents), $(d.grossCents - d.taxCents), $(d.windowCents), $(d.onlineCents), $(d.feeCents), $(d.refundCents)]);
  sendCsv(res, `${v.slug}-books-${b.from}-to-${b.to}.csv`, rows);
});
// QuickBooks (and most bookkeeping apps) can import journal entries: one balanced entry per day.
router.get('/journal.csv', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, b = await booksDays(v, req.query || {});
  const rows = [['Journal No', 'Journal Date', 'Account', 'Debits', 'Credits', 'Description']];
  b.days.forEach((d, i) => {
    const no = `OK-${d.day.replace(/-/g, '')}`, memo = `${v.business_name} sales ${d.day}`;
    if (d.windowCents) rows.push([no, d.day, 'Undeposited Funds', $(d.windowCents), '', memo + ' (window)']);
    if (d.onlineCents) rows.push([no, d.day, 'Stripe Clearing', $(d.onlineCents - d.feeCents), '', memo + ' (online, after fees)']);
    if (d.feeCents) rows.push([no, d.day, 'Merchant Fees', $(d.feeCents), '', memo + ' card fees (estimate)']);
    rows.push([no, d.day, 'Sales', '', $(d.grossCents - d.taxCents), memo]);
    if (d.taxCents) rows.push([no, d.day, 'Sales Tax Payable', '', $(d.taxCents), memo + ' sales tax']);
  });
  sendCsv(res, `${v.slug}-journal-${b.from}-to-${b.to}.csv`, rows);
});

/* ======================= Reminders for the morning card ======================= */
async function reminders(v) {
  const t = today(v), out = [];
  const ev = await all("SELECT id, name, deadline_day FROM biz_events WHERE vendor_id = ? AND status = 'idea' AND deadline_day >= ? AND deadline_day <= ?", [v.id, t, addDays(t, 7)]);
  for (const e of ev) { const n = daysBetween(t, e.deadline_day); out.push({ kind: 'event', text: `Application for ${e.name} is due ${n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days'}.` }); }
  for (const m of (await all('SELECT * FROM maint_items WHERE vendor_id = ?', [v.id])).map((x) => maintShape(x, t))) {
    if (m.status === 'overdue') out.push({ kind: 'maint', text: `${m.name} is overdue (${Math.abs(m.left)} ${m.unit} past).` });
    else if (m.status === 'soon') out.push({ kind: 'maint', text: `${m.name} is due in ${m.left} ${m.unit}.` });
  }
  return out;
}

module.exports = { router, bizOpen, reminders, refreshCosts, taxReport, booksDays, eventResult, maintShape };
