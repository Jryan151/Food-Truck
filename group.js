'use strict';
/* =====================================================================
   Group order: one link, everyone adds their own items, one pickup and one name.
   The host starts it from their cart and shares the link. Each person picks their items on their own
   phone and taps "Add to <host>'s order". The host sees everyone's items live and places one order
   (the normal checkout: same prices, stock and rules), with who-gets-what written on the ticket.
   Nothing about a person is kept beyond the first name they type, and groups end after 3 hours.
   ===================================================================== */
const express = require('express');
const crypto = require('crypto');
const core = require('./core');
const auth = require('./auth');
const { run, get, all } = core;
const { requireVendor, rateLimit } = auth;

const router = express.Router();
const limit = rateLimit({ windowMs: 10 * 60 * 1000, max: 60 });
const LIFE_MS = 3 * 60 * 60 * 1000;
const MAX_PEOPLE = 20;
const MAX_LINES = 30;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 30);

/** Checks a person's items against the menu: real items, sensible amounts. */
function cleanItems(menu, items) {
  const byId = new Map(menu.map((m) => [m.id, m]));
  const out = [];
  for (const l of Array.isArray(items) ? items.slice(0, MAX_LINES) : []) {
    const m = byId.get(parseInt(l && l.id, 10));
    const qty = parseInt(l && l.qty, 10);
    if (!m || !Number.isInteger(qty) || qty < 1 || qty > 50) continue;
    const meats = m.meats ? m.meats.split(',').map((x) => x.trim()).filter(Boolean) : [];
    const meat = l.meat && meats.includes(String(l.meat)) ? String(l.meat) : '';
    const option = l.option && (m.options || []).includes(String(l.option)) ? String(l.option) : '';
    out.push({ id: m.id, qty, meat, option });
  }
  return out;
}
function label(menu, l) {
  const m = menu.find((x) => x.id === l.id);
  return (m ? m.name : 'Item') + (l.meat ? ` (${l.meat})` : '') + (l.option ? ` (${l.option})` : '');
}

async function groupOf(vendorId, token) {
  const g = await get('SELECT * FROM group_orders WHERE vendor_id = ? AND token = ?', [vendorId, String(token || '')]);
  if (!g) return null;
  if (g.status === 'open' && g.expires_at < Date.now()) { await run("UPDATE group_orders SET status = 'expired' WHERE id = ? AND status = 'open'", [g.id]); g.status = 'expired'; }
  return g;
}
const tell = (vendorId, token) => core.broadcast(vendorId, 'GROUP', { tag: core.orderTag(token) });

async function shape(v, g, key) {
  const menu = core.parseMenu(v.menu_data);
  const people = await all('SELECT name, key_hash, items_json, allergy, updated_at FROM group_people WHERE group_id = ? ORDER BY id', [g.id]);
  const mine = KEY_RE.test(String(key || '')) ? sha(key) : null;
  let order = null;
  if (g.order_id) {
    const o = await get('SELECT ticket_no, status, pickup_at FROM orders WHERE id = ?', [g.order_id]);
    if (o) order = { ticket: o.ticket_no, status: o.status, pickupAt: o.pickup_at || null };
  }
  return {
    host: g.host_name,
    status: g.status,
    isHost: !!mine && mine === g.host_key_hash,
    expiresAt: g.expires_at,
    order,
    people: people.map((p) => {
      const items = JSON.parse(p.items_json || '[]');
      const isMine = !!mine && p.key_hash === mine;
      // Allergies go to the host (for the kitchen) and the person who wrote it, nobody else in the group.
      const seeAllergy = isMine || (!!mine && mine === g.host_key_hash);
      return { name: p.name, mine: isMine, host: p.key_hash === g.host_key_hash, allergy: seeAllergy ? p.allergy || '' : undefined, items: items.map((l) => Object.assign({ label: label(menu, l) }, l)) };
    }),
  };
}

