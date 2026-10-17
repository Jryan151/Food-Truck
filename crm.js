/* crm.js — clients that fill themselves in, and reach-outs that always have a reason.
   The standard: under 10 minutes a week of owner time, zero typing to build a record.
   - Records come from catering (requests, bookings, served events, custom questions, "email me this
     quote") and from confirmed followers. Matched by email, then phone.
   - Automatic messages are only transactional: a thank-you with one-tap feedback after each event,
     and one follow-up on a quote someone asked us to email. Everything else is a draft on the
     "Reach out this week" list that the owner reads and sends.
   - Never over-messaged (one relationship message a month per client), never tone-deaf (negative
     feedback pauses everything automatic), one-click unsubscribe, a message is never sent twice. */
'use strict';
const express = require('express');
const core = require('./core');
const auth = require('./auth');
const Insights = require('./public/insights-core');
const { run, get, all } = core;
const { requireVendor, requireRole, sendMail, mailLater, mailConfigured, escHtml, EMAIL_RE } = auth;

const router = express.Router();
const ownerOnly = [requireVendor, requireRole('owner')];
const DAY = 24 * 60 * 60 * 1000;
const KINDS = ['client', 'lead', 'partner', 'regular'];
const MONTH_MS = 30 * DAY;
const PAUSE_MS = 90 * DAY;

