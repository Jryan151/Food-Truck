'use strict';
/* =====================================================================
   Private customer feedback. After pickup the customer can tap 👍 or 👎 (plus an optional reason).
   Only the owner sees it, and as patterns ("Took too long" 4 times, mostly at lunch) rather than a
   stream of one-off complaints. No names are kept with it.
   ===================================================================== */
const express = require('express');
const core = require('./core');
const auth = require('./auth');
const Insights = require('./public/insights-core');
const Day = require('./public/day-core');
const { run, get, all } = core;
const { requireVendor, requireRole, rateLimit } = auth;

const router = express.Router();
const ownerOnly = [requireVendor, requireRole('owner')];
const limit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });
const OPEN_FOR_MS = 3 * 24 * 60 * 60 * 1000;  // feedback is taken for 3 days after an order
const CHANGE_MS = 30 * 60 * 1000;             // a vote can be changed for 30 minutes

router.post('/order/:token', limit, requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  const vote = b.vote === 1 || b.vote === -1 ? b.vote : null;
  if (!vote) return res.status(400).json({ error: 'Pick 👍 or 👎.' });
  const o = await get('SELECT id, status, created_at, items_json FROM orders WHERE vendor_id = ? AND public_token = ?', [v.id, String(req.params.token || '')]);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (!['Ready', 'Fulfilled'].includes(o.status)) return res.status(409).json({ error: 'You can rate your order once it’s ready.' });
  if (Date.now() - o.created_at > OPEN_FOR_MS) return res.status(409).json({ error: 'This order is too old to rate.' });
  const allowed = vote > 0 ? Day.TAGS_UP : Day.TAGS_DOWN;
  const tags = Array.isArray(b.tags) ? [...new Set(b.tags.map(String).filter((t) => allowed.includes(t)))].slice(0, 4) : [];
  const comment = String(b.comment || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
  let names = [];
  try { names = [...new Set((JSON.parse(o.items_json) || []).map((i) => Insights.baseName(i.name)))]; } catch (e) {}
  const now = Date.now();
  const r = await run(
    `INSERT INTO order_feedback (vendor_id, order_id, vote, tags, comment, items, at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (order_id) DO UPDATE SET vote = excluded.vote, tags = excluded.tags, comment = COALESCE(excluded.comment, order_feedback.comment)
     WHERE order_feedback.at > ?`,
    [v.id, o.id, vote, JSON.stringify(tags), comment, JSON.stringify(names), now, now - CHANGE_MS]);
  if (!r.changes) return res.status(409).json({ error: 'Thanks, you already rated this order.' });
  res.json({ ok: true, vote });
});

router.get('/owner', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const tz = Insights.validTz(v.timezone);
  const days = [7, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
  const now = Date.now(), from = now - days * Insights.DAY;
  const shape = (r) => ({ vote: r.vote, tags: JSON.parse(r.tags || '[]'), comment: r.comment || '', items: JSON.parse(r.items || '[]'), at: r.at });
  const rows = (await all('SELECT * FROM order_feedback WHERE vendor_id = ? AND at >= ?', [v.id, from])).map(shape);
  const prev = (await all('SELECT * FROM order_feedback WHERE vendor_id = ? AND at >= ? AND at < ?', [v.id, from - days * Insights.DAY, from])).map(shape);
  const orders = await get("SELECT COUNT(*) AS n FROM orders WHERE vendor_id = ? AND status IN ('Ready','Fulfilled') AND created_at >= ?", [v.id, from]);
  res.json(Object.assign(Day.feedbackPatterns(rows, prev, tz), { days, orders: orders.n }));
});

module.exports = { router };
