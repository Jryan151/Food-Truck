'use strict';
/* =====================================================================
   Compliance vault: permits, inspections and insurance certificates, with reminders before they expire,
   and one link an event organizer can open to download the truck's vendor packet.
   Files are kept outside the public photo folder (DOC_DIR) and are only ever served to the owner, or
   through the packet link (a long random token the owner can replace at any time).
   ===================================================================== */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./core');
const auth = require('./auth');
const Insights = require('./public/insights-core');
const { run, get, all } = core;
const { requireVendor, requireRole, rateLimit } = auth;

const router = express.Router();
const DOC_DIR = process.env.DOC_DIR || path.join(__dirname, 'documents');
const TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const KINDS = ['permit', 'inspection', 'insurance', 'license', 'other'];
const MAX_BYTES = 8 * 1024 * 1024;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const betaOpen = () => process.env.FREE_BETA === 'true' || !(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
const gate = (req, res, next) => (core.features(req.tenant.vendor).business || betaOpen() ? next() : res.status(402).json({ error: 'This is part of the Business plan.', upgrade: true }));
const ownerOnly = [requireVendor, requireRole('owner'), gate];
const limitPacket = rateLimit({ windowMs: 10 * 60 * 1000, max: 120 });

const today = (v) => Insights.dateKey(Insights.parts(Date.now(), Insights.validTz(v.timezone)));
function daysUntil(from, to) { const f = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((f(to) - f(from)) / 864e5); }
function docShape(d, t) {
  const left = d.expires_day ? daysUntil(t, d.expires_day) : null;
  return { id: d.id, kind: d.kind, title: d.title, mime: d.mime, size: d.size, expiresDay: d.expires_day || '', inPacket: !!d.in_packet, createdAt: d.created_at,
    daysLeft: left, status: left === null ? 'none' : left < 0 ? 'expired' : left <= 30 ? 'soon' : 'ok' };
}
function sendFile(res, d, inline) {
  const file = path.join(DOC_DIR, path.basename(d.file));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'That file is missing.' });
  const name = `${d.title.replace(/[^\w .-]+/g, '').trim() || 'document'}.${TYPES[d.mime] || 'bin'}`;
  res.set({ 'Content-Type': d.mime, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}
async function packetToken(v) {
  if (v.packet_token) return v.packet_token;
  const t = crypto.randomBytes(18).toString('base64url');
  await run('UPDATE vendors SET packet_token = ? WHERE id = ? AND packet_token IS NULL', [t, v.id]);
  return (await get('SELECT packet_token FROM vendors WHERE id = ?', [v.id])).packet_token;
}

// Upload: the file is the body; title, kind and expiry are in the address.
router.post('/', ownerOnly, express.raw({ type: Object.keys(TYPES), limit: MAX_BYTES }), async (req, res) => {
  const v = req.tenant.vendor;
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!TYPES[mime]) return res.status(415).json({ error: 'Upload a PDF or a photo (JPG or PNG).' });
  const body = Buffer.isBuffer(req.body) ? req.body : null;
  if (!body || !body.length) return res.status(400).json({ error: 'That file was empty.' });
  if (body.length > MAX_BYTES) return res.status(413).json({ error: 'Files can be up to 8 MB.' });
  // The first bytes must match the type (a renamed file isn't stored).
  const sig = body.subarray(0, 4).toString('hex');
  const okSig = { pdf: sig === '25504446', png: sig === '89504e47', jpg: sig.startsWith('ffd8ff'), webp: body.subarray(8, 12).toString() === 'WEBP' }[TYPES[mime]];
  if (!okSig) return res.status(415).json({ error: 'That file doesn’t look like a ' + TYPES[mime].toUpperCase() + '.' });
  const q = req.query || {};
  const title = String(q.title || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Document';
  const kind = KINDS.includes(q.kind) ? q.kind : 'other';
  const expires = DAY_RE.test(String(q.expires || '')) ? String(q.expires) : null;
  await fs.promises.mkdir(DOC_DIR, { recursive: true });
  const file = `${v.id}-${crypto.randomBytes(12).toString('hex')}.${TYPES[mime]}`;
  await fs.promises.writeFile(path.join(DOC_DIR, file), body, { mode: 0o600 });
  const x = await run('INSERT INTO vault_docs (vendor_id, kind, title, file, mime, size, expires_day, in_packet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [v.id, kind, title, file, mime, body.length, expires, q.packet === '0' ? 0 : 1, Date.now()]);
  res.status(201).json({ id: x.lastID });
});

router.get('/', ownerOnly, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  const t = today(v);
  const docs = (await all('SELECT * FROM vault_docs WHERE vendor_id = ? ORDER BY COALESCE(expires_day, \'9999\'), title', [v.id])).map((d) => docShape(d, t));
  const origin = `${req.secure ? 'https' : 'http'}://${req.tenant.host}`;
  res.json({ docs, packetUrl: `${origin}/packet/${await packetToken(v)}`, kinds: KINDS });
});
router.put('/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor, b = req.body || {};
  const d = await get('SELECT * FROM vault_docs WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), v.id]);
  if (!d) return res.status(404).json({ error: 'Document not found.' });
  if (b.expiresDay !== undefined && b.expiresDay !== '' && !DAY_RE.test(String(b.expiresDay))) return res.status(400).json({ error: 'Pick the expiry date.' });
  await run('UPDATE vault_docs SET title = ?, kind = ?, expires_day = ?, in_packet = ?, warned = ? WHERE id = ?', [
    b.title !== undefined ? String(b.title).replace(/\s+/g, ' ').trim().slice(0, 80) || d.title : d.title,
    KINDS.includes(b.kind) ? b.kind : d.kind,
    b.expiresDay !== undefined ? b.expiresDay || null : d.expires_day,
    b.inPacket !== undefined ? (b.inPacket ? 1 : 0) : d.in_packet,
    b.expiresDay !== undefined && b.expiresDay !== d.expires_day ? null : d.warned, // a renewed date gets fresh reminders
    d.id]);
  res.json({ ok: true });
});
router.delete('/:id', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  const d = await get('SELECT * FROM vault_docs WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), v.id]);
  if (!d) return res.json({ ok: true });
  await run('DELETE FROM vault_docs WHERE id = ?', [d.id]);
  fs.promises.unlink(path.join(DOC_DIR, path.basename(d.file))).catch(() => {});
  res.json({ ok: true });
});
router.get('/:id/file', ownerOnly, async (req, res) => {
  const d = await get('SELECT * FROM vault_docs WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), req.tenant.vendor.id]);
  if (!d) return res.status(404).json({ error: 'Document not found.' });
  sendFile(res, d, true);
});
// A new packet link: the old one stops working at once (e.g. after an event, or if it was forwarded).
router.post('/packet/new', ownerOnly, async (req, res) => {
  const v = req.tenant.vendor;
  await run('UPDATE vendors SET packet_token = ? WHERE id = ?', [crypto.randomBytes(18).toString('base64url'), v.id]);
  const fresh = await get('SELECT packet_token FROM vendors WHERE id = ?', [v.id]);
  res.json({ packetUrl: `${req.secure ? 'https' : 'http'}://${req.tenant.host}/packet/${fresh.packet_token}` });
});

/* ----- the organizer's side: one link, the truck's current documents ----- */
async function byPacket(req) {
  const v = req.tenant.vendor;
  const tok = String(req.params.token || '');
  if (!v || !/^[A-Za-z0-9_-]{20,40}$/.test(tok) || !v.packet_token) return null;
  const a = Buffer.from(tok), b = Buffer.from(v.packet_token);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? v : null;
}
router.get('/public/:token', limitPacket, requireVendor, async (req, res) => {
  const v = await byPacket(req);
  if (!v) return res.status(404).json({ error: 'This link has been replaced. Ask the truck for the current one.' });
  const t = today(v);
  const docs = (await all('SELECT * FROM vault_docs WHERE vendor_id = ? AND in_packet = 1 ORDER BY kind, title', [v.id])).map((d) => docShape(d, t));
  res.set('Cache-Control', 'no-store');
  res.json({ truck: v.business_name, brand: core.brandOf(v), docs: docs.map(({ id, kind, title, expiresDay, status, mime }) => ({ id, kind, title, expiresDay, status, mime })), contact: (await require('./fleet').ownerEmail(v)) || '' });
});
router.get('/public/:token/:id', limitPacket, requireVendor, async (req, res) => {
  const v = await byPacket(req);
  if (!v) return res.status(404).json({ error: 'This link has been replaced.' });
  const d = await get('SELECT * FROM vault_docs WHERE id = ? AND vendor_id = ? AND in_packet = 1', [parseInt(req.params.id, 10), v.id]);
  if (!d) return res.status(404).json({ error: 'Document not found.' });
  sendFile(res, d, false);
});

/* ----- reminders: 30 days and 7 days before something expires ----- */
async function expiring(v) {
  const t = today(v);
  return (await all('SELECT * FROM vault_docs WHERE vendor_id = ? AND expires_day IS NOT NULL', [v.id])).map((d) => docShape(d, t)).filter((d) => d.status === 'soon' || d.status === 'expired');
}
async function sweep(ownerMail) {
  const rows = await all("SELECT d.*, v.timezone FROM vault_docs d JOIN vendors v ON v.id = d.vendor_id WHERE v.status = 'active' AND d.expires_day IS NOT NULL");
  let sent = 0;
  for (const d of rows) {
    const left = daysUntil(today(d), d.expires_day);
    const step = left <= 7 ? '7' : left <= 30 ? '30' : null;
    if (!step || (d.warned || '').split(',').includes(step) || left < -1) continue;
    const r = await run('UPDATE vault_docs SET warned = ? WHERE id = ? AND COALESCE(warned, \'\') = ?', [[d.warned, step].filter(Boolean).join(','), d.id, d.warned || '']);
    if (!r.changes) continue;
    const v = await get('SELECT * FROM vendors WHERE id = ?', [d.vendor_id]);
    const when = left < 0 ? 'expired' : left === 0 ? 'expires today' : `expires in ${left} day${left === 1 ? '' : 's'}`;
    await ownerMail(v, { subject: `${d.title} ${when}`, text: `Your ${d.title} ${when} (${d.expires_day}). Renew it, then upload the new one in Business → Documents so your vendor packet stays current.`, html: `<p>Your <b>${auth.escHtml(d.title)}</b> ${when} (${d.expires_day}).</p><p>Renew it, then upload the new one in Business → Documents so your vendor packet stays current.</p>` });
    sent++;
  }
  return sent;
}

module.exports = { router, expiring, sweep, DOC_DIR };
