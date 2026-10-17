'use strict';
/**
 * billing.js — Stripe subscriptions for the Pro plan.
 * Stripe is the source of truth: a vendor's plan only changes when a signed webhook says so.
 *
 * .env needed:  STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET
 * Stripe webhook URL (add in the Stripe dashboard):  https://onlinekitchen.fyi/api/stripe/webhook
 * Events to send:  checkout.session.completed, customer.subscription.created,
 *                  customer.subscription.updated, customer.subscription.deleted,
 *                  invoice.payment_failed, invoice.paid
 */
const express = require('express');
const core = require('./core');
const { requireVendor, requireRole } = require('./auth');
const { run, get } = core;

let stripeClient = null;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripeClient) stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

const router = express.Router();
const ownerOnly = [requireVendor, requireRole('owner')];
const SCHEME = process.env.PUBLIC_SCHEME || 'https';

function notConfigured(res) {
  return res.status(503).json({ error: 'Billing is not set up yet.' });
}

router.post('/checkout', ownerOnly, async (req, res) => {
  const s = stripe();
  if (!s || !process.env.STRIPE_PRICE_ID) return notConfigured(res);
  const v = await get('SELECT * FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  if (core.effectivePlan(v) === 'pro' && v.stripe_subscription_id) {
    return res.status(409).json({ error: 'You are already on Pro. Use Manage billing.' });
  }
  let customerId = v.stripe_customer_id;
  if (!customerId) {
    const c = await s.customers.create({
      email: v.email || undefined,
      name: v.business_name,
      metadata: { vendor_id: String(v.id), slug: v.slug },
    });
    customerId = c.id;
    await run('UPDATE vendors SET stripe_customer_id = ? WHERE id = ?', [customerId, v.id]);
  }
  const origin = `${SCHEME}://${req.tenant.host}`;
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: String(v.id),
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    allow_promotion_codes: true,
    subscription_data: { metadata: { vendor_id: String(v.id) } },
    success_url: `${origin}/owner.html?billing=success`,
    cancel_url: `${origin}/owner.html?billing=cancel`,
  });
  res.json({ url: session.url });
});

router.post('/portal', ownerOnly, async (req, res) => {
  const s = stripe();
  if (!s) return notConfigured(res);
  const v = await get('SELECT stripe_customer_id FROM vendors WHERE id = ?', [req.tenant.vendor.id]);
  if (!v.stripe_customer_id) return res.status(400).json({ error: 'No billing account yet.' });
  const portal = await s.billingPortal.sessions.create({
    customer: v.stripe_customer_id,
    return_url: `${SCHEME}://${req.tenant.host}/owner.html`,
  });
  res.json({ url: portal.url });
});

/**
 * Cancels a vendor's Pro subscription right away (used when they delete their account).
 * Returns { ok: true } or { ok: false, error } — it never throws.
 */
async function cancelSubscription(vendor) {
  if (!vendor || !vendor.stripe_subscription_id) return { ok: true };
  const s = stripe();
  if (!s) return { ok: false, error: 'Billing is not configured, so the subscription could not be canceled.' };
  try {
    await s.subscriptions.cancel(vendor.stripe_subscription_id);
    return { ok: true };
  } catch (e) {
    // Already canceled on Stripe's side is fine.
    if (e && e.code === 'resource_missing') return { ok: true };
    console.error('Stripe cancel failed:', e.message);
    return { ok: false, error: 'We could not cancel your Pro subscription. Please try again, or cancel it in Manage Billing first.' };
  }
}

/* ---------- webhook (mounted in server.js BEFORE express.json, needs the raw body) ---------- */
async function findVendor(obj) {
  const meta = obj.metadata || {};
  if (meta.vendor_id) {
    const v = await get('SELECT id FROM vendors WHERE id = ?', [parseInt(meta.vendor_id, 10)]);
    if (v) return v.id;
  }
  if (obj.client_reference_id) {
    const v = await get('SELECT id FROM vendors WHERE id = ?', [parseInt(obj.client_reference_id, 10)]);
    if (v) return v.id;
  }
  const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
  if (customer) {
    const v = await get('SELECT id FROM vendors WHERE stripe_customer_id = ?', [customer]);
    if (v) return v.id;
  }
  return null;
}

async function setPlan(vendorId, fields) {
  const keys = Object.keys(fields);
  await run(`UPDATE vendors SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [
    ...keys.map((k) => fields[k]), Date.now(), vendorId,
  ]);
}

async function handleEvent(event) {
  const obj = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'subscription') return;
      const id = await findVendor(obj);
      if (!id) return console.warn('Stripe checkout for unknown vendor', obj.id);
      await setPlan(id, {
        stripe_customer_id: typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id,
        stripe_subscription_id: typeof obj.subscription === 'string' ? obj.subscription : obj.subscription && obj.subscription.id,
        plan: 'pro', plan_status: 'active', past_due_since: null,
      });
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const id = await findVendor(obj);
      if (!id) return;
      if (obj.status === 'active' || obj.status === 'trialing') {
        await setPlan(id, { plan: 'pro', plan_status: 'active', past_due_since: null, stripe_subscription_id: obj.id });
      } else if (obj.status === 'past_due' || obj.status === 'unpaid') {
        const v = await get('SELECT past_due_since FROM vendors WHERE id = ?', [id]);
        await setPlan(id, { plan: 'pro', plan_status: 'past_due', past_due_since: v.past_due_since || Date.now(), stripe_subscription_id: obj.id });
      } else if (obj.status === 'canceled' || obj.status === 'incomplete_expired') {
        await setPlan(id, { plan: 'free', plan_status: 'canceled', past_due_since: null, stripe_subscription_id: null });
      }
      return;
    }
    case 'customer.subscription.deleted': {
      const id = await findVendor(obj);
      if (id) await setPlan(id, { plan: 'free', plan_status: 'canceled', past_due_since: null, stripe_subscription_id: null });
      return;
    }
    case 'invoice.payment_failed': {
      const id = await findVendor(obj);
      if (!id) return;
      const v = await get('SELECT plan, past_due_since FROM vendors WHERE id = ?', [id]);
      if (v.plan === 'pro') await setPlan(id, { plan_status: 'past_due', past_due_since: v.past_due_since || Date.now() });
      return;
    }
    case 'invoice.paid': {
      const id = await findVendor(obj);
      if (!id) return;
      const v = await get('SELECT plan FROM vendors WHERE id = ?', [id]);
      if (v.plan === 'pro') await setPlan(id, { plan_status: 'active', past_due_since: null });
      return;
    }
    default:
      return; // other events are ignored
  }
}

async function webhook(req, res) {
  const s = stripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) return res.status(503).send('Billing not configured');
  let event;
  try {
    event = s.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    return res.status(400).send('Invalid signature');
  }
  // Stripe may deliver the same event twice; only handle each id once.
  try {
    await run('INSERT INTO stripe_events (id, created_at) VALUES (?, ?)', [event.id, Date.now()]);
  } catch (e) {
    return res.json({ received: true, duplicate: true });
  }
  try {
    await handleEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    await run('DELETE FROM stripe_events WHERE id = ?', [event.id]).catch(() => {});
    res.status(500).send('Handler error'); // Stripe will retry
  }
}

module.exports = { router, webhook, handleEvent, cancelSubscription, stripe };
