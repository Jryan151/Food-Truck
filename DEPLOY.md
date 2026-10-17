# Release update — Online Kitchen on onlinekitchen.fyi

Do these in order. Keep jasonryean.pro completely separate; nothing here touches it except removing the old app lines from Caddy.

## 1. Back up first
```
cd /var/www/foodtruck
pm2 stop foodtruck-backend
cp database.sqlite ~/database-before-release.sqlite
cp .env ~/env-before-release.txt
```

## 2. Copy the files in
Upload everything in this zip over the old files (same folders): `server.js core.js api.js billing.js payments.js`,
`public/` (owner.html, customer.html, index.html, signup.html, login.html, reset.html, terms.html, privacy.html, demo-shim.js, logo.js),
`scripts/reset-data.js`. Nothing to npm install.

## 3. Point the new domain at your server (DNS)
Where you bought onlinekitchen.fyi, add two **A records** to your server's IP (same IP jasonryean.pro uses):
| Type | Name | Value |
|---|---|---|
| A | `@` | your server IP |
| A | `*` | your server IP |

The `*` (wildcard) is what makes every truck's `name.onlinekitchen.fyi` work. Check with `dig +short taco.onlinekitchen.fyi` — it should print your IP (can take up to an hour).

## 4. Caddy
`sudo nano /etc/caddy/Caddyfile`. Remove the old app block that served jasonryean.pro / *.jasonryean.pro through the app (leave anything else you host there alone). The app part should look like this:
```
{
    on_demand_tls {
        ask http://localhost:3000/api/check-domain
    }
}

# Online Kitchen: onlinekitchen.fyi, every truck subdomain, and Pro custom domains
https:// {
    tls {
        on_demand
    }
    reverse_proxy localhost:3000
}
```
If jasonryean.pro is now a separate site on the same server, give it its own block *above* the `https://` block, e.g.
`jasonryean.pro, www.jasonryean.pro { root * /var/www/jasonryean; file_server }`.
Then `sudo systemctl reload caddy`. Each truck's certificate is issued automatically the first time its page is opened (a few seconds).

## 5. Update .env
```
ROOT_DOMAIN=onlinekitchen.fyi
PRO_PRICE_DISPLAY=$34.99/mo
MAIL_FROM=Online Kitchen <hello@onlinekitchen.fyi>
```
- **Email:** in Resend add the domain `onlinekitchen.fyi` and add the DNS records it shows you (until it says Verified, emails won't send). To *receive* mail at hello@onlinekitchen.fyi (it's the contact on the legal pages), turn on email forwarding at your domain registrar (most offer it free) to your Gmail.
- **Stripe** (when you set it up): webhook URLs are `https://onlinekitchen.fyi/api/stripe/webhook` and `https://onlinekitchen.fyi/api/stripe/connect-webhook`. If you already made webhooks for jasonryean.pro, edit their URLs.
- **Pro price:** in Stripe, make the Pro price $34.99/month and put its price ID in `STRIPE_PRICE_ID`. The display text above is just what the pages show.

## 6. Clear the test data
This deletes every truck, order and photo (a copy is saved first, see the top of the script):
```
node scripts/reset-data.js --yes
```

## 7. Rebuild the stylesheet and start
```
npm run build:css
pm2 start foodtruck-backend
pm2 logs foodtruck-backend --lines 20
```
The log should say `root domain: onlinekitchen.fyi`.

## 8. Check
- `https://onlinekitchen.fyi` → shows Online Kitchen, Pro at $34.99/mo → Try the live demo works
- Sign up a real truck → `https://yourtruck.onlinekitchen.fyi` opens with a lock icon
- Owner portal → **Guide** tab → "Take me there" jumps to each feature
- Customer page → tap an item with a photo → whole photo shows, not zoomed
- Customer page → buttons say **Order Status**
- Fill in `[LLC LEGAL NAME]` and `[HOSTING PROVIDER]` in `public/terms.html` and `public/privacy.html` once your LLC is approved

