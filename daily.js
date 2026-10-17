'use strict';
/* =====================================================================
   The owner's day, without a stream of notifications.
   - One day summary (orders, top item, busiest and slowest hour, what customers said, what sold out,
     tomorrow's weather and prep nudges), by email the next morning or right after close.
   - Quiet hours: no email to the owner from closing until morning; anything that comes in waits.
   - Sold-out history: the first time each item runs out each day, for prep nudges.
   - Weather heads-up for the truck's area (Open-Meteo: free, no key).
   - A morning card in the portal with the same summary, nudges and weather.
   ===================================================================== */
const express = require('express');
const core = require('./core');
const auth = require('./auth');
const inventory = require('./inventory');
const schedule = require('./schedule');
const Insights = require('./public/insights-core');
const Day = require('./public/day-core');
const { run, get, all } = core;
const { requireVendor, requireRole, mailLater, escHtml } = auth;

const router = express.Router();
const ownerOnly = [requireVendor, requireRole('owner')];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SOLD = "status IN ('Fulfilled','Ready') AND COALESCE(payment_status, 'window') != 'pending'";
const pad = (n) => String(n).padStart(2, '0');

/* ---------- settings ---------- */
const DEFAULTS = { on: true, from: 'close', until: '08:00', summary: 'morning' };
function settings(v) {
  let q = {};
  try { q = JSON.parse(v.quiet_json || '{}') || {}; } catch (e) {}
  return Object.assign({}, DEFAULTS, q);
}
function place(v) { try { return JSON.parse(v.weather_json || 'null'); } catch (e) { return null; } }
const tzOf = (v) => Insights.validTz(v.timezone);
const keyOf = (ms, tz) => Insights.dateKey(Insights.parts(ms, tz));
function addDays(key, n) { const [y, m, d] = key.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
function dayBounds(key, tz) { const [y, m, d] = key.split('-').map(Number); return [Insights.zonedStart(y, m, d, tz), Insights.zonedStart(y, m, d + 1, tz)]; }
function closingTime(v, ms) {
  const h = core.parseHours(v.hours_json);
  if (!h) return null;
  const today = h[Insights.parts(ms, tzOf(v)).wd];
  return today && !today.closed ? today.close : null;
}

/** 0 if the owner can be emailed now, else when quiet hours end. */
function quietUntil(v, now = Date.now()) { return Day.quietUntil(settings(v), now, tzOf(v), closingTime(v, now)); }

/**
 * Email to the owner that respects quiet hours: held until morning, or dropped if it would be
 * useless by then (a "nobody is watching the kitchen" alert).
 */
async function ownerMail(v, msg, { dropIfQuiet = false, staleAfterMs } = {}) {
  // A second truck in a fleet has no email of its own: its owner's mail goes to the first truck's email.
  const to = v && (await require('./fleet').ownerEmail(v));
  if (!to) return false;
  const until = quietUntil(v);
  if (until) {
    if (dropIfQuiet) return false;
    return mailLater(Object.assign({}, msg, { to }), { notBefore: until });
  }
  return mailLater(Object.assign({}, msg, { to }), { staleAfterMs });
}

/* ---------- sold-out history ----------
   Watches what the pages are told. Only a real change while the truck is open counts (available, then
   sold out), so an item left switched off since yesterday never looks like it "sold out at 9 AM". */
const lastOut = new Map();
async function seed(vendorId) {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [vendorId]);
  if (!v) return;
  for (const m of await inventory.menuFor(v)) lastOut.set(`${vendorId}:${m.id}`, !!m.soldOut);
}
async function observe(vendorId, list) {
  let state = null;
  for (const it of list) {
    const k = `${vendorId}:${it.id}`;
    const before = lastOut.get(k);
    lastOut.set(k, !!it.soldOut);
    if (before !== false || !it.soldOut) continue;
    state = state || (await core.getState(vendorId));
    if (state.status !== 'open') continue;
    const v = await get('SELECT timezone, menu_data FROM vendors WHERE id = ?', [vendorId]);
    const name = it.name || ((core.parseMenu(v.menu_data).find((m) => m.id === it.id) || {}).name);
    if (!name) continue;
    const now = Date.now();
    await run('INSERT OR IGNORE INTO soldout_log (vendor_id, item_id, name, day, at) VALUES (?, ?, ?, ?, ?)', [vendorId, it.id, name, keyOf(now, tzOf(v)), now]);
  }
}
function watchSoldOut() {
  core.onBroadcast((vendorId, type, p) => {
    if (type === 'SOLD_OUT' && p) observe(vendorId, [{ id: p.itemId, soldOut: p.soldOut }]).catch(() => {});
    else if (type === 'MENU_UPDATE' && p && Array.isArray(p.menu)) observe(vendorId, p.menu.map((m) => ({ id: m.id, name: m.name, soldOut: m.soldOut }))).catch(() => {});
    else if (type === 'STORE_STATUS' && p && p.status === 'open') seed(vendorId).catch(() => {});
  });
}