// The host starts a group with what's in their cart.
router.post('/', limit, requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  const name = cleanName(b.name);
  if (!name) return res.status(400).json({ error: 'Add your name, so everyone knows whose order it is.' });
  if (!KEY_RE.test(String(b.key || ''))) return res.status(400).json({ error: 'Please refresh the page and try again.' });
  const items = cleanItems(core.parseMenu(v.menu_data), b.items);
  const token = core.randomToken(10);
  const now = Date.now();
  const g = await run('INSERT INTO group_orders (vendor_id, token, host_name, host_key_hash, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [v.id, token, name, sha(b.key), 'open', now, now + LIFE_MS]);
  await run('INSERT INTO group_people (group_id, name, key_hash, items_json, updated_at) VALUES (?, ?, ?, ?, ?)', [g.lastID, name, sha(b.key), JSON.stringify(items), now]);
  res.status(201).json({ token, group: await shape(v, await groupOf(v.id, token), b.key) });
});

router.get('/:token', requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const g = await groupOf(v.id, req.params.token);
  res.set('Cache-Control', 'no-store');
  if (!g) return res.status(404).json({ error: 'This group order link isn’t valid.' });
  res.json(await shape(v, g, req.query.key));
});

// Each person's own items (replaces what they added before; no items = leave the group).
router.put('/:token/me', limit, requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  const g = await groupOf(v.id, req.params.token);
  if (!g) return res.status(404).json({ error: 'This group order link isn’t valid.' });
  if (g.status !== 'open') return res.status(409).json({ error: g.status === 'placed' ? `${g.host_name} already placed this order.` : 'This group order has ended.', status: g.status });
  if (!KEY_RE.test(String(b.key || ''))) return res.status(400).json({ error: 'Please refresh the page and try again.' });
  const name = cleanName(b.name);
  const items = cleanItems(core.parseMenu(v.menu_data), b.items);
  const allergy = b.allergy === undefined ? undefined : String(b.allergy || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
  const kh = sha(b.key);
  const existing = await get('SELECT id FROM group_people WHERE group_id = ? AND key_hash = ?', [g.id, kh]);
  if (!items.length) {
    if (existing && kh !== g.host_key_hash) await run('DELETE FROM group_people WHERE id = ?', [existing.id]);
    else if (existing) await run('UPDATE group_people SET items_json = ?, updated_at = ? WHERE id = ?', ['[]', Date.now(), existing.id]);
  } else {
    if (!name) return res.status(400).json({ error: 'Add your name, so the truck knows whose food is whose.' });
    if (existing) {
      await run('UPDATE group_people SET name = ?, items_json = ?, updated_at = ? WHERE id = ?', [name, JSON.stringify(items), Date.now(), existing.id]);
      if (allergy !== undefined) await run('UPDATE group_people SET allergy = ? WHERE id = ?', [allergy, existing.id]);
    } else {
      const n = await get('SELECT COUNT(*) AS n FROM group_people WHERE group_id = ?', [g.id]);
      if (n.n >= MAX_PEOPLE) return res.status(409).json({ error: `This group is full (${MAX_PEOPLE} people).` });
      await run('INSERT INTO group_people (group_id, name, key_hash, items_json, allergy, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [g.id, name, kh, JSON.stringify(items), allergy || null, Date.now()]);
    }
  }
  tell(v.id, g.token);
  res.json(await shape(v, g, b.key));
});

/** Called by POST /orders: is this the host of an open group? Returns the group or an error. */
async function forOrder(vendorId, token, key) {
  if (!token) return { group: null };
  const g = await groupOf(vendorId, token);
  if (!g) return { error: 'This group order link isn’t valid.' };
  if (g.status === 'placed') return { error: 'This group order was already placed.', placed: true };
  if (g.status !== 'open') return { error: 'This group order has ended.' };
  if (!KEY_RE.test(String(key || '')) || sha(key) !== g.host_key_hash) return { error: `Only ${g.host_name} can place this group order.` };
  return { group: g };
}
async function placed(vendorId, g, orderId) {
  await run("UPDATE group_orders SET status = 'placed', order_id = ? WHERE id = ? AND status = 'open'", [orderId, g.id]);
  tell(vendorId, g.token);
}

// Old groups are cleared out: only first names and items, kept a day.
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  run('DELETE FROM group_people WHERE group_id IN (SELECT id FROM group_orders WHERE created_at < ?)', [cutoff])
    .then(() => run('DELETE FROM group_orders WHERE created_at < ?', [cutoff])).catch(() => {});
}, 60 * 60 * 1000).unref();

module.exports = { router, forOrder, placed, cleanItems };
