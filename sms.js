'use strict';
/**
 * sms.js — text alerts through Twilio (Pro plan only).
 *   • Owners: "New order #105…" — always, or only when no kitchen screen is open.
 *   • Customers: "Your order is ready" — only if they typed a number and ticked the consent box.
 *
 * .env:  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and either TWILIO_MESSAGING_SERVICE_SID (recommended)
 *        or TWILIO_FROM (+15551234567).  Optional: SMS_MONTHLY_LIMIT (per truck, default 1000).
 * US texting needs A2P 10DLC registration in Twilio before carriers will deliver messages.
 * Twilio handles STOP / HELP replies automatically on Messaging Services.
 */
const express = require('express');
const crypto = require('crypto');
const core = require('./core');
const auth = require('./auth');
const { run, get } = core;

const API_BASE = process.env.TWILIO_API_BASE || 'https://api.twilio.com'; // overridable for testing
const MONTHLY_LIMIT = parseInt(process.env.SMS_MONTHLY_LIMIT, 10) || 1000;

function configured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM));
}
const enabledFor = (v) => !!(v && core.features(v).sms && configured());

/** US numbers only for now. Returns +1XXXXXXXXXX or null. */
function normalizePhone(input) {
  const d = String(input || '').replace(/\D/g, '');
  const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  if (ten.length !== 10 || /^[01]/.test(ten)) return null; // US area codes never start with 0 or 1
  return '+1' + ten;
}
const maskPhone = (p) => (p ? p.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) •••-$3') : '');

/** Sends one text. Never throws; returns true when Twilio accepted it. */
async function sendRaw(to, body) {
  if (!configured()) { console.warn(`[SMS not configured — not sent] to=${to} "${body}"`); return false; }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const form = new URLSearchParams({ To: to, Body: body.slice(0, 320) });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set('From', process.env.TWILIO_FROM);
  try {
    const r = await fetch(`${API_BASE}/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!r.ok) { console.error('SMS send failed:', r.status, (await r.text()).slice(0, 300)); return false; }
    return true;
  } catch (e) {
    console.error('SMS send error:', e.message);
    return false;
  }
}

function monthStart() { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
async function usedThisMonth(vendorId) {
  const r = await get('SELECT COUNT(*) AS n FROM sms_log WHERE vendor_id = ? AND created_at >= ?', [vendorId, monthStart()]);
  return r ? r.n : 0;
}

/** Sends a text on a truck's behalf, counted against its monthly allowance. */
async function sendForVendor(v, kind, to, body) {
  if (!enabledFor(v) || !to) return false;
  if ((await usedThisMonth(v.id)) >= MONTHLY_LIMIT) { console.warn(`SMS monthly limit reached for vendor ${v.id}`); return false; }
  await run('INSERT INTO sms_log (vendor_id, kind, created_at) VALUES (?, ?, ?)', [v.id, kind, Date.now()]);
  return sendRaw(to, body);
}

/* ---------- what triggers a text ---------- */

/**
 * Call when an order is ready for the kitchen (placed for the window, or paid online).
 * Puts it on every open kitchen screen, and texts the owner if they asked for it.
 */
async function notifyNewOrder(vendorId, order) {
  const screens = core.broadcast(vendorId, 'ORDER_NEW', order, true);
  try {
    const v = await get('SELECT * FROM vendors WHERE id = ?', [vendorId]);
    if (!v || !enabledFor(v) || !v.owner_phone || !v.owner_phone_verified) return;
    const mode = v.sms_owner_mode || 'idle';
    if (mode === 'off' || (mode === 'idle' && screens > 0)) return;
    const paid = order.payment === 'paid' ? ' (paid online)' : '';
    await sendForVendor(v, 'owner_new', v.owner_phone, `New order #${order.ticket} from ${order.name}: ${order.summary} — $${Number(order.total).toFixed(2)}${paid}`);
  } catch (e) { console.error('Owner SMS failed:', e.message); }
}

/** Call when the kitchen taps Mark Ready. */
async function notifyReady(v, orderRow) {
  if (!orderRow.customer_phone || !v.sms_customer_ready) return;
  await sendForVendor(v, 'customer_ready', orderRow.customer_phone,
    `${v.business_name}: your order #${orderRow.ticket_no} is ready for pickup! Reply STOP to opt out.`).catch(() => {});
}

/* ---------- owner settings routes (/api/sms/...) ---------- */
const router = express.Router();
const ownerOnly = [auth.requireVendor, auth.requireRole('owner')];
const limitCodes = auth.rateLimit({ windowMs: 60 * 60 * 1000, max: 5, key: (req) => 'smscode:' + (req.tenant.vendor ? req.tenant.vendor.id : req.ip) });
const limitVerify = auth.rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: (req) => 'smsverify:' + (req.tenant.vendor ? req.tenant.vendor.id : req.ip) });

