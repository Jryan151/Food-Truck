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

async function sendMail({ to, subject, html, text }) {
  if (!mailConfigured()) {
    console.warn(`[MAIL NOT CONFIGURED — this email was NOT sent] to=${to} subject="${subject}"\n${text}\n`);
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, html, text }),
    });
    if (!r.ok) console.error('Mail send failed:', r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error('Mail send error:', e.message);
    return false;
  }
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
  const s = await get('SELECT vendor_id, role, expires_at FROM sessions WHERE token_hash = ?', [core.sha256(token)]);
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

async function startSession(req, res, vendorId, role) {
  const token = core.randomToken(32);
  const ttl = role === 'owner' ? OWNER_TTL : STAFF_TTL;
  await run('INSERT INTO sessions (token_hash, vendor_id, role, expires_at) VALUES (?, ?, ?, ?)', [
    core.sha256(token), vendorId, role, Date.now() + ttl,
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
  if (!t.vendor || t.vendor.id !== vendor.id) return res.status(403).json({ error: 'That account does not belong to this page.' });
  await startSession(req, res, vendor.id, 'owner');
  res.json({ ok: true, role: 'owner' });
});

router.post('/staff', limitLogin, async (req, res) => {
  const v = req.tenant.vendor;
  if (!v || v.status !== 'active') return res.status(404).json({ error: 'Not found' });
  if (pinLocked(v.id, req.ip)) return res.status(429).json({ error: 'Too many attempts from this device. Try again in 15 minutes.' });
  const pin = String((req.body || {}).pin || '');
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

router.get('/me', async (req, res) => {
  const s = await getSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  const v = req.tenant.vendor;
  res.set('Cache-Control', 'no-store');
  res.json({
    role: s.role,
    vendor: {
      businessName: v.business_name,
      slug: v.slug,
      ownerName: v.owner_name || '',
      ownerIG: v.owner_ig || '',
      emoji: v.emoji || '',
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
  rateLimit, sendMail, mailConfigured, escHtml, parseCookies, vendorUrl, EMAIL_RE, PIN_RE, cleanIG,
};
