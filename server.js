'use strict';
require('dotenv').config();

/* ---------- error monitoring (optional): set SENTRY_DSN in .env and `npm i @sentry/node` ---------- */
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
    Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV || 'production' });
    console.log('Error monitoring: Sentry on');
  } catch (e) {
    console.warn('SENTRY_DSN is set but @sentry/node is not installed. Run: npm i @sentry/node');
  }
}
const report = (err) => { if (Sentry) try { Sentry.captureException(err); } catch (e) {} };

const express = require('express');
const fs = require('fs');
const path = require('path');
const core = require('./core');
const auth = require('./auth');
const api = require('./api');
const billing = require('./billing');
const payments = require('./payments');
const sms = require('./sms');
const catering = require('./catering');
const schedule = require('./schedule');
const rewards = require('./rewards');

const app = express();
const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');

app.set('trust proxy', 1); // Caddy sits in front
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  // HTTPS only from now on for this browser (1 year). Only sent over HTTPS, so local testing is unaffected.
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// Stripe webhook needs the raw body, so it goes BEFORE express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), billing.webhook);
app.post('/api/stripe/connect-webhook', express.raw({ type: 'application/json' }), payments.webhook);

app.use(express.json({ limit: '100kb' }));

// Work out which vendor (or the root site) every request is for.
app.use(auth.tenant);

// Block cross-site writes: browsers send Origin on POST/PUT/PATCH/DELETE.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host.toLowerCase(); } catch (e) {}
    if (host !== String(req.headers.host || '').toLowerCase()) return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  next();
});

app.use('/api/auth', auth.router);
app.use('/api/billing', billing.router);
app.use('/api/payments', payments.router);
app.use('/api/sms', sms.router);
app.use('/api/catering', catering.router);
app.use('/api/schedule', schedule.router);
app.use('/api/rewards', rewards.router);
app.use('/api', api.router);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* ---------- pages ---------- */
const sendPage = (res, file) => res.sendFile(path.join(PUB, file));
const unavailable = (res) =>
  res.status(503).send('<h1>This page is not available right now.</h1>');

