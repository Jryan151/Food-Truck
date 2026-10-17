/* inventory.js — never sell what you don't have.
   - Stock counts: "40 left". Each order takes from it in one atomic step; at zero the item is sold out
     everywhere at once. A canceled order puts its stock back (once).
   - Ingredient out: tag items with key ingredients; "Out of cilantro" sells out every item that uses it.
   One function decides what is available, and every screen gets its answer. */
'use strict';
const core = require('./core');
const { run, get, all } = core;

const LOW = 5; // customers see "Only 3 left" at or below this

function outList(v) {
  try { return (JSON.parse(v.out_json || '[]') || []).map(String); } catch (e) { return []; }
}
const norm = (s) => String(s || '').trim().toLowerCase();

async function stockMap(vendorId) {
  const rows = await all('SELECT item_id, left_count FROM item_stock WHERE vendor_id = ?', [vendorId]);
  return new Map(rows.map((r) => [r.item_id, r.left_count]));
}

/**
 * The menu as it really is right now. For customers (owner=false) the exact count is only shown when it's low.
 * Each item gets: soldOut (effective), outReason ('manual' | 'stock' | 'ingredient'), left (or null).
 */
async function menuFor(v, { owner = false, costs = owner } = {}) {
  const menu = core.parseMenu(v.menu_data);
  const stock = await stockMap(v.id);
  const out = outList(v).map(norm);
  return menu.map((m) => {
    const left = stock.has(m.id) ? stock.get(m.id) : null;
    const missing = (m.ingredients || []).find((i) => out.includes(norm(i)));
    const reason = m.soldOut ? 'manual' : left !== null && left <= 0 ? 'stock' : missing ? 'ingredient' : null;
    const item = Object.assign({}, m, { soldOut: !!reason, outReason: reason });
    if (owner) { item.left = left; item.manualSoldOut = !!m.soldOut; item.missing = missing || null; if (!costs) delete item.cost; }
    else { item.left = left !== null && left <= LOW ? Math.max(0, left) : null; delete item.ingredients; delete item.cost; }
    return item;
  });
}

/** Sends the real menu to every open page (customers get the customer version). */
async function broadcastMenu(vendorId) {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [vendorId]);
  if (!v) return;
  core.broadcast(vendorId, 'MENU_UPDATE', { menu: await menuFor(v) });
}

/**
 * Takes stock for an order's lines, all or nothing. lines: [{id, qty}].
 * Returns { taken: {itemId: qty} } or { error } (nothing taken).
 */
async function take(vendorId, lines) {
  const want = new Map();
  for (const l of lines) want.set(l.id, (want.get(l.id) || 0) + l.qty);
  const taken = {};
  for (const [itemId, qty] of want) {
    const r = await run('UPDATE item_stock SET left_count = left_count - ? WHERE vendor_id = ? AND item_id = ? AND left_count >= ?', [qty, vendorId, itemId, qty]);
    if (r.changes) { taken[itemId] = qty; continue; }
    const row = await get('SELECT left_count FROM item_stock WHERE vendor_id = ? AND item_id = ?', [vendorId, itemId]);
    if (!row) continue; // not counted: unlimited
    await giveBack(vendorId, taken);
    return { error: row.left_count > 0 ? { itemId, left: row.left_count } : { itemId, left: 0 } };
  }
  return { taken };
}

async function giveBack(vendorId, taken) {
  for (const [itemId, qty] of Object.entries(taken || {})) {
    await run('UPDATE item_stock SET left_count = left_count + ? WHERE vendor_id = ? AND item_id = ?', [qty, vendorId, parseInt(itemId, 10)]);
  }
}

/** After stock moved: tell pages about low counts and items that just ran out or came back. */
async function announce(vendorId, itemIds) {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [vendorId]);
  if (!v) return;
  const menu = await menuFor(v, { owner: true });
  for (const id of itemIds) {
    const m = menu.find((x) => x.id === +id);
    if (!m) continue;
    core.broadcast(vendorId, 'STOCK', { itemId: m.id, left: m.left, soldOut: m.soldOut }, true);            // kitchen: exact
    core.broadcast(vendorId, 'SOLD_OUT', { itemId: m.id, soldOut: m.soldOut, left: m.left !== null && m.left <= LOW ? m.left : null });
  }
}

/** A canceled order puts its stock back, once. */
async function restore(vendorId, orderId) {
  const o = await get('UPDATE orders SET stock_returned = 1 WHERE id = ? AND stock_json IS NOT NULL AND stock_returned = 0 RETURNING stock_json', [orderId]);
  if (!o) return;
  let taken = {};
  try { taken = JSON.parse(o.stock_json) || {}; } catch (e) {}
  await giveBack(vendorId, taken);
  await announce(vendorId, Object.keys(taken));
}
core.onOrderClosed((vendorId, orderId, event) => (event === 'canceled' || event === 'expired' ? restore(vendorId, orderId) : null));

module.exports = { menuFor, broadcastMenu, take, giveBack, announce, restore, outList, LOW };