async function nudgesFor(v, key) {
  const tz = tzOf(v);
  const [from] = dayBounds(addDays(key, -35), tz);
  const rows = await all('SELECT item_id AS itemId, name, at FROM soldout_log WHERE vendor_id = ? AND at >= ?', [v.id, from]);
  return Day.prepNudges(rows, key, tz);
}

/* ---------- weather (Open-Meteo, no key) ---------- */
const forecasts = new Map(); // vendorId -> { at, days }
async function geocode(q) {
  const u = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(q)}`;
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('geocode ' + r.status);
  const d = await r.json();
  const g = d && d.results && d.results[0];
  return g ? { q, name: [g.name, g.admin1].filter(Boolean).join(', '), lat: g.latitude, lon: g.longitude } : null;
}
async function forecastFor(v) {
  const p = place(v);
  if (!p) return null;
  const hit = forecasts.get(v.id);
  if (hit && Date.now() - hit.at < 3 * 3600000 && hit.key === p.lat + ',' + p.lon) return hit.days;
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&daily=precipitation_probability_max,temperature_2m_max,temperature_2m_min,wind_speed_10m_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=3`;
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('forecast ' + r.status);
    const d = (await r.json()).daily || {};
    const days = (d.time || []).map((date, i) => ({ date, rainPct: (d.precipitation_probability_max || [])[i] || 0, maxF: (d.temperature_2m_max || [])[i], minF: (d.temperature_2m_min || [])[i], windMph: (d.wind_speed_10m_max || [])[i] || 0 }));
    forecasts.set(v.id, { at: Date.now(), days, key: p.lat + ',' + p.lon });
    return days;
  } catch (e) { return hit ? hit.days : null; } // weather is a nicety: never an error
}
async function weatherFor(v, key, when) {
  const days = await forecastFor(v);
  const d = days && days.find((x) => x.date === key);
  return d ? Day.weatherHeadsUp(d, when) : null;
}

/* ---------- the day summary ---------- */
async function feedbackRows(vendorId, from, to) {
  const rows = await all('SELECT vote, tags, comment, items, at FROM order_feedback WHERE vendor_id = ? AND at >= ? AND at < ?', [vendorId, from, to]);
  return rows.map((r) => ({ vote: r.vote, tags: safe(r.tags), comment: r.comment || '', items: safe(r.items), at: r.at }));
}
function safe(j) { try { return JSON.parse(j || '[]') || []; } catch (e) { return []; } }

async function buildSummary(v, key) {
  const tz = tzOf(v);
  const [from, to] = dayBounds(key, tz);
  const [lwFrom, lwTo] = dayBounds(addDays(key, -7), tz);
  const rows = await all(`SELECT created_at, total, items_json FROM orders WHERE vendor_id = ? AND ${SOLD} AND created_at >= ? AND created_at < ?`, [v.id, from, to]);
  const last = await get(`SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS total FROM orders WHERE vendor_id = ? AND ${SOLD} AND created_at >= ? AND created_at < ?`, [v.id, lwFrom, lwTo]);
  const shaped = rows.map((r) => ({ t: r.created_at, cents: Math.round(r.total * 100), items: safe(r.items_json) }));
  const t = Insights.totals(shaped);
  const items = {};
  shaped.forEach((r) => r.items.forEach((i) => { const k = Insights.baseName(i.name); items[k] = (items[k] || 0) + (i.qty || 0); }));
  const topName = Object.keys(items).sort((a, b) => items[b] - items[a])[0];
  const hours = new Array(24).fill(0);
  shaped.forEach((r) => { hours[Insights.parts(r.t, tz).h]++; });
  const used = hours.map((n, h) => (n ? h : -1)).filter((h) => h >= 0);
  let busiest = null, slowest = null;
  if (used.length) {
    busiest = hours.indexOf(Math.max(...hours));
    // The slow hour: the quietest full hour between the first and the last order.
    for (let h = used[0]; h <= used[used.length - 1]; h++) if (slowest === null || hours[h] < hours[slowest]) slowest = h;
  }
  const fb = await feedbackRows(v.id, from, to);
  const sold = await all('SELECT name, at FROM soldout_log WHERE vendor_id = ? AND day = ? ORDER BY at', [v.id, key]);
  const next = addDays(key, 1);
  const stops = await schedule.upcoming(v.id, tz, 8).catch(() => []);
  const stop = stops.find((s) => s.day >= next);
  return {
    day: key,
    weekday: WEEKDAYS[Insights.parts(from + 12 * 3600000, tz).wd],
    orders: t.orders, cents: t.cents, avgCents: t.avgCents,
    top: topName ? { name: topName, qty: items[topName] } : null,
    busiest, slowest,
    lastWeek: { orders: last.orders, cents: Math.round(last.total * 100) },
    feedback: Object.assign(Day.feedbackPatterns(fb, [], tz), { comments: undefined }),
    soldOut: sold.map((s) => { const p = Insights.parts(s.at, tz); return { name: s.name, time: Day.clock(p.h * 60 + p.min) }; }),
    tomorrow: {
      day: next,
      nudges: await nudgesFor(v, next),
      weather: await weatherFor(v, next, 'tomorrow'),
      stop: stop ? { day: stop.day, start: stop.start, end: stop.end, location: stop.location } : null,
    },
  };
}

