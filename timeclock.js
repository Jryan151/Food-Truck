'use strict';
/* =====================================================================
   Staff schedule and time clock.
   - The owner posts shifts and sets each person's hourly pay.
   - Crew clock in and out on the kitchen tablet with their own PIN (one tap).
   - Hours for payroll by week (overtime past 40 hours), labor cost per day next to sales.
   ===================================================================== */
const express = require('express');
const core = require('./core');
const auth = require('./auth');
const Insights = require('./public/insights-core');
const { run, get, all } = core;
const { requireVendor, requireRole, getSession } = auth;

const router = express.Router();
const betaOpen = () => process.env.FREE_BETA === 'true' || !(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
const gate = (req, res, next) => (core.features(req.tenant.vendor).business || betaOpen() ? next() : res.status(402).json({ error: 'This is part of the Business plan.', upgrade: true }));
const ownerOnly = [requireVendor, requireRole('owner'), gate];
const crew = [requireVendor, requireRole('owner', 'staff'), gate];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_SHIFT_MS = 16 * 60 * 60 * 1000;
const tzOf = (v) => Insights.validTz(v.timezone);
const keyOf = (ms, tz) => Insights.dateKey(Insights.parts(ms, tz));
function addDays(key, n) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function weekStart(key) { const [y, m, d] = key.split('-').map(Number); const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return addDays(key, -((wd + 6) % 7)); } // Monday
function bounds(key, tz) { const [y, m, d] = key.split('-').map(Number); return [Insights.zonedStart(y, m, d, tz), Insights.zonedStart(y, m, d + 1, tz)]; }
const hours = (ms) => Math.round((ms / 3600000) * 100) / 100;

// The kitchen tablet: am I on the clock, and what's my shift today?
router.get('/me', crew, async (req, res) => {
  const v = req.tenant.vendor;
  const s = await getSession(req);
  if (!s || !s.staff_id) return res.json({ person: false });
  const open = await get('SELECT in_at FROM time_entries WHERE vendor_id = ? AND staff_id = ? AND out_at IS NULL ORDER BY in_at DESC LIMIT 1', [v.id, s.staff_id]);
  const t = keyOf(Date.now(), tzOf(v));
  const shift = await get('SELECT start_time, end_time FROM shifts WHERE vendor_id = ? AND staff_id = ? AND day = ? ORDER BY start_time LIMIT 1', [v.id, s.staff_id, t]);
  res.json({ person: true, name: s.staff_name, inSince: open ? open.in_at : null, shift: shift ? { start: shift.start_time, end: shift.end_time } : null });
});
router.post('/punch', crew, async (req, res) => {
  const v = req.tenant.vendor;
  const s = await getSession(req);
  if (!s || !s.staff_id) return res.status(403).json({ error: 'Sign in with your own PIN to clock in.' });
  const action = (req.body || {}).action;
  const now = Date.now();
  const open = await get('SELECT * FROM time_entries WHERE vendor_id = ? AND staff_id = ? AND out_at IS NULL ORDER BY in_at DESC LIMIT 1', [v.id, s.staff_id]);
  if (action === 'in') {
    if (open) return res.status(409).json({ error: 'You’re already clocked in.', inSince: open.in_at });
    const m = await get('SELECT wage_cents FROM staff_members WHERE id = ?', [s.staff_id]);
    await run('INSERT INTO time_entries (vendor_id, staff_id, in_at, wage_cents) VALUES (?, ?, ?, ?)', [v.id, s.staff_id, now, m ? m.wage_cents : null]);
    core.logOrderEvent(v.id, 0, 'clock-in', s.staff_name || 'staff');
    return res.json({ inSince: now });
  }
  if (action === 'out') {
    if (!open) return res.status(409).json({ error: 'You’re not clocked in.' });
    await run('UPDATE time_entries SET out_at = ? WHERE id = ? AND out_at IS NULL', [now, open.id]);
    core.logOrderEvent(v.id, 0, 'clock-out', s.staff_name || 'staff');
    return res.json({ inSince: null, worked: hours(now - open.in_at) });
  }
  res.status(400).json({ error: 'Clock in or out?' });
});

/* ----- the owner's side ----- */
router.put('/wage/:staffId', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const w = Number((req.body || {}).wage);
  const c = (req.body || {}).wage === '' || (req.body || {}).wage === null ? null : Math.round(w * 100);
  if (c !== null && !(c >= 0 && c <= 50000)) return res.status(400).json({ error: 'Hourly pay in dollars, like 17.50.' });
  const r = await run('UPDATE staff_members SET wage_cents = ? WHERE id = ? AND vendor_id = ?', [c, parseInt(req.params.staffId, 10), v.id]);
  if (!r.changes) return res.status(404).json({ error: 'Crew member not found.' });
  // Open and future entries use the new pay; finished ones keep what they were paid at.
  await run('UPDATE time_entries SET wage_cents = ? WHERE staff_id = ? AND vendor_id = ? AND out_at IS NULL', [c, parseInt(req.params.staffId, 10), v.id]);
  res.json({ ok: true });
});