const cleanEmail = (e) => { const s = String(e || '').trim().toLowerCase().slice(0, 254); return EMAIL_RE.test(s) ? s : null; };
const cleanPhone = (p) => { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length >= 7 ? d.slice(0, 15) : null; };
const money = (c) => '$' + (Math.round(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const parse = (s, d) => { try { return JSON.parse(s) || d; } catch (e) { return d; } };
const proOpen = (v) => !!core.features(v).crm || process.env.FREE_BETA === 'true' || !(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);

/* ---------- records: find or create, never duplicate on the way in ---------- */
// An email is the person. A phone alone (no email given) is matched by phone. A new email with a
// known phone is kept separate and shown as a likely duplicate: an office line can be shared, so a
// merge is the owner's call (with undo), never silent.
async function findClient(vendorId, email, phone) {
  if (email) return get('SELECT * FROM crm_clients WHERE vendor_id = ? AND email = ? AND merged_into IS NULL ORDER BY id LIMIT 1', [vendorId, email]);
  if (phone) return get('SELECT * FROM crm_clients WHERE vendor_id = ? AND phone = ? AND merged_into IS NULL ORDER BY id LIMIT 1', [vendorId, phone]);
  return null;
}

/**
 * Upserts a person from something they did, and adds it to their timeline (once per ref).
 * who: { email, phone, name, company, kind }   ev: { type, ref, summary, data, at }
 * Kinds only move "up": lead → client; regular → client. Partners stay partners.
 */
async function record(vendorId, who, ev) {
  try {
    const email = cleanEmail(who.email);
    const phone = cleanPhone(who.phone);
    if (!email && !phone) return null;
    const now = Date.now();
    let c = await findClient(vendorId, email, phone);
    if (!c) {
      const r = await run(
        `INSERT INTO crm_clients (vendor_id, kind, name, company, email, phone, email_ok, consent_at, consent_how, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [vendorId, KINDS.includes(who.kind) ? who.kind : 'lead', String(who.name || '').trim().slice(0, 80), String(who.company || '').trim().slice(0, 80) || null,
          email, phone, who.consent ? 1 : 0, who.consent ? now : null, who.consent || null, now, now]
      );
      c = await get('SELECT * FROM crm_clients WHERE id = ?', [r.lastID]);
    } else {
      const rank = { regular: 0, lead: 1, client: 2, partner: 3 };
      const kind = c.kind === 'partner' ? 'partner' : (rank[who.kind] || 0) > (rank[c.kind] || 0) ? who.kind : c.kind;
      await run(
        `UPDATE crm_clients SET kind = ?, name = CASE WHEN name = '' THEN ? ELSE name END, company = COALESCE(company, ?),
           email = COALESCE(email, ?), phone = COALESCE(phone, ?),
           email_ok = CASE WHEN ? AND unsubscribed_at IS NULL THEN 1 ELSE email_ok END,
           consent_at = CASE WHEN ? AND unsubscribed_at IS NULL AND email_ok = 0 THEN ? ELSE consent_at END,
           consent_how = CASE WHEN ? AND unsubscribed_at IS NULL AND email_ok = 0 THEN ? ELSE consent_how END,
           updated_at = ? WHERE id = ?`,
        [kind, String(who.name || '').trim().slice(0, 80), String(who.company || '').trim().slice(0, 80) || null, email, phone,
          who.consent ? 1 : 0, who.consent ? 1 : 0, now, who.consent ? 1 : 0, who.consent || null, now, c.id]
      );
    }
    if (ev) await addEvent(vendorId, c.id, ev);
    return c.id;
  } catch (e) {
    console.error('crm record:', e.message);
    return null;
  }
}

async function addEvent(vendorId, clientId, ev) {
  try {
    await run('INSERT INTO crm_events (vendor_id, client_id, at, type, ref, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [vendorId, clientId, ev.at || Date.now(), ev.type, ev.ref || null, String(ev.summary || '').slice(0, 300), ev.data ? JSON.stringify(ev.data) : null]);
    if (['email', 'asked', 'requested', 'booked', 'served', 'feedback'].includes(ev.type)) {
      await run('UPDATE crm_clients SET last_contact_at = MAX(COALESCE(last_contact_at, 0), ?) WHERE id = ?', [ev.at || Date.now(), clientId]);
    }
  } catch (e) {
    if (e.code !== 'SQLITE_CONSTRAINT') console.error('crm event:', e.message); // same ref twice: already on the timeline
  }
}

/* ---------- catering hooks (called from catering.js) ---------- */
const fmtDay = (ymd) => { try { return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch (e) { return ymd; } };
function bookingFacts(b) {
  const d = parse(b.details, {});
  return { bookingId: b.id, date: b.event_date, guests: b.guests, totalCents: b.total_cents, packageName: d.packageName, choices: d.choices || [], vegetarian: d.vegetarian || 0, address: d.address };
}
const catering = {
  requested: (b) => record(b.vendor_id, { email: b.host_email, phone: b.host_phone, name: b.host_name, company: b.company, kind: 'lead' },
    { type: 'requested', ref: 'booking:' + b.id, summary: `Requested ${fmtDay(b.event_date)}, ${b.guests} guests, ${money(b.total_cents)}`, data: bookingFacts(b) }),
  booked: (b) => record(b.vendor_id, { email: b.host_email, phone: b.host_phone, name: b.host_name, company: b.company, kind: 'client' },
    { type: 'booked', ref: 'booking:' + b.id, summary: `Booked ${fmtDay(b.event_date)}, ${b.guests} guests, ${money(b.total_cents)}`, data: bookingFacts(b) }),
  declined: (b) => record(b.vendor_id, { email: b.host_email, name: b.host_name }, { type: 'declined', ref: 'booking:' + b.id, summary: `Declined ${fmtDay(b.event_date)}` }),
  canceled: (b) => record(b.vendor_id, { email: b.host_email, name: b.host_name }, { type: 'canceled', ref: 'booking:' + b.id, summary: `Withdrew the request for ${fmtDay(b.event_date)}` }),
  expired: (b) => record(b.vendor_id, { email: b.host_email, name: b.host_name }, { type: 'expired', ref: 'booking:' + b.id, summary: `Request for ${fmtDay(b.event_date)} expired before an answer` }),
  asked: (vendorId, who, message) => record(vendorId, Object.assign({ kind: 'lead' }, who), { type: 'asked', summary: 'Custom request: ' + String(message).slice(0, 200) }),
};

/* ---------- the outbox: queued, logged, retried, sent once ---------- */
async function enqueue(vendorId, clientId, { kind, key, subject, body, sendAfter }) {
  try {
    const r = await run('INSERT INTO crm_outbox (vendor_id, client_id, kind, dedupe_key, subject, body, status, send_after, created_at) VALUES (?, ?, ?, ?, ?, ?, \'queued\', ?, ?)',
      [vendorId, clientId, kind, key, subject.slice(0, 200), body.slice(0, 5000), sendAfter || Date.now(), Date.now()]);
    return r.lastID;
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT') return null; // already queued or sent once: never twice
    throw e;
  }
}

const AUTO_KINDS = ['thanks', 'quote-followup'];
async function signedLink(vendor, kind, id) {
  const sig = await core.sign(`${kind}:${vendor.id}:${id}`);
  return auth.vendorUrl(vendor.slug, `/crm/${kind}?i=${id}&s=${sig}`);
}

/** Sends what's due. A message is claimed before it's sent; after a crash it retries with the same
    idempotency key, so the mail service never delivers it twice. */
async function deliver() {
  if (!mailConfigured()) return 0;
  const now = Date.now();
  // Anything stuck mid-send for 10 minutes (a restart) goes back in line: same key, so no double send.
  await run("UPDATE crm_outbox SET status = 'queued' WHERE status = 'sending' AND send_after < ? AND attempts < 6", [now - 10 * 60 * 1000]);
  const due = await all("SELECT id FROM crm_outbox WHERE status = 'queued' AND send_after <= ? ORDER BY send_after LIMIT 25", [now]);
  let sent = 0;
  for (const { id } of due) {
    const m = await get("UPDATE crm_outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued' RETURNING *", [id]);
    if (!m) continue; // another worker took it
    const c = await get('SELECT * FROM crm_clients WHERE id = ?', [m.client_id]);
    const v = await get('SELECT * FROM vendors WHERE id = ?', [m.vendor_id]);
    const skip = !c || !c.email || c.unsubscribed_at ? 'unsubscribed or no email'
      : AUTO_KINDS.includes(m.kind) && c.paused_until && c.paused_until > now ? 'paused after feedback' : null;
    if (skip) { await run("UPDATE crm_outbox SET status = 'skipped', last_error = ? WHERE id = ?", [skip, m.id]); continue; }
    const unsub = await signedLink(v, 'u', c.id); // a page with an Unsubscribe button (link scanners can't trigger it)
    const oneClick = unsub.replace('/crm/u?', '/api/crm/public/u?'); // mail apps POST here (RFC 8058)
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;color:#111;line-height:1.5">${escHtml(m.body).replace(/\n/g, '<br>')}
      <p style="color:#888;font-size:12px;margin-top:24px">${escHtml(v.business_name)} · <a href="${unsub}" style="color:#888">Unsubscribe</a></p></div>`;
    const ok = await sendMail({
      to: c.email, replyTo: v.email || undefined, brand: auth.brandFor(v), subject: m.subject, text: m.body + `\n\n—\nUnsubscribe: ${unsub}`, html,
      headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      idempotencyKey: `crm-${m.id}`,
    }).catch(() => false);
    if (ok) {
      await run("UPDATE crm_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?", [Date.now(), m.id]);
      if (!AUTO_KINDS.includes(m.kind)) await run('UPDATE crm_clients SET last_marketing_at = ? WHERE id = ?', [Date.now(), c.id]);
      await addEvent(m.vendor_id, c.id, { type: 'email', ref: 'outbox:' + m.id, summary: (AUTO_KINDS.includes(m.kind) ? 'Automatic: ' : 'Sent: ') + m.subject });
      sent++;
    } else {
      // Email down: try again later (5 min, 30 min, 2 h, 6 h, 12 h), then give up and show it.
      const backoff = [5, 30, 120, 360, 720][Math.min(m.attempts - 1, 4)] * 60 * 1000;
      await run(`UPDATE crm_outbox SET status = CASE WHEN attempts >= 6 THEN 'failed' ELSE 'queued' END, send_after = ?, last_error = 'Email service did not accept it' WHERE id = ?`, [Date.now() + backoff, m.id]);
    }
  }
  return sent;
}

/* ---------- the automatic part (transactional only) ---------- */
function nextMorning(tz, fromMs) {
  // 10 AM in the truck's time zone, the day after fromMs.
  const p = Insights.parts(fromMs, tz);
  return Insights.zonedTime(p.y, p.m, p.d + 1, 10, 0, tz);
}
/** The next moment inside business hours (Mon–Fri, 9–5) in the truck's time zone. */
function businessHours(tz, ms) {
  let t = ms;
  for (let i = 0; i < 8; i++) {
    const p = Insights.parts(t, tz);
    if (p.wd >= 1 && p.wd <= 5 && p.h >= 9 && p.h < 17) return t;
    const next = p.h < 9 && p.wd >= 1 && p.wd <= 5 ? Insights.zonedTime(p.y, p.m, p.d, 9, 0, tz) : Insights.zonedTime(p.y, p.m, p.d + 1, 9, 0, tz);
    t = next;
  }
  return t;
}
function signature(v) { return `\n\n${v.owner_name ? v.owner_name + '\n' : ''}${v.business_name}`; }

async function sweep() {
  const now = Date.now();
  const vendors = await all("SELECT * FROM vendors WHERE status = 'active'");
  for (const v of vendors) {
    if (!proOpen(v)) continue;
    const tz = Insights.validTz(v.timezone);
    const today = Insights.dateKey(Insights.parts(now, tz));
    // Served: accepted events whose day has passed → on the timeline, and a thank-you the next morning.
    const served = await all("SELECT * FROM catering_bookings WHERE vendor_id = ? AND status = 'accepted' AND event_date < ? AND event_date >= ?",
      [v.id, today, Insights.dateKey(Insights.parts(now - 14 * DAY, tz))]);
    for (const b of served) {
      const cid = await record(v.id, { email: b.host_email, phone: b.host_phone, name: b.host_name, company: b.company, kind: 'client' },
        { type: 'served', ref: 'booking:' + b.id, summary: `Served ${fmtDay(b.event_date)}, ${b.guests} guests`, data: bookingFacts(b) });
      if (!cid) continue;
      const [y, m, d] = b.event_date.split('-').map(Number);
      const due = nextMorning(tz, Insights.zonedTime(y, m, d, 12, 0, tz));
      if (now - due > 3 * DAY) continue; // too late to say thanks naturally
      const id = await enqueue(v.id, cid, {
        kind: 'thanks', key: 'thanks:booking:' + b.id, sendAfter: due,
        subject: `Thank you from ${v.business_name}`,
        body: `Hi ${String(b.host_name || '').split(' ')[0] || 'there'},\n\nThank you for having us on ${fmtDay(b.event_date)}. How did it go?\n\n👍 Great: {{up}}\n👎 Not great: {{down}}\n\nOne tap is plenty. If you'd like us back, here's the same setup ready to book again: {{again}}${signature(v)}`,
      });
      if (id) {
        const up = await signedLink(v, 'f', id) + '&r=up';
        const down = await signedLink(v, 'f', id) + '&r=down';
        const again = auth.vendorUrl(v.slug, '/catering');
        const row = await get('SELECT body FROM crm_outbox WHERE id = ?', [id]);
        await run('UPDATE crm_outbox SET body = ? WHERE id = ?', [row.body.replace('{{up}}', up).replace('{{down}}', down).replace('{{again}}', again), id]);
      }
    }
    // A quote they asked us to email: one follow-up three days later, unless they've booked since.
    const quotes = await all('SELECT q.*, c.email FROM crm_quote_requests q JOIN crm_clients c ON c.id = q.client_id WHERE q.vendor_id = ? AND q.created_at < ? AND q.created_at > ?',
      [v.id, now - 3 * DAY, now - 10 * DAY]);
    for (const q of quotes) {
      const booked = await get("SELECT id FROM catering_bookings WHERE vendor_id = ? AND host_email = ? AND created_at > ?", [v.id, q.email, q.created_at]);
      if (booked) continue;
      await enqueue(v.id, q.client_id, {
        kind: 'quote-followup', key: 'quote-followup:' + q.id, sendAfter: businessHours(tz, now),
        subject: `Still planning ${q.event_date ? fmtDay(q.event_date) : 'your event'}?`,
        body: `Hi,\n\nYou priced ${q.package_name || 'catering'} for ${q.guests || 'your'} guests${q.event_date ? ' on ' + fmtDay(q.event_date) : ''}: ${money(q.total_cents || 0)}. Dates fill up, so if it's still on, you can book in about a minute here: ${auth.vendorUrl(v.slug, '/catering')}\n\nIf plans changed, no reply needed.${signature(v)}`,
      });
    }
  }
  return deliver();
}
let sweeping = false;
setInterval(() => {
  if (sweeping) return;
  sweeping = true;
  sweep().catch((e) => console.error('crm sweep:', e.message)).finally(() => { sweeping = false; });
}, 10 * 60 * 1000).unref();

/* ---------- the "Reach out this week" list ---------- */
const WEEKS6 = 42 * DAY;
async function stats(vendorId, clientId) {
  const ev = await all('SELECT * FROM crm_events WHERE client_id = ? ORDER BY at ASC', [clientId]);
  const served = ev.filter((e) => e.type === 'served').map((e) => parse(e.data, {}));
  const booked = ev.filter((e) => e.type === 'booked').map((e) => parse(e.data, {}));
  const valueCents = served.reduce((s, d) => s + (d.totalCents || 0), 0);
  const pk = {};
  booked.concat(served).forEach((d) => { const k = [d.packageName].concat(d.choices || []).filter(Boolean).join(' · '); if (k) pk[k] = (pk[k] || 0) + 1; });
  const fav = Object.keys(pk).sort((a, b) => pk[b] - pk[a])[0] || null;
  const all2 = booked.length ? booked : served;
  const budget = all2.length ? Math.round(all2.reduce((s, d) => s + (d.totalCents || 0), 0) / all2.length) : null;
  const lastBooked = booked.length ? booked[booked.length - 1].date : null;
  const lastServed = served.length ? served[served.length - 1].date : null;
  const fb = ev.filter((e) => e.type === 'feedback').pop();
  return { events: ev, served, booked, valueCents, fav, budget, lastBooked, lastServed, lastFeedback: fb ? parse(fb.data, {}).rating : null };
}
function brief(c, st) {
  const bits = [];
  if (st.lastBooked) bits.push('Last booked ' + fmtDay(st.lastBooked).replace(/^\w+, /, ''));
  else if (c.last_contact_at) bits.push('Last in touch ' + new Date(c.last_contact_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  if (st.fav) bits.push('usually ' + st.fav);
  if (st.budget) bits.push('budget about ' + money(st.budget));
  if (st.lastFeedback === 'down') bits.push('last event: not happy');
  bits.push(c.email ? 'email' : c.phone ? 'phone' : 'no contact');
  return bits.join(' · ');
}

async function reachList(v) {
  const now = Date.now();
  const tz = Insights.validTz(v.timezone);
  const dismissed = new Set((await all('SELECT item_key FROM crm_dismissed WHERE vendor_id = ? AND until > ?', [v.id, now])).map((r) => r.item_key));
  const queued = new Set((await all("SELECT dedupe_key FROM crm_outbox WHERE vendor_id = ? AND kind = 'reach'", [v.id])).map((r) => r.dedupe_key.replace(/^reach:/, '')));
  const clients = await all('SELECT * FROM crm_clients WHERE vendor_id = ? AND merged_into IS NULL', [v.id]);
  const first = (c) => String(c.name || '').split(' ')[0] || 'there';
  const sig = signature(v);
  const items = [];
  for (const c of clients) {
    const st = await stats(v.id, c.id);
    const recentlyMarketed = c.last_marketing_at && now - c.last_marketing_at < MONTH_MS;
    const push = (key, priority, reason, subject, body, personal) => {
      if (dismissed.has(key) || queued.has(key)) return;
      if (!personal && (recentlyMarketed || c.unsubscribed_at || !c.email)) return;
      items.push({ key, priority, clientId: c.id, name: c.name || c.email, company: c.company || '', reason, brief: brief(c, st), personal: !!personal,
        canEmail: !!c.email && !c.unsubscribed_at, phone: c.phone || '', draft: { subject, body } });
    };
    // 1. Unhappy last time: a personal note from the owner, not a template.
    if (st.lastFeedback === 'down' && c.paused_until && c.paused_until > now) {
      push(`unhappy:${c.id}`, 1, `Rated their last event 👎. Automatic messages are paused; a personal word goes a long way.`,
        `About your event`, `Hi ${first(c)},\n\nI saw the last event didn't go the way you wanted, and I'm sorry. I'd like to hear what happened and make it right.\n\nWhat's a good time to talk?${sig}`, true);
    }
    // 2. A request that expired before anyone answered, and no booking since.
    const exp = st.events.filter((e) => e.type === 'expired' && now - e.at < 30 * DAY).pop();
    if (exp && !st.events.some((e) => e.type === 'booked' && e.at > exp.at)) {
      const d = parse((st.events.find((e) => e.type === 'requested' && e.ref === exp.ref) || {}).data, {});
      push(`expired:${exp.ref}`, 2, `Their request${d.date ? ' for ' + fmtDay(d.date) : ''} expired before you answered.`,
        `Your event${d.date ? ' on ' + fmtDay(d.date) : ''}`, `Hi ${first(c)},\n\nSorry I didn't get back to you in time about ${d.date ? fmtDay(d.date) : 'your event'}${d.guests ? ' for ' + d.guests + ' guests' : ''}. If it's still on, I'd love to do it. Want me to lock it in?${sig}`, true);
    }
    // 3. Anniversary: about six weeks before the date of an event they had last year.
    for (const d of st.served) {
      if (!d.date) continue;
      const [y, m, dd] = d.date.split('-').map(Number);
      const next = Insights.zonedTime(y + 1, m, dd, 12, 0, tz);
      const away = next - now;
      if (away > 35 * DAY && away < 49 * DAY && !st.booked.some((b) => b.date && b.date > d.date)) {
        push(`anniv:${c.id}:${y + 1}`, 3, `A year since ${fmtDay(d.date)} (${d.guests} guests). Same time this year?`,
          `Same time this year?`, `Hi ${first(c)},\n\nLast year we fed your group on ${fmtDay(d.date)}${d.packageName ? ' (' + d.packageName + ')' : ''}. If you're doing it again around ${new Date(next).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: tz })}, I'd be glad to hold the date.\n\nBook here, same setup ready to go: ${auth.vendorUrl(v.slug, '/catering')}${sig}`);
      }
    }
    // 4. Regular clients who've gone quiet.
    if (st.served.length >= 2 && st.lastServed) {
      const [y, m, dd] = st.lastServed.split('-').map(Number);
      const since = now - Insights.zonedTime(y, m, dd, 12, 0, tz);
      if (since > 150 * DAY && !st.events.some((e) => e.type === 'booked' && e.at > now - 150 * DAY)) {
        push(`quiet:${c.id}:${Math.floor(now / (60 * DAY))}`, 4, `${st.served.length} events with you, none since ${fmtDay(st.lastServed)}.`,
          `It's been a while`, `Hi ${first(c)},\n\nIt's been a while since ${fmtDay(st.lastServed)}. If you have something coming up, I'd love to feed your crew again${st.fav ? ' (' + st.fav + ' is still on the menu)' : ''}.\n\n${auth.vendorUrl(v.slug, '/catering')}${sig}`);
      }
    }
    // 5. Partner spots trending down: a check-in backed by numbers.
    if (c.kind === 'partner' && c.location) {
      const p = Insights.parts(now, tz);
      const monthStart = Insights.zonedStart(p.y, p.m, 1, tz);
      const lastStart = Insights.zonedStart(p.m === 1 ? p.y - 1 : p.y, p.m === 1 ? 12 : p.m - 1, 1, tz);
      const perDay = async (a, b) => {
        const rows = await all("SELECT created_at, total FROM orders WHERE vendor_id = ? AND location = ? AND status IN ('Fulfilled','Ready') AND created_at >= ? AND created_at < ?", [v.id, c.location, a, b]);
        const days = new Set(rows.map((r) => Insights.dateKey(Insights.parts(r.created_at, tz))));
        return days.size ? { cents: rows.reduce((s, r) => s + Math.round(r.total * 100), 0) / days.size, days: days.size } : null;
      };
      const nowM = await perDay(monthStart, now), lastM = await perDay(lastStart, monthStart);
      if (nowM && lastM && nowM.days >= 2 && nowM.cents < lastM.cents * 0.8) {
        const pct = Math.round((1 - nowM.cents / lastM.cents) * 100);
        push(`partner:${c.id}:${p.y}-${p.m}`, 2, `Sales at ${c.location} are down ${pct}% a day this month.`,
          `Checking in about ${c.location}`, `Hi ${first(c)},\n\nOur days at ${c.location} have been about ${pct}% slower this month than last. Anything changed on your side, like hours, events or parking? Happy to adjust our nights or try something together.${sig}`, true);
      }
    }
  }
  items.sort((a, b) => a.priority - b.priority);
  return items.slice(0, 5);
}

/* ---------- owner routes ---------- */
const gate = (req, res, next) => (proOpen(req.tenant.vendor) ? next() : res.status(402).json({ error: 'Clients are part of Business.', upgrade: true }));

async function clientRow(v, c) {
  const st = await stats(v.id, c.id);
  const upcoming = st.booked.filter((d) => d.date && d.date >= Insights.dateKey(Insights.parts(Date.now(), Insights.validTz(v.timezone)))).map((d) => d.date).sort()[0] || null;
  return {
    id: c.id, kind: c.kind, name: c.name, company: c.company || '', email: c.email || '', phone: c.phone || '', location: c.location || '',
    valueCents: st.valueCents, events: st.served.length, upcoming, lastContactAt: c.last_contact_at || null,
    brief: brief(c, st), unsubscribed: !!c.unsubscribed_at, paused: !!(c.paused_until && c.paused_until > Date.now()),
  };
}

router.get('/owner/week', ownerOnly, gate, async (req, res) => {
  const v = req.tenant.vendor;
  const items = await reachList(v);
  const auto = await all(`SELECT o.id, o.kind, o.subject, o.status, o.sent_at, o.send_after, o.last_error, c.name FROM crm_outbox o JOIN crm_clients c ON c.id = o.client_id
    WHERE o.vendor_id = ? AND (o.status IN ('queued','sending','failed') OR o.sent_at > ?) ORDER BY COALESCE(o.sent_at, o.send_after) DESC LIMIT 20`, [v.id, Date.now() - 7 * DAY]);
  res.json({ items, outbox: auto, mailReady: mailConfigured() });
});

router.post('/owner/send', ownerOnly, gate, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  const c = await get('SELECT * FROM crm_clients WHERE id = ? AND vendor_id = ? AND merged_into IS NULL', [parseInt(b.clientId, 10), v.id]);
  if (!c) return res.status(404).json({ error: 'That client is gone.' });
  if (!c.email || c.unsubscribed_at) return res.status(400).json({ error: 'This client can’t be emailed (no email, or they unsubscribed).' });
  const subject = String(b.subject || '').trim(), body = String(b.body || '').trim();
  if (!subject || body.length < 10) return res.status(400).json({ error: 'Add a subject and a message.' });
  const key = String(b.key || 'manual:' + Date.now()).slice(0, 120);
  const tz = Insights.validTz(v.timezone);
  const id = await enqueue(v.id, c.id, { kind: 'reach', key: 'reach:' + key, subject, body, sendAfter: businessHours(tz, Date.now()) });
  if (!id) return res.status(409).json({ error: 'That message was already sent.' });
  deliver().catch(() => {});
  const m = await get('SELECT status, send_after FROM crm_outbox WHERE id = ?', [id]);
  res.json({ ok: true, sendAt: m.send_after, status: m.status });
});

router.post('/owner/dismiss', ownerOnly, gate, async (req, res) => {
  const key = String((req.body || {}).key || '').slice(0, 120);
  if (!key) return res.status(400).json({ error: 'Nothing to dismiss.' });
  await run('INSERT INTO crm_dismissed (vendor_id, item_key, until) VALUES (?, ?, ?) ON CONFLICT (vendor_id, item_key) DO UPDATE SET until = excluded.until',
    [req.tenant.vendor.id, key, Date.now() + 60 * DAY]);
  res.json({ ok: true });
});

router.get('/owner/clients', ownerOnly, gate, async (req, res) => {
  const v = req.tenant.vendor;
  const q = String(req.query.q || '').trim().toLowerCase();
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  let rows = await all('SELECT * FROM crm_clients WHERE vendor_id = ? AND merged_into IS NULL ORDER BY COALESCE(last_contact_at, created_at) DESC LIMIT 500', [v.id]);
  if (kind) rows = rows.filter((c) => c.kind === kind);
  if (q) rows = rows.filter((c) => [c.name, c.company, c.email, c.phone, c.location].some((x) => String(x || '').toLowerCase().includes(q)));
  const list = [];
  for (const c of rows.slice(0, 200)) list.push(await clientRow(v, c));
  // Pipeline: priced → booked → served → rebooked.
  const ev = await all("SELECT client_id, type FROM crm_events WHERE vendor_id = ? AND type IN ('quote','requested','booked','served')", [v.id]);
  const by = (t) => new Set(ev.filter((e) => e.type === t).map((e) => e.client_id));
  const servedCount = {};
  ev.filter((e) => e.type === 'served').forEach((e) => { servedCount[e.client_id] = (servedCount[e.client_id] || 0) + 1; });
  const priced = new Set([...by('quote'), ...by('requested')]);
  res.json({
    clients: list,
    pipeline: { priced: priced.size, booked: by('booked').size, served: by('served').size, rebooked: Object.values(servedCount).filter((n) => n >= 2).length },
    duplicates: await duplicates(v.id),
  });
});

async function duplicates(vendorId) {
  const rows = await all('SELECT id, name, email, phone FROM crm_clients WHERE vendor_id = ? AND merged_into IS NULL', [vendorId]);
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if ((a.email && a.email === b.email) || (a.phone && a.phone === b.phone)) pairs.push({ keep: a.id, merge: b.id, names: [a.name || a.email, b.name || b.email], why: a.email && a.email === b.email ? 'same email' : 'same phone' });
    }
  }
  return pairs.slice(0, 20);
}

router.get('/owner/clients/:id', ownerOnly, gate, async (req, res) => {
  const v = req.tenant.vendor;
  const c = await get('SELECT * FROM crm_clients WHERE id = ? AND vendor_id = ?', [parseInt(req.params.id, 10), v.id]);
  if (!c) return res.status(404).json({ error: 'That client is gone.' });
  const st = await stats(v.id, c.id);
  const outbox = await all('SELECT id, kind, subject, status, sent_at, send_after, last_error FROM crm_outbox WHERE client_id = ? ORDER BY created_at DESC LIMIT 30', [c.id]);
  res.json({
    client: Object.assign(await clientRow(v, c), { notes: c.notes || '', crewNotes: c.crew_notes || '', facts: parse(c.facts, {}), consent: { email: !!c.email_ok, at: c.consent_at, how: c.consent_how || '' }, mergedInto: c.merged_into }),
    timeline: st.events.slice().reverse().map((e) => ({ at: e.at, type: e.type, summary: e.summary })),
    outbox,
  });
});

router.post('/owner/clients', ownerOnly, gate, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  const email = cleanEmail(b.email), phone = cleanPhone(b.phone);
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Add a name.' });
  if (!email && !phone) return res.status(400).json({ error: 'Add an email or a phone number.' });
  if ((email && (await findClient(v.id, email, null))) || (phone && (await findClient(v.id, null, phone)))) return res.status(409).json({ error: 'Someone with that email or phone is already here.' });
  const id = await record(v.id, { email, phone, name: b.name, company: b.company, kind: KINDS.includes(b.kind) ? b.kind : 'lead' }, { type: 'note', summary: 'Added by you' });
  if (b.location) await run('UPDATE crm_clients SET location = ? WHERE id = ?', [String(b.location).trim().slice(0, 80), id]);
  res.status(201).json({ id });
});

router.put('/owner/clients/:id', ownerOnly, gate, async (req, res) => {
  const v = req.tenant.vendor;
  const c = await get('SELECT * FROM crm_clients WHERE id = ? AND vendor_id = ? AND merged_into IS NULL', [parseInt(req.params.id, 10), v.id]);
  if (!c) return res.status(404).json({ error: 'That client is gone.' });
  const b = req.body || {};
  const set = (col, val) => run(`UPDATE crm_clients SET ${col} = ?, updated_at = ? WHERE id = ?`, [val, Date.now(), c.id]);
  if (b.name !== undefined) await set('name', String(b.name).trim().slice(0, 80));
  if (b.company !== undefined) await set('company', String(b.company).trim().slice(0, 80) || null);
  if (b.kind !== undefined && KINDS.includes(b.kind)) await set('kind', b.kind);
  if (b.location !== undefined) await set('location', String(b.location).trim().slice(0, 80) || null);
  if (b.notes !== undefined) await set('notes', String(b.notes).slice(0, 2000) || null);
  if (b.crewNotes !== undefined) await set('crew_notes', String(b.crewNotes).slice(0, 400) || null);
  if (b.facts !== undefined && b.facts && typeof b.facts === 'object') {
    const f = {};
    Object.keys(b.facts).slice(0, 12).forEach((k) => { const val = String(b.facts[k] || '').trim().slice(0, 120); if (val) f[String(k).slice(0, 30)] = val; });
    await set('facts', JSON.stringify(f));
  }
  if (b.note) await addEvent(v.id, c.id, { type: 'note', summary: String(b.note).slice(0, 300) });
  res.json({ ok: true });
});

// Merge two records (same person). Undo puts everything back exactly.
router.post('/owner/clients/:id/merge', ownerOnly, gate, async (req, res) => {
  const v = req.tenant.vendor;
  const from = await get('SELECT * FROM crm_clients WHERE id = ? AND vendor_id = ? AND merged_into IS NULL', [parseInt(req.params.id, 10), v.id]);
  const into = await get('SELECT * FROM crm_clients WHERE id = ? AND vendor_id = ? AND merged_into IS NULL', [parseInt((req.body || {}).into, 10), v.id]);
  if (!from || !into || from.id === into.id) return res.status(400).json({ error: 'Pick two different clients.' });
  const evIds = (await all('SELECT id FROM crm_events WHERE client_id = ?', [from.id])).map((r) => r.id);
  const obIds = (await all('SELECT id FROM crm_outbox WHERE client_id = ?', [from.id])).map((r) => r.id);
  const before = { name: into.name, company: into.company, email: into.email, phone: into.phone, notes: into.notes, crew_notes: into.crew_notes, kind: into.kind, unsubscribed_at: into.unsubscribed_at };
  await run('UPDATE crm_events SET client_id = ? WHERE client_id = ?', [into.id, from.id]);
  await run('UPDATE crm_outbox SET client_id = ? WHERE client_id = ?', [into.id, from.id]);
  const rank = { regular: 0, lead: 1, client: 2, partner: 3 };
  await run(`UPDATE crm_clients SET name = CASE WHEN name = '' THEN ? ELSE name END, company = COALESCE(company, ?), email = COALESCE(email, ?), phone = COALESCE(phone, ?),
      notes = CASE WHEN ? IS NULL THEN notes WHEN notes IS NULL THEN ? ELSE notes || char(10) || ? END, crew_notes = COALESCE(crew_notes, ?), kind = ?,
      unsubscribed_at = COALESCE(unsubscribed_at, ?), updated_at = ? WHERE id = ?`,
    [from.name, from.company, from.email, from.phone, from.notes, from.notes, from.notes, from.crew_notes, (rank[from.kind] || 0) > (rank[into.kind] || 0) ? from.kind : into.kind,
      from.unsubscribed_at, Date.now(), into.id]);
  await run('UPDATE crm_clients SET merged_into = ? WHERE id = ?', [into.id, from.id]);
  const m = await run('INSERT INTO crm_merges (vendor_id, from_id, into_id, moved, before, at) VALUES (?, ?, ?, ?, ?, ?)',
    [v.id, from.id, into.id, JSON.stringify({ events: evIds, outbox: obIds }), JSON.stringify(before), Date.now()]);
  res.json({ ok: true, mergeId: m.lastID });
});
router.post('/owner/merges/:id/undo', ownerOnly, gate, async (req, res) => {
  const v = req.tenant.vendor;
  const m = await get('UPDATE crm_merges SET undone_at = ? WHERE id = ? AND vendor_id = ? AND undone_at IS NULL RETURNING *', [Date.now(), parseInt(req.params.id, 10), v.id]);
  if (!m) return res.status(409).json({ error: 'That merge was already undone.' });
  const moved = parse(m.moved, { events: [], outbox: [] }), before = parse(m.before, {});
  for (const id of moved.events) await run('UPDATE crm_events SET client_id = ? WHERE id = ?', [m.from_id, id]);
  for (const id of moved.outbox) await run('UPDATE crm_outbox SET client_id = ? WHERE id = ?', [m.from_id, id]);
  await run('UPDATE crm_clients SET name = ?, company = ?, email = ?, phone = ?, notes = ?, crew_notes = ?, kind = ?, unsubscribed_at = ?, updated_at = ? WHERE id = ?',
    [before.name, before.company, before.email, before.phone, before.notes, before.crew_notes, before.kind, before.unsubscribed_at, Date.now(), m.into_id]);
  await run('UPDATE crm_clients SET merged_into = NULL WHERE id = ?', [m.from_id]);
  res.json({ ok: true });
});

// Every client, for the owner's own records or a move to another tool.
router.get('/owner/clients.csv', ownerOnly, gate, async (req, res) => {
  const v = req.tenant.vendor;
  const rows = await all('SELECT * FROM crm_clients WHERE vendor_id = ? AND merged_into IS NULL ORDER BY name', [v.id]);
  const cell = (x) => { x = String(x == null ? '' : x); if (/^[=+\-@]/.test(x)) x = "'" + x; return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
  const lines = ['Name,Company,Kind,Email,Phone,Spot,Events served,Lifetime value,Last contact,Email consent,Unsubscribed,Notes'];
  for (const c of rows) {
    const st = await stats(v.id, c.id);
    lines.push([c.name, c.company, c.kind, c.email, c.phone, c.location, st.served.length, (st.valueCents / 100).toFixed(2),
      c.last_contact_at ? new Date(c.last_contact_at).toISOString().slice(0, 10) : '', c.email_ok ? 'yes (' + (c.consent_how || '') + ')' : 'no',
      c.unsubscribed_at ? new Date(c.unsubscribed_at).toISOString().slice(0, 10) : '', c.notes].map(cell).join(','));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="clients-${new Date().toISOString().slice(0, 10)}.csv"` });
  res.send(lines.join('\r\n') + '\r\n');
});

/* ---------- public: unsubscribe and one-tap feedback (signed links) ---------- */
router.post('/public/u', requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const src = (req.body && req.body.i) ? req.body : req.query || {}; // our page sends JSON; mail apps send the link itself
  const id = parseInt(src.i, 10);
  if (!(await core.signOk(`u:${v.id}:${id}`, src.s))) return res.status(403).json({ error: 'This link isn’t valid.' });
  const c = await get('SELECT * FROM crm_clients WHERE id = ? AND vendor_id = ?', [id, v.id]);
  if (!c) return res.json({ ok: true });
  // Honored everywhere at once: this record, anything merged into it, and anything queued.
  await run('UPDATE crm_clients SET unsubscribed_at = COALESCE(unsubscribed_at, ?), email_ok = 0 WHERE id = ? OR merged_into = ?', [Date.now(), c.id, c.id]);
  await run("UPDATE crm_outbox SET status = 'skipped', last_error = 'unsubscribed' WHERE client_id = ? AND status = 'queued'", [c.id]);
  await addEvent(v.id, c.id, { type: 'note', summary: 'Unsubscribed from emails' });
  res.json({ ok: true, business: v.business_name });
});
router.post('/public/f', requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const b = req.body || {};
  const id = parseInt(b.i, 10);
  if (!(await core.signOk(`f:${v.id}:${id}`, b.s))) return res.status(403).json({ error: 'This link isn’t valid.' });
  const m = await get('SELECT * FROM crm_outbox WHERE id = ? AND vendor_id = ?', [id, v.id]);
  if (!m) return res.status(404).json({ error: 'This link has expired.' });
  const rating = b.r === 'down' ? 'down' : 'up';
  const comment = String(b.comment || '').trim().slice(0, 1000);
  await run('DELETE FROM crm_events WHERE vendor_id = ? AND type = \'feedback\' AND ref = ?', [v.id, 'outbox:' + m.id]); // they can change their answer
  await addEvent(v.id, m.client_id, { type: 'feedback', ref: 'outbox:' + m.id, summary: (rating === 'up' ? '👍 ' : '👎 ') + (comment || (rating === 'up' ? 'Went well' : 'Not happy')), data: { rating, comment } });
  if (rating === 'down') {
    // Never tone-deaf: nothing automatic goes out, and the owner is nudged to reach out personally.
    await run('UPDATE crm_clients SET paused_until = ? WHERE id = ?', [Date.now() + PAUSE_MS, m.client_id]);
    await run("UPDATE crm_outbox SET status = 'skipped', last_error = 'paused after feedback' WHERE client_id = ? AND status = 'queued'", [m.client_id]);
    const c = await get('SELECT * FROM crm_clients WHERE id = ?', [m.client_id]);
    if (v.email) require('./daily').ownerMail(v, { to: v.email, replyTo: c.email || undefined, subject: `${c.name || 'A client'} wasn’t happy with their event`, text: `${c.name || c.email} tapped 👎 after their event.${comment ? '\n\nThey wrote: ' + comment : ''}\n\nAutomatic messages to them are paused. A personal call or email works best. It's at the top of your Clients list.`, html: `<p><b>${escHtml(c.name || c.email)}</b> tapped 👎 after their event.</p>${comment ? `<p>They wrote: “${escHtml(comment)}”</p>` : ''}<p>Automatic messages to them are paused. A personal call or email works best. It's at the top of your Clients list.</p>` }).catch(() => {});
  } else {
    await run('UPDATE crm_clients SET paused_until = NULL WHERE id = ?', [m.client_id]);
  }
  res.json({ ok: true, business: v.business_name, again: auth.vendorUrl(v.slug, '/catering') });
});

module.exports = { router, record, addEvent, catering, enqueue, deliver, sweep, reachList, stats, brief, cleanEmail, businessHours, proOpen };
