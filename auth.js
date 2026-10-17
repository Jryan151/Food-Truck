'use strict';
/**
 * auth.js — tenant resolution, sessions, rate limiting, mail, and /api/auth routes.
 * Owners log in with email + password. Staff use a PIN (kitchen screen only).
 * Sessions are host-only cookies, so a login on one subdomain never works on another.
 */
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const core = require('./core');
const { run, get } = core;

const COOKIE = 'ft_session';
const OWNER_TTL = 30 * 24 * 60 * 60 * 1000;
const STAFF_TTL = 12 * 60 * 60 * 1000;
const SCHEME = process.env.PUBLIC_SCHEME || 'https';
const REQUIRE_EMAIL_VERIFY = process.env.REQUIRE_EMAIL_VERIFY === 'true';
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10); // keeps login timing the same for unknown emails

/* ---------- helpers ---------- */
function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* bad cookie, skip */ }
    }
  }
  return out;
}

function vendorUrl(slug, pathAndQuery = '/') {
  return `${SCHEME}://${slug}.${core.ROOT_DOMAIN}${pathAndQuery}`;
}

/**
 * In-memory rate limiter. `key` decides who shares a bucket (default: the IP address).
 * Note: in-memory means one server process. If you ever run several, move this to Redis.
 */
function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  const keyOf = key || ((req) => req.ip || 'unknown');
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const k = keyOf(req);
    let e = hits.get(k);
    if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; hits.set(k, e); }
    e.n++;
    if (e.n > max) {
      res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });
    }
    next();
  };
}

const mailConfigured = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

async function sendMail(msg) { return (await deliverMail(msg)).ok; }

/* ---------- the truck's brand on customer emails ----------
   `brand` ({ name, color, logo, emoji, origin }) puts the truck's color bar, logo and name at the top. */
