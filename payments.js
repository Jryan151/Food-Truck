'use strict';
/**
 * payments.js — online pre-order payments for Pro trucks (Stripe Connect).
 *
 * How the money moves: each truck connects its OWN Stripe account (Accounts v2, full Stripe Dashboard).
 * Customer card payments are "direct charges" on the truck's account, so:
 *   • the money goes straight to the truck, and Stripe's processing fee is taken from the truck's payment;
 *   • you take no cut (no application fee) and Stripe — not you — covers fraud losses on those accounts;
 *   • refunds and disputes happen on the truck's account.
 *
 * .env:  STRIPE_SECRET_KEY (same key as Pro billing), STRIPE_CONNECT_WEBHOOK_SECRET
 * Stripe Dashboard → Developers → Webhooks → Add destination → "Connected accounts" →
 *   URL https://onlinekitchen.fyi/api/stripe/connect-webhook
 *   Events: checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.expired
 * The webhook is a backup: the customer's page also confirms the payment with Stripe when they come back.
 */
const express = require('express');
const core = require('./core');
const auth = require('./auth');
const billing = require('./billing');
const sms = require('./sms');
const { run, get } = core;

const SCHEME = process.env.PUBLIC_SCHEME || 'https';
const stripe = () => billing.stripe();

/* ---------- which way a truck takes payment right now ---------- */
function onlineReady(v) {
  return !!(v && stripe() && core.features(v).onlinePayments && v.stripe_account_id && v.connect_charges_enabled);
}
/** 'window' | 'both' | 'online' — what the customer page offers. */
function effectivePayMode(v) {
  if (!onlineReady(v)) return 'window';
  return ['window', 'both', 'online'].includes(v.pay_mode) ? v.pay_mode : 'both';
}