function summaryEmail(v, s) {
  const lines = Day.summaryLines(s);
  const more = [];
  if (s.tomorrow.stop) more.push(`Next: ${s.tomorrow.stop.day === s.tomorrow.day ? 'tomorrow' : s.tomorrow.stop.day} ${s.tomorrow.stop.start}–${s.tomorrow.stop.end} at ${s.tomorrow.stop.location}`);
  if (s.tomorrow.weather) more.push(s.tomorrow.weather.text);
  s.tomorrow.nudges.slice(0, 2).forEach((n) => more.push(n.text.replace(/^You/, 'For tomorrow: you')));
  const url = auth.vendorUrl(v.slug, '/owner.html');
  const title = `${s.weekday}: ${s.orders} order${s.orders === 1 ? '' : 's'}, $${(s.cents / 100).toFixed(2)}`;
  return {
    subject: `${v.business_name} · ${title}`,
    text: `${lines.join('\n')}${more.length ? '\n\n' + more.join('\n') : ''}\n\nInsights: ${url}\n\nOne summary a day. Change when it comes (or turn it off) in Settings → Your day.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
<h2 style="margin:0 0 10px;font-size:18px">${escHtml(title)}</h2>
${lines.slice(1).map((l) => `<p style="margin:4px 0;font-size:14px">${escHtml(l)}</p>`).join('')}
${more.length ? `<div style="margin-top:14px;padding-top:10px;border-top:1px solid #ddd">${more.map((l) => `<p style="margin:4px 0;font-size:14px">${escHtml(l)}</p>`).join('')}</div>` : ''}
<p style="margin-top:16px"><a href="${url}" style="color:#111">Open Insights</a></p>
<p style="color:#777;font-size:12px">One summary a day. Change when it comes, or turn it off, in Settings → Your day.</p></div>`,
  };
}

/** Builds and sends one day's summary, once (the row is the claim). */
async function sendSummary(v, key) {
  const s = await buildSummary(v, key);
  const r = await run('INSERT OR IGNORE INTO day_summaries (vendor_id, day, body) VALUES (?, ?, ?)', [v.id, key, JSON.stringify(s)]);
  if (!r.changes) return false;
  const to = await require('./fleet').ownerEmail(v);
  if (!s.orders || !to) return false;
  const m = summaryEmail(v, s);
  await mailLater(Object.assign({ to, idempotencyKey: `sum-${v.id}-${key}` }, m));
  await run('UPDATE day_summaries SET sent_at = ? WHERE vendor_id = ? AND day = ?', [Date.now(), v.id, key]);
  return true;
}

/** Runs every minute: sends any summary that's due. */
async function sweep(now = Date.now()) {
  const vendors = await all(`SELECT DISTINCT v.* FROM vendors v JOIN orders o ON o.vendor_id = v.id
    WHERE v.status = 'active' AND o.created_at > ? AND o.status IN ('Fulfilled','Ready') AND COALESCE(o.payment_status, 'window') != 'pending'`, [now - 40 * 3600000]);
  let sent = 0;
  for (const v of vendors) {
    const q = settings(v);
    if (q.summary === 'off') continue;
    const tz = tzOf(v), p = Insights.parts(now, tz), today = Insights.dateKey(p), yesterday = addDays(today, -1);
    const nowM = p.h * 60 + p.min;
    const um = /^(\d\d):(\d\d)$/.test(q.until) ? +q.until.slice(0, 2) * 60 + +q.until.slice(3) : 480;
    if (q.summary === 'close') {
      // Right after close: the truck is closed and the last order is 20 minutes old.
      const st = await core.getState(v.id);
      const [from] = dayBounds(today, tz);
      const lastOrder = await get(`SELECT MAX(created_at) AS t FROM orders WHERE vendor_id = ? AND ${SOLD} AND created_at >= ?`, [v.id, from]);
      if (st.status === 'closed' && lastOrder.t && now - lastOrder.t > 20 * 60000 && (await sendSummary(v, today))) sent++;
    }
    // Morning (and the back-up for "after close" if the truck never closed): yesterday, once it's morning.
    if (nowM >= um && (await sendSummary(v, yesterday))) sent++;
  }
  return sent;
}