function brandWrap(b, html) {
  const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#111111';
  const mark = b.logo && b.origin
    ? `<img src="${escHtml(b.origin + b.logo)}" alt="" width="40" height="40" style="display:block;width:40px;height:40px;border-radius:20px;object-fit:cover">`
    : b.emoji ? `<span style="font-size:28px;line-height:40px">${escHtml(b.emoji)}</span>` : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
<div style="height:4px;background:${color};border-radius:2px"></div>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 10px"><tr>${mark ? `<td style="padding-right:10px;vertical-align:middle">${mark}</td>` : ''}<td style="font-weight:800;font-size:17px;vertical-align:middle">${escHtml(b.name || '')}</td></tr></table>
${html}</div>`;
}
/** brand for a vendor row, with the absolute address its logo is served from. */
function brandFor(v) { return Object.assign(core.brandOf(v), { origin: vendorUrl(v.slug, '').replace(/\/$/, '') }); }

// { ok } on success; { ok: false, retry: true } when trying again later can help (network, 5xx, 429).
async function deliverMail({ to, subject, html, text, replyTo, headers, idempotencyKey, brand }) {
  if (brand && html) html = brandWrap(brand, html);
  if (!mailConfigured()) {
    console.warn(`[MAIL NOT CONFIGURED — this email was NOT sent] to=${to} subject="${subject}"\n${text}\n`);
    return { ok: false, retry: false };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(15000), // a hung mail service is a failed try (retried), never a stuck request
      // The idempotency key makes a retry after a crash safe: the mail service sends it once.
      headers: Object.assign({ Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {}),
      // replyTo lets a customer's reply go straight to the truck owner.
      body: JSON.stringify(Object.assign({ from: process.env.MAIL_FROM, to: [to], subject, html, text }, replyTo ? { reply_to: replyTo } : {}, headers ? { headers } : {})),
    });
    if (!r.ok) console.error('Mail send failed:', r.status, await r.text());
    return { ok: r.ok, retry: !r.ok && (r.status >= 500 || r.status === 429), error: r.ok ? null : 'HTTP ' + r.status };
  } catch (e) {
    console.error('Mail send error:', e.message);
    return { ok: false, retry: true, error: e.message };
  }
}

/* ---------- mail that must arrive ----------
   One failed part never stops the car: if the mail service is down, the order, booking or alert still
   goes through, and its email waits here and retries (1, 5, 15 minutes, then hourly) for up to a day.
   Every try carries the same idempotency key, so a message can't arrive twice. */
const MAIL_BACKOFF_MIN = [1, 5, 15, 60, 60, 120, 240, 480];
const MAIL_GIVE_UP_MS = 24 * 60 * 60 * 1000;
async function mailLater(msg, { staleAfterMs, notBefore } = {}) {
  const key = msg.idempotencyKey || 'ml-' + crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  // Held for later (the owner's quiet hours): kept and sent when the time comes.
  const hold = !!(notBefore && notBefore > now);
  const r = hold ? { ok: false, retry: true, error: null } : await deliverMail(Object.assign({}, msg, { idempotencyKey: key }));
  if (r.ok || !r.retry) return r.ok;
  const payload = JSON.stringify({ to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, replyTo: msg.replyTo, headers: msg.headers, brand: msg.brand });
  try {
    await run('INSERT OR IGNORE INTO mail_outbox (idem_key, payload, next_at, stale_at, last_error, created_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [key, payload, hold ? notBefore : now + MAIL_BACKOFF_MIN[0] * 60000, staleAfterMs ? (hold ? notBefore : now) + staleAfterMs : null, r.error || null, hold ? notBefore : now, hold ? 0 : 1]);
  } catch (e) { console.error('mail outbox:', e.message); }
  return hold;
}

/** Sends what's due. Each row is claimed before sending, so two runs can't send the same message. */
async function retryMail() {
  const now = Date.now();
  await run("UPDATE mail_outbox SET status = 'stale' WHERE status = 'queued' AND stale_at IS NOT NULL AND stale_at < ?", [now]);
  const due = await core.all("SELECT id FROM mail_outbox WHERE status = 'queued' AND next_at <= ? ORDER BY next_at LIMIT 25", [now]);
  let sent = 0;
  for (const { id } of due) {
    // Claim: push next_at out first; only the run that moved it sends.
    const row = await get("UPDATE mail_outbox SET next_at = ? WHERE id = ? AND status = 'queued' AND next_at <= ? RETURNING *", [now + 10 * 60000, id, now]);
    if (!row) continue;
    const r = await deliverMail(Object.assign(JSON.parse(row.payload), { idempotencyKey: row.idem_key }));
    if (r.ok) { await run("UPDATE mail_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?", [Date.now(), id]); sent++; continue; }
    const giveUp = !r.retry || now - row.created_at > MAIL_GIVE_UP_MS;
    const wait = MAIL_BACKOFF_MIN[Math.min(row.attempts, MAIL_BACKOFF_MIN.length - 1)] * 60000;
    await run('UPDATE mail_outbox SET status = ?, attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?', [giveUp ? 'failed' : 'queued', Date.now() + wait, r.error || null, id]);
    if (giveUp) console.error(`Mail gave up after ${row.attempts + 1} tries: ${JSON.parse(row.payload).subject}`);
  }
  // Keep a week of history, no more.
  await run("DELETE FROM mail_outbox WHERE status != 'queued' AND created_at < ?", [now - 7 * 864e5]);
  return sent;
}

const escHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- tenant resolution: which vendor does this hostname belong to? ---------- */
async function tenant(req, res, next) {
  const host = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
  const root = core.ROOT_DOMAIN;
  const t = { host, isRoot: false, vendor: null };

  if (host === root || host === 'www.' + root || host === 'localhost' || host === '127.0.0.1') {
    t.isRoot = true;
  } else if (host.endsWith('.' + root)) {
    const slug = host.slice(0, -(root.length + 1));
    if (/^[a-z0-9-]+$/.test(slug)) t.vendor = (await get('SELECT * FROM vendors WHERE slug = ?', [slug])) || null;
  } else {
    const v = await get('SELECT * FROM vendors WHERE custom_domain = ?', [host]);
    t.vendor = v && core.features(v).customDomain ? v : null; // custom domains are a paid feature
  }
  req.tenant = t;
  next();
}

/** For routes that need a live vendor site. */
function requireVendor(req, res, next) {
  const v = req.tenant && req.tenant.vendor;
  if (!v) return res.status(404).json({ error: 'Vendor not found' });
  if (v.status !== 'active') return res.status(503).json({ error: 'This page is not active.' });
  next();
}

/* ---------- sessions ---------- */
/** The raw session token on this request (cookie first, then Bearer header), or ''. */
function requestToken(req) {
  let token = parseCookies(req.headers.cookie)[COOKIE];
  const h = req.headers.authorization;
  if (!token && h && h.startsWith('Bearer ')) token = h.slice(7);
  return token || '';
}

async function getSession(req) {
  if (req._session !== undefined) return req._session;
  req._session = null;
  const v = req.tenant && req.tenant.vendor;
  if (!v) return null;
  const token = requestToken(req);
  if (!token) return null;
  const s = await get('SELECT s.vendor_id, s.role, s.expires_at, s.staff_id, m.name AS staff_name FROM sessions s LEFT JOIN staff_members m ON m.id = s.staff_id WHERE s.token_hash = ?', [core.sha256(token)]);
  if (s && s.expires_at > Date.now() && s.vendor_id === v.id) req._session = s;
  return req._session;
}

function requireRole(...roles) {
  return async (req, res, next) => {
    const s = await getSession(req);
    if (!s) return res.status(401).json({ error: 'Please log in.' });
    if (!roles.includes(s.role)) return res.status(403).json({ error: 'Owner access required.' });
    req.session = s;
    next();
  };
}

async function startSession(req, res, vendorId, role, staffId) {
  const token = core.randomToken(32);
  const ttl = role === 'owner' ? OWNER_TTL : STAFF_TTL;
  await run('INSERT INTO sessions (token_hash, vendor_id, role, expires_at, staff_id) VALUES (?, ?, ?, ?, ?)', [
    core.sha256(token), vendorId, role, Date.now() + ttl, staffId || null,
  ]);
  res.append(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}${req.secure ? '; Secure' : ''}`
  );
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* ---------- validation ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PIN_RE = /^[A-Za-z0-9]{4,8}$/;
const cleanIG = (v) => String(v || '').replace(/^@/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 30);

