'use strict';
/* =====================================================================
   Limp mode: if the app server can't be reached, customers still see the menu and "Order at the window".

   Each truck's public menu, hours and spot are kept as a small file on disk (one per web address:
   name.onlinekitchen.fyi.json, plus the custom domain on Pro). The files are rewritten a moment after
   anything on the page changes, and checked every 15 minutes. Caddy serves them by itself when the app
   doesn't answer (see DEPLOY.md, "Limp mode"), together with public/limp.html for a first-time visitor.
   Nothing private goes in these files: only what the public ordering page already shows.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const core = require('./core');
const inventory = require('./inventory');

const { get, all } = core;
const DIR = process.env.LIMP_DIR || path.join(__dirname, 'limp');
const SAFE = /^[a-z0-9.-]+$/;
// Anything a customer can see changing: rewrite that truck's file shortly after.
const WATCH = new Set(['MENU_UPDATE', 'SOLD_OUT', 'STOCK', 'OUT_UPDATE', 'LOCATION_UPDATE', 'HOURS_UPDATE', 'STATE', 'STORE_STATUS', 'PROFILE']);

function hostsFor(v) {
  const hosts = [`${v.slug}.${core.ROOT_DOMAIN}`];
  if (v.custom_domain && core.features(v).customDomain) hosts.push(String(v.custom_domain).toLowerCase());
  return hosts.filter((h) => SAFE.test(h));
}

async function snapshotOf(v) {
  const state = await core.getState(v.id);
  const menu = (await inventory.menuFor(v)).map((m) => ({
    id: m.id, name: m.name, desc: m.desc || '', category: m.category || '', price: m.price,
    salePrice: m.salePrice || 0, meats: m.meats || '', premiumSurcharge: m.premiumSurcharge || 0,
    options: m.options || [], soldOut: !!m.soldOut, prep: m.prep || 0,
  }));
  return {
    limp: true,
    businessName: v.business_name,
    slug: v.slug,
    emoji: v.emoji || '',
    ownerIG: v.owner_ig || '',
    hours: core.parseHours(v.hours_json),
    timezone: v.timezone || '',
    menu,
    state: { status: state.status, location: state.location || '', closedNote: state.closedNote || '', paused: false, rush: 0, wait: null, pace: null, sched: null },
    at: Date.now(),
  };
}

// Writes only when something changed; a crash mid-write never leaves half a file (write, then rename).
function writeIfChanged(file, body) {
  try {
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    // `at` changes every time, so compare without it.
    if (old && old.replace(/"at":\d+/, '') === body.replace(/"at":\d+/, '')) return false;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { console.error('limp snapshot:', e.message); return false; }
}

async function write(vendorId) {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [vendorId]);
  if (!v) return;
  if (v.status !== 'active') { removeFor(v); return; }
  fs.mkdirSync(DIR, { recursive: true });
  const body = JSON.stringify(await snapshotOf(v));
  for (const h of hostsFor(v)) writeIfChanged(path.join(DIR, h + '.json'), body);
}

function removeFor(v) {
  for (const h of hostsFor(v)) { try { fs.unlinkSync(path.join(DIR, h + '.json')); } catch (e) { /* not there */ } }
}

const timers = new Map();
function soon(vendorId) {
  clearTimeout(timers.get(vendorId));
  timers.set(vendorId, setTimeout(() => { timers.delete(vendorId); write(vendorId).catch((e) => console.error('limp:', e.message)); }, 2000).unref());
}

/** Every active truck, and no file left behind for a truck that's gone, suspended or changed address. */
async function refreshAll() {
  fs.mkdirSync(DIR, { recursive: true });
  const vendors = await all("SELECT * FROM vendors WHERE status = 'active'");
  const keep = new Set();
  for (const v of vendors) {
    const body = JSON.stringify(await snapshotOf(v));
    for (const h of hostsFor(v)) { keep.add(h + '.json'); writeIfChanged(path.join(DIR, h + '.json'), body); }
  }
  for (const f of fs.readdirSync(DIR)) if (f.endsWith('.json') && !keep.has(f)) { try { fs.unlinkSync(path.join(DIR, f)); } catch (e) {} }
  return keep.size;
}

/** The same file the app would serve, for the customer page's own fallback while the app is up. */
function readFor(host) {
  const h = String(host || '').toLowerCase();
  if (!SAFE.test(h)) return null;
  try { return fs.readFileSync(path.join(DIR, h + '.json'), 'utf8'); } catch (e) { return null; }
}

function start() {
  core.onBroadcast((vendorId, type) => { if (WATCH.has(type)) soon(vendorId); });
  setTimeout(() => refreshAll().catch((e) => console.error('limp:', e.message)), 5000).unref();
  setInterval(() => refreshAll().catch((e) => console.error('limp:', e.message)), 15 * 60 * 1000).unref();
}

module.exports = { start, write, refreshAll, readFor, removeFor, snapshotOf, DIR };
