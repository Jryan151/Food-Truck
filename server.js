require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize SQLite Database locally

// Load onboarding routes now that db is ready


// 1. Explicit HTML Traffic Cop for the root URL
app.get('/', (req, res) => {
    const rawHost = req.headers.host || "";
    const host = rawHost.split(':')[0].trim();
    const rootDomain = (process.env.ROOT_DOMAIN || "jasonryean.pro").trim();

    if (host === rootDomain || host === 'www.' + rootDomain || host === 'localhost' || host === 'jasonryean.pro' || host === 'www.jasonryean.pro') {
        return res.sendFile('/var/www/foodtruck/public/index.html');
    }

    res.sendFile('/var/www/foodtruck/public/customer.html');
});

// 2. Dynamic Subdomain & Custom Domain API Lookup
app.get('/api/vendor-data', (req, res) => {
    const rawHost = req.headers.host || "";
    const host = rawHost.split(':')[0].trim();
    const rootDomain = (process.env.ROOT_DOMAIN || "jasonryean.pro").trim();

    if (host === rootDomain || host === 'www.' + rootDomain || host === 'localhost' || host === 'jasonryean.pro' || host === 'www.jasonryean.pro') {
        return res.json({ isDemo: true, message: "Welcome to root demo" });
    }

    let query = "SELECT * FROM vendors WHERE slug = ?";
    let param = host.split('.')[0];

    db.get(query, [param], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Vendor not found' });

        res.json({
            isDemo: false,
            businessName: row.business_name,
            slug: row.slug,
            customDomain: row.custom_domain,
            menu: JSON.parse(row.menu_data || '[]')
        });
    });
});


// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite Database locally
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to local SQLite database.');
        // Create vendors table with safety measures
        db.run(`CREATE TABLE IF NOT EXISTS vendors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            business_name TEXT NOT NULL,
            menu_data TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

// Reserved slugs blacklist to prevent squatting
const RESERVED_SLUGS = ['admin', 'api', 'www', 'support', 'root', 'auth', 'help', 'jasonryean'];

// 1. Vendor Registration Endpoint

// 2. Dynamic Subdomain & Custom Domain Lookup
app.get('/api/vendor-data', (req, res) => {
    const host = req.headers.host || "";
    
    // Catch root domain traffic
    if (host === process.env.ROOT_DOMAIN || host === 'www.' + process.env.ROOT_DOMAIN || host.startsWith('localhost')) {
        return res.json({ isDemo: true, message: 'Welcome to root demo' });
    }

    let query = "";
    let param = "";

    // Route based on whether it is a subdomain or a custom domain
    if (host.endsWith('.' + process.env.ROOT_DOMAIN)) {

        query = "SELECT * FROM vendors WHERE slug = ?";
        param = host.split('.')[0];
    } else {
        query = "SELECT * FROM vendors WHERE custom_domain = ?";
        param = host;
    }

    db.get(query, [param], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Vendor portal not found.' });

        res.json({
            isDemo: false,
            businessName: row.business_name,
            slug: row.slug,
            customDomain: row.custom_domain,
            menu: JSON.parse(row.menu_data || '[]')
        });
    });
});

// 3. Caddy On-Demand TLS Guardrail
app.get('/api/check-domain', (req, res) => {
    const domain = req.query.domain;
    if (!domain) return res.sendStatus(400);

    // Always allow the master root domain
    if (domain === 'jasonryean.pro' || domain === 'www.jasonryean.pro') {
        return res.sendStatus(200);
    }

    // Check database for subdomains OR custom domains
    if (domain.endsWith('.jasonryean.pro')) {
        const slug = domain.split('.')[0];
        db.get("SELECT id FROM vendors WHERE slug = ?", [slug], (err, row) => {
            if (row) return res.sendStatus(200);
            return res.sendStatus(404); // Blocks SSL generation
        });
    } else {
        db.get("SELECT id FROM vendors WHERE custom_domain = ?", [domain], (err, row) => {
            if (row) return res.sendStatus(200);
            return res.sendStatus(404); // Blocks SSL generation
        });
    }
});

// Modular Onboarding Router Mount
const onboardingRouter = require('./routes/onboarding')(db);
app.use('/api', onboardingRouter);

// --- REALTIME SYNC (SSE) ---
const truckClients = new Map();

app.get('/api/live-stream', (req, res) => {
  const host = req.headers.host || '';
  const slug = host.split('.')[0];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!truckClients.has(slug)) truckClients.set(slug, new Set());
  truckClients.get(slug).add(res);
  res.write(': connected\n\n');

  req.on('close', () => {
    const clients = truckClients.get(slug);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) truckClients.delete(slug);
    }
  });
});

app.post('/api/sync-event', (req, res) => {
  const { slug, type, payload } = req.body;
  const targetSlug = slug || (req.headers.host || '').split('.')[0];
  const clients = truckClients.get(targetSlug);

  if (clients && clients.size > 0) {
    const message = `data: ${JSON.stringify({ type, payload })}\n\n`;
    clients.forEach(client => client.write(message));
  }
  res.json({ ok: true, activeListeners: clients ? clients.size : 0 });
});
    

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