const escAttr = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Link previews (Instagram, iMessage, Facebook...) read these tags, so they're filled in per truck on the server. */
function shareTags(req, v, kind) {
  const origin = `${req.secure ? 'https' : 'http'}://${req.tenant.host}`;
  const name = v.business_name;
  const title = kind === 'owner' ? `${name} — Kitchen` : kind === 'catering' ? `${name} — Catering` : kind === 'schedule' ? `${name} — Where we’ll be` : `${name} — Order online`;
  const desc = kind === 'owner' ? `Kitchen dashboard for ${name}.` : kind === 'catering' ? `Price your event with ${name} in about three minutes. No back-and-forth.` : kind === 'schedule' ? `Where ${name} will be this week. Add it to your calendar or follow along.` : `Order ahead from ${name} and pick up at the window.`;
  return [
    `<title>${escAttr(title)}</title>`,
    `<meta name="description" content="${escAttr(desc)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(desc)}">`,
    `<meta property="og:url" content="${escAttr(origin + '/')}">`,
    `<meta property="og:image" content="${escAttr(origin + '/og-image.png')}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join('\n    ');
}

function vendorPage(file, kind) {
  return async (req, res, next) => {
    const v = req.tenant.vendor;
    if (!v) return res.status(404).send('<h1>Page not found</h1>');
    if (v.status !== 'active') return unavailable(res);
    try {
      const html = await fs.promises.readFile(path.join(PUB, file), 'utf8');
      res.set('Cache-Control', 'no-cache');
      res.type('html').send(html.replace(/<title>[^<]*<\/title>/i, shareTags(req, v, kind)));
    } catch (e) { next(e); }
  };
}
function rootPage(file) {
  return (req, res) => (req.tenant.isRoot ? sendPage(res, file) : res.status(404).send('<h1>Page not found</h1>'));
}

app.get('/', (req, res, next) => {
  if (req.tenant.isRoot) return sendPage(res, 'index.html');
  return vendorPage('customer.html', 'customer')(req, res, next);
});
app.get(['/customer', '/customer.html'], vendorPage('customer.html', 'customer'));
app.get(['/owner', '/owner.html'], vendorPage('owner.html', 'owner'));
// Catering: hosts book at /catering, get one link per booking, and the owner manages it at /catering/manage.
app.get(['/catering', '/catering/'], vendorPage('catering.html', 'catering'));
app.get('/catering/b/:token', vendorPage('catering-booking.html', 'catering'));
app.get('/catering/manage', vendorPage('catering-manage.html', 'owner'));
// Where the truck will be: list, add-to-calendar, calendar feed, follow by email.
app.get(['/schedule', '/schedule/'], vendorPage('schedule.html', 'schedule'));
app.get('/schedule.ics', (req, res) => res.redirect(301, '/api/schedule/feed.ics'));
app.get(['/signup', '/signup.html'], rootPage('signup.html'));
app.get(['/login', '/login.html'], (req, res) =>
  req.tenant.isRoot ? sendPage(res, 'login.html') : res.redirect('/owner.html'));
app.get(['/reset', '/reset.html'], rootPage('reset.html'));
// Legal pages work on the main site and on every vendor page (the customer footer links to them).
app.get(['/terms', '/terms.html'], (req, res) => sendPage(res, 'terms.html'));
app.get(['/privacy', '/privacy.html'], (req, res) => sendPage(res, 'privacy.html'));

/* ---------- demo (main site only, no account, nothing touches the database) ----------
   The demo serves the REAL customer and owner pages with demo-shim.js loaded first. The shim
   answers every /api call in the browser from a preset truck saved in localStorage, so the demo
   always matches the real product. */
const DEMO_TAG = '<script src="/demo-shim.js"></script>';
function demoPage(file) {
  return async (req, res, next) => {
    if (!req.tenant.isRoot) return res.status(404).send('<h1>Page not found</h1>');
    try {
      const html = await fs.promises.readFile(path.join(PUB, file), 'utf8');
      res.set('Cache-Control', 'no-store');
      res.type('html').send(html.replace(/<head>/i, '<head>\n    ' + DEMO_TAG));
    } catch (e) { next(e); }
  };
}
app.get(['/demo', '/demo/'], (req, res) =>
  req.tenant.isRoot ? res.redirect('/demo/customer') : res.status(404).send('<h1>Page not found</h1>'));
app.get('/demo/customer', demoPage('customer.html'));
app.get('/demo/owner', demoPage('owner.html'));

/* ---------- installable app (PWA) ----------
   Two manifests per truck: the owner portal installs as "<Truck> Kitchen" and opens the dashboard;
   the customer page installs as the truck's ordering app. */
function manifest(kind) {
  return (req, res) => {
    const v = req.tenant.vendor;
    const name = v ? v.business_name : 'Online Kitchen';
    const owner = kind === 'owner';
    res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
      name: owner ? `${name} Kitchen` : name,
      short_name: (owner ? 'Kitchen' : name).slice(0, 12),
      id: owner ? '/owner.html' : '/',
      start_url: owner ? '/owner.html' : '/',
      scope: '/',
      display: 'standalone',
      background_color: '#0a0a0b',
      theme_color: '#0a0a0b',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  };
}
app.get('/manifest.webmanifest', manifest('customer'));
app.get('/manifest-owner.webmanifest', manifest('owner'));
app.get('/offline.html', (req, res) => sendPage(res, 'offline.html'));
app.get('/sw.js', (req, res) => {
  // The service worker must not be cached for long, or fixes take days to reach phones.
  res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
  sendPage(res, 'sw.js');
});
app.get('/favicon.ico', (req, res) => sendPage(res, 'favicon.png'));

/* ---------- menu photos ---------- */
const IMG_EXT = new Set(['.jpg', '.png', '.webp']);
app.use('/uploads', (req, res, next) => {
  if (!IMG_EXT.has(path.extname(req.path).toLowerCase())) return res.status(404).send('Not found');
  next();
}, express.static(core.UPLOAD_DIR, { index: false, dotfiles: 'ignore', maxAge: '30d', immutable: true }));

/* ---------- static assets (css/js/images only — notes, backups and .txt files are never served) ---------- */
const ASSET_EXT = new Set(['.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp', '.woff', '.woff2']);
app.use((req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  if (ext && !ASSET_EXT.has(ext)) return res.status(404).send('Not found');
  next();
});
app.use(express.static(PUB, { index: false, dotfiles: 'ignore', maxAge: '1h' }));

app.use((req, res) => res.status(404).send('<h1>Page not found</h1>'));

// Any error in an async route lands here (Express 5 forwards rejected promises).
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Unhandled error:', err);
  report(err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  res.status(500).send('Something went wrong.');
});

process.on('unhandledRejection', (e) => { console.error('Unhandled rejection:', e); report(e); });

/* ---------- startup checks: say loudly what isn't set up yet ---------- */
function startupWarnings() {
  if (!auth.mailConfigured()) {
    console.warn('⚠️  EMAIL IS NOT SET UP (RESEND_API_KEY / MAIL_FROM). Password resets and activation emails will NOT be sent.');
  }
  if (!fs.existsSync(path.join(PUB, 'app.css'))) {
    console.warn('⚠️  public/app.css is missing — pages will be unstyled. Run: npm run build:css');
  }
  if (!process.env.ADMIN_TOKEN) console.warn('ℹ️  ADMIN_TOKEN is not set, so the admin API is off.');
  if (!process.env.STRIPE_SECRET_KEY) console.warn('ℹ️  STRIPE_SECRET_KEY is not set: Pro billing and online payments are off.');
  else if (!process.env.STRIPE_CONNECT_WEBHOOK_SECRET) console.warn('ℹ️  STRIPE_CONNECT_WEBHOOK_SECRET is not set: paid orders still work (the customer page confirms them), but add the Connect webhook as a backup.');
  if (!sms.configured()) console.warn('ℹ️  Twilio is not set up: Pro text alerts are off.');
}

/* ---------- daily checks: database integrity and data retention ---------- */
async function dailyChecks() {
  try {
    const result = await core.integrityCheck();
    if (result !== 'ok') {
      console.error('DATABASE INTEGRITY PROBLEM:', result);
      report(new Error('Database integrity check failed: ' + result));
      if (process.env.ADMIN_EMAIL) {
        auth.sendMail({
          to: process.env.ADMIN_EMAIL,
          subject: 'Online Kitchen: database check found a problem',
          text: `The nightly database check reported:\n\n${result}\n\nRestore the most recent good backup (see DEPLOY.md) and check the server's disk.`,
          html: `<p>The nightly database check reported:</p><pre>${auth.escHtml(result)}</pre><p>Restore the most recent good backup (see DEPLOY.md) and check the server's disk.</p>`,
        }).catch(() => {});
      }
    }
    const r = await core.applyRetention();
    if (r.ordersCleared || r.eventsRemoved) console.log('Retention:', r);
  } catch (e) { console.error('Daily checks failed:', e.message); }
}

let httpServer = null;
core.ensureSchema()
  .then(() => core.autoCloseOrders().catch(() => {}))
  .then(() => {
    httpServer = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT} (root domain: ${core.ROOT_DOMAIN})`);
      startupWarnings();
    });
    setTimeout(dailyChecks, 60 * 1000).unref();
    setInterval(dailyChecks, 24 * 60 * 60 * 1000).unref();
    // The line keeps aging between taps: refresh the wait customers see once a minute.
    setInterval(() => core.refreshAllWaits().catch(() => {}), 60 * 1000).unref();
  })
  .catch((e) => { console.error('Startup failed:', e); report(e); process.exit(1); });

/* ---------- graceful stop: requests in progress finish before the old version exits ----------
   pm2 restart/reload sends SIGINT. Live kitchen screens reconnect to the new process by themselves. */
function shutdown(signal) {
  console.log(`${signal}: finishing requests in progress, then stopping.`);
  if (!httpServer) process.exit(0);
  httpServer.close(() => process.exit(0));
  if (httpServer.closeIdleConnections) httpServer.closeIdleConnections();
  core.closeAllStreams();
  setTimeout(() => process.exit(0), 8000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
