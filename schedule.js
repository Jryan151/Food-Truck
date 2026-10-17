/* schedule.js — where the truck will be, and the people who want to know.
   - Owner posts stops (date, hours, place). "Repeat weekly" builds a regular route in one go.
   - Customers see /schedule, add a stop to their calendar, or subscribe to a calendar feed that
     updates itself (no app, no texts).
   - Follow by email: double opt-in, pick which spots you care about, one-click unsubscribe.
     Followers only hear from the truck when the owner taps a button, never automatically. */
'use strict';
const express = require('express');
const crypto = require('crypto');
const core = require('./core');
const auth = require('./auth');
const Insights = require('./public/insights-core');
const { run, get, all } = core;
const { requireVendor, requireRole, rateLimit, mailLater, mailConfigured, escHtml, EMAIL_RE } = auth;

const router = express.Router();
const ownerOnly = [requireVendor, requireRole('owner')];

const MAX_UPCOMING = 200;
const MAX_REPEAT_WEEKS = 12;
const OPEN_EVERY_MS = 6 * 60 * 60 * 1000;     // "We're open" at most every 6 hours
const WEEK_EVERY_MS = 3 * 24 * 60 * 60 * 1000; // the week's schedule at most every 3 days
const CONFIRM_RESEND_MS = 60 * 1000;

/* ---------- small helpers ---------- */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const pad = (n) => String(n).padStart(2, '0');

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
function today(tz) { return Insights.dateKey(Insights.parts(Date.now(), tz)); }
function time12(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + pad(m) : ''} ${h < 12 ? 'AM' : 'PM'}`;
}
function dayName(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
/** UTC start and end of a stop. An end at or before the start means it runs past midnight. */
function stopTimes(s, tz) {
  const at = (dayKey, hhmm) => {
    const [y, m, d] = dayKey.split('-').map(Number);
    const [h, mi] = hhmm.split(':').map(Number);
    return Insights.zonedTime(y, m, d, h, mi, tz);
  };
  const start = at(s.day, s.start_time);
  const end = s.end_time > s.start_time ? at(s.day, s.end_time) : at(addDays(s.day, 1), s.end_time);
  return { start, end };
}

const stopShape = (s, tz) => {
  const t = stopTimes(s, tz);
  return {
    id: s.id, day: s.day, start: s.start_time, end: s.end_time, location: s.location, address: s.address || '', note: s.note || '',
    series: s.series || null, startsAt: t.start, endsAt: t.end, label: `${time12(s.start_time)} – ${time12(s.end_time)}`, dayLabel: dayName(s.day),
  };
};

async function upcoming(vendorId, tz, days = 90) {
  const from = today(tz);
  const rows = await all('SELECT * FROM schedule_stops WHERE vendor_id = ? AND day >= ? AND day <= ? ORDER BY day, start_time LIMIT ?',
    [vendorId, from, addDays(from, days), MAX_UPCOMING]);
  const now = Date.now();
  return rows.map((s) => stopShape(s, tz)).filter((s) => s.endsAt > now); // today's stops drop off once they're over
}

const origin = (req) => `${req.secure ? 'https' : 'http'}://${req.tenant.host}`;

/* ---------- public ---------- */
router.get('/', requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const tz = Insights.validTz(v.timezone);
  res.set('Cache-Control', 'no-store');
  res.json({ stops: await upcoming(v.id, tz), timezone: tz, followEnabled: mailConfigured(), locations: await followLocations(v.id) });
});

// Locations a follower can pick: the truck's saved ones plus anything on the schedule.
async function followLocations(vendorId) {
  const a = await all('SELECT name FROM locations WHERE vendor_id = ? AND deleted = 0', [vendorId]);
  const b = await all('SELECT DISTINCT location AS name FROM schedule_stops WHERE vendor_id = ?', [vendorId]);
  return [...new Set(a.concat(b).map((r) => r.name).filter(Boolean))];
}