/* ---------- connected account status ---------- */
async function refreshAccountStatus(v) {
  const s = stripe();
  if (!s || !v.stripe_account_id) return { connected: false, chargesEnabled: false };
  const acct = await s.v2.core.accounts.retrieve(v.stripe_account_id, { include: ['configuration.merchant', 'requirements'] });
  const cap = acct && acct.configuration && acct.configuration.merchant && acct.configuration.merchant.capabilities &&
    acct.configuration.merchant.capabilities.card_payments;
  const enabled = !!(cap && cap.status === 'active');
  if (enabled !== !!v.connect_charges_enabled) {
    await run('UPDATE vendors SET connect_charges_enabled = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, Date.now(), v.id]);
  }
  return { connected: true, chargesEnabled: enabled };
}

/* ---------- checkout for one order ---------- */
async function createCheckout(v, orderRow, origin) {
  const s = stripe();
  let items = [];
  try { items = JSON.parse(orderRow.items_json); } catch (e) {}
  const session = await s.checkout.sessions.create({
    mode: 'payment',
    line_items: items.map((i) => ({
      quantity: i.qty,
      price_data: { currency: 'usd', unit_amount: Math.round(i.price * 100), product_data: { name: String(i.name).slice(0, 250) } },
    })),
    client_reference_id: String(orderRow.id),
    metadata: { order_id: String(orderRow.id), vendor_id: String(v.id) },
    payment_intent_data: {
      description: `${v.business_name} order #${orderRow.ticket_no}`,
      metadata: { order_id: String(orderRow.id), vendor_id: String(v.id) },
    },
    success_url: `${origin}/?paid=${orderRow.public_token}`,
    cancel_url: `${origin}/?canceled=${orderRow.public_token}`,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60, // Stripe's minimum is 30 minutes
  }, { stripeAccount: v.stripe_account_id, idempotencyKey: `order-${orderRow.id}` });
  await run('UPDATE orders SET stripe_session_id = ? WHERE id = ?', [session.id, orderRow.id]);
  return session;
}

/**
 * Marks a pending order as paid (once — safe to call from the webhook and the customer's page at the
 * same time) and sends it to the kitchen. Checks the amount so a tampered session can't underpay.
 */
async function markPaid(orderRow, session) {
  if (!session || session.payment_status !== 'paid') return null;
  if (Math.round(orderRow.total * 100) !== session.amount_total) {
    console.error(`Order ${orderRow.id}: paid ${session.amount_total} but total is ${orderRow.total}. Not sending to kitchen.`);
    return null;
  }
  const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent && session.payment_intent.id;
  const row = await get(
    "UPDATE orders SET status = 'Preparing', payment_status = 'paid', stripe_payment_intent = ?, updated_at = ? WHERE id = ? AND status = 'Pending' RETURNING *",
    [pi || null, Date.now(), orderRow.id]
  );
  if (!row) return null; // already handled
  core.logOrderEvent(row.vendor_id, row.id, 'paid', 'customer');
  core.refreshWait(row.vendor_id);
  const order = core.orderShape(row);
  await sms.notifyNewOrder(row.vendor_id, order);
  core.broadcast(row.vendor_id, 'ORDER_STATUS', { tag: core.orderTag(row.public_token), status: row.status });
  return row;
}

async function cancelPending(orderRow, reason = 'expired') {
  await run("UPDATE orders SET status = 'Canceled', payment_status = ?, customer_phone = NULL, updated_at = ? WHERE id = ? AND status = 'Pending'",
    [reason, Date.now(), orderRow.id]);
}

/** Refunds a paid order in full on the truck's Stripe account. Returns { ok } or { ok:false, error }. */
async function refundOrder(v, orderRow) {
  if (orderRow.payment_status !== 'paid' || !orderRow.stripe_payment_intent) return { ok: true, refunded: false };
  const s = stripe();
  if (!s) return { ok: false, error: 'Payments are not configured on the server.' };
  try {
    await s.refunds.create({ payment_intent: orderRow.stripe_payment_intent }, { stripeAccount: v.stripe_account_id, idempotencyKey: `refund-${orderRow.id}` });
    await run("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", [orderRow.id]);
    return { ok: true, refunded: true };
  } catch (e) {
    if (e && e.code === 'charge_already_refunded') {
      await run("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", [orderRow.id]);
      return { ok: true, refunded: true };
    }
    console.error('Refund failed:', e.message);
    return { ok: false, error: 'The refund did not go through. Try again, or refund it from your Stripe Dashboard.' };
  }
}

/* ---------- routes (/api/payments/...) ---------- */
const router = express.Router();
const ownerOnly = [auth.requireVendor, auth.requireRole('owner')];

router.get('/status', ownerOnly, async (req, res) => {
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  let st = { connected: !!v.stripe_account_id, chargesEnabled: !!v.connect_charges_enabled };
  if (v.stripe_account_id && stripe()) {
    try { st = await refreshAccountStatus(v); } catch (e) { console.error('Stripe account check failed:', e.message); }
  }
  res.json({
    configured: !!stripe(),
    pro: !!core.features(v).onlinePayments,
    connected: st.connected,
    chargesEnabled: st.chargesEnabled,
    payMode: v.pay_mode || 'both',
    effective: effectivePayMode({ ...v, connect_charges_enabled: st.chargesEnabled ? 1 : 0 }),
  });
});

// Creates the truck's Stripe account the first time, then sends them to Stripe's own sign-up pages.
router.post('/connect', ownerOnly, async (req, res) => {
  const s = stripe();
  if (!s) return res.status(503).json({ error: 'Payments are not set up on the server yet.' });
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  if (!core.features(v).onlinePayments) return res.status(402).json({ error: 'Online payments are a Pro feature.', upgrade: true });
  let acctId = v.stripe_account_id;
  if (!acctId) {
    const acct = await s.v2.core.accounts.create({
      contact_email: v.email || undefined,
      display_name: v.business_name,
      identity: { country: 'us' },
      dashboard: 'full',
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: { currency: 'usd', responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      metadata: { vendor_id: String(v.id), slug: v.slug },
      include: ['configuration.merchant'],
    }, { idempotencyKey: `connect-account-${v.id}` });
    acctId = acct.id;
    await run('UPDATE vendors SET stripe_account_id = ?, updated_at = ? WHERE id = ?', [acctId, Date.now(), v.id]);
  }
  const origin = `${SCHEME}://${req.tenant.host}`;
  const link = await s.v2.core.accountLinks.create({
    account: acctId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['merchant'],
        return_url: `${origin}/owner.html?connect=return`,
        refresh_url: `${origin}/owner.html?connect=refresh`,
      },
    },
  });
  res.json({ url: link.url });
});