/*
 * Staff-PIN lockout. A 4-digit PIN is guessable without one, but locking the whole truck
 * would let any stranger shut down the kitchen screen mid-rush. So we lock out the GUESSER:
 *  - each device (IP) gets PIN_MAX_PER_DEVICE wrong tries per window for a given truck;
 *  - if a truck sees PIN_MAX_PER_VENDOR wrong tries in a window (a spread-out attack),
 *    every device that has guessed wrong is locked, while devices with no wrong tries
 *    (the crew's own tablet) keep working.
 */
const PIN_WINDOW_MS = 15 * 60 * 1000;
const PIN_MAX_PER_DEVICE = 10;
const PIN_MAX_PER_VENDOR = 100;
const pinFails = new Map(); // key: `${vendorId}|${ip}` -> { n, reset }
const pinVendorFails = new Map(); // key: vendorId -> { n, reset }

function freshEntry(map, key) {
  const now = Date.now();
  let e = map.get(key);
  if (!e || e.reset < now) { e = { n: 0, reset: now + PIN_WINDOW_MS }; map.set(key, e); }
  return e;
}
function peek(map, key) {
  const e = map.get(key);
  return e && e.reset > Date.now() ? e.n : 0;
}
function pinLocked(vendorId, ip) {
  const mine = peek(pinFails, `${vendorId}|${ip}`);
  if (mine >= PIN_MAX_PER_DEVICE) return true;
  return mine > 0 && peek(pinVendorFails, vendorId) >= PIN_MAX_PER_VENDOR;
}
function pinFailed(vendorId, ip) {
  freshEntry(pinFails, `${vendorId}|${ip}`).n++;
  freshEntry(pinVendorFails, vendorId).n++;
}
setInterval(() => {
  const now = Date.now();
  for (const m of [pinFails, pinVendorFails]) for (const [k, e] of m) if (e.reset < now) m.delete(k);
}, PIN_WINDOW_MS).unref();

/* ---------- routes ---------- */
const router = express.Router();
const limitSignup = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
const limitLogin = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });
const limitMailer = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

router.get('/slug-available', async (req, res) => {
  const v = core.validateSlug(req.query.slug);
  if (!v.ok) return res.json({ available: false, error: v.error });
  const row = await get('SELECT id FROM vendors WHERE slug = ?', [v.slug]);
  res.json({ available: !row, slug: v.slug, error: row ? 'That web address is taken.' : undefined });
});