/* ----- calendar files ----- */
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// Lines longer than 75 bytes are folded (RFC 5545); calendar apps reject the file otherwise.
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function icsFor(v, req, stops, { feed }) {
  const host = req.tenant.host;
  const name = v.business_name;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Online Kitchen//Truck schedule//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (feed) lines.push(`X-WR-CALNAME:${icsEsc(name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H');
  const stamp = icsTime(Date.now());
  for (const s of stops) {
    lines.push('BEGIN:VEVENT',
      `UID:stop-${s.id}@${host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(s.startsAt)}`,
      `DTEND:${icsTime(s.endsAt)}`,
      `SUMMARY:${icsEsc(`${name} at ${s.location}`)}`,
      `LOCATION:${icsEsc(s.address || s.location)}`,
      `DESCRIPTION:${icsEsc((s.note ? s.note + '\n\n' : '') + 'Order ahead: ' + origin(req) + '/')}`,
      `URL:${origin(req)}/`,
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
const slugFile = (s) => String(s || 'truck').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'truck';

router.get('/feed.ics', requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const tz = Insights.validTz(v.timezone);
  // The feed keeps the last two weeks too, so a subscribed calendar doesn't lose yesterday's stop.
  const rows = await all('SELECT * FROM schedule_stops WHERE vendor_id = ? AND day >= ? ORDER BY day, start_time LIMIT 400', [v.id, addDays(today(tz), -14)]);
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'public, max-age=900', 'Content-Disposition': `inline; filename="${slugFile(v.business_name)}.ics"` });
  res.send(icsFor(v, req, rows.map((s) => stopShape(s, tz)), { feed: true }));
});

// /stop/12.ics — the id is parsed by hand so the route works the same in every router version.
router.get('/stop/:file', requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const m = /^(\d+)\.ics$/.exec(String(req.params.file || ''));
  const s = m && (await get('SELECT * FROM schedule_stops WHERE id = ? AND vendor_id = ?', [parseInt(m[1], 10), v.id]));
  if (!s) return res.status(404).send('Not found');
  const shaped = stopShape(s, Insights.validTz(v.timezone));
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${slugFile(v.business_name)}-${s.day}.ics"` });
  res.send(icsFor(v, req, [shaped], { feed: false }));
});

/* ----- follow by email ----- */
const limitFollow = rateLimit({ windowMs: 60 * 60 * 1000, max: 6 });
const cleanLocs = (x, allowed) => (Array.isArray(x) ? [...new Set(x.map((s) => String(s).slice(0, 80)))].filter((s) => allowed.includes(s)).slice(0, 30) : []);
const maskEmail = (e) => { const [a, b] = String(e).split('@'); return (a.length <= 2 ? a[0] + '•' : a.slice(0, 2) + '•••') + '@' + b; };

function mailShell(v, bodyHtml, manageUrl) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
${bodyHtml}
<p style="color:#777;font-size:12px;margin-top:28px;border-top:1px solid #eee;padding-top:12px">You follow ${escHtml(v.business_name)}. <a href="${manageUrl}" style="color:#777">Change what you get or unfollow</a>.</p></div>`;
}

router.post('/follow', requireVendor, limitFollow, async (req, res) => {
  const v = req.tenant.vendor;
  if (!mailConfigured()) return res.status(503).json({ error: 'Following by email isn’t available yet.' });
  const email = String((req.body || {}).email || '').trim().toLowerCase().slice(0, 254);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
  const locs = cleanLocs((req.body || {}).locations, await followLocations(v.id));
  const done = { ok: true, message: 'Check your email and tap the link to confirm.' }; // same answer either way: no peeking at who follows
  const existing = await get('SELECT * FROM followers WHERE vendor_id = ? AND email = ?', [v.id, email]);
  const now = Date.now();
  if (existing && existing.last_mail_at && now - existing.last_mail_at < CONFIRM_RESEND_MS) return res.json(done);
  const token = core.randomToken(24);
  if (existing) {
    // A new link each time; the old one stops working. Their choices only change once they confirm.
    await run('UPDATE followers SET token_hash = ?, pending_locations = ?, last_mail_at = ? WHERE id = ?', [sha(token), JSON.stringify(locs), now, existing.id]);
  } else {
    await run('INSERT INTO followers (vendor_id, email, token_hash, locations, pending_locations, created_at, last_mail_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [v.id, email, sha(token), JSON.stringify(locs), JSON.stringify(locs), now, now]);
  }
  const link = `${origin(req)}/schedule?follow=${token}`;
  const confirmed = existing && existing.confirmed_at;
  mailLater({
    to: email, brand: auth.brandFor(v),
    replyTo: v.email || undefined,
    subject: confirmed ? `Your ${v.business_name} updates` : `Confirm: follow ${v.business_name}`,
    text: confirmed ? `You already follow ${v.business_name}. Change what you get here: ${link}` : `Tap to confirm you want updates from ${v.business_name}: ${link}\n\nIf this wasn't you, ignore this email and nothing happens.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