router.get('/week', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, tz = tzOf(v);
  const start = weekStart(DAY_RE.test(String(req.query.week || '')) ? String(req.query.week) : keyOf(Date.now(), tz));
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i));
  const people = await all('SELECT id, name, wage_cents FROM staff_members WHERE vendor_id = ? ORDER BY name', [v.id]);
  const shifts = await all('SELECT * FROM shifts WHERE vendor_id = ? AND day >= ? AND day <= ? ORDER BY day, start_time', [v.id, days[0], days[6]]);
  const [a] = bounds(days[0], tz), [, b] = bounds(days[6], tz);
  const entries = await all('SELECT * FROM time_entries WHERE vendor_id = ? AND in_at >= ? AND in_at < ? ORDER BY in_at', [v.id, a, b]);
  const now = Date.now();
  const out = people.map((p) => {
    const mine = entries.filter((e) => e.staff_id === p.id);
    const ms = mine.reduce((n, e) => n + Math.min((e.out_at || now) - e.in_at, MAX_SHIFT_MS), 0);
    const h = hours(ms), ot = Math.max(0, Math.round((h - 40) * 100) / 100);
    const wage = p.wage_cents;
    // Overtime is paid at time and a half (the federal rule; some states also count daily overtime).
    const pay = wage === null ? null : Math.round((h - ot) * wage + ot * wage * 1.5);
    return {
      id: p.id, name: p.name, wageCents: wage, hours: h, overtime: ot, payCents: pay,
      open: mine.some((e) => !e.out_at), long: mine.some((e) => !e.out_at && now - e.in_at > 12 * 3600000),
      entries: mine.map((e) => ({ id: e.id, inAt: e.in_at, outAt: e.out_at, day: keyOf(e.in_at, tz) })),
      shifts: shifts.filter((s) => s.staff_id === p.id).map((s) => ({ id: s.id, day: s.day, start: s.start_time, end: s.end_time })),
    };
  });
  res.json({ week: start, days, people: out, totals: { hours: Math.round(out.reduce((n, p) => n + p.hours, 0) * 100) / 100, payCents: out.reduce((n, p) => n + (p.payCents || 0), 0) } });
});