router.post('/signup', limitSignup, async (req, res) => {
  if (!req.tenant.isRoot) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};

  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const businessName = String(b.businessName || '').trim();
  const ownerName = String(b.ownerName || '').trim().slice(0, 60);
  const sv = core.validateSlug(b.slug);

  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8-72 characters.' });
  if (businessName.length < 2 || businessName.length > 60) return res.status(400).json({ error: 'Business name must be 2-60 characters.' });
  if (!sv.ok) return res.status(400).json({ error: sv.error });
  if (b.acceptTerms !== true) return res.status(400).json({ error: 'Please agree to the Terms and Privacy Policy.' });

  let staffPin = String(b.staffPin || '').trim();
  if (staffPin && !PIN_RE.test(staffPin)) return res.status(400).json({ error: 'Staff PIN must be 4-8 letters or numbers.' });
  if (!staffPin) staffPin = String(crypto.randomInt(1000, 10000));

  // normalizeMenu also enforces the 200-item ceiling.
  let menu = core.normalizeMenu(b.menuData);
  if (!menu.length) menu = core.normalizeMenu(core.DEFAULT_MENU);

  const passwordHash = await bcrypt.hash(password, 10);
  const staffHash = await bcrypt.hash(staffPin, 10);
  const status = REQUIRE_EMAIL_VERIFY ? 'pending' : 'active';
  const now = Date.now();

  let vendorId;
  try {
    const r = await run(
      `INSERT INTO vendors (slug, business_name, menu_data, email, password_hash, staff_pin_hash,
                            owner_name, owner_ig, status, plan, plan_status, email_verified, updated_at, terms_accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'free', 'active', 0, ?, ?)`,
      [sv.slug, businessName, JSON.stringify(menu), email, passwordHash, staffHash, ownerName, cleanIG(b.ownerIG), status, now, now]
    );
    vendorId = r.lastID;
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      const msg = String(err.message);
      if (msg.includes('email')) return res.status(409).json({ error: 'An account with that email already exists. Try logging in.' });
      return res.status(409).json({ error: 'That web address is taken.' });
    }
    throw err;
  }
  await run('INSERT OR IGNORE INTO store_state (vendor_id) VALUES (?)', [vendorId]);

  if (REQUIRE_EMAIL_VERIFY) {
    const t = await core.createToken(vendorId, 'verify', 24 * 60 * 60 * 1000);
    const link = `${SCHEME}://${core.ROOT_DOMAIN}/api/auth/verify?token=${t}`;
    await sendMail({
      to: email,
      subject: `Activate ${businessName}`,
      text: `Welcome! Activate your page: ${link}`,
      html: `<p>Welcome! Click to activate <b>${escHtml(businessName)}</b>:</p><p><a href="${link}">Activate my page</a></p>`,
    });
    return res.status(201).json({ success: true, pending: true, slug: sv.slug, staffPin });
  }

  const code = await core.createToken(vendorId, 'handoff', 5 * 60 * 1000);
  res.status(201).json({
    success: true,
    pending: false,
    slug: sv.slug,
    staffPin,
    redirect: vendorUrl(sv.slug, `/api/auth/handoff?code=${code}`),
  });
});

/* ---------- preview-first signup with a 6-digit email code ----------
 * 1. The page builds a live preview in the browser (no account, nothing saved).
 * 2. POST /signup/start  {businessName, slug, menuData, ownerName, email, password, acceptTerms}
 *    checks everything and emails a 6-digit code. NOTHING is created or reserved yet.
 * 3. POST /signup/verify {email, code[, slug]} creates the page, verified, and signs the owner in.
 * If email isn't set up on this server (no Resend key) and REQUIRE_EMAIL_VERIFY isn't 'true',
 * step 2 creates the page directly, so signups keep working until email is configured.
 */
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_MAX_TRIES = 5;
const CODE_RESEND_MS = 45 * 1000;
const codeHash = (email, code) => core.sha256(`${email}:${code}`);