## Setting up a custom domain for a Pro truck
1. The truck adds a **CNAME** at their domain host: name `order` (or whatever they want) → value `yourtruck.onlinekitchen.fyi`.
2. You run on the server (with ADMIN_TOKEN from .env; find the truck's id with the first command):
```
curl -s -H "x-admin-token: $ADMIN_TOKEN" https://onlinekitchen.fyi/api/admin/vendors
curl -s -X POST -H "x-admin-token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"customDomain":"order.theirtruck.com"}' https://onlinekitchen.fyi/api/admin/vendors/ID
```
3. Open `https://order.theirtruck.com` once; Caddy gets the certificate. It only works while the truck is on Pro. Send `"customDomain":""` to remove it.
(Run `export ADMIN_TOKEN=...` first, or paste the token in place of `$ADMIN_TOKEN`.)

## What changed
- **New name and address:** Online Kitchen on onlinekitchen.fyi. Trucks get `name.onlinekitchen.fyi`. Old test subdomains are not carried over.
- **Time zones:** just the US zones with plain names (Eastern, Central, Mountain, Arizona, Pacific, Alaska, Hawaii).
- **Logos:** new trucks get a food-truck logo instead of 🌮. Owners pick from preset logos in Settings → Business Profile, or type any emoji.
- **Item photos:** the item pop-up shows the whole photo instead of a zoomed crop.
- **Order Status:** the customer buttons and screen say "Order Status" ("Estado del pedido" in Spanish).
- **Guide tab** (owners only, staff don't see it): every feature explained, Pro ones marked, with "Take me there" buttons.
- **Pro:** $34.99/mo shown everywhere; custom domain listed as a Pro feature; admin can set a truck's custom domain.
- **Legal:** Terms and Privacy rewritten for an Arizona LLC in Phoenix: US only (not aimed at EU/UK), Arizona law, Maricopa County courts, no users under 13, trucks responsible for food, refunds and sales tax, Arizona breach notice rules. Not legal advice; have a lawyer look before you take payments.
- **Reset script:** `scripts/reset-data.js` clears test data with a backup.

---

# Phase 1 update — how to install

## 1. Clean up old files first
In the project / on the server, delete these so the wrong version can't be deployed:
- `api 2.js` (outdated copy — `api.js` is the real one)
- the old `public/` and `backend/` copies in the Claude project, plus `index main.html`, `index_phase1_backup.html`, `customer .html`

Server layout stays the same:
```
/var/www/foodtruck/
  server.js  core.js  auth.js  api.js  billing.js  .env  database.sqlite
  tailwind.config.js  src/input.css  scripts/backup.sh
  public/  index.html signup.html login.html reset.html owner.html customer.html
           terms.html privacy.html demo-shim.js  app.css (built in step 3)
```

## 2. Back up the database, then copy the files in
```
cp database.sqlite database.backup-before-phase1.sqlite
```
The database upgrades itself on start (one new column, `terms_accepted_at`). Nothing is deleted.

## 3. Build the stylesheet (replaces the Tailwind CDN)
```
npm i -D tailwindcss@3
npm pkg set scripts.build:css="tailwindcss -i ./src/input.css -o ./public/app.css --minify"
npm run build:css
```
Re-run `npm run build:css` whenever you change classes in an HTML file. If `public/app.css` is missing, the server prints a warning and pages show unstyled.

## 4. Set up email (required before real vendors)
In resend.com: add and verify your domain, add the SPF/DKIM DNS records it shows, create an API key.
Put `RESEND_API_KEY` and `MAIL_FROM` in `.env` (see `env_example.txt`). Until then the server prints
"EMAIL IS NOT SET UP" on start and password-reset emails are not sent.

## 5. Error monitoring (recommended)
Create a free Node.js project at sentry.io, put its DSN in `.env` as `SENTRY_DSN`, then `npm i @sentry/node`.

## 6. Nightly backups
Follow the setup lines at the top of `scripts/backup.sh` (install sqlite3 + rclone, add an off-server remote, add the cron line). Test a restore once.

## 7. Fill in the legal pages
`public/terms.html` and `public/privacy.html` are templates — replace every `[BRACKETED]` item and have them reviewed. Signup now requires agreeing to them.

## 8. Restart and check
```
pm2 restart foodtruck      # or however you run it
```
Then check:
- `https://onlinekitchen.fyi` → "Try the live demo" → place an order → switch to Owner view → it's there
- Sign up a test truck → owner portal shows "View my customer page"
- Owner portal on a phone: the "Tap here to turn on new-order sounds" bar disappears after one tap

## What changed
**Demo:** `/demo` (main site only). Real customer + owner pages, preset truck, no account, nothing saved to the database. Both views stay in sync, even in two tabs. "Reset demo" starts over.

**Must-fix items**
- "View my customer page" button in the owner header
- Screen stays awake on the dashboard; when the phone comes back from sleep it reconnects and reloads orders
- "Tap to turn on sounds" prompt (browsers block audio until a tap)
- "Pay at the window" on the cart and the order confirmation
- Live updates no longer broadcast order tokens (customers match by a one-way tag)
- Startup warnings for missing email / stylesheet; backup script; deploy notes

**Should-fix items**
- Order rate limit is now per truck + IP, 60 per 10 minutes
- 200-item menu ceiling enforced on the server for every plan (no plan-based cap)
- Sample menu has 6 items
- Auto-close: Ready orders → Fulfilled after 3 hours; Preparing orders → Canceled after 12 hours
- Terms + Privacy pages, signup checkbox, account deletion (cancels Pro first), email change
- Optional Sentry error monitoring
- Tailwind is built into `app.css` instead of loaded from the CDN

---

# Phase 2 update — owner & customer experience

Install exactly like Phase 1: back up `database.sqlite`, copy the files in, run `npm run build:css`, restart.
The database upgrades itself (new columns: posted hours, time zone, paused). No new packages.

**New files:** `public/qr.js`, `public/sw.js`, `public/offline.html`, `public/og-image.png`, `public/favicon.png`, `public/icons/*`.
**New folder:** `uploads/` (menu photos) is created next to `server.js` the first time someone adds a photo.
`scripts/backup.sh` now backs it up too. Set `UPLOAD_DIR` in `.env` only if you want it somewhere else.

Check after restarting:
- Owner portal → Inventory → Edit an item → Choose photo → Save. The photo shows on the customer menu.
- Settings → Print QR code sign → scan it with your phone camera; it opens your page.
- Settings → Pause online orders → your page says "Online ordering paused" right away.
- Send your page link in a text or Instagram DM — the preview shows your truck name and the share image.
- On an Android phone, the owner portal shows "📲 Install app"; on iPhone, Share → Add to Home Screen.

## What changed
**Owner portal**
- First-week checklist on the Orders tab (location, menu, hours, QR/share, test order); hide it any time
- Printable QR code sign for the truck window, plus a "Save QR image" button
- Menu categories, ▲▼ reordering within a category, item photos (shrunk on the phone before upload), and flavor/size options in the editor
- "Pause online orders" switch: still open for walk-ups, no new online orders (staff can use it too)
- Posted hours for each day + time zone, shown on the customer page
- CSV export of orders for any date range (Analytics tab)
- Installable as a phone/tablet app, with a "No connection" screen when the signal drops

**Customer page**
- Menu grouped by category with quick-jump chips, photos on items and in the item pop-up
- Today's hours with a tap-to-see-the-week list (in the truck's time zone)
- English / Español switch (automatic for Spanish-language phones; menu items show as the truck wrote them)
- Clear paused state, remembered name at checkout, zoom allowed for accessibility
- Link previews (truck name + image) when the page is shared

**Behind the scenes**
- Hidden honeypot field blocks simple spam bots from placing fake orders
- HSTS (HTTPS-only) and a Permissions-Policy header
- Photo uploads are checked to be real JPG/PNG/WebP, limited to 2 MB, and unused ones are cleaned up
- CSV cells that start with = + - @ are neutralised so a customer name can't run as a spreadsheet formula
- Demo updated for all of the above (photo upload is turned off in the demo)

Note: the customer page's own words are translated; error messages that come from the server are still English.

---

# Phase 3 update — online payments + text alerts (Pro)

Install like before: back up `database.sqlite`, copy the files in, `npm run build:css`, restart.
New server files: `payments.js`, `sms.js`. The database upgrades itself (payment and text columns, `sms_log` table).

**Update the Stripe package** (online payments use Stripe's newer Accounts v2 API):
```
npm i stripe@latest
```

## Turn on online payments
1. Stripe Dashboard → **Connect** → Get started → choose **Platform** (vendors get paid directly, you charge a subscription). Finish your platform profile.
2. Developers → Webhooks → **Add destination** → **Connected accounts** →
   URL `https://onlinekitchen.fyi/api/stripe/connect-webhook`, events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`.
   Put its signing secret in `.env` as `STRIPE_CONNECT_WEBHOOK_SECRET`.
3. Test with your **test** keys first: upgrade a test truck to Pro → Settings → Online Payments → Connect with Stripe →
   use Stripe's test data → place an order with card `4242 4242 4242 4242` → it lands in the kitchen marked 💳 PAID ONLINE →
   cancel it and check the refund in the truck's Stripe test dashboard.

How the money moves: each truck has its own Stripe account (full Stripe Dashboard). Customer payments go straight to
that truck; Stripe takes its card fee from the truck's payment; you take no cut; Stripe covers fraud losses on those accounts.

## Turn on text alerts
1. Twilio: buy a number, create a **Messaging Service** with it, and complete **A2P 10DLC** registration
   (brand + campaign "order notifications"). Carriers block unregistered texts, and approval can take days to weeks.
2. `.env`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM`), optional `SMS_MONTHLY_LIMIT`.
3. A Pro truck: Settings → Text Alerts → enter mobile → type the 6-digit code.

## What changed
**Customers (Pro trucks)**
- Choose 💳 Pay now (card, Apple Pay, Google Pay on Stripe's secure page) or 💵 Pay at the window — or the truck can require card
- Paid orders only reach the kitchen once Stripe confirms payment (the page checks with Stripe on return; the webhook is a backup)
- Tapping back on Stripe's page cancels the unpaid order and puts their cart back
- Optional "Text me when it's ready" with a consent checkbox; the number is deleted when the order closes

**Owners (Pro)**
- Settings → Online Payments: Connect with Stripe, then choose how customers pay; link to their Stripe Dashboard
- Tickets show 💳 PAID ONLINE / 💵 PAY AT WINDOW / 📱 texts when ready
- Canceling a paid order refunds the card in full (owner only — staff can't)
- Settings → Text Alerts: verified mobile number; new-order texts "only when no kitchen screen is open", "every order" or "never"; customer ready-texts on/off; monthly usage
- Free trucks see these as Pro features with an Upgrade button (the demo too)

**Safety**
- Payment amounts are checked against the order total before an order is marked paid
- Webhook events are only trusted from the Stripe account that owns the order, and each event is handled once
- Unpaid card checkouts expire after an hour; paid orders are never auto-canceled
- Phone numbers are verified by code; texts are capped per truck per month

Your Terms and Privacy templates now include payment and text-message sections — fill in and have them reviewed again.

# New look + new signup (branch `new-look`)

## What changed
- **Silver and black, day and night.** `public/theme.css` (loaded after `app.css` on every page) maps the colors the pages use onto day/night tokens. `public/theme.js` picks the theme before the page paints: it follows the phone's light/dark setting, or the owner's choice in **Settings → Appearance** (saved per device).
- **Manrope** replaces the serif headings (loaded from Google Fonts).
- **Preview-first signup** (`public/signup.html`): truck name and menu show a live preview with no account. "Save my page" asks for name, email and password, then a **6-digit code** is emailed. The page and its web address are only created once the code is entered.
- New endpoints: `POST /api/auth/signup/start` and `POST /api/auth/signup/verify`. New table `pending_signups` is created automatically on start.

## Email and the code step
- With Resend set up (`RESEND_API_KEY` and `MAIL_FROM` in `.env`), every signup needs the emailed code.
- Without email set up, signups still work: the page is created straight away (as before) and the server log notes it. Once Resend works, codes turn on by themselves. Set `REQUIRE_EMAIL_VERIFY=true` to require codes even then (signups will fail until email works).

## Install
```
cd /var/www/foodtruck
git fetch origin
git checkout new-look
pm2 restart foodtruck-backend
```
No new packages. `npm run build:css` is optional: `theme.css` doesn't depend on it.

## Check
1. Open the home page on your phone in light mode, then dark mode: day is silver with black buttons, night is black with silver buttons.
2. Sign up a test truck from your phone: type a name, watch the preview, Save, enter the code from your email, land in the dashboard.
3. Owner portal → Settings → Appearance: try Day and Night.

# Catering (branch `catering`, built on `new-look`)

## What it is
- **Hosts** book at `yourtruck.onlinekitchen.fyi/catering`: date, address, ZIP and guests are checked instantly, they pick a package, answer the site questions, and see an exact itemized quote that updates as they choose. "Request" holds the date for 24 hours. They get one link (`/catering/b/...`) that always shows the booking.
- **Owners** manage everything at `/catering/manage` (also linked from Settings → Catering in the kitchen portal): the **Playbook** (packages with price breaks, minimums, notice, travel zones by ZIP, service charge, tax, deposit %, site questions, blocked days, terms) and **Bookings** (accept or decline in one tap, and a day-of **event sheet** that keeps working without signal).
- A **"Planning an event? Get a catering quote"** button appears on the truck's page once catering is turned on.
- Anything outside the rules (a far ZIP, too many guests) becomes a structured **custom request** emailed to the owner, with replies going straight to the host.
- Emails: host request receipt, owner new-request alert, confirmation or decline, and hold-ended notices. Replies always go to the other person.

## Rules that protect the money
- Prices are worked out on the server with `public/catering-quote.js` (the same code the page uses), in whole cents; the browser's numbers are never trusted.
- A day can't be double-booked, even if two hosts submit at the same instant.
- A hold that isn't answered within 24 hours ends on its own; the owner can still accept later if the day is free.
- Deposits are shown to hosts but not collected until Stripe is set up.

## Install
```
cd /var/www/foodtruck
git fetch origin
git checkout catering
pm2 restart foodtruck-backend
```
New tables (`catering_settings`, `catering_bookings`) are created automatically. Email (Resend) must be set up for hosts and owners to get the emails.

## Schedule and followers

- Customers see where the truck will be at `/schedule`. They can add a stop to their calendar, subscribe to a
  calendar feed that updates itself (`/api/schedule/feed.ics`), or follow by email.
- Following by email uses the same Resend settings as everything else (`RESEND_API_KEY`, `MAIL_FROM`).
  Without them, the follow form stays hidden and the schedule and calendar still work.
- Follow is double opt-in: nothing is sent until the person taps the link in their confirm email. Every email
  has a one-click unsubscribe, which deletes the email address.
- Followers only hear from the truck when the owner taps "Email this week" (at most every 3 days) or ticks
  "tell followers" at Start service (at most every 6 hours).
- No new environment settings are needed. The tables are created on start.

## Crew PINs

- Each crew member can have their own kitchen PIN (Settings → Crew). Their name is recorded on what they do.
- PINs are found with a keyed hash and checked with bcrypt; the PIN itself is never stored. The key comes
  from `PIN_PEPPER` if set, otherwise one is generated on first start and kept in the database.
  If you set `PIN_PEPPER` later, existing crew PINs stop matching and need to be set again.
- The old shared staff PIN still works until the owner turns it off.

## Clients (CRM)

- `/clients` is the owner's client list. It fills itself from catering (quotes emailed, requests,
  bookings, served events, custom questions) and from confirmed followers. Nobody types records in.
- Only two messages ever go out automatically, both transactional: a thank-you the morning after an
  event (with one-tap 👍/👎), and one follow-up on a quote someone asked to have emailed. Everything else
  is a draft on "Reach out this week" that the owner reads and sends.
- A 👎 pauses automatic messages to that client for 90 days and emails the owner.
- At most one relationship email a month per client, sent in business hours (truck's time zone).
- Every email has one-click unsubscribe; it's honored everywhere at once.
- Messages are queued and retried if email is down. Each send carries an idempotency key, so a restart
  mid-send can't deliver it twice.
- Links in emails are signed with a key from `LINK_SECRET` if set, otherwise one generated on first start
  and kept in the database. Changing it later makes older unsubscribe and feedback links stop working.
- Export: Clients → "Export all" downloads every client as a spreadsheet.

## Durability: when the signal, the server or a service drops

Nothing to install. New files: `limp.js`, `watch.js`, `public/limp.html`, `scripts/deploy.sh`,
`scripts/rollback.sh`, `scripts/load-test.js`, `test/order-path.test.js`, `RUNBOOK.md`.

**Limp mode (customers).** If the app can't be reached, the order page shows the truck's last saved
menu, spot and prices with "Order at the window", and switches back by itself. The app keeps one small
public file per truck in `limp/` (no private data). For first-time visitors, Caddy has to serve it while
the app is down. Add this inside the `https:// { ... }` block, under `reverse_proxy`:
```
    encode zstd gzip

    # Limp mode: when the app doesn't answer, Caddy serves the menu file and a plain page itself.
    handle_errors {
        @menu path /limp.json
        handle @menu {
            root * /var/www/foodtruck/limp
            rewrite * /{host}.json
            file_server
        }
        @asset path *.css *.js *.png *.svg *.woff2
        handle @asset {
            root * /var/www/foodtruck/public
            file_server
        }
        handle {
            root * /var/www/foodtruck/public
            rewrite * /limp.html
            file_server
        }
    }
```
`sudo systemctl reload caddy`. Test it: `pm2 stop foodtruck-backend`, open a truck page on your phone
(menu + "Order at the window"), `pm2 start foodtruck-backend`, and it turns back within 20 seconds.
`encode` also makes every page about four times smaller over the air.

**Kitchen with no signal.** Taps made with no signal are saved on the tablet, shown at once, and sent
in order (with the time they were really tapped) when signal returns. Reloading with no signal opens
the last ticket list. If something changed meanwhile (the customer canceled), the tablet says so.

**Email retries.** Email that can't go out (mail service down) is kept in the database and retried
for up to a day. Same idempotency key every try, so it never arrives twice. Alerts that are useless
late (the "no kitchen screen" email) are dropped instead of sent late.

**Prank protection.** One phone can have 3 unpaid orders waiting at once (a script that hides which
phone it is: 8 per network). Unpaid orders of $150 or more, or over 20 items, show "Big order, check
with the customer before cooking" in the kitchen; Mark Ready waits for that tap.

**Deploys with a spare tire.** From now on deploy with:
```
cd /var/www/foodtruck && scripts/deploy.sh main      # or the branch you approved
```
It saves the running code and a copy of the database, switches to the branch, runs the order-path
tests (its own copy of the app, empty database, no email), restarts without dropping requests, checks
`/api/health`, and puts the previous version back by itself if anything fails. By hand later:
`scripts/rollback.sh`. If you still copy files in by hand instead of using git, run
`scripts/deploy.sh` with no branch after copying; it skips the git step. One-time setup:
`chmod +x scripts/*.sh`, and `sudo apt install sqlite3` if it isn't there.

**Versioned database changes.** Each change to the tables is numbered in `core.js` (SCHEMA_CHANGES).
When newer code starts on an older database it saves a full copy to `backups/` first. The first start
of this version does that once.

**Load test before a big event.** `npm run load-test` (200 orders over 10 minutes on the server's own
copy of the app; real trucks and email are never touched). `node scripts/load-test.js --orders 300 --minutes 2`
for a harder run. It ends with a plain verdict.

**Certificate watch.** Once a day the app checks the certificates on the main site and the busiest
truck addresses, and emails `ADMIN_EMAIL` if any has under 14 days left. Set `ADMIN_EMAIL` in `.env`.

**Your steps (the app can't do these for you):**
1. **Uptime monitor:** a free UptimeRobot (or Better Stack) monitor on `https://onlinekitchen.fyi/api/health`,
   every 5 minutes, alerting your phone. It tells you before a truck notices.
2. **Litestream (continuous backup, seconds instead of a day):** make a bucket at Backblaze B2 (cheapest)
   with an application key. Then:
   ```
   wget https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.deb
   sudo dpkg -i litestream-v0.3.13-linux-amd64.deb
   sudo nano /etc/litestream.yml
   ```
   ```
   dbs:
     - path: /var/www/foodtruck/database.sqlite
       replicas:
         - type: s3
           bucket: YOUR-BUCKET
           path: foodtruck
           endpoint: https://s3.YOUR-REGION.backblazeb2.com
   ```
   Put the two keys in `/etc/default/litestream` (never in chat or email):
   `LITESTREAM_ACCESS_KEY_ID=...` and `LITESTREAM_SECRET_ACCESS_KEY=...`, then
   `sudo systemctl enable --now litestream`. Check with `litestream snapshots /var/www/foodtruck/database.sqlite`.
3. Read `RUNBOOK.md` once now, and fill in the three logins at the bottom on your own copy.

## The owner's day, the kitchen screen, group orders

Nothing to install and no new settings. New files: `daily.js`, `feedback.js`, `group.js`, `zip.js`, `public/day-core.js`.
The tables are added on start (database change 3, with a copy saved first).

- **Day summary:** one email a day (orders, top item, busiest and slowest hour, what customers said, what sold out,
  tomorrow's weather and prep nudges). Owners choose next morning, right after close, or off (Settings → Your day).
  The same summary is the card at the top of the kitchen screen in the morning.
- **Quiet hours:** from closing time (or a set hour) until morning, no email to the owner. Catering requests and the
  like wait until morning; "no kitchen screen is open" alerts are dropped at night.
- **Weather heads-up:** owners type a city or ZIP; forecasts come from Open-Meteo (free, no key). The server needs to
  reach `geocoding-api.open-meteo.com` and `api.open-meteo.com` over HTTPS (normal outbound internet).
- **Prep nudges:** the first time each item sells out each day is remembered; three of the last four same weekdays
  becomes "You sold out of birria by 1:10 PM the last three Fridays. Prep more, or set a limit?"
- **Private feedback:** after pickup customers can tap 👍 or 👎 (with an optional reason). Owners see patterns in
  Insights → What customers say. No names are kept with it.
- **Regulars:** the kitchen ticket shows "★ 4th visit · usually “no onions”" (matched by the phone, or the punch card).
- **Saved menus:** Inventory → Saved menus. Switch to the festival menu in one tap; the menu that was on is kept.
- **Export everything:** Insights → Export → "Download everything (.zip)".
- **Share today's spot:** Settings → Your Ordering Page → an Instagram-ready image of today's location and hours.
- **Learns the week:** Start service offers where the truck usually is on that weekday.
- **This screen (per PIN):** text size, rush view, glove mode (tap or swipe a ticket, 3 seconds to undo), station
  (show only the grill's items), a Bluetooth Ready button (any button that types a key), and a different sound for
  each kind of event. Saved to each crew member's PIN, so any tablet they sign in on is set up their way.
- **Group order:** "Ordering for a group? Send everyone a link" in the cart. Everyone adds their own items on their
  own phone; the host places one order with who-gets-what and everyone's allergies on the ticket.
- **Spanish menu:** item editor → "En español" for the owner's own Spanish name and description.
