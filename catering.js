'use strict';
/**
 * catering.js — the catering space: the owner's playbook, the host's request-to-book, and bookings.
 *
 * The owner answers every question once, as rules (the playbook). Hosts get an exact, itemized price
 * instantly and request a date; the date is held for HOLD_MS while the owner accepts or declines.
 * Prices are always worked out here with public/catering-quote.js; the browser's numbers are never trusted.
 * Deposits and contracts wait for Stripe.
 */
const express = require('express');
const core = require('./core');
const auth = require('./auth');
const Q = require('./public/catering-quote.js');
const { run, get, all } = core;
const { requireVendor, requireRole, rateLimit, sendMail, escHtml, EMAIL_RE } = auth;

const router = express.Router();
const ownerOnly = [requireVendor, requireRole('owner')];
const HOLD_MS = 24 * 60 * 60 * 1000;
const STATUSES = ['requested', 'accepted', 'declined', 'canceled', 'expired'];

/* ---------- playbook ---------- */
// A starting point shown to owners the first time. Catering stays off until they turn it on.
const STARTER = {
  enabled: false,
  minGuests: 25, maxGuests: 300, leadDays: 7, maxDaysAhead: 365, maxEventsPerDay: 1,
  serviceChargePct: 18, taxPct: 0, depositPct: 50, serviceHours: 2, finalCountDays: 7,
  packages: [{
    id: 'taco-bar', name: 'Taco bar', desc: 'Two proteins, rice, beans, salsas and tortillas, served from the truck.',
    tiers: [{ minGuests: 1, priceCents: 1600 }, { minGuests: 50, priceCents: 1400 }],
    choiceLabel: 'Proteins', choices: ['Birria', 'Chicken', 'Al pastor'], chooseCount: 2, allowVegetarian: true,
  }],
  zones: [],
  siteQuestions: [
    { id: 'parking', question: 'Can the truck park within 50 ft of where guests gather?', yesNote: 'Perfect. The truck needs a level spot about 30 ft long.', noNote: 'Tell us more in the notes and we’ll find a way.', mustBeYes: false },
    { id: 'power', question: 'Do you need us to bring our own power?', yesNote: 'No problem. Our generator is included.', noNote: 'Great, we’ll plug in on site.', mustBeYes: false },
  ],
  blockedDates: [],
  cancellationPolicy: 'Free cancellation until 14 days before the event. After that, the deposit is non-refundable.',
  notes: '',
};

async function loadSettings(vendorId) {
  const row = await get('SELECT data FROM catering_settings WHERE vendor_id = ?', [vendorId]);
  if (!row) return Q.normalizeSettings(STARTER);
  try { return Q.normalizeSettings(JSON.parse(row.data)); } catch (e) { return Q.normalizeSettings(STARTER); }
}

/** Dates already at capacity (accepted, or requested with a live hold). */
async function fullDates(vendorId, settings, fromYmd) {
  const rows = await all(
    `SELECT event_date, COUNT(*) AS n FROM catering_bookings
     WHERE vendor_id = ? AND event_date >= ? AND (status = 'accepted' OR (status = 'requested' AND hold_expires_at > ?))
     GROUP BY event_date`,
    [vendorId, fromYmd, Date.now()]
  );
  return rows.filter((r) => r.n >= settings.maxEventsPerDay).map((r) => r.event_date);
}

const vendorTz = (v) => core.validTimezone(v.timezone) || 'America/Denver';

/* ---------- shapes ---------- */
function bookingShape(b, forOwner) {
  const d = JSON.parse(b.details || '{}');
  const out = {
    token: b.public_token, status: b.status, date: b.event_date, startTime: b.start_time, guests: b.guests,
    packageName: d.packageName || '', choices: d.choices || [], vegetarian: d.vegetarian || 0,
    address: d.address || '', zip: d.zip || '', siteAnswers: d.siteAnswers || [], notes: d.notes || '',
    quote: JSON.parse(b.quote || '{}'), totalCents: b.total_cents, holdExpiresAt: b.hold_expires_at,
    hostName: b.host_name, company: b.company || '', createdAt: b.created_at,
  };
  if (forOwner) Object.assign(out, { id: b.id, hostEmail: b.host_email, hostPhone: b.host_phone || '', policy: d.policy || '', serviceHours: d.serviceHours });
  return out;
}

