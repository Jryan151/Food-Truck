# Runbook: when something's wrong

Written to work when you're tired, or when someone else is helping. Every command runs on the server
(`ssh` in first). The app lives in `/var/www/foodtruck` and runs under pm2 as `foodtruck-backend`.

While you work, trucks keep going: customers see the menu with "Order at the window" (limp mode) and
kitchen tablets keep their taps until the app is back. You have a few minutes. Don't rush a fix.

---

## 1. Site down — do this first

```
curl -s localhost:3000/api/health          # {"ok":true,...} means the app is fine
pm2 status                                  # foodtruck-backend should say "online"
pm2 logs foodtruck-backend --lines 50       # the last thing it said
```

- **pm2 says "errored" or "stopped":** `pm2 restart foodtruck-backend`, then check health again.
  If it stops again, read the logs: the first red line usually names the problem.
- **It broke right after a deploy:** go to 2.
- **Health says `"error":"database"`:** go to 3.
- **Health is fine but the site isn't:** it's Caddy or DNS.
  `sudo systemctl status caddy`, then `sudo systemctl restart caddy`. `dig +short onlinekitchen.fyi`
  should print the server's IP.
- **"No space left on device" in the logs:** go to 6.

## 2. Bad deploy: put the previous version back

```
cd /var/www/foodtruck && scripts/rollback.sh
```
Seconds. It restores the code that ran before the last `scripts/deploy.sh` and checks health. The
database stays as it is (changes only ever add, so older code runs fine on it). Then find the problem
calmly on the branch, not on the live site.

`scripts/deploy.sh` already does this by itself if the new version doesn't answer within 30 seconds,
and refuses to restart at all if the order-path tests fail.

## 3. Database problem

You'll usually hear about it from the nightly check email ("database check found a problem").

1. Stop writes: `pm2 stop foodtruck-backend` (customers get limp mode).
2. Keep the damaged file: `cp database.sqlite ~/database-damaged-$(date +%F).sqlite`
3. Pick the newest good copy, in this order:
   - Litestream (if set up): `litestream restore -o /tmp/restored.sqlite database.sqlite` (seconds old)
   - before a deploy: `ls -t backups/ /var/backups/foodtruck/releases/db-*` (taken just before each change)
   - nightly: `ls -t /var/backups/foodtruck/db-*.sqlite.gz` then `gunzip -k <file>`
4. Check it: `sqlite3 <copy> "PRAGMA integrity_check;"` must print `ok`.
5. `cp <copy> database.sqlite && rm -f database.sqlite-wal database.sqlite-shm && pm2 start foodtruck-backend`
6. Tell affected trucks which hours of orders may be missing (anything after the copy was taken).

## 4. Email isn't arriving

- Emails that failed are kept and retried for a day, so a short outage fixes itself. To see them:
  `sqlite3 database.sqlite "SELECT status, attempts, last_error, created_at FROM mail_outbox ORDER BY id DESC LIMIT 20;"`
- `last_error` says HTTP 401/403: the `RESEND_API_KEY` in `.env` is wrong or revoked. Make a new key in
  Resend, put it in `.env` (never in chat or email), `pm2 restart foodtruck-backend --update-env`.
- Resend's dashboard shows the domain as not verified: re-add the DNS records it lists.

## 5. Certificate expiring

The daily check emails you when a certificate has under 14 days left (Caddy normally renews at 30).

```
sudo journalctl -u caddy --since "2 days ago" | grep -i -E "error|certificate" | tail -20
```
Usually a DNS record changed or port 80/443 is blocked. Fix that, then `sudo systemctl reload caddy`;
Caddy retries by itself.

## 6. Disk full

```
df -h /                     # how full
du -sh /var/backups/foodtruck/* /var/www/foodtruck/backups ~/.pm2/logs | sort -h | tail
pm2 flush                   # clears old pm2 logs (safe)
```
Delete the oldest backups first (keep the newest 3 of each kind). Never delete `database.sqlite*`.

## 7. "My orders aren't coming in"

1. Their page: open `https://<truck>.onlinekitchen.fyi`. Does it say open? Is ordering paused or paced?
2. Their kitchen screen: the dot by Log out should be green. Amber means it lost its connection: they
   should reload. A "No signal" bar means the tablet itself has no internet (their hotspot).
3. The service record for one order: Kitchen → tap the ticket → History, or
   `sqlite3 database.sqlite "SELECT event, actor, datetime(at/1000,'unixepoch') FROM order_events WHERE order_id = <id>;"`

## 8. What customers see while the app is down

Limp mode: the truck's name, spot and menu with prices, and "Online ordering is down for a moment ·
Order at the window". Pages switch back by themselves within 20 seconds of the app returning. Nothing
to do. (It needs the Caddy `handle_errors` block from DEPLOY.md, "Limp mode".)

---

Phone numbers and logins you'll need (fill in, keep this copy off the server):
- Hetzner console: ______________________
- Domain registrar: ______________________
- Resend: ______________________
