/* rewards.js — the punch card.
   No logins: the card lives on the customer's phone as a private token (only its hash is stored here).
   Stamps are only added when the kitchen marks the order Ready or picked up, never just for placing it,
   and come back off if that order is canceled. A free item is taken off the most expensive item in the
   order, up to the owner's cap, and shows as its own line so the receipt, the card charge and the
   kitchen all see the same thing. */
'use strict';
const express = require('express');
const crypto = require('crypto');
const core = require('./core');
const auth = require('./auth');
const { run, get, all } = core;
const { requireVendor, requireRole, rateLimit, mailLater, mailConfigured, escHtml, EMAIL_RE } = auth;

const router = express.Router();
const ownerOnly = [requireVendor, requireRole('owner')];
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const DEFAULTS = { on: false, name: 'Punch card', every: 8, minCents: 500, capCents: 1200 };
function normalize(x) {
  x = x && typeof x === 'object' ? x : {};
  const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  return {
    on: x.on === true,
    name: String(x.name || DEFAULTS.name).trim().slice(0, 30) || DEFAULTS.name,
    every: int(x.every, 3, 20, DEFAULTS.every),
    minCents: int(x.minCents, 0, 10000, DEFAULTS.minCents),
    capCents: int(x.capCents, 100, 10000, DEFAULTS.capCents),
  };
}
const proOpen = (v) => !!core.features(v).rewards || process.env.FREE_BETA === 'true' || !(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
function settings(v) {
  let s = {};
  try { s = JSON.parse(v.rewards_json || '{}'); } catch (e) {}
  return normalize(s);
}
const enabled = (v) => proOpen(v) && settings(v).on;

async function cardByToken(vendorId, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  return get('SELECT * FROM reward_cards WHERE vendor_id = ? AND token_hash = ?', [vendorId, sha(token)]);
}
async function newCard(vendorId) {
  const token = core.randomToken(20);
  const now = Date.now();
  const r = await run('INSERT INTO reward_cards (vendor_id, token_hash, stamps, rewards_used, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?)', [vendorId, sha(token), now, now]);
  return { card: await get('SELECT * FROM reward_cards WHERE id = ?', [r.lastID]), token };
}
const cardShape = (s, card) => ({
  on: true, name: s.name, every: s.every, minCents: s.minCents, capCents: s.capCents,
  stamps: card ? card.stamps : 0, ready: !!card && card.stamps >= s.every, used: card ? card.rewards_used : 0,
});

/**
 * Called while an order is being placed (before it is saved).
 * items: the priced lines [{id, name, qty, price}] — changed in place when a reward is used.
 * Returns { cardId, token (only when a new card was made), rewardCents, rewardEvery } or { error, status }.
 */
async function atOrder(v, { cardToken, useReward, items }) {
  if (!enabled(v)) return { cardId: null, rewardCents: 0, rewardEvery: null };
  const s = settings(v);
  let card = await cardByToken(v.id, cardToken);
  let token = null;
  let rewardCents = 0;
  if (useReward) {
    if (!card || card.stamps < s.every) return { error: 'Your free item isn’t ready yet.', status: 409 };
    // The most expensive single unit, up to the cap.
    let best = -1;
    items.forEach((it, i) => { if (best < 0 || it.price > items[best].price) best = i; });
    if (best < 0) return { error: 'Your cart is empty.', status: 400 };
    const unitCents = Math.round(items[best].price * 100);
    rewardCents = Math.min(unitCents, s.capCents);
    // Take the stamps now (atomically), so two phones can't spend one card twice.
    const took = await run('UPDATE reward_cards SET stamps = stamps - ?, rewards_used = rewards_used + 1, updated_at = ? WHERE id = ? AND stamps >= ?', [s.every, Date.now(), card.id, s.every]);
    if (!took.changes) return { error: 'Your free item isn’t ready yet.', status: 409 };
    const line = items[best];
    const free = Object.assign({}, line, { qty: 1, price: Math.round(unitCents - rewardCents) / 100, name: `${line.name} (${s.name} reward)`, reward: true });
    if (line.qty > 1) { line.qty -= 1; items.splice(best + 1, 0, free); } else items[best] = free;
  }
  if (!card) { const made = await newCard(v.id); card = made.card; token = made.token; }
  return { cardId: card.id, token, rewardCents, rewardEvery: rewardCents ? s.every : null };
}

/** Same checks as atOrder, without touching anything: the reward a customer would get. */
async function preview(v, { cardToken, useReward, items }) {
  if (!enabled(v) || !useReward) return { rewardCents: 0 };
  const s = settings(v);
  const card = await cardByToken(v.id, cardToken);
  if (!card || card.stamps < s.every) return { error: 'Your free item isn’t ready yet.', status: 409 };
  const top = items.reduce((m, it) => Math.max(m, Math.round(it.price * 100)), 0);
  return { rewardCents: Math.min(top, s.capCents) };
}
/** Puts the stamps back when an order that used a reward never got saved. */
async function giveBack(cardId, every) {
  if (cardId && every) await run('UPDATE reward_cards SET stamps = stamps + ?, rewards_used = MAX(0, rewards_used - 1) WHERE id = ?', [every, cardId]);
}

/** A stamp, once, when the kitchen marks the order Ready or picked up. */
async function stamp(vendorId, orderId) {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [vendorId]);
  if (!v || !enabled(v)) return false;
  const s = settings(v);
  const o = await get('UPDATE orders SET stamped = 1 WHERE id = ? AND vendor_id = ? AND stamped = 0 AND card_id IS NOT NULL AND (total * 100 + COALESCE(reward_cents, 0)) >= ? RETURNING card_id', [orderId, vendorId, s.minCents - 0.5]);
  if (!o) return false;
  await run('UPDATE reward_cards SET stamps = stamps + 1, last_stamp_at = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), o.card_id]);
  return true;
}

/** An order was canceled: give back a reward it used, take back a stamp it earned. Safe to call twice. */
async function undo(orderId) {
  const o = await get('SELECT id, card_id, reward_cents, reward_every, reward_returned, stamped FROM orders WHERE id = ?', [orderId]);
  if (!o || !o.card_id) return;
  if (o.reward_cents > 0 && !o.reward_returned) {
    const r = await run('UPDATE orders SET reward_returned = 1 WHERE id = ? AND reward_returned = 0', [o.id]);
    if (r.changes) await run('UPDATE reward_cards SET stamps = stamps + ?, rewards_used = MAX(0, rewards_used - 1), updated_at = ? WHERE id = ?', [o.reward_every || 0, Date.now(), o.card_id]);
  }
  if (o.stamped) {
    const r = await run('UPDATE orders SET stamped = 0 WHERE id = ? AND stamped = 1', [o.id]);
    if (r.changes) await run('UPDATE reward_cards SET stamps = MAX(0, stamps - 1), updated_at = ? WHERE id = ?', [Date.now(), o.card_id]);
  }
}
// Orders the system closes on its own (stale tickets) follow the same rules.
core.onOrderClosed((vendorId, orderId, event) => (event === 'canceled' || event === 'expired' ? undo(orderId) : stamp(vendorId, orderId)));

/* ---------- customer ---------- */
router.get('/', requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  res.set('Cache-Control', 'no-store');
  if (!enabled(v)) return res.json({ on: false });
  const card = await cardByToken(v.id, req.query.card);
  res.json(Object.assign(cardShape(settings(v), card), { known: !!card, canSave: mailConfigured() }));
});