const pageUrl = (req, path) => `${req.secure ? 'https' : 'http'}://${req.tenant.host}${path}`;

function fmtDate(ymd) {
  try { return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  catch (e) { return ymd; }
}
function fmtTime(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  if (!Number.isFinite(h)) return hm;
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function quoteRowsHtml(q) {
  return (q.lines || []).map((l) => `<tr><td style="padding:4px 12px 4px 0">${escHtml(l.label)}</td><td style="padding:4px 0;text-align:right">${Q.money(l.cents)}</td></tr>`).join('') +
    `<tr><td style="padding:8px 12px 4px 0;font-weight:700;border-top:1px solid #ccc">Total</td><td style="padding:8px 0 4px;text-align:right;font-weight:700;border-top:1px solid #ccc">${Q.money(q.totalCents)}</td></tr>`;
}

/* =====================================================================
   PUBLIC (the truck's own address)
   ===================================================================== */

// Everything the booking page needs to price and check a request in the browser.
router.get('/config', requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const s = await loadSettings(v.id);
  res.set('Cache-Control', 'no-store');
  if (!s.enabled) return res.json({ enabled: false, businessName: v.business_name });
  const tz = vendorTz(v);
  const today = Q.todayIn(tz);
  res.json({
    enabled: true, businessName: v.business_name, emoji: v.emoji || '', timezone: tz, today,
    settings: s, fullDates: await fullDates(v.id, s, today),
  });
});

const limitRequest = rateLimit({ windowMs: 60 * 60 * 1000, max: 8 });

router.post('/request', requireVendor, limitRequest, async (req, res) => {
  const v = req.tenant.vendor;
  const s = await loadSettings(v.id);
  if (!s.enabled) return res.status(404).json({ error: 'This truck isn’t taking catering requests right now.' });
  const b = req.body || {};

  const host = {
    name: String(b.hostName || '').trim().slice(0, 80),
    email: String(b.hostEmail || '').trim().toLowerCase().slice(0, 120),
    phone: String(b.hostPhone || '').trim().slice(0, 30),
    company: String(b.company || '').trim().slice(0, 80),
  };
  if (!host.name) return res.status(400).json({ error: 'Please enter your name.', field: 'hostName' });
  if (!EMAIL_RE.test(host.email)) return res.status(400).json({ error: 'Please enter a valid email.', field: 'hostEmail' });
  if (b.acceptPolicy !== true) return res.status(400).json({ error: 'Please agree to the booking terms.', field: 'acceptPolicy' });

  const tz = vendorTz(v);
  const today = Q.todayIn(tz);
  const date = String(b.date || '');
  const dateProblem = Q.checkDate(s, date, today, null);
  if (dateProblem) return res.status(400).json({ error: dateProblem, field: 'date' });
  const startTime = String(b.startTime || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) return res.status(400).json({ error: 'Choose a start time.', field: 'startTime' });
  const address = String(b.address || '').trim().slice(0, 160);
  if (address.length < 5) return res.status(400).json({ error: 'Enter the event address.', field: 'address' });

  // The price is worked out here, from the saved playbook, never taken from the browser.
  const quote = Q.computeQuote(s, { packageId: b.packageId, guests: b.guests, zip: b.zip, vegetarian: b.vegetarian });
  if (!quote.ok) return res.status(400).json({ error: quote.problems[0].message, field: quote.problems[0].field });
  const pkg = s.packages.find((p) => p.id === quote.packageId);

  let choices = Array.isArray(b.choices) ? b.choices.map(String).filter((c) => pkg.choices.includes(c)) : [];
  choices = choices.filter((c, i) => choices.indexOf(c) === i);
  if (pkg.chooseCount && choices.length !== pkg.chooseCount) {
    return res.status(400).json({ error: `Choose ${pkg.chooseCount} ${pkg.choiceLabel ? pkg.choiceLabel.toLowerCase() : 'options'}.`, field: 'choices' });
  }
  const answers = s.siteQuestions.map((q) => {
    const a = b.siteAnswers && b.siteAnswers[q.id];
    return { id: q.id, question: q.question, answer: a === true ? 'yes' : a === false ? 'no' : '' };
  });
  const unanswered = answers.find((a) => !a.answer);
  if (unanswered) return res.status(400).json({ error: 'Please answer: ' + unanswered.question, field: 'site' });
  const mustYes = s.siteQuestions.find((q) => q.mustBeYes && answers.find((a) => a.id === q.id).answer !== 'yes');
  if (mustYes) return res.status(400).json({ error: (mustYes.noNote || 'We need a yes to: ' + mustYes.question) + ' Ask for a custom quote instead.', field: 'site' });

  const details = {
    packageName: pkg.name, choiceLabel: pkg.choiceLabel, choices, vegetarian: quote.vegetarian,
    address, zip: String(b.zip).trim(), siteAnswers: answers, notes: String(b.notes || '').trim().slice(0, 600),
    policy: s.cancellationPolicy, serviceHours: s.serviceHours, finalCountDays: s.finalCountDays,
  };
  const now = Date.now();
  const token = core.randomToken(18);

  // One statement, so two hosts can never both get the last slot on a day.
  const r = await run(
    `INSERT INTO catering_bookings (vendor_id, public_token, status, event_date, start_time, guests, package_id, details, quote,
       total_cents, host_name, host_email, host_phone, company, hold_expires_at, created_at, updated_at)
     SELECT ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM catering_bookings WHERE vendor_id = ? AND event_date = ?
            AND (status = 'accepted' OR (status = 'requested' AND hold_expires_at > ?))) < ?`,
    [v.id, token, date, startTime, quote.guests, pkg.id, JSON.stringify(details), JSON.stringify(quote), quote.totalCents,
      host.name, host.email, host.phone, host.company, now + HOLD_MS, now, now,
      v.id, date, now, s.maxEventsPerDay]
  );
  if (!r.changes) return res.status(409).json({ error: 'Someone just booked that day. Please choose another date.', field: 'date' });

  const link = pageUrl(req, `/catering/b/${token}`);
  const when = `${fmtDate(date)} at ${fmtTime(startTime)}`;
  const holdUntil = new Date(now + HOLD_MS);
  // To the host: what they asked for, the locked quote, and one link for everything.
  sendMail({
    to: host.email, replyTo: v.email || undefined,
    subject: `Your catering request with ${v.business_name} for ${fmtDate(date)}`,
    text: `Thanks, ${host.name}. ${v.business_name} has your request for ${when}, ${quote.guests} guests (${pkg.name}).\n\nTotal: ${Q.money(quote.totalCents)}. The date is held for 24 hours while ${v.business_name} confirms.\n\nEverything about your booking: ${link}\n\nReply to this email to reach ${v.business_name} directly.`,
    html: `<p>Thanks, ${escHtml(host.name)}. <b>${escHtml(v.business_name)}</b> has your request for <b>${escHtml(when)}</b>, ${quote.guests} guests (${escHtml(pkg.name)}).</p>
      <table style="border-collapse:collapse;font-size:14px">${quoteRowsHtml(quote)}</table>
      <p>The date is held for 24 hours while ${escHtml(v.business_name)} confirms.</p>
      <p><a href="${link}">See your booking</a></p><p style="color:#666">Reply to this email to reach ${escHtml(v.business_name)} directly.</p>`,
  }).catch(() => {});
  // To the owner: everything needed to accept in one tap.
  if (v.email) {
    sendMail({
      to: v.email, replyTo: host.email,
      subject: `New catering request: ${fmtDate(date)}, ${quote.guests} guests, ${Q.money(quote.totalCents)}`,
      text: `${host.name}${host.company ? ' (' + host.company + ')' : ''} requested ${when} for ${quote.guests} guests (${pkg.name}), ${Q.money(quote.totalCents)}.\nIt's inside all your rules. Accept or decline within 24 hours: ${pageUrl(req, '/catering/manage')}\nReply to this email to reach the host.`,
      html: `<p><b>${escHtml(host.name)}</b>${host.company ? ' (' + escHtml(host.company) + ')' : ''} requested <b>${escHtml(when)}</b> for ${quote.guests} guests (${escHtml(pkg.name)}).</p>
        <table style="border-collapse:collapse;font-size:14px">${quoteRowsHtml(quote)}</table>
        <p>It's inside all your rules. <a href="${pageUrl(req, '/catering/manage')}">Accept or decline</a> by ${escHtml(holdUntil.toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }))}.</p>
        <p style="color:#666">Reply to this email to reach the host.</p>`,
    }).catch(() => {});
  }
  core.broadcast(v.id, 'CATERING_NEW', { date, guests: quote.guests }, true);
  res.status(201).json({ token, link: `/catering/b/${token}`, holdExpiresAt: now + HOLD_MS });
});

// Anything outside the rules (a far-away ZIP, 500 guests, a dish not on the menu) comes in as one
// structured message to the owner, who replies by email. Nothing is held or priced.
router.post('/custom', requireVendor, limitRequest, async (req, res) => {
  const v = req.tenant.vendor;
  const s = await loadSettings(v.id);
  if (!s.enabled) return res.status(404).json({ error: 'This truck isn’t taking catering requests right now.' });
  const b = req.body || {};
  const name = String(b.hostName || '').trim().slice(0, 80);
  const email = String(b.hostEmail || '').trim().toLowerCase().slice(0, 120);
  const message = String(b.message || '').trim().slice(0, 1200);
  if (!name) return res.status(400).json({ error: 'Please enter your name.', field: 'hostName' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.', field: 'hostEmail' });
  if (message.length < 5) return res.status(400).json({ error: 'Tell the truck what you need.', field: 'message' });
  if (!v.email) return res.status(503).json({ error: 'This truck can’t take custom requests online yet.' });
  const facts = [
    ['Date', Q.validDate(String(b.date || '')) ? fmtDate(b.date) : 'not set'],
    ['Guests', Number.isFinite(Number(b.guests)) && Number(b.guests) > 0 ? String(Math.round(Number(b.guests))) : 'not set'],
    ['ZIP', /^\d{5}$/.test(String(b.zip || '')) ? String(b.zip) : 'not set'],
    ['Phone', String(b.hostPhone || '').trim().slice(0, 30) || 'not given'],
  ];
  const ok = await sendMail({
    to: v.email, replyTo: email,
    subject: `Custom catering request from ${name}`,
    text: `${name} (${email}) sent a custom catering request.\n\n${facts.map((f) => f[0] + ': ' + f[1]).join('\n')}\n\n${message}\n\nReply to this email to answer them.`,
    html: `<p><b>${escHtml(name)}</b> (${escHtml(email)}) sent a custom catering request.</p><p>${facts.map((f) => `${escHtml(f[0])}: <b>${escHtml(f[1])}</b>`).join('<br>')}</p><p style="white-space:pre-wrap">${escHtml(message)}</p><p style="color:#666">Reply to this email to answer them.</p>`,
  });
  if (!ok) return res.status(502).json({ error: 'We couldn’t send that just now. Please try again in a minute.' });
  sendMail({
    to: email, replyTo: v.email,
    subject: `${v.business_name} got your catering question`,
    text: `Thanks, ${name}. ${v.business_name} got your message and will reply to this email address.\n\nYour message:\n${message}`,
    html: `<p>Thanks, ${escHtml(name)}. ${escHtml(v.business_name)} got your message and will reply to this email address.</p><p style="white-space:pre-wrap;color:#555">${escHtml(message)}</p>`,
  }).catch(() => {});
  res.json({ ok: true });
});

// The host's one link: status, the locked quote and details.
router.get('/booking/:token', requireVendor, async (req, res) => {
  const b = await get('SELECT * FROM catering_bookings WHERE vendor_id = ? AND public_token = ?', [req.tenant.vendor.id, String(req.params.token)]);
  if (!b) return res.status(404).json({ error: 'We couldn’t find that booking.' });
  res.set('Cache-Control', 'no-store');
  res.json({ businessName: req.tenant.vendor.business_name, ownerEmail: req.tenant.vendor.email || '', booking: bookingShape(b, false) });
});

// A host can withdraw a request until the owner accepts it. After that, they reply to the email.
router.post('/booking/:token/cancel', requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const r = await run(
    "UPDATE catering_bookings SET status = 'canceled', updated_at = ? WHERE vendor_id = ? AND public_token = ? AND status = 'requested'",
    [Date.now(), v.id, String(req.params.token)]
  );
  if (!r.changes) return res.status(409).json({ error: 'This booking can’t be canceled here. Reply to your confirmation email to reach the truck.' });
  const b = await get('SELECT * FROM catering_bookings WHERE public_token = ?', [String(req.params.token)]);
  if (v.email) sendMail({ to: v.email, replyTo: b.host_email, subject: `Catering request withdrawn: ${fmtDate(b.event_date)}`, text: `${b.host_name} withdrew their request for ${fmtDate(b.event_date)}. The date is free again.`, html: `<p>${escHtml(b.host_name)} withdrew their request for ${escHtml(fmtDate(b.event_date))}. The date is free again.</p>` }).catch(() => {});
  res.json({ ok: true });
});

/* =====================================================================
   OWNER
   ===================================================================== */
router.get('/owner/settings', ownerOnly, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const row = await get('SELECT 1 FROM catering_settings WHERE vendor_id = ?', [req.tenant.vendor.id]);
  res.json({ settings: await loadSettings(req.tenant.vendor.id), saved: !!row, timezone: vendorTz(req.tenant.vendor) });
});

router.put('/owner/settings', ownerOnly, async (req, res) => {
  const s = Q.normalizeSettings((req.body || {}).settings);
  if (s.enabled && !s.packages.length) return res.status(400).json({ error: 'Add at least one package with a price before turning catering on.' });
  if (s.enabled && !s.zones.length) return res.status(400).json({ error: 'Add at least one travel zone (ZIP codes you serve) before turning catering on.' });
  await run(
    `INSERT INTO catering_settings (vendor_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(vendor_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [req.tenant.vendor.id, JSON.stringify(s), Date.now()]
  );
  res.json({ settings: s });
});

router.get('/owner/bookings', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const today = Q.todayIn(vendorTz(v));
  const rows = await all(
    `SELECT * FROM catering_bookings WHERE vendor_id = ? AND (event_date >= ? OR updated_at > ?)
     ORDER BY event_date ASC, start_time ASC LIMIT 300`,
    [v.id, Q.addDays(today, -30), Date.now() - 30 * 24 * 60 * 60 * 1000]
  );
  res.set('Cache-Control', 'no-store');
  res.json({ today, bookings: rows.map((b) => bookingShape(b, true)) });
});

async function decide(req, res, accept) {
  const v = req.tenant.vendor;
  const id = parseInt(req.params.id, 10);
  const s = await loadSettings(v.id);
  const now = Date.now();
  let r;
  if (accept) {
    // Accept while the hold is live, or later if the day still has room.
    r = await run(
      `UPDATE catering_bookings SET status = 'accepted', updated_at = ? WHERE id = ? AND vendor_id = ? AND status IN ('requested', 'expired')
       AND (hold_expires_at > ? OR (SELECT COUNT(*) FROM catering_bookings c2 WHERE c2.vendor_id = ? AND c2.event_date = catering_bookings.event_date
            AND c2.id != catering_bookings.id AND (c2.status = 'accepted' OR (c2.status = 'requested' AND c2.hold_expires_at > ?))) < ?)`,
      [now, id, v.id, now, v.id, now, s.maxEventsPerDay]
    );
  } else {
    r = await run("UPDATE catering_bookings SET status = 'declined', updated_at = ? WHERE id = ? AND vendor_id = ? AND status IN ('requested', 'expired')", [now, id, v.id]);
  }
  if (!r.changes) return res.status(409).json({ error: accept ? 'That day is now full, or this request was already handled.' : 'This request was already handled.' });
  const b = await get('SELECT * FROM catering_bookings WHERE id = ?', [id]);
  const d = JSON.parse(b.details);
  const link = pageUrl(req, `/catering/b/${b.public_token}`);
  const reason = String((req.body || {}).message || '').trim().slice(0, 400);
  if (accept) {
    sendMail({
      to: b.host_email, replyTo: v.email || undefined,
      subject: `Confirmed: ${v.business_name} on ${fmtDate(b.event_date)}`,
      text: `Good news, ${b.host_name}: ${v.business_name} confirmed ${fmtDate(b.event_date)} at ${fmtTime(b.start_time)} for ${b.guests} guests. Total ${Q.money(b.total_cents)}.\n${d.finalCountDays ? `Final guest count is due ${d.finalCountDays} days before the event.\n` : ''}${reason ? '\n' + reason + '\n' : ''}\nYour booking: ${link}\nReply to this email to reach ${v.business_name}.`,
      html: `<p>Good news, ${escHtml(b.host_name)}: <b>${escHtml(v.business_name)}</b> confirmed <b>${escHtml(fmtDate(b.event_date))} at ${escHtml(fmtTime(b.start_time))}</b> for ${b.guests} guests.</p>
        <table style="border-collapse:collapse;font-size:14px">${quoteRowsHtml(JSON.parse(b.quote))}</table>
        ${d.finalCountDays ? `<p>Final guest count is due ${d.finalCountDays} days before the event.</p>` : ''}${reason ? `<p>${escHtml(reason)}</p>` : ''}
        <p><a href="${link}">Your booking</a></p><p style="color:#666">Reply to this email to reach ${escHtml(v.business_name)}.</p>`,
    }).catch(() => {});
  } else {
    sendMail({
      to: b.host_email, replyTo: v.email || undefined,
      subject: `${v.business_name} can’t make ${fmtDate(b.event_date)}`,
      text: `Sorry, ${b.host_name}: ${v.business_name} can't take your event on ${fmtDate(b.event_date)}.${reason ? '\n\n' + reason : ''}\n\nReply to this email to ask about another date.`,
      html: `<p>Sorry, ${escHtml(b.host_name)}: ${escHtml(v.business_name)} can't take your event on ${escHtml(fmtDate(b.event_date))}.</p>${reason ? `<p>${escHtml(reason)}</p>` : ''}<p>Reply to this email to ask about another date.</p>`,
    }).catch(() => {});
  }
  res.json({ booking: bookingShape(b, true) });
}
router.post('/owner/bookings/:id/accept', ownerOnly, (req, res) => decide(req, res, true));
router.post('/owner/bookings/:id/decline', ownerOnly, (req, res) => decide(req, res, false));