function readSignup(b) {
  const out = {
    email: String(b.email || '').trim().toLowerCase(),
    password: String(b.password || ''),
    businessName: String(b.businessName || '').trim(),
    ownerName: String(b.ownerName || '').trim().slice(0, 60),
    ownerIG: cleanIG(b.ownerIG),
    slug: core.validateSlug(b.slug),
  };
  if (!out.businessName || out.businessName.length < 2 || out.businessName.length > 60) out.error = 'Truck name must be 2-60 characters.';
  else if (!out.slug.ok) out.error = out.slug.error;
  else if (!out.ownerName) out.error = 'Please enter your name.';
  else if (!EMAIL_RE.test(out.email) || out.email.length > 120) out.error = 'Please enter a valid email.';
  else if (out.password.length < 8 || out.password.length > 72) out.error = 'Password must be 8-72 characters.';
  else if (b.acceptTerms !== true) out.error = 'Please agree to the Terms and Privacy Policy.';
  return out;
}

/** Creates an active, email-verified vendor. Returns { vendorId, staffPin } or { conflict: 'email'|'slug' }. */
async function createVerifiedVendor({ email, passwordHash, businessName, ownerName, ownerIG, slug, menu }) {
  const staffPin = String(crypto.randomInt(1000, 10000));
  const staffHash = await bcrypt.hash(staffPin, 10);
  const now = Date.now();
  try {
    const r = await run(
      `INSERT INTO vendors (slug, business_name, menu_data, email, password_hash, staff_pin_hash,
                            owner_name, owner_ig, status, plan, plan_status, email_verified, updated_at, terms_accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'free', 'active', 1, ?, ?)`,
      [slug, businessName, JSON.stringify(menu), email, passwordHash, staffHash, ownerName, ownerIG || '', now, now]
    );
    await run('INSERT OR IGNORE INTO store_state (vendor_id) VALUES (?)', [r.lastID]);
    return { vendorId: r.lastID, staffPin };
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') return { conflict: String(err.message).includes('email') ? 'email' : 'slug' };
    throw err;
  }
}

function signupMenu(menuData) {
  // normalizeMenu also enforces the 200-item ceiling. No items = the sample menu, which the owner edits later.
  const menu = core.normalizeMenu(menuData);
  return menu.length ? menu : core.normalizeMenu(core.DEFAULT_MENU);
}