router.post('/shifts', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, b = req.body || {};
  const staff = await get('SELECT id FROM staff_members WHERE id = ? AND vendor_id = ?', [parseInt(b.staffId, 10), v.id]);
  if (!staff) return res.status(400).json({ error: 'Pick who works it.' });
  if (!DAY_RE.test(String(b.day || '')) || !TIME_RE.test(String(b.start || '')) || !TIME_RE.test(String(b.end || ''))) return res.status(400).json({ error: 'Pick the day, start and end.' });
  if (b.end <= b.start) return res.status(400).json({ error: 'The shift ends before it starts.' });
  const x = await run('INSERT INTO shifts (vendor_id, staff_id, day, start_time, end_time) VALUES (?, ?, ?, ?, ?)', [v.id, staff.id, b.day, b.start, b.end]);
  res.status(201).json({ id: x.lastID });
});
router.delete('/shifts/:id', ownerOnly, async (req, res) => {
  await run('DELETE FROM shifts WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), req.tenant.vendor.id]);
  res.json({ ok: true });
});
// Fix a forgotten clock-out (or a wrong time): the owner's change is recorded on the entry.
router.put('/entries/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, b = req.body || {};
  const e = await get('SELECT * FROM time_entries WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), v.id]);
  if (!e) return res.status(404).json({ error: 'Not found.' });
  const inAt = b.inAt !== undefined ? Number(b.inAt) : e.in_at;
  const outAt = b.outAt !== undefined ? (b.outAt === null ? null : Number(b.outAt)) : e.out_at;
  if (!Number.isFinite(inAt) || (outAt !== null && (!Number.isFinite(outAt) || outAt <= inAt || outAt - inAt > MAX_SHIFT_MS))) return res.status(400).json({ error: 'Clock-out must be after clock-in, within 16 hours.' });
  await run('UPDATE time_entries SET in_at = ?, out_at = ?, edited_by = ? WHERE id = ?', [inAt, outAt, 'owner', e.id]);
  res.json({ ok: true });
});
router.delete('/entries/:id', ownerOnly, async (req, res) => {
  await run('DELETE FROM time_entries WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), req.tenant.vendor.id]);
  res.json({ ok: true });
});

/** Labor cost per day (for Insights): hours worked that day × each entry's pay. */
async function laborByDay(v, fromKey, toKey) {
  const tz = tzOf(v);
  const [a] = bounds(fromKey, tz), [, b] = bounds(toKey, tz);
  const rows = await all('SELECT in_at, out_at, wage_cents FROM time_entries WHERE vendor_id = ? AND in_at >= ? AND in_at < ?', [v.id, a, b]);
  const now = Date.now(), days = {};
  for (const e of rows) {
    const k = keyOf(e.in_at, tz), ms = Math.min((e.out_at || now) - e.in_at, MAX_SHIFT_MS);
    const d = days[k] || (days[k] = { day: k, hours: 0, cents: 0, unpaid: 0 });
    d.hours = Math.round((d.hours + ms / 3600000) * 100) / 100;
    if (e.wage_cents === null) d.unpaid++; else d.cents += Math.round((ms / 3600000) * e.wage_cents);
  }
  return days;
}
router.get('/labor', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, tz = tzOf(v);
  const from = DAY_RE.test(String(req.query.from || '')) ? String(req.query.from) : keyOf(Date.now(), tz);
  const to = DAY_RE.test(String(req.query.to || '')) ? String(req.query.to) : from;
  const days = await laborByDay(v, from, to);
  const list = Object.values(days);
  res.json({ from, to, days: list, cents: list.reduce((n, d) => n + d.cents, 0), hours: Math.round(list.reduce((n, d) => n + d.hours, 0) * 100) / 100, missingPay: list.some((d) => d.unpaid) });
});

router.get('/payroll.csv', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, tz = tzOf(v);
  const start = weekStart(DAY_RE.test(String(req.query.week || '')) ? String(req.query.week) : keyOf(Date.now(), tz));
  const end = addDays(start, 6);
  const [a] = bounds(start, tz), [, b] = bounds(end, tz);
  const rows = await all('SELECT t.*, m.name FROM time_entries t JOIN staff_members m ON m.id = t.staff_id WHERE t.vendor_id = ? AND t.in_at >= ? AND t.in_at < ? ORDER BY m.name, t.in_at', [v.id, a, b]);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const cell = (x) => { const s = String(x == null ? '' : x); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [['Name', 'Date', 'In', 'Out', 'Hours', 'Hourly pay', 'Edited by owner'].join(',')];
  for (const e of rows) lines.push([e.name, keyOf(e.in_at, tz), fmt.format(new Date(e.in_at)), e.out_at ? fmt.format(new Date(e.out_at)) : 'still in', e.out_at ? hours(e.out_at - e.in_at).toFixed(2) : '', e.wage_cents === null ? '' : (e.wage_cents / 100).toFixed(2), e.edited_by ? 'yes' : ''].map(cell).join(','));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${v.slug}-hours-${start}.csv"`, 'Cache-Control': 'no-store' });
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

module.exports = { router, laborByDay, weekStart };