/* ---------- housekeeping: holds nobody answered ---------- */
async function expireHolds() {
  const now = Date.now();
  const due = await all("SELECT b.*, v.business_name, v.email AS owner_email FROM catering_bookings b JOIN vendors v ON v.id = b.vendor_id WHERE b.status = 'requested' AND b.hold_expires_at <= ?", [now]);
  for (const b of due) {
    const r = await run("UPDATE catering_bookings SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'requested'", [now, b.id]);
    if (!r.changes) continue;
    sendMail({
      to: b.host_email, replyTo: b.owner_email || undefined,
      subject: `Your hold with ${b.business_name} for ${fmtDate(b.event_date)} has ended`,
      text: `${b.business_name} hasn't confirmed your request for ${fmtDate(b.event_date)} yet, so the 24-hour hold has ended. They can still confirm if the date is free; reply to this email to check in.`,
      html: `<p>${escHtml(b.business_name)} hasn't confirmed your request for ${escHtml(fmtDate(b.event_date))} yet, so the 24-hour hold has ended. They can still confirm if the date is free; reply to this email to check in.</p>`,
    }).catch(() => {});
  }
  return due.length;
}
setInterval(() => { expireHolds().catch((e) => console.error('Catering hold expiry failed:', e.message)); }, 10 * 60 * 1000).unref();

/** For the truck's public data: is catering on? */
async function isEnabled(vendorId) {
  return (await loadSettings(vendorId)).enabled;
}

module.exports = { router, expireHolds, isEnabled, loadSettings, STATUSES };