// "Keep my card": emails a link that puts this card on any phone. Same answer whatever happens.
const limitSave = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
router.post('/save', requireVendor, limitSave, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
  if (!mailConfigured()) return res.status(503).json({ error: 'Email isn’t available right now.' });
  const card = enabled(v) && (await cardByToken(v.id, b.card));
  if (card) {
    const link = `${req.secure ? 'https' : 'http'}://${req.tenant.host}/?card=${encodeURIComponent(b.card)}`;
    mailLater({
      to: email, replyTo: v.email || undefined, brand: auth.brandFor(v), subject: `Your ${v.business_name} ${settings(v).name.toLowerCase()}`,
      text: `Open this on any phone to keep your ${settings(v).name.toLowerCase()} (${card.stamps} stamp${card.stamps === 1 ? '' : 's'} so far): ${link}\n\nKeep this email private: the link is your card.`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111"><h2 style="margin:0 0 8px">Your ${escHtml(settings(v).name.toLowerCase())}</h2><p>${card.stamps} stamp${card.stamps === 1 ? '' : 's'} so far. Open this link on any phone to keep collecting.</p><p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">Open my card</a></p><p style="color:#777;font-size:12px">Keep this email private: the link is your card.</p></div>`,
    }).catch(() => {});
  }
  res.json({ ok: true, message: 'Sent. Open the link on any phone to keep your card.' });
});

/* ---------- owner ---------- */
router.get('/owner', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const stats = await get('SELECT COUNT(*) AS cards, COALESCE(SUM(rewards_used), 0) AS used, COALESCE(SUM(CASE WHEN stamps > 0 THEN 1 ELSE 0 END), 0) AS active FROM reward_cards WHERE vendor_id = ?', [v.id]);
  const given = await get('SELECT COUNT(*) AS n FROM orders WHERE vendor_id = ? AND stamped = 1', [v.id]);
  res.json({ settings: settings(v), allowed: proOpen(v), stats: { cards: stats.cards, active: stats.active, rewardsUsed: stats.used, stampsGiven: given.n } });
});
router.put('/owner', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  if (!proOpen(v)) return res.status(402).json({ error: 'The punch card is part of Pro.', upgrade: true });
  const s = normalize(req.body || {});
  await run('UPDATE vendors SET rewards_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(s), Date.now(), v.id]);
  core.broadcast(v.id, 'REWARDS_UPDATE', s.on ? { on: true, name: s.name, every: s.every, capCents: s.capCents, minCents: s.minCents } : { on: false });
  res.json({ settings: s });
});

module.exports = { router, atOrder, preview, giveBack, stamp, undo, enabled, settings, normalize };