<h2 style="margin:0 0 8px">${confirmed ? 'You already follow ' : 'Follow '}${escHtml(v.business_name)}</h2>
<p>${confirmed ? 'Here’s your link to change what you get or unfollow.' : 'Tap below to confirm. You’ll hear from the truck when they open near you or post their week. Nothing else.'}</p>
<p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">${confirmed ? 'Manage' : 'Confirm'}</a></p>
<p style="color:#777;font-size:12px">If this wasn’t you, ignore this email and nothing happens.</p></div>`,
  }).catch(() => {});
  res.json(done);
});

async function followerByToken(vendorId, token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) return null;
  return get('SELECT * FROM followers WHERE vendor_id = ? AND token_hash = ?', [vendorId, sha(token)]);
}
const parseLocs = (s) => { try { return JSON.parse(s || '[]') || []; } catch (e) { return []; } };
const followerShape = async (f, vendorId) => ({
  email: maskEmail(f.email), confirmed: !!f.confirmed_at, locations: parseLocs(f.locations), allLocations: await followLocations(vendorId),
});

router.get('/follow/:token', requireVendor, async (req, res) => {
  const f = await followerByToken(req.tenant.vendor.id, req.params.token);
  if (!f) return res.status(404).json({ error: 'That link has expired. Follow again from the schedule page.' });
  res.json(await followerShape(f, req.tenant.vendor.id));
});
router.post('/follow/:token/confirm', requireVendor, async (req, res) => {
  const f = await followerByToken(req.tenant.vendor.id, req.params.token);
  if (!f) return res.status(404).json({ error: 'That link has expired. Follow again from the schedule page.' });
  await run('UPDATE followers SET confirmed_at = COALESCE(confirmed_at, ?), locations = COALESCE(pending_locations, locations), pending_locations = NULL WHERE id = ?', [Date.now(), f.id]);
  // A confirmed follower is a regular who asked to hear from the truck (double opt-in = consent).
  require('./crm').record(req.tenant.vendor.id, { email: f.email, kind: 'regular', consent: 'followed (double opt-in)' }, { type: 'follow', ref: 'follower:' + f.id, summary: 'Started following the truck' }).catch(() => {});
  res.json(await followerShape(await get('SELECT * FROM followers WHERE id = ?', [f.id]), req.tenant.vendor.id));
});
router.post('/follow/:token', requireVendor, async (req, res) => {
  const f = await followerByToken(req.tenant.vendor.id, req.params.token);
  if (!f || !f.confirmed_at) return res.status(404).json({ error: 'That link has expired. Follow again from the schedule page.' });
  const locs = cleanLocs((req.body || {}).locations, await followLocations(req.tenant.vendor.id));
  await run('UPDATE followers SET locations = ? WHERE id = ?', [JSON.stringify(locs), f.id]);
  res.json(await followerShape(await get('SELECT * FROM followers WHERE id = ?', [f.id]), req.tenant.vendor.id));
});
// Also the one-click unsubscribe target mail apps call (RFC 8058). Unfollowing deletes the email entirely.
router.post('/follow/:token/unsubscribe', requireVendor, async (req, res) => {
  const f = await followerByToken(req.tenant.vendor.id, req.params.token);
  if (f) await run('DELETE FROM followers WHERE id = ?', [f.id]);
  res.json({ ok: true });
});

/* ---------- owner ---------- */
function readStop(b) {
  const day = String(b.day || '');
  const start = String(b.start || '');
  const end = String(b.end || '');
  const location = String(b.location || '').trim().slice(0, 80);
  if (!validDate(day)) return { error: 'Pick a date.' };
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) return { error: 'Set a start and end time.' };
  if (start === end) return { error: 'The end time has to be different from the start.' };
  if (!location) return { error: 'Where will you be?' };
  return { day, start, end, location, address: String(b.address || '').trim().slice(0, 160), note: String(b.note || '').trim().slice(0, 200) };
}

router.get('/owner/stops', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const tz = Insights.validTz(v.timezone);
  res.json({ stops: await upcoming(v.id, tz, 120), timezone: tz, today: today(tz) });
});

router.post('/owner/stops', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const tz = Insights.validTz(v.timezone);
  const s = readStop(req.body || {});
  if (s.error) return res.status(400).json({ error: s.error });
  if (s.day < today(tz)) return res.status(400).json({ error: 'That date has already passed.' });
  const weeks = Math.max(0, Math.min(MAX_REPEAT_WEEKS, parseInt((req.body || {}).repeatWeeks, 10) || 0));
  const count = await get('SELECT COUNT(*) AS n FROM schedule_stops WHERE vendor_id = ? AND day >= ?', [v.id, today(tz)]);
  if (count.n + weeks + 1 > MAX_UPCOMING) return res.status(400).json({ error: `You can have up to ${MAX_UPCOMING} upcoming stops.` });
  const series = weeks ? core.randomToken(8) : null;
  const now = Date.now();
  for (let w = 0; w <= weeks; w++) {
    await run('INSERT INTO schedule_stops (vendor_id, day, start_time, end_time, location, address, note, series, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [v.id, addDays(s.day, 7 * w), s.start, s.end, s.location, s.address, s.note, series, now, now]);
  }
  core.broadcast(v.id, 'SCHEDULE_UPDATE', {});
  res.status(201).json({ added: weeks + 1, stops: await upcoming(v.id, tz, 120) });
});

router.put('/owner/stops/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const tz = Insights.validTz(v.timezone);
  const s = readStop(req.body || {});
  if (s.error) return res.status(400).json({ error: s.error });
  const r = await run('UPDATE schedule_stops SET day = ?, start_time = ?, end_time = ?, location = ?, address = ?, note = ?, updated_at = ? WHERE id = ? AND vendor_id = ?',
    [s.day, s.start, s.end, s.location, s.address, s.note, Date.now(), parseInt(req.params.id, 10), v.id]);
  if (!r.changes) return res.status(404).json({ error: 'That stop is gone.' });
  core.broadcast(v.id, 'SCHEDULE_UPDATE', {});
  res.json({ stops: await upcoming(v.id, tz, 120) });
});

// ?following=1 removes this stop and the later ones in its weekly series.
router.delete('/owner/stops/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const tz = Insights.validTz(v.timezone);
  const s = await get('SELECT * FROM schedule_stops WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), v.id]);
  if (!s) return res.status(404).json({ error: 'That stop is gone.' });
  let r;
  if (req.query.following === '1' && s.series) r = await run('DELETE FROM schedule_stops WHERE vendor_id = ? AND series = ? AND day >= ?', [v.id, s.series, s.day]);
  else r = await run('DELETE FROM schedule_stops WHERE id = ?', [s.id]);
  core.broadcast(v.id, 'SCHEDULE_UPDATE', {});
  res.json({ removed: r.changes, stops: await upcoming(v.id, tz, 120) });
});

router.get('/owner/followers', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const rows = await all('SELECT locations FROM followers WHERE vendor_id = ? AND confirmed_at IS NOT NULL', [v.id]);
  const byLocation = {};
  let everywhere = 0;
  for (const r of rows) {
    const l = parseLocs(r.locations);
    if (!l.length) everywhere++;
    for (const n of l) byLocation[n] = (byLocation[n] || 0) + 1;
  }
  const vv = await get('SELECT follow_open_at, follow_week_at FROM vendors WHERE id = ?', [v.id]);
  res.json({
    count: rows.length, everywhere, byLocation, mailReady: mailConfigured(),
    openNextAt: vv.follow_open_at ? vv.follow_open_at + OPEN_EVERY_MS : 0,
    weekNextAt: vv.follow_week_at ? vv.follow_week_at + WEEK_EVERY_MS : 0,
  });
});

/** Who hears about a location: everyone who follows all spots, plus those who picked it. */
async function audience(vendorId, location) {
  const rows = await all('SELECT * FROM followers WHERE vendor_id = ? AND confirmed_at IS NOT NULL', [vendorId]);
  return rows.filter((f) => { const l = parseLocs(f.locations); return !l.length || !location || l.includes(location); });
}

async function mailFollowers(req, v, list, subject, bodyFor) {
  // Each follower gets their own manage link (and one-click unsubscribe). A fresh token is minted per send.
  for (const f of list) {
    const token = core.randomToken(24);
    await run('UPDATE followers SET token_hash = ? WHERE id = ?', [sha(token), f.id]);
    const manage = `${origin(req)}/schedule?follow=${token}`;
    const b = bodyFor(f);
    // "We're open near you" is no use tomorrow: retried for two hours at most.
    await mailLater({
      to: f.email, replyTo: v.email || undefined, brand: auth.brandFor(v), subject, text: b.text + `\n\nChange what you get or unfollow: ${manage}`, html: mailShell(v, b.html, manage),
      headers: { 'List-Unsubscribe': `<${origin(req)}/api/schedule/follow/${token}/unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }, { staleAfterMs: 2 * 60 * 60 * 1000 }).catch(() => {});
  }
}

