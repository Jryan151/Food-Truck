'use strict';
/* =====================================================================
   More than one truck, one owner. Each truck runs on its own (own page, menu, kitchen screen, crew),
   and the owner sees one combined summary and moves between trucks in one tap.
   A fleet is the first truck plus the trucks added from it (vendors.fleet_id = the first truck's id).
   Added trucks share the owner's login: the email and password open any truck in the fleet.
   ===================================================================== */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const core = require('./core');
const auth = require('./auth');
const Insights = require('./public/insights-core');
const { run, get, all } = core;
const { requireVendor, requireRole } = auth;

const router = express.Router();
const betaOpen = () => process.env.FREE_BETA === 'true' || !(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
const gate = (req, res, next) => (core.features(req.tenant.vendor).business || betaOpen() ? next() : res.status(402).json({ error: 'More than one truck is part of the Business plan.', upgrade: true }));
const ownerOnly = [requireVendor, requireRole('owner'), gate];
const MAX_TRUCKS = 10;
const SOLD = "status IN ('Fulfilled','Ready') AND COALESCE(payment_status, 'window') != 'pending'";

const fleetIdOf = (v) => v.fleet_id || v.id;
async function trucksOf(v) {
  const id = fleetIdOf(v);
  return all('SELECT * FROM vendors WHERE id = ? OR fleet_id = ? ORDER BY id', [id, id]);
}
/** The owner's email for any truck in a fleet (added trucks have no email of their own). */
async function ownerEmail(v) {
  if (v.email) return v.email;
  if (!v.fleet_id) return null;
  const first = await get('SELECT email FROM vendors WHERE id = ?', [v.fleet_id]);
  return first ? first.email : null;
}
/** May this login (the first truck's email) open truck t? */
async function sameFleet(loginVendor, t) {
  return !!(loginVendor && t && loginVendor.id !== t.id && fleetIdOf(t) === fleetIdOf(loginVendor) && t.status === 'active');
}

router.get('/', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const trucks = await trucksOf(v);
  const now = Date.now();
  const out = [];
  for (const t of trucks) {
    const tz = Insights.validTz(t.timezone), p = Insights.parts(now, tz);
    const dayFrom = Insights.zonedStart(p.y, p.m, p.d, tz), weekFrom = Insights.zonedStart(p.y, p.m, p.d - 6, tz);
    const today = await get(`SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS s FROM orders WHERE vendor_id = ? AND ${SOLD} AND created_at >= ?`, [t.id, dayFrom]);
    const week = await get(`SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS s FROM orders WHERE vendor_id = ? AND ${SOLD} AND created_at >= ?`, [t.id, weekFrom]);
    const st = await core.getState(t.id);
    const line = await get("SELECT COUNT(*) AS n FROM orders WHERE vendor_id = ? AND status = 'Preparing'", [t.id]);
    out.push({ id: t.id, name: t.business_name, slug: t.slug, current: t.id === v.id, status: t.status, open: st.status === 'open' && !st.paused, location: st.location || '', line: line.n,
      today: { orders: today.n, cents: Math.round(today.s * 100) }, week: { orders: week.n, cents: Math.round(week.s * 100) } });
  }
  res.json({ trucks: out, max: MAX_TRUCKS, totals: { today: { orders: out.reduce((n, x) => n + x.today.orders, 0), cents: out.reduce((n, x) => n + x.today.cents, 0) }, week: { orders: out.reduce((n, x) => n + x.week.orders, 0), cents: out.reduce((n, x) => n + x.week.cents, 0) } } });
});

// Add a truck: its own web address and kitchen; it starts with a copy of this truck's menu and hours.
router.post('/trucks', ownerOnly, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const b = req.body || {};
  const name = String(b.businessName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (name.length < 2) return res.status(400).json({ error: 'Name the new truck.' });
  const s = core.validateSlug(b.slug);
  if (!s.ok) return res.status(400).json({ error: s.error, field: 'slug' });
  if ((await trucksOf(v)).length >= MAX_TRUCKS) return res.status(400).json({ error: `Up to ${MAX_TRUCKS} trucks. Email us for more.` });
  if (await get('SELECT id FROM vendors WHERE slug = ?', [s.slug])) return res.status(409).json({ error: 'That web address is taken. Pick another.', field: 'slug' });
  const fleet = fleetIdOf(v);
  if (!v.fleet_id) await run('UPDATE vendors SET fleet_id = ? WHERE id = ?', [v.id, v.id]); // the first truck leads the fleet
  const staffPin = String(crypto.randomInt(1000, 10000));
  const now = Date.now();
  let r;
  try {
    r = await run(`INSERT INTO vendors (slug, business_name, menu_data, email, password_hash, staff_pin_hash, owner_name, owner_ig, status, plan, plan_status, email_verified,
        timezone, hours_json, emoji, logo_url, brand_color, fleet_id, updated_at, terms_accepted_at)
      VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'active', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [s.slug, name, b.copyMenu === false ? JSON.stringify(core.normalizeMenu(core.DEFAULT_MENU)) : v.menu_data, await bcrypt.hash(staffPin, 10), v.owner_name, v.owner_ig || '',
        v.plan, v.plan_status, v.timezone, v.hours_json, v.emoji, v.logo_url, v.brand_color, fleet, now, now]);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ error: 'That web address is taken. Pick another.', field: 'slug' });
    throw e;
  }
  await run('INSERT OR IGNORE INTO store_state (vendor_id, status) VALUES (?, ?)', [r.lastID, 'closed']);
  res.status(201).json({ id: r.lastID, slug: s.slug, staffPin, url: auth.vendorUrl(s.slug, '/owner.html') });
});

// Move to another truck: a one-time code opens its kitchen portal, already signed in.
router.post('/open/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const t = await get('SELECT * FROM vendors WHERE id = ?', [parseInt(req.params.id, 10)]);
  if (!t || fleetIdOf(t) !== fleetIdOf(v) || t.status !== 'active') return res.status(404).json({ error: 'Truck not found.' });
  const code = await core.createToken(t.id, 'handoff', 2 * 60 * 1000);
  res.json({ url: auth.vendorUrl(t.slug, `/api/auth/handoff?code=${code}`) });
});

module.exports = { router, ownerEmail, sameFleet, fleetIdOf, trucksOf };