router.post('/signup/start', limitSignup, async (req, res) => {
  if (!req.tenant.isRoot) return res.status(404).json({ error: 'Not found' });
  const s = readSignup(req.body || {});
  if (s.error) return res.status(400).json({ error: s.error });

  if (await get('SELECT id FROM vendors WHERE email = ?', [s.email])) {
    return res.status(409).json({ error: 'An account with that email already exists. Try logging in.', field: 'email' });
  }
  if (await get('SELECT id FROM vendors WHERE slug = ?', [s.slug.slug])) {
    return res.status(409).json({ error: 'That web address was just taken. Please pick another.', field: 'slug' });
  }

  const passwordHash = await bcrypt.hash(s.password, 10);
  const menu = signupMenu((req.body || {}).menuData);

  // No email on this server yet: create the page now (same as before codes existed).
  if (!mailConfigured() && !REQUIRE_EMAIL_VERIFY) {
    console.warn('[signup] Email is not set up, so this page was created without an email code:', s.slug.slug);
    const made = await createVerifiedVendor({ ...s, slug: s.slug.slug, passwordHash, menu });
    if (made.conflict === 'email') return res.status(409).json({ error: 'An account with that email already exists. Try logging in.', field: 'email' });
    if (made.conflict) return res.status(409).json({ error: 'That web address was just taken. Please pick another.', field: 'slug' });
    const handoff = await core.createToken(made.vendorId, 'handoff', 5 * 60 * 1000);
    return res.status(201).json({ created: true, slug: s.slug.slug, staffPin: made.staffPin, redirect: vendorUrl(s.slug.slug, `/api/auth/handoff?code=${handoff}`) });
  }

  const prev = await get('SELECT sent_at FROM pending_signups WHERE email = ?', [s.email]);
  if (prev && Date.now() - prev.sent_at < CODE_RESEND_MS) {
    return res.status(429).json({ error: 'We just sent a code. Please wait a minute before asking for another.' });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  const data = JSON.stringify({ passwordHash, businessName: s.businessName, ownerName: s.ownerName, ownerIG: s.ownerIG, slug: s.slug.slug, menu });
  await run(
    `INSERT INTO pending_signups (email, code_hash, data, attempts, sent_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, data = excluded.data, attempts = 0,
       sent_at = excluded.sent_at, expires_at = excluded.expires_at`,
    [s.email, codeHash(s.email, code), data, now, now + CODE_TTL_MS]
  );
  const sent = await sendMail({
    to: s.email,
    subject: `${code} is your Online Kitchen code`,
    text: `Your code to save ${s.businessName}: ${code}\n\nIt works for 15 minutes. If you didn't ask for this, you can ignore this email.`,
    html: `<p>Your code to save <b>${escHtml(s.businessName)}</b>:</p><p style="font-size:28px;font-weight:800;letter-spacing:6px">${code}</p><p>It works for 15 minutes. If you didn't ask for this, you can ignore this email.</p>`,
  });
  if (!sent) {
    await run('DELETE FROM pending_signups WHERE email = ?', [s.email]);
    return res.status(502).json({ error: "We couldn't send the email just now. Please try again in a minute." });
  }
  res.json({ codeSent: true, email: s.email });
});

router.post('/signup/verify', limitLogin, async (req, res) => {
  if (!req.tenant.isRoot) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const code = String(b.code || '').replace(/\D/g, '');
  const row = email ? await get('SELECT * FROM pending_signups WHERE email = ?', [email]) : null;
  if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: 'This code has expired. Send a new one.', expired: true });
  if (row.attempts >= CODE_MAX_TRIES) {
    await run('DELETE FROM pending_signups WHERE email = ?', [email]);
    return res.status(429).json({ error: 'Too many wrong codes. Send a new one.', expired: true });
  }
  const expected = Buffer.from(row.code_hash);
  const given = Buffer.from(codeHash(email, code));
  if (code.length !== 6 || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    await run('UPDATE pending_signups SET attempts = attempts + 1 WHERE email = ?', [email]);
    const left = CODE_MAX_TRIES - row.attempts - 1;
    return res.status(400).json({ error: left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Send a new one.', expired: left <= 0 });
  }

  const data = JSON.parse(row.data);
  // The web address may have been taken while they checked their email: let them pick another.
  let slug = data.slug;
  if (b.slug !== undefined) {
    const sv = core.validateSlug(b.slug);
    if (!sv.ok) return res.status(400).json({ error: sv.error, field: 'slug' });
    slug = sv.slug;
  }
  const made = await createVerifiedVendor({ ...data, email, slug });
  if (made.conflict === 'slug') return res.status(409).json({ error: `Someone just took ${slug}. Pick another web address and tap Save again.`, field: 'slug' });
  if (made.conflict === 'email') {
    await run('DELETE FROM pending_signups WHERE email = ?', [email]);
    return res.status(409).json({ error: 'An account with that email already exists. Try logging in.', field: 'email' });
  }
  await run('DELETE FROM pending_signups WHERE email = ?', [email]);
  const handoff = await core.createToken(made.vendorId, 'handoff', 5 * 60 * 1000);
  res.status(201).json({ created: true, slug, staffPin: made.staffPin, redirect: vendorUrl(slug, `/api/auth/handoff?code=${handoff}`) });
});

router.get('/verify', async (req, res) => {
  const vendorId = await core.consumeToken(String(req.query.token || ''), 'verify');
  if (!vendorId) return res.status(400).send('This activation link is invalid or has expired.');
  await run("UPDATE vendors SET status = 'active', email_verified = 1, updated_at = ? WHERE id = ? AND status = 'pending'", [Date.now(), vendorId]);
  await run('UPDATE vendors SET email_verified = 1 WHERE id = ?', [vendorId]);
  const v = await get('SELECT slug FROM vendors WHERE id = ?', [vendorId]);
  if (!v) return res.status(400).send('This account no longer exists.');
  const code = await core.createToken(vendorId, 'handoff', 5 * 60 * 1000);
  res.redirect(vendorUrl(v.slug, `/api/auth/handoff?code=${code}`));
});

// Lands the owner on their own subdomain with a fresh session (cookies are host-only).
router.get('/handoff', limitLogin, async (req, res) => {
  const v = req.tenant.vendor;
  if (!v || v.status !== 'active') return res.status(404).send('Not found');
  const vendorId = await core.consumeToken(String(req.query.code || ''), 'handoff');
  if (!vendorId || vendorId !== v.id) return res.redirect('/owner.html');
  await startSession(req, res, v.id, 'owner');
  res.redirect('/owner.html');
});

router.post('/login', limitLogin, async (req, res) => {
  const b = req.body || {};
  const t = req.tenant;

  // Legacy vendors (created before accounts existed) have only a PIN: let it open the owner screen.
  if (b.pin !== undefined && !b.email) {
    const v = t.vendor;
    if (!v || v.status !== 'active') return res.status(404).json({ error: 'Not found' });
    if (v.password_hash) return res.status(400).json({ error: 'Please log in with your email and password.' });
    if (pinLocked(v.id, req.ip)) return res.status(429).json({ error: 'Too many attempts from this device. Try again in 15 minutes.' });
    const ok = v.staff_pin_hash ? await bcrypt.compare(String(b.pin), v.staff_pin_hash) : false;
    if (!ok) { pinFailed(v.id, req.ip); return res.status(401).json({ error: 'Incorrect PIN.' }); }
    await startSession(req, res, v.id, 'owner');
    return res.json({ ok: true, role: 'owner' });
  }

  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const vendor = email ? await get('SELECT * FROM vendors WHERE email = ?', [email]) : null;
  const ok = await bcrypt.compare(password.slice(0, 72), vendor && vendor.password_hash ? vendor.password_hash : DUMMY_HASH);
  if (!vendor || !vendor.password_hash || !ok) return res.status(401).json({ error: 'Incorrect email or password.' });
  if (vendor.status === 'pending') return res.status(403).json({ error: 'Please activate your page using the link we emailed you.' });
  if (vendor.status !== 'active') return res.status(403).json({ error: 'This account is not active. Contact support.' });

  if (t.isRoot) {
    // Login from the main site: bounce them to their own subdomain with a handoff code.
    const code = await core.createToken(vendor.id, 'handoff', 5 * 60 * 1000);
    return res.json({ ok: true, redirect: vendorUrl(vendor.slug, `/api/auth/handoff?code=${code}`) });
  }
  // An owner with more than one truck: the same login opens every truck in the fleet.
  const fleetTruck = t.vendor && t.vendor.id !== vendor.id && (await require('./fleet').sameFleet(vendor, t.vendor));
  if (!t.vendor || (t.vendor.id !== vendor.id && !fleetTruck)) return res.status(403).json({ error: 'That account does not belong to this page.' });
  await startSession(req, res, t.vendor.id, 'owner');
  res.json({ ok: true, role: 'owner' });
});

router.post('/staff', limitLogin, async (req, res) => {
  const v = req.tenant.vendor;
  if (!v || v.status !== 'active') return res.status(404).json({ error: 'Not found' });
  if (pinLocked(v.id, req.ip)) return res.status(429).json({ error: 'Too many attempts from this device. Try again in 15 minutes.' });
  const pin = String((req.body || {}).pin || '').trim();
  // A crew member's own PIN first (their name goes on everything they do), then the shared kitchen PIN.
  if (PIN_RE.test(pin)) {
    const m = await get('SELECT * FROM staff_members WHERE vendor_id = ? AND pin_lookup = ?', [v.id, await core.pinLookup(v.id, pin)]);
    if (m && (await bcrypt.compare(pin.toUpperCase(), m.pin_hash))) {
      await run('UPDATE staff_members SET last_login_at = ? WHERE id = ?', [Date.now(), m.id]);
      await startSession(req, res, v.id, 'staff', m.id);
      return res.json({ ok: true, role: 'staff', name: m.name });
    }
  }
  const ok = v.staff_pin_hash ? await bcrypt.compare(pin, v.staff_pin_hash) : false;
  if (!ok) { pinFailed(v.id, req.ip); return res.status(401).json({ error: 'Incorrect PIN.' }); }
  await startSession(req, res, v.id, 'staff');
  res.json({ ok: true, role: 'staff' });
});

router.post('/logout', async (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await run('DELETE FROM sessions WHERE token_hash = ?', [core.sha256(token)]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ---------- each PIN remembers its kitchen screen ----------
   Text size, sound, read aloud, day/night, station, glove mode, rush view and the ready button follow the
   person, so signing in on any tablet sets it up their way. The shared PIN has no person: device only. */
const PREF_KEYS = { text: ['normal', 'large', 'xl'], theme: ['auto', 'day', 'night'], rush: ['auto', 'on', 'off'] };
function cleanPrefs(p) {
  p = p && typeof p === 'object' ? p : {};
  const out = {};
  for (const [k, allowed] of Object.entries(PREF_KEYS)) if (allowed.includes(p[k])) out[k] = p[k];
  for (const k of ['sound', 'speak', 'glove']) if (typeof p[k] === 'boolean') out[k] = p[k];
  if (Array.isArray(p.station)) out.station = p.station.map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 20);
  if (p.bumpKey && typeof p.bumpKey === 'object') out.bumpKey = { key: String(p.bumpKey.key || '').slice(0, 30), code: String(p.bumpKey.code || '').slice(0, 30) };
  else if (p.bumpKey === null) out.bumpKey = null;
  return out;
}
async function prefsFor(s, v) {
  try {
    if (s.role === 'owner') return JSON.parse(v.owner_prefs_json || 'null');
    if (s.staff_id) { const m = await get('SELECT prefs_json FROM staff_members WHERE id = ? AND vendor_id = ?', [s.staff_id, v.id]); return m ? JSON.parse(m.prefs_json || 'null') : null; }
  } catch (e) { /* bad JSON: start fresh */ }
  return null;
}
router.put('/prefs', async (req, res) => {
  const s = await getSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  const v = req.tenant.vendor;
  const merged = Object.assign({}, (await prefsFor(s, v)) || {}, cleanPrefs(req.body));
  if (s.role === 'owner') await run('UPDATE vendors SET owner_prefs_json = ? WHERE id = ?', [JSON.stringify(merged), v.id]);
  else if (s.staff_id) await run('UPDATE staff_members SET prefs_json = ? WHERE id = ? AND vendor_id = ?', [JSON.stringify(merged), s.staff_id, v.id]);
  else return res.json({ prefs: merged, saved: false }); // shared PIN: this device only
  res.json({ prefs: merged, saved: true });
});

router.get('/me', async (req, res) => {
  const s = await getSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  const v = req.tenant.vendor;
  res.set('Cache-Control', 'no-store');
  res.json({
    role: s.role,
    staffName: s.staff_name || '',   // the crew member signed in on this screen (named PINs)
    staffId: s.staff_id || null,
    prefs: await prefsFor(s, v),     // their kitchen screen setup (null: none saved yet)
    vendor: {
      businessName: v.business_name,
      slug: v.slug,
      ownerName: v.owner_name || '',
      ownerIG: v.owner_ig || '',
      emoji: v.emoji || '',
      brand: core.brandOf(v),
      email: s.role === 'owner' ? v.email || '' : undefined,
      plan: core.effectivePlan(v),
      planStatus: v.plan_status,
      features: core.features(v),
      hasPassword: !!v.password_hash,
    },
  });
});

router.post('/forgot', limitMailer, async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const v = email ? await get('SELECT id, business_name FROM vendors WHERE email = ?', [email]) : null;
  if (v) {
    const t = await core.createToken(v.id, 'reset', 60 * 60 * 1000);
    const link = `${SCHEME}://${core.ROOT_DOMAIN}/reset.html?token=${t}`;
    await sendMail({
      to: email,
      subject: 'Reset your password',
      text: `Reset your password (valid 1 hour): ${link}`,
      html: `<p>Reset your password (valid 1 hour):</p><p><a href="${link}">Choose a new password</a></p>`,
    });
  }
  res.json({ ok: true }); // same answer either way, so emails can't be probed
});

router.post('/reset', limitLogin, async (req, res) => {
  const b = req.body || {};
  const password = String(b.password || '');
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8-72 characters.' });
  const vendorId = await core.consumeToken(String(b.token || ''), 'reset');
  if (!vendorId) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  await run('UPDATE vendors SET password_hash = ?, updated_at = ? WHERE id = ?', [await bcrypt.hash(password, 10), Date.now(), vendorId]);
  await run('DELETE FROM sessions WHERE vendor_id = ?', [vendorId]); // sign out everywhere
  res.json({ ok: true });
});

module.exports = {
  router, tenant, requireVendor, requireRole, getSession, startSession, clearSessionCookie, requestToken,
  rateLimit, sendMail, mailLater, retryMail, mailConfigured, brandFor, brandWrap, escHtml, parseCookies, vendorUrl, EMAIL_RE, PIN_RE, cleanIG,
};