/* ---------- routes ---------- */
router.get('/owner/settings', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  res.json({ quiet: settings(v), weather: place(v) });
});

router.put('/owner/settings', ownerOnly, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const b = req.body || {};
  const q = settings(v);
  const T = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (b.quiet) {
    if (b.quiet.on !== undefined) q.on = !!b.quiet.on;
    if (b.quiet.from !== undefined) { if (b.quiet.from !== 'close' && !T.test(b.quiet.from)) return res.status(400).json({ error: 'Pick when quiet hours start.' }); q.from = b.quiet.from; }
    if (b.quiet.until !== undefined) { if (!T.test(b.quiet.until)) return res.status(400).json({ error: 'Pick when quiet hours end.' }); q.until = b.quiet.until; }
    if (b.quiet.summary !== undefined) { if (!['morning', 'close', 'off'].includes(b.quiet.summary)) return res.status(400).json({ error: 'Pick when the day summary comes.' }); q.summary = b.quiet.summary; }
  }
  let w = place(v);
  if (b.weather !== undefined) {
    const text = String(b.weather || '').trim().slice(0, 80);
    if (!text) w = null;
    else {
      let g = null;
      try { g = await geocode(text); } catch (e) { return res.status(502).json({ error: 'Couldn’t look that up just now. Try again in a minute.' }); }
      if (!g) return res.status(400).json({ error: 'We couldn’t find that place. Try a city and state, like “Tempe, AZ”.' });
      w = g;
    }
    forecasts.delete(v.id);
  }
  await run('UPDATE vendors SET quiet_json = ?, weather_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(q), w ? JSON.stringify(w) : null, Date.now(), v.id]);
  res.json({ quiet: q, weather: w });
});

// The morning card: the last day's summary (if it's recent), today's prep nudges, the weather.
router.get('/owner/brief', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const tz = tzOf(v), now = Date.now(), today = keyOf(now, tz);
  res.set('Cache-Control', 'no-store');
  const lastDay = await get(`SELECT MAX(created_at) AS t FROM orders WHERE vendor_id = ? AND ${SOLD} AND created_at < ? AND created_at > ?`, [v.id, dayBounds(today, tz)[0], now - 3 * 864e5]);
  let summary = null;
  if (lastDay && lastDay.t) {
    const key = keyOf(lastDay.t, tz);
    const kept = await get('SELECT body FROM day_summaries WHERE vendor_id = ? AND day = ?', [v.id, key]);
    summary = kept ? JSON.parse(kept.body) : await buildSummary(v, key);
    summary.lines = Day.summaryLines(summary);
  }
  const tomorrow = addDays(today, 1);
  // Business reminders: an application deadline, maintenance coming due, a permit about to expire.
  const reminders = (await require('./business').reminders(v).catch(() => []))
    .concat((await require('./vault').expiring(v).catch(() => [])).map((d) => ({ kind: 'doc', text: d.daysLeft < 0 ? `${d.title} has expired.` : `${d.title} expires in ${d.daysLeft} day${d.daysLeft === 1 ? '' : 's'}.` })));
  res.json({
    today,
    summary,
    nudges: await nudgesFor(v, today),
    weather: (await weatherFor(v, today, 'today')) || (await weatherFor(v, tomorrow, 'tomorrow')),
    place: place(v),
    reminders: reminders.slice(0, 4),
  });
});

function start() {
  watchSoldOut();
  all("SELECT id FROM vendors WHERE status = 'active'").then((rows) => rows.forEach((r) => seed(r.id).catch(() => {}))).catch(() => {});
  setInterval(() => sweep().catch((e) => console.error('day summary:', e.message)), 60 * 1000).unref();
}

module.exports = { router, start, sweep, sendSummary, buildSummary, ownerMail, quietUntil, settings, observe, seed, nudgesFor, forecastFor, geocode, lastOut };
