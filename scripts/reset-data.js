#!/usr/bin/env node
// Wipes ALL trucks, orders, sessions and menu photos so you can launch with a clean slate.
// It makes a copy first, so nothing is lost if you change your mind.
//
// Run on the server, from the app folder:
//   pm2 stop foodtruck-backend
//   node scripts/reset-data.js --yes
//   pm2 start foodtruck-backend
//
// Copies go next to the app as database.before-reset-<date>.sqlite and uploads.before-reset-<date>/.
// Delete those yourself once you're happy.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const APP_DIR = path.join(__dirname, '..');
const DB_FILE = process.env.DB_FILE || path.join(APP_DIR, 'database.sqlite');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(APP_DIR, 'uploads');
const TABLES = ['sms_log', 'stripe_events', 'tokens', 'sessions', 'orders', 'locations', 'store_state', 'vendors'];

if (!process.argv.includes('--yes')) {
  console.log('This deletes EVERY truck, order, login session and menu photo.');
  console.log('Stop the app first (pm2 stop foodtruck-backend), then run:  node scripts/reset-data.js --yes');
  process.exit(1);
}
if (!fs.existsSync(DB_FILE)) { console.log('No database found at', DB_FILE, '— nothing to reset.'); process.exit(0); }

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const db = new sqlite3.Database(DB_FILE);
const run = (sql, params = []) => new Promise((ok, bad) => db.run(sql, params, (e) => (e ? bad(e) : ok())));
const all = (sql, params = []) => new Promise((ok, bad) => db.all(sql, params, (e, r) => (e ? bad(e) : ok(r))));

(async () => {
  // 1. Safe copy of the database (VACUUM INTO works even with WAL files around).
  const copy = path.join(path.dirname(DB_FILE), `database.before-reset-${stamp}.sqlite`);
  await run('VACUUM INTO ?', [copy]);
  console.log('Saved a copy of the database to', copy);

  // 2. Empty every table that exists (schema stays, the app recreates nothing it doesn't need).
  const have = new Set((await all("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name));
  await run('BEGIN');
  for (const t of TABLES) {
    if (!have.has(t)) continue;
    const [{ n }] = await all(`SELECT COUNT(*) AS n FROM ${t}`);
    await run(`DELETE FROM ${t}`);
    console.log(`  ${t}: removed ${n} rows`);
  }
  if (have.has('sqlite_sequence')) await run('DELETE FROM sqlite_sequence');
  await run('COMMIT');
  await run('VACUUM');

  // 3. Move menu photos aside (not deleted) and start a fresh, empty uploads folder.
  if (fs.existsSync(UPLOAD_DIR)) {
    const aside = `${UPLOAD_DIR}.before-reset-${stamp}`;
    fs.renameSync(UPLOAD_DIR, aside);
    console.log('Moved old menu photos to', aside);
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  try { db.close(); } catch (e) { /* already closing */ }
  console.log('\nDone. Start the app again:  pm2 start foodtruck-backend');
})().catch((e) => {
  console.error('Reset failed, nothing was committed:', e.message);
  db.run('ROLLBACK', () => { try { db.close(); } catch (er) { /* ignore */ } });
  process.exit(1);
});
