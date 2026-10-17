'use strict';
/* =====================================================================
   Certificate watch. Caddy renews every truck's certificate by itself; this checks that it really did.
   Once a day it opens the main site and the busiest truck addresses the way a phone would, reads each
   certificate's expiry date, and emails ADMIN_EMAIL if any has under two weeks left (Caddy normally
   renews at 30 days, so two weeks means renewals are failing).
   ===================================================================== */
const tls = require('tls');
const core = require('./core');

const WARN_DAYS = 14;

/** Days until the certificate served for `host` expires, or null if it couldn't be checked. */
function certDaysLeft(host, { port = 443, connectHost, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const sock = tls.connect({ host: connectHost || host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert || !cert.valid_to) return finish(null);
      finish(Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 864e5));
    });
    sock.on('timeout', () => { sock.destroy(); finish(null); });
    sock.on('error', () => finish(null));
  });
}

/** The addresses worth checking: the main site, the trucks with the most recent orders, and Pro custom domains. */
async function hostsToWatch(limit = 25) {
  const root = core.ROOT_DOMAIN;
  const rows = await core.all(
    `SELECT v.slug, v.custom_domain, MAX(o.created_at) AS last FROM vendors v LEFT JOIN orders o ON o.vendor_id = v.id
     WHERE v.status = 'active' GROUP BY v.id ORDER BY last DESC LIMIT ?`, [limit]);
  const hosts = [root];
  for (const r of rows) {
    hosts.push(`${r.slug}.${root}`);
    if (r.custom_domain) hosts.push(r.custom_domain);
  }
  return [...new Set(hosts)];
}

/** Returns { checked, soon: [{host, days}], unreachable: [host] }. */
async function check(hosts, opts) {
  const out = { checked: 0, soon: [], unreachable: [] };
  for (const host of hosts) {
    const days = await certDaysLeft(host, opts);
    out.checked++;
    if (days === null) out.unreachable.push(host);
    else if (days < WARN_DAYS) out.soon.push({ host, days });
  }
  return out;
}

async function daily(mailLater) {
  const root = core.ROOT_DOMAIN;
  if (process.env.CERT_WATCH === 'off' || !root.includes('.') || root.endsWith('.local') || root === 'localhost') return null;
  const r = await check(await hostsToWatch());
  if (r.soon.length && process.env.ADMIN_EMAIL) {
    const lines = r.soon.map((s) => `${s.host}: ${s.days < 0 ? 'EXPIRED' : s.days + ' days left'}`);
    await mailLater({
      to: process.env.ADMIN_EMAIL,
      subject: `Online Kitchen: ${r.soon.length} certificate${r.soon.length === 1 ? '' : 's'} not renewing`,
      text: `Caddy normally renews certificates 30 days ahead. These have under ${WARN_DAYS} days left:\n\n${lines.join('\n')}\n\nSee RUNBOOK.md, "Certificate expiring".`,
      html: `<p>Caddy normally renews certificates 30 days ahead. These have under ${WARN_DAYS} days left:</p><pre>${lines.join('\n')}</pre><p>See RUNBOOK.md, “Certificate expiring”.</p>`,
    });
  }
  if (r.soon.length) console.error('Certificates not renewing:', r.soon);
  return r;
}

module.exports = { certDaysLeft, hostsToWatch, check, daily, WARN_DAYS };