router.post('/owner/notify', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const tz = Insights.validTz(v.timezone);
  const kind = String((req.body || {}).kind || '');
  if (!mailConfigured()) return res.status(503).json({ error: 'Email isn’t set up on the server yet.' });
  const vv = await get('SELECT follow_open_at, follow_week_at FROM vendors WHERE id = ?', [v.id]);
  const now = Date.now();
  const site = origin(req) + '/';

  if (kind === 'open') {
    const st = await core.getState(v.id);
    if (st.status !== 'open') return res.status(409).json({ error: 'Open first, then tell your followers.' });
    if (vv.follow_open_at && now - vv.follow_open_at < OPEN_EVERY_MS) return res.status(429).json({ error: 'You told followers you’re open less than 6 hours ago.' });
    const list = await audience(v.id, st.location);
    if (!list.length) return res.json({ sent: 0 });
    await run('UPDATE vendors SET follow_open_at = ? WHERE id = ?', [now, v.id]);
    const stop = (await upcoming(v.id, tz, 0)).find((s) => s.startsAt <= now + 60 * 60 * 1000 && (!st.location || s.location === st.location));
    const where = st.location ? ` at ${st.location}` : '';
    const until = stop ? ` until ${time12(stop.end)}` : '';
    const subject = `${v.business_name} is open now${where}`;
    mailFollowers(req, v, list, subject, () => ({
      text: `${v.business_name} is open now${where}${until}. Order ahead and skip the line: ${site}`,
      html: `<h2 style="margin:0 0 6px">Open now${escHtml(where)}</h2><p style="margin:0 0 16px;color:#444">${escHtml(v.business_name)}${escHtml(until ? ' is serving' + until : ' is serving now')}.${stop && stop.address ? '<br>' + escHtml(stop.address) : ''}</p>
<p><a href="${site}" style="display:inline-block;background:#111;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">Order ahead</a></p>`,
    })).catch((e) => console.error('follow mail:', e.message));
    return res.json({ sent: list.length });
  }

  if (kind === 'week') {
    if (vv.follow_week_at && now - vv.follow_week_at < WEEK_EVERY_MS) return res.status(429).json({ error: 'You sent your schedule less than 3 days ago.' });
    const stops = (await upcoming(v.id, tz, 7)).filter((s) => s.day <= addDays(today(tz), 6));
    if (!stops.length) return res.status(400).json({ error: 'Add your stops for the next 7 days first.' });
    const list = await audience(v.id, null);
    if (!list.length) return res.json({ sent: 0 });
    await run('UPDATE vendors SET follow_week_at = ? WHERE id = ?', [now, v.id]);
    mailFollowers(req, v, list, `Where ${v.business_name} will be this week`, (f) => {
      const mine = parseLocs(f.locations);
      const show = mine.length ? stops.filter((s) => mine.includes(s.location)) : stops;
      const use = show.length ? show : stops;
      return {
        text: use.map((s) => `${s.dayLabel}: ${s.label} at ${s.location}${s.address ? ' (' + s.address + ')' : ''}`).join('\n') + `\n\nFull schedule: ${origin(req)}/schedule`,
        html: `<h2 style="margin:0 0 12px">This week</h2>` + use.map((s) => `<p style="margin:0 0 10px"><b>${escHtml(s.dayLabel)}</b><br>${escHtml(s.label)} · ${escHtml(s.location)}${s.address ? '<br><span style="color:#666">' + escHtml(s.address) + '</span>' : ''}</p>`).join('') +
          `<p style="margin-top:16px"><a href="${origin(req)}/schedule" style="color:#111;font-weight:700">Full schedule and calendar</a></p>`,
      };
    }).catch((e) => console.error('follow mail:', e.message));
    return res.json({ sent: list.length });
  }
  res.status(400).json({ error: 'Unknown message.' });
});

module.exports = { router, upcoming, stopTimes, icsFor, time12 };