const codeHash = (vendorId, phone, code) => core.sha256(`phone:${vendorId}:${phone}:${code}`);

router.get('/status', ownerOnly, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  res.json({
    configured: configured(),
    pro: !!core.features(v).sms,
    phone: maskPhone(v.owner_phone),
    verified: !!(v.owner_phone && v.owner_phone_verified),
    pending: maskPhone(v.owner_phone_pending),
    ownerMode: v.sms_owner_mode || 'idle',
    customerReady: !!v.sms_customer_ready,
    used: await usedThisMonth(v.id),
    limit: MONTHLY_LIMIT,
  });
});

// Step 1: owner types their number; we text a 6-digit code to prove it's theirs.
router.post('/owner-phone', ownerOnly, limitCodes, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  if (!core.features(v).sms) return res.status(402).json({ error: 'Text alerts are a Pro feature.', upgrade: true });
  if (!configured()) return res.status(503).json({ error: 'Text messaging is not set up on the server yet.' });
  const phone = normalizePhone((req.body || {}).phone);
  if (!phone) return res.status(400).json({ error: 'Enter a 10-digit US mobile number.' });
  const code = String(crypto.randomInt(100000, 1000000));
  await run("DELETE FROM tokens WHERE vendor_id = ? AND kind = 'phone'", [v.id]);
  await run("INSERT INTO tokens (token_hash, vendor_id, kind, expires_at, used) VALUES (?, ?, 'phone', ?, 0)", [codeHash(v.id, phone, code), v.id, Date.now() + 10 * 60 * 1000]);
  await run('UPDATE vendors SET owner_phone_pending = ? WHERE id = ?', [phone, v.id]);
  const ok = await sendRaw(phone, `Your ${v.business_name} verification code is ${code}. It expires in 10 minutes.`);
  if (!ok) return res.status(502).json({ error: 'We could not text that number. Check it and try again.' });
  res.json({ ok: true, phone: maskPhone(phone) });
});

// Step 2: owner types the code back.
router.post('/owner-phone/verify', ownerOnly, limitVerify, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const code = String((req.body || {}).code || '').replace(/\D/g, '');
  if (!v.owner_phone_pending || code.length !== 6) return res.status(400).json({ error: 'Enter the 6-digit code we texted you.' });
  const row = await get(
    "UPDATE tokens SET used = 1 WHERE token_hash = ? AND kind = 'phone' AND used = 0 AND expires_at > ? RETURNING vendor_id",
    [codeHash(v.id, v.owner_phone_pending, code), Date.now()]
  );
  if (!row || row.vendor_id !== v.id) return res.status(400).json({ error: 'That code is wrong or has expired.' });
  await run('UPDATE vendors SET owner_phone = owner_phone_pending, owner_phone_pending = NULL, owner_phone_verified = 1, updated_at = ? WHERE id = ?', [Date.now(), v.id]);
  res.json({ ok: true, phone: maskPhone(v.owner_phone_pending) });
});

router.delete('/owner-phone', ownerOnly, async (req, res) => {
  await run('UPDATE vendors SET owner_phone = NULL, owner_phone_pending = NULL, owner_phone_verified = 0 WHERE id = ?', [req.tenant.vendor.id]);
  res.json({ ok: true });
});

router.put('/settings', ownerOnly, async (req, res) => {
  const b = req.body || {};
  const sets = [], params = [];
  if (b.ownerMode !== undefined) {
    if (!['off', 'idle', 'always'].includes(b.ownerMode)) return res.status(400).json({ error: 'Unknown option.' });
    sets.push('sms_owner_mode = ?'); params.push(b.ownerMode);
  }
  if (b.customerReady !== undefined) { sets.push('sms_customer_ready = ?'); params.push(b.customerReady ? 1 : 0); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  params.push(req.tenant.vendor.id);
  await run(`UPDATE vendors SET ${sets.join(', ')} WHERE id = ?`, params);
  res.json({ ok: true });
});

module.exports = { router, configured, enabledFor, normalizePhone, sendRaw, sendForVendor, notifyNewOrder, notifyReady, usedThisMonth };