router.put('/mode', ownerOnly, async (req, res) => {
  const mode = String((req.body || {}).payMode || '');
  if (!['window', 'both', 'online'].includes(mode)) return res.status(400).json({ error: 'Unknown option.' });
  await run('UPDATE vendors SET pay_mode = ?, updated_at = ? WHERE id = ?', [mode, Date.now(), req.tenant.vendor.id]);
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  core.broadcast(v.id, 'PAY_MODE', { payMode: effectivePayMode(v) });
  res.json({ ok: true, effective: effectivePayMode(v) });
});

const limitPublic = auth.rateLimit({ windowMs: 10 * 60 * 1000, max: 60, key: (req) => 'pay:' + req.ip });

// The customer's page calls this when they come back from Stripe, so the order reaches the kitchen
// right away even if the webhook is slow or not set up yet.
router.post('/confirm', limitPublic, auth.requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const token = String((req.body || {}).token || '');
  const o = token ? await get('SELECT * FROM orders WHERE vendor_id = ? AND public_token = ?', [v.id, token]) : null;
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.status === 'Pending' && o.stripe_session_id && stripe()) {
    try {
      const session = await stripe().checkout.sessions.retrieve(o.stripe_session_id, {}, { stripeAccount: v.stripe_account_id });
      await markPaid(o, session);
    } catch (e) { console.error('Payment confirm failed:', e.message); }
  }
  const now = await get('SELECT status, payment_status FROM orders WHERE id = ?', [o.id]);
  res.json({ status: now.status, payment: now.payment_status });
});

// Customer tapped "back" on Stripe's page: drop the unpaid order so it never shows in the kitchen.
router.post('/cancel', limitPublic, auth.requireVendor, async (req, res) => {
  const v = req.tenant.vendor;
  const token = String((req.body || {}).token || '');
  const o = token ? await get('SELECT * FROM orders WHERE vendor_id = ? AND public_token = ?', [v.id, token]) : null;
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  if (o.status !== 'Pending') return res.json({ status: o.status, payment: o.payment_status });
  if (o.stripe_session_id && stripe()) {
    try { await stripe().checkout.sessions.expire(o.stripe_session_id, {}, { stripeAccount: v.stripe_account_id }); }
    catch (e) {
      // Already paid at the last second? Then treat it as paid instead of canceling.
      try {
        const session = await stripe().checkout.sessions.retrieve(o.stripe_session_id, {}, { stripeAccount: v.stripe_account_id });
        if (await markPaid(o, session)) return res.json({ status: 'Preparing', payment: 'paid' });
      } catch (e2) {}
    }
  }
  await cancelPending(o, 'canceled');
  res.json({ status: 'Canceled', payment: 'canceled' });
});

/* ---------- Connect webhook (raw body, mounted in server.js before express.json) ---------- */
async function webhook(req, res) {
  const s = stripe();
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!s || !secret) return res.status(503).send('Payments webhook not configured');
  let event;
  try { event = s.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret); }
  catch (e) { return res.status(400).send('Invalid signature'); }
  try { await run('INSERT INTO stripe_events (id, created_at) VALUES (?, ?)', [event.id, Date.now()]); }
  catch (e) { return res.json({ received: true, duplicate: true }); }
  try {
    const obj = event.data && event.data.object;
    if (obj && obj.object === 'checkout.session' && obj.metadata && obj.metadata.order_id) {
      const o = await get('SELECT * FROM orders WHERE id = ?', [parseInt(obj.metadata.order_id, 10)]);
      const v = o ? await get('SELECT * FROM vendors WHERE id = ?', [o.vendor_id]) : null;
      // Only trust the event if it came from the account that owns this order.
      if (o && v && v.stripe_account_id && v.stripe_account_id === event.account && o.stripe_session_id === obj.id) {
        if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') await markPaid(o, obj);
        else if (event.type === 'checkout.session.expired') await cancelPending(o, 'expired');
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Connect webhook error:', err);
    await run('DELETE FROM stripe_events WHERE id = ?', [event.id]).catch(() => {});
    res.status(500).send('Handler error');
  }
}

module.exports = { router, webhook, onlineReady, effectivePayMode, createCheckout, refundOrder, cancelPending, markPaid };
