/**
 * demo-shim.js — powers the no-signup demo at /demo/customer and /demo/owner.
 *
 * The server loads this file BEFORE the real customer.html / owner.html code. It replaces
 * window.fetch (for /api/... only) and window.EventSource with in-browser fakes backed by a
 * preset truck saved in localStorage. Nothing reaches the database, and both views share the
 * same data, so an order placed on the customer side shows up on the owner side (even in two
 * tabs side by side). Because the real pages are reused, the demo always matches the product.
 */
(function () {
    'use strict';
    window.__FT_DEMO = true; // tells the pages not to register the offline helper, etc.

    var KEY = 'ft_demo_v3';            // the demo truck's data
    var EVT = 'ft_demo_evt';           // cross-tab live events
    var SLUG = 'demo-truck';
    var MAX_ITEMS = 200;
    var isOwnerPage = /^\/demo\/owner/.test(location.pathname);

    /* ---------------- preset truck ---------------- */
    function seed() {
        var now = Date.now(), min = 60 * 1000;
        var menu = [
            { id: 1, category: 'Tacos & Mains', photo: '', name: 'Street Tacos (3)', desc: 'Corn tortillas, onion, cilantro, salsa verde.', price: 9, salePrice: null, prep: 4, meats: 'Asada, Pollo, Al Pastor, Veggie', premiumSurcharge: 0, options: [], soldOut: false },
            { id: 2, category: 'Tacos & Mains', photo: '', name: 'Loaded Quesadilla', desc: 'Flour tortilla, melted cheese, pico, crema.', price: 10.5, salePrice: null, prep: 6, meats: 'Pollo, Asada, Veggie', premiumSurcharge: 1, options: [], soldOut: false },
            { id: 3, category: 'Tacos & Mains', photo: '', name: 'Burrito Bowl', desc: 'Rice, beans, your choice of protein, all the toppings.', price: 12, salePrice: null, prep: 5, meats: 'Pollo, Asada, Veggie', premiumSurcharge: 1, options: [], soldOut: false },
            { id: 4, category: 'Sides', photo: '', name: 'Street Corn', desc: 'Grilled elote with cotija, chile and lime.', price: 5, salePrice: 4, prep: 3, meats: '', premiumSurcharge: 0, options: [], soldOut: false },
            { id: 5, category: 'Sides', photo: '', name: 'Chips & Salsa', desc: 'House-made chips with roasted salsa.', price: 3.5, salePrice: null, prep: 1, meats: '', premiumSurcharge: 0, options: [], soldOut: false },
            { id: 6, category: 'Drinks', photo: '', name: 'Agua Fresca', desc: '24 oz, made fresh daily.', price: 4, salePrice: null, prep: 1, meats: '', premiumSurcharge: 0, options: ['Horchata', 'Jamaica', 'Tamarindo'], soldOut: false }
        ];
        function order(id, ticket, name, items, status, agoMin, notes) {
            var total = items.reduce(function (s, i) { return s + i.price * i.qty; }, 0);
            return {
                id: id, ticket: ticket, token: 'demo-' + id, tag: 'demo-' + id, name: name, items: items,
                summary: items.map(function (i) { return i.qty + 'x ' + i.name; }).join(', '),
                notes: notes || '', total: Math.round(total * 100) / 100, status: status,
                createdAt: now - agoMin * min, updatedAt: now - Math.max(0, agoMin - 8) * min
            };
        }
        return {
            v: 2,
            vendor: { businessName: 'Taco Demo Truck', emoji: '🌮', ownerIG: '', ownerName: 'Demo Owner' },
            menu: menu,
            state: { status: 'open', rush: 0, location: 'Downtown Plaza — 5th & Main', paused: false },
            hours: [0, 1, 2, 3, 4, 5, 6].map(function (i) { return { closed: i === 0, open: i >= 5 ? '11:00' : '11:30', close: i >= 5 ? '21:00' : '14:30' }; }),
            timezone: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return 'America/Denver'; } })(),
            locations: [
                { id: 1, name: 'Downtown Plaza — 5th & Main', deleted: false },
                { id: 2, name: 'Brewery Row', deleted: false },
                { id: 3, name: 'Saturday Farmers Market', deleted: false }
            ],
            orders: [
                order(1, 101, 'Sam', [{ id: 3, name: 'Burrito Bowl (Asada)', qty: 1, price: 13 }, { id: 6, name: 'Agua Fresca (Horchata)', qty: 1, price: 4 }], 'Fulfilled', 95),
                order(2, 102, 'Priya', [{ id: 1, name: 'Street Tacos (3) (Al Pastor)', qty: 2, price: 9 }], 'Fulfilled', 70),
                order(3, 103, 'Jordan', [{ id: 2, name: 'Loaded Quesadilla (Pollo)', qty: 1, price: 10.5 }, { id: 5, name: 'Chips & Salsa', qty: 1, price: 3.5 }], 'Fulfilled', 40),
                order(4, 104, 'Maria', [{ id: 1, name: 'Street Tacos (3) (Asada)', qty: 1, price: 9 }, { id: 4, name: 'Street Corn', qty: 1, price: 4 }], 'Preparing', 3, 'Extra salsa please'),
                Object.assign(order(5, 105, 'Devon', [{ id: 2, name: 'Loaded Quesadilla (Pollo)', qty: 2, price: 11.5 }, { id: 1, name: 'Street Tacos (3) (Pollo)', qty: 1, price: 9 }], 'Preparing', 1), { allergy: 'peanuts', allergyAck: false })
            ],
            nextTicket: 106, nextOrderId: 6, nextLocId: 4
        };
    }

    var mem = null;
    function load() {
        var d = null;
        try { d = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
        if (!d || d.v !== 2) { d = mem || seed(); save(d); }
        return d;
    }
    function save(d) { mem = d; try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {} }
    function resetDemo() {
        try { localStorage.removeItem(KEY); localStorage.removeItem('ft_orders_' + SLUG); } catch (e) {}
        mem = null;
        location.reload();
    }

    /* ---------------- fake live stream ---------------- */
    var sources = [];
    function deliver(type, payload, staffOnly) {
        var msg = { data: JSON.stringify({ type: type, payload: payload }) };
        sources.slice().forEach(function (s) {
            if (staffOnly && !s._staff) return;
            if (s.readyState !== 2 && typeof s.onmessage === 'function') { try { s.onmessage(msg); } catch (e) { console.error(e); } }
        });
    }
    function emit(type, payload, staffOnly) {
        setTimeout(function () { deliver(type, payload, staffOnly); }, 0);
        // other tabs (e.g. customer and owner side by side) hear it through the storage event
        try { localStorage.setItem(EVT, JSON.stringify({ type: type, payload: payload, staffOnly: !!staffOnly, n: Math.random() })); } catch (e) {}
    }
    window.addEventListener('storage', function (e) {
        if (e.key !== EVT || !e.newValue) return;
        try { var m = JSON.parse(e.newValue); deliver(m.type, m.payload, m.staffOnly); } catch (er) {}
    });

    // Same rules as the server's honest wait: median order-to-ready of recent tickets (3+),
    // else the starting wait, never under the oldest open ticket's age, plus Busy; or the owner's lock.
    function demoWait(d) {
        var now = Date.now(), st = d.state;
        var since = Math.max(now - 3 * 60 * 60 * 1000, st.serviceStartedAt || 0);
        var xs = d.orders.filter(function (o) { return (o.status === 'Fulfilled' || o.status === 'Ready') && o.createdAt >= since; })
            .map(function (o) { return (o.readyAt || o.updatedAt) - o.createdAt; }).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
        var base = null, basis = null;
        if (xs.length >= 3) { var k = Math.floor(xs.length / 2); base = Math.ceil((xs.length % 2 ? xs[k] : (xs[k - 1] + xs[k]) / 2) / 60000); basis = 'pace'; }
        else if (st.waitStart) { base = st.waitStart; basis = 'start'; }
        var open = d.orders.filter(function (o) { return o.status === 'Preparing'; }).map(function (o) { return o.createdAt; });
        var q = open.length ? Math.round((now - Math.min.apply(null, open)) / 60000) : 0;
        if (q > (base || 0) && (base !== null || q >= 5)) { base = q; basis = 'queue'; }
        var sug = base === null ? null : Math.min(90, Math.max(1, base + (st.rush || 0)));
        return { minutes: st.waitLock || sug, mode: st.waitLock ? 'locked' : 'auto', basis: basis, samples: xs.length, suggested: sug, start: st.waitStart || null };
    }
    /* ---------- Insights: a believable, repeatable sales history ----------
       Weekday lunch downtown, Friday evenings at the brewery, Saturday mornings at the market.
       Seeded, so every visitor sees the same numbers, and the same math as the real server (insights-core.js). */
    var demoHistory = null;
    function seeded(n) { var x = Math.sin(n * 9301 + 49297) * 233280; return x - Math.floor(x); }
    function history(d) {
        var IC = window.InsightsCore;
        if (!IC) return [];
        if (!demoHistory) {
            var tz = d.timezone, rows = [], today = IC.parts(Date.now(), tz);
            var plan = { 1: ['Downtown Plaza — 5th & Main', 11, 14, 9], 2: ['Downtown Plaza — 5th & Main', 11, 14, 8], 3: ['Downtown Plaza — 5th & Main', 11, 14, 10],
                4: ['Downtown Plaza — 5th & Main', 11, 14, 11], 5: ['Brewery Row', 16, 21, 9], 6: ['Saturday Farmers Market', 9, 13, 16] };
            var shape = function (h, a, b) { var mid = (a + b) / 2; return Math.max(0.25, 1 - Math.abs(h + 0.5 - mid) / ((b - a) / 1.6)); };
            var menu = d.menu, k = 0;
            for (var back = 120; back >= 1; back--) {
                var day = new Date(Date.UTC(today.y, today.m - 1, today.d - back)), wd = day.getUTCDay(), pl = plan[wd];
                if (!pl || back % 23 === 0) continue; // the odd day off
                var start = IC.zonedStart(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), tz);
                var trend = 0.8 + (120 - back) / 300; // business growing
                for (var h = pl[1]; h < pl[2]; h++) {
                    var n = Math.round(pl[3] * shape(h, pl[1], pl[2]) * trend * (0.7 + seeded(back * 31 + h) * 0.6));
                    for (var j = 0; j < n; j++) {
                        k++;
                        var items = [], c = 0, lines = 1 + Math.floor(seeded(k * 7) * 2.4);
                        for (var q = 0; q < lines; q++) {
                            var it = menu[Math.floor(seeded(k * 13 + q) * menu.length)];
                            if (!it) continue;
                            var price = it.salePrice > 0 ? it.salePrice : it.price, qty = seeded(k * 17 + q) < 0.2 ? 2 : 1;
                            items.push({ name: it.name, qty: qty, price: price }); c += Math.round(price * 100) * qty;
                        }
                        rows.push({ t: start + h * 3600000 + Math.floor(seeded(k * 3) * 3600000), cents: c, items: items, loc: pl[0] });
                    }
                }
            }
            demoHistory = rows;
        }
        var live = d.orders.filter(function (o) { return o.status === 'Fulfilled' || o.status === 'Ready'; }).map(function (o) {
            return { t: o.createdAt, cents: Math.round(o.total * 100), items: o.items, loc: o.location || d.state.location || '' };
        });
        return demoHistory.concat(live);
    }

    /* ---------- punch card (same rules as rewards.js; a new demo card starts with 3 stamps so the reward is reachable) ---------- */
    function rw(d) { if (!d.rewards) d.rewards = { on: true, name: 'Punch card', every: 5, minCents: 500, capCents: 1200 }; if (!d.cards) d.cards = {}; return d.rewards; }
    function cardOut(d, tok) {
        var s = rw(d), c = d.cards[tok];
        return { on: !!s.on, name: s.name, every: s.every, minCents: s.minCents, capCents: s.capCents, stamps: c ? c.stamps : 0, ready: !!c && c.stamps >= s.every, used: c ? c.used : 0, known: !!c, canSave: true };
    }
    function stampDemo(d, o) {
        var s = rw(d);
        if (!s.on || !o.cardToken || o.stamped || !d.cards[o.cardToken] || (o.total * 100 + (o.rewardCents || 0)) < s.minCents) return;
        o.stamped = true; d.cards[o.cardToken].stamps++;
    }
    function undoDemo(d, o) {
        var c = o.cardToken && d.cards[o.cardToken];
        if (!c) return;
        if (o.rewardCents && !o.rewardReturned) { o.rewardReturned = true; c.stamps += o.rewardEvery || 0; c.used = Math.max(0, c.used - 1); }
        if (o.stamped) { o.stamped = false; c.stamps = Math.max(0, c.stamps - 1); }
    }

    function stateOut(d) { return Object.assign({}, d.state, { wait: demoWait(d) }); }
    function emitWait(d) { emit('WAIT', demoWait(d)); }

    function FakeEventSource(url) {
        var self = this;
        this.url = url; this.readyState = 0; this._staff = isOwnerPage;
        this.onopen = null; this.onmessage = null; this.onerror = null;
        sources.push(this);
        setTimeout(function () {
            if (self.readyState === 2) return;
            self.readyState = 1;
            if (typeof self.onopen === 'function') self.onopen({});
            var st = stateOut(load());
            if (typeof self.onmessage === 'function') self.onmessage({ data: JSON.stringify({ type: 'STATE', payload: st }) });
        }, 30);
    }
    FakeEventSource.prototype.close = function () {
        this.readyState = 2;
        var me = this; sources = sources.filter(function (s) { return s !== me; });
    };
    FakeEventSource.prototype.addEventListener = function () {};
    FakeEventSource.prototype.removeEventListener = function () {};
    window.EventSource = FakeEventSource;

    /* ---------------- fake API ---------------- */
    function ok(body, status) { return { status: status || 200, body: body }; }
    function fail(status, msg, extra) { var b = { error: msg }; if (extra) for (var k in extra) b[k] = extra[k]; return { status: status, body: b }; }
    var DEMO_OFF = 'This is turned off in the demo. Create a free page to use it.';
    var round = function (n) { return Math.round(n * 100) / 100; };

    /* ---------- inventory: the same rules as inventory.js ---------- */
    var LOW = 5;
    function demoInv(d) {
        if (!d.stock) {
            d.stock = { 4: 6 }; d.out = [];
            var tags = { 1: ['tortillas', 'cilantro', 'onion'], 2: ['tortillas', 'cheese'], 3: ['rice', 'beans'], 4: ['corn', 'cotija'], 5: ['tortillas'] };
            d.menu.forEach(function (m) { if (!m.ingredients) m.ingredients = tags[m.id] || []; });
        }
    }
    function menuFor(d, owner) {
        demoInv(d);
        var out = d.out.map(function (x) { return x.toLowerCase(); });
        return d.menu.map(function (m) {
            var left = m.id in d.stock ? d.stock[m.id] : null;
            var missing = (m.ingredients || []).filter(function (i) { return out.indexOf(i.toLowerCase()) >= 0; })[0];
            var reason = m.soldOut ? 'manual' : left !== null && left <= 0 ? 'stock' : missing ? 'ingredient' : null;
            var it = Object.assign({}, m, { soldOut: !!reason, outReason: reason });
            if (owner) { it.left = left; it.manualSoldOut = !!m.soldOut; it.missing = missing || null; }
            else { it.left = left !== null && left <= LOW ? Math.max(0, left) : null; delete it.ingredients; }
            return it;
        });
    }
    function announceStock(d, ids) {
        var om = menuFor(d, true);
        ids.forEach(function (id) { var m = om.filter(function (x) { return x.id === +id; })[0]; if (m) emit('SOLD_OUT', { itemId: m.id, soldOut: m.soldOut, left: m.left !== null && m.left <= LOW ? m.left : null }); });
    }
    function restoreStock(d, o) {
        if (!o.stockTaken || o.stockReturned) return;
        o.stockReturned = true;
        Object.keys(o.stockTaken).forEach(function (k) { if (k in d.stock) d.stock[k] += o.stockTaken[k]; });
        announceStock(d, Object.keys(o.stockTaken));
    }

    function cleanItem(b, id, prev) {
        prev = prev || {};
        var price = parseFloat(b.price), sale = parseFloat(b.salePrice), prep = parseInt(b.prep, 10), up = parseFloat(b.premiumSurcharge);
        return {
            id: id,
            name: String(b.name != null ? b.name : prev.name || 'Item').trim().slice(0, 80) || 'Item',
            desc: String(b.desc != null ? b.desc : prev.desc || '').trim().slice(0, 300),
            price: isFinite(price) ? round(Math.max(0, Math.min(10000, price))) : (prev.price || 0),
            salePrice: isFinite(sale) && sale > 0 ? round(sale) : null,
            prep: isFinite(prep) ? Math.max(1, Math.min(120, prep)) : (prev.prep || 3),
            meats: String(b.meats != null ? b.meats : prev.meats || '').trim().slice(0, 200),
            premiumSurcharge: isFinite(up) ? round(Math.max(0, up)) : (prev.premiumSurcharge || 0),
            options: b.options != null ? (Array.isArray(b.options) ? b.options : String(b.options).split(',')).map(function (o) { return String(o).trim().slice(0, 60); }).filter(Boolean).slice(0, 20) : (prev.options || []),
            category: String(b.category != null ? b.category : prev.category || '').trim().slice(0, 40),
            ingredients: b.ingredients != null ? (Array.isArray(b.ingredients) ? b.ingredients : String(b.ingredients).split(',')).map(function (o) { return String(o).trim().slice(0, 30); }).filter(Boolean).slice(0, 12) : (prev.ingredients || []),
            photo: b.photo != null ? String(b.photo) : (prev.photo || ''),
            soldOut: !!prev.soldOut
        };
    }

    function vendorPublic(d) {
        return {
            isDemo: false, businessName: d.vendor.businessName, slug: SLUG, customDomain: null,
            ownerIG: d.vendor.ownerIG, emoji: d.vendor.emoji, menu: menuFor(d, false), state: stateOut(d),
            showBranding: true, pinOnly: false, hours: d.hours, timezone: d.timezone, payMode: 'window', smsReady: false,
            deals: (d.deals || []).filter(function (x) { return x.on; }),
            rewards: rw(d).on ? { name: rw(d).name, every: rw(d).every, capCents: rw(d).capCents, minCents: rw(d).minCents } : null,
            nextStop: (function () { var u = demoStops(d)[0]; return u ? { day: u.day, start: u.start, end: u.end, location: u.location, startsAt: u.startsAt, endsAt: u.endsAt } : null; })()
        };
    }

    /* ---------- schedule: the same weekly route as the sales history, two weeks out ---------- */
    function demoStops(d) {
        var IC = window.InsightsCore;
        if (!IC) return [];
        var tz = d.timezone, today = IC.parts(Date.now(), tz);
        if (!d.schedule) {
            var plan = { 1: ['Downtown Plaza — 5th & Main', '11:00', '14:00', '500 S 5th St'], 2: ['Downtown Plaza — 5th & Main', '11:00', '14:00', '500 S 5th St'], 3: ['Downtown Plaza — 5th & Main', '11:00', '14:00', '500 S 5th St'],
                4: ['Downtown Plaza — 5th & Main', '11:00', '14:00', '500 S 5th St'], 5: ['Brewery Row', '16:00', '21:00', ''], 6: ['Saturday Farmers Market', '09:00', '13:00', ''] };
            d.schedule = []; d.nextStopId = 1;
            for (var i = 0; i < 14; i++) {
                var t = new Date(Date.UTC(today.y, today.m - 1, today.d + i)), p = plan[t.getUTCDay()];
                if (p) d.schedule.push({ id: d.nextStopId++, day: t.toISOString().slice(0, 10), start: p[1], end: p[2], location: p[0], address: p[3], note: '', series: 'demo' });
            }
            save(d);
        }
        var key = IC.dateKey(today), now = Date.now();
        return d.schedule.filter(function (s) { return s.day >= key; }).map(function (s) {
            var a = s.day.split('-').map(Number), hs = s.start.split(':').map(Number), he = s.end.split(':').map(Number);
            var st = IC.zonedTime(a[0], a[1], a[2], hs[0], hs[1], tz), en = IC.zonedTime(a[0], a[1], a[2] + (s.end <= s.start ? 1 : 0), he[0], he[1], tz);
            var lbl = function (x) { var h = +x.split(':')[0], m = +x.split(':')[1]; return (h % 12 || 12) + (m ? ':' + (m < 10 ? '0' : '') + m : '') + (h < 12 ? ' AM' : ' PM'); };
            return Object.assign({}, s, { startsAt: st, endsAt: en, label: lbl(s.start) + ' – ' + lbl(s.end), dayLabel: new Date(Date.UTC(a[0], a[1] - 1, a[2])).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }) });
        }).filter(function (s) { return s.endsAt > now; }).sort(function (x, y) { return x.startsAt - y.startsAt; });
    }
    function me(d) {
        return {
            role: 'owner',
            vendor: {
                businessName: d.vendor.businessName, slug: SLUG, ownerName: d.vendor.ownerName, ownerIG: d.vendor.ownerIG,
                emoji: d.vendor.emoji, email: 'demo@example.com', plan: 'free', planStatus: 'active',
                features: { label: 'Free', customDomain: false, sms: false, removeBranding: false, onlinePayments: false },
                hasPassword: true
            }
        };
    }

    function placeOrder(d, b) {
        if (d.state.status === 'closed') return fail(403, 'Sorry, we are closed right now.');
        var lines = Array.isArray(b.items) ? b.items.slice(0, 30) : [];
        if (!lines.length) return fail(400, 'Your cart is empty.');
        var items = [], total = 0, prep = 0;
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            var item = menuFor(d, true).filter(function (m) { return m.id === parseInt(l.id, 10); })[0];
            var qty = parseInt(l.qty, 10);
            if (!item) return fail(400, 'An item in your cart is no longer on the menu.');
            if (item.soldOut) return fail(409, item.name + ' is sold out.');
            var wantQ = (b.items || []).reduce(function (n, x) { return n + (parseInt(x && x.id, 10) === item.id ? parseInt(x.qty, 10) || 0 : 0); }, 0);
            if (item.left !== null && wantQ > item.left) return fail(409, 'Only ' + item.left + ' ' + item.name + ' left. Please lower the amount.', { stock: { itemId: item.id, left: item.left } });
            if (!(qty >= 1 && qty <= 50)) return fail(400, 'Invalid quantity.');
            var label = item.name, extra = 0;
            if (item.meats) {
                var choices = item.meats.split(',').map(function (m) { return m.trim(); }).filter(Boolean);
                var idx = l.meat ? choices.indexOf(String(l.meat)) : 0;
                if (idx < 0) return fail(400, 'Invalid option selected.');
                if (idx > 0) extra = item.premiumSurcharge || 0;
                if (choices[idx]) label += ' (' + choices[idx] + ')';
            }
            var reg = Math.round((item.price + extra) * 100), sale = item.salePrice > 0 ? Math.round((item.salePrice + extra) * 100) : null;
            var pr = window.DealsCore && window.InsightsCore ? DealsCore.price(item, reg, sale, DealsCore.active(d.deals || [], InsightsCore.parts(Date.now(), d.timezone))) : { cents: sale !== null ? sale : reg };
            var unit = pr.cents / 100;
            if (item.options && item.options.length && l.option) label += ' (' + l.option + ')';
            unit = round(unit);
            items.push({ id: item.id, name: label, qty: qty, price: unit });
            total += unit * qty; prep += item.prep * qty;
        }
        var s = rw(d), tok = String(b.cardToken || ''), card = s.on && d.cards[tok], rewardCents = 0;
        if (b.useReward === true && s.on) {
            if (!card || card.stamps < s.every) return fail(409, 'Your free item isn’t ready yet.', { rewardGone: true });
            var bi = 0; items.forEach(function (it, k) { if (it.price > items[bi].price) bi = k; });
            var uc = Math.round(items[bi].price * 100); rewardCents = Math.min(uc, s.capCents);
            var ln = items[bi], free = { id: ln.id, name: ln.name + ' (' + s.name + ' reward)', qty: 1, price: (uc - rewardCents) / 100, reward: true };
            if (ln.qty > 1) { ln.qty -= 1; items.splice(bi + 1, 0, free); } else items[bi] = free;
            total = items.reduce(function (sum, it) { return sum + it.price * it.qty; }, 0);
        }
        if (Number.isFinite(Number(b.seenTotal)) && round(total) > Number(b.seenTotal) + 0.004) { if (rewardCents) return fail(409, 'Prices changed while you were ordering.', { priceChanged: true, total: round(total) }); return fail(409, 'Prices changed while you were ordering. Your total is now $' + round(total).toFixed(2) + '.', { priceChanged: true, total: round(total) }); }
        var newTok = null;
        if (s.on && !card) { newTok = 'demo' + Math.random().toString(36).slice(2) + Date.now().toString(36); card = d.cards[newTok] = { stamps: 3, used: 0 }; tok = newTok; }
        if (rewardCents) { card.stamps -= s.every; card.used++; }
        var stockTaken = {};
        items.forEach(function (it) { if (it.id in d.stock) { d.stock[it.id] -= it.qty; stockTaken[it.id] = (stockTaken[it.id] || 0) + it.qty; } });
        var now = Date.now(), id = d.nextOrderId++, ticket = d.nextTicket++;
        var o = {
            id: id, ticket: ticket, token: 'demo-' + id + '-' + Math.random().toString(36).slice(2, 8), name: String(b.customerName || '').trim().slice(0, 40) || 'Guest',
            items: items, summary: items.map(function (x) { return x.qty + 'x ' + x.name; }).join(', '),
            notes: String(b.notes || '').trim().slice(0, 300), total: round(total), status: 'Preparing', createdAt: now, updatedAt: now,
            allergy: String(b.allergy || '').trim().slice(0, 120), allergyAck: false, location: d.state.location || '',
            cardToken: s.on ? tok : null, rewardCents: rewardCents, rewardEvery: rewardCents ? s.every : null,
            stockTaken: Object.keys(stockTaken).length ? stockTaken : null
        };
        if (o.stockTaken) setTimeout(function () { announceStock(d, Object.keys(stockTaken)); }, 0);
        o.tag = o.token;
        d.orders.push(o); save(d);
        emit('ORDER_NEW', o, true); emitWait(d);
        var w = demoWait(d).minutes;
        return ok({ ticket: o.ticket, token: o.token, tag: o.tag, status: o.status, total: o.total, estimatedMinutes: w ? Math.max(w, Math.min(prep, 90)) : prep + (d.state.rush || 0), changeUntil: now + 120000, now: now, rewardCents: rewardCents, cardToken: newTok || undefined }, 201);
    }

    function handle(method, u, b) {
        var p = u.pathname, d = load(), m, id, loc;
        method = String(method || 'GET').toUpperCase();

        /* public */
        if (p === '/api/plans') return ok({ plans: {}, maxItems: MAX_ITEMS, pro: { price: '$34.99/mo' } });
        if (p === '/api/vendor-data') return ok(vendorPublic(d));
        if (p === '/api/orders' && method === 'POST') { if (d.state.paused) return fail(403, 'Online ordering is paused right now. Please order at the window.'); return placeOrder(d, b); }
        if (p === '/api/orders/track') {
            var toks = String(u.searchParams.get('tokens') || '').split(',');
            return ok({ now: Date.now(), orders: d.orders.filter(function (o) { return toks.indexOf(o.token) >= 0; }).map(function (o) { return { ticket: o.ticket, token: o.token, name: o.name, status: o.status, changeUntil: o.status === 'Preparing' ? o.createdAt + 120000 : 0 }; }) });
        }
        if ((m = p.match(/^\/api\/orders\/([^/]+)\/cancel$/)) && method === 'POST') {
            var oc = d.orders.filter(function (x) { return x.token === decodeURIComponent(m[1]); })[0];
            if (!oc) return fail(404, 'Order not found.');
            if (oc.status === 'Canceled') return ok({ status: 'Canceled' });
            if (oc.status !== 'Preparing') return fail(409, 'Your order is already made.');
            if (Date.now() - oc.createdAt > 120000) return fail(409, 'The kitchen has started on it. Please ask at the window.');
            oc.status = 'Canceled'; oc.updatedAt = Date.now(); undoDemo(d, oc); restoreStock(d, oc); save(d);
            emit('ORDER_UPDATE', Object.assign({}, oc, { byCustomer: true }), true);
            emit('ORDER_STATUS', { tag: oc.tag, status: 'Canceled' }); emitWait(d);
            return ok({ status: 'Canceled' });
        }

        /* auth: the demo visitor is always the owner */
        if (p === '/api/auth/me') return ok(me(d));
        if (p === '/api/auth/login' || p === '/api/auth/staff') return ok({ ok: true, role: 'owner' });
        if (p === '/api/auth/logout') { setTimeout(function () { location.href = '/demo/customer'; }, 50); return ok({ ok: true }); }
        if (p === '/api/auth/forgot') return ok({ ok: true });

        /* orders */
        if (p === '/api/owner/orders' && method === 'GET') {
            var f = u.searchParams.get('status') || 'Active', list;
            if (f === 'Fulfilled' || f === 'Canceled') list = d.orders.filter(function (o) { return o.status === f; }).sort(function (a, c) { return c.updatedAt - a.updatedAt; });
            else list = d.orders.filter(function (o) { return o.status === 'Preparing' || o.status === 'Ready'; }).sort(function (a, c) { return a.createdAt - c.createdAt; });
            return ok({ orders: list, now: Date.now() });
        }
        if (p === '/api/owner/orders' && method === 'DELETE') {
            d.orders = d.orders.filter(function (o) { return o.status === 'Preparing' || o.status === 'Ready'; }); save(d);
            return ok({ ok: true });
        }
        if ((m = p.match(/^\/api\/owner\/orders\/(\d+)$/)) && method === 'PATCH' && b.action === 'ack-allergy') {
            var oa = d.orders.filter(function (x) { return x.id === parseInt(m[1], 10); })[0];
            if (!oa || !oa.allergy || oa.allergyAck) return fail(409, 'That allergy was already confirmed.');
            oa.allergyAck = true; oa.updatedAt = Date.now(); save(d); emit('ORDER_UPDATE', oa, true);
            return ok({ order: oa });
        }
        if ((m = p.match(/^\/api\/owner\/orders\/(\d+)$/)) && method === 'PATCH') {
            var next = { ready: 'Ready', fulfill: 'Fulfilled', cancel: 'Canceled' }[b.action];
            if (!next) return fail(400, 'Unknown action.');
            var o = d.orders.filter(function (x) { return x.id === parseInt(m[1], 10); })[0];
            var from = b.action === 'ready' ? ['Preparing'] : ['Preparing', 'Ready'];
            if (!o || from.indexOf(o.status) < 0) return fail(409, 'That order cannot be changed.');
            if (b.action !== 'cancel' && o.allergy && !o.allergyAck) return fail(409, 'Confirm the allergy on this ticket first.');
            o.status = next; o.updatedAt = Date.now(); if (next === 'Ready') o.readyAt = o.updatedAt;
            if (next === 'Canceled') { undoDemo(d, o); restoreStock(d, o); } else stampDemo(d, o);
            save(d);
            emit('ORDER_UPDATE', o, true);
            emit('ORDER_STATUS', { tag: o.tag, status: o.status }); emitWait(d);
            return ok({ order: o });
        }

        /* crew */
        if (!d.crew) { d.crew = [{ id: 1, name: 'Maria', createdAt: Date.now() - 40 * 864e5, lastLoginAt: Date.now() - 3600e3 }, { id: 2, name: 'Jo', createdAt: Date.now() - 12 * 864e5, lastLoginAt: Date.now() - 2 * 864e5 }]; d.crewPins = { 1: '2580', 2: '1470' }; d.sharedPin = true; }
        var crewOut = function () { return { crew: d.crew.map(function (m) { return Object.assign({ screens: m.id === 1 ? 1 : 0 }, m); }).sort(function (a, c) { return a.name.localeCompare(c.name); }), sharedPin: !!d.sharedPin, sharedScreens: 0, max: 30 }; };
        var pinTaken = function (pin, except) { return Object.keys(d.crewPins).some(function (k) { return +k !== except && d.crewPins[k] === pin; }); };
        if (p === '/api/owner/crew' && method === 'GET') return ok(crewOut());
        if (p === '/api/owner/crew' && method === 'POST') {
            var nm = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 30), pn = String(b.pin || '').trim();
            if (!nm) return fail(400, 'Add their name.');
            if (!/^[0-9]{4,8}$/.test(pn)) return fail(400, 'A crew PIN is 4 to 8 numbers.');
            if (pinTaken(pn)) return fail(400, 'Someone on your crew already has that PIN. Pick another.');
            var nid = d.crew.reduce(function (mx, m) { return Math.max(mx, m.id); }, 0) + 1;
            d.crew.push({ id: nid, name: nm, createdAt: Date.now(), lastLoginAt: null }); d.crewPins[nid] = pn; save(d);
            return ok(crewOut(), 201);
        }
        if ((m = p.match(/^\/api\/owner\/crew\/(\d+)$/))) {
            var cid = +m[1], cm = d.crew.filter(function (x) { return x.id === cid; })[0];
            if (!cm) return fail(404, 'That person is gone.');
            if (method === 'DELETE') { d.crew = d.crew.filter(function (x) { return x.id !== cid; }); delete d.crewPins[cid]; save(d); return ok(crewOut()); }
            if (method === 'PUT') {
                if (b.pin !== undefined) { var np = String(b.pin || '').trim(); if (!/^[0-9]{4,8}$/.test(np)) return fail(400, 'A crew PIN is 4 to 8 numbers.'); if (pinTaken(np, cid)) return fail(400, 'Someone on your crew already has that PIN. Pick another.'); d.crewPins[cid] = np; }
                if (b.name !== undefined) cm.name = String(b.name).trim().slice(0, 30) || cm.name;
                save(d); return ok(crewOut());
            }
        }
        if (p === '/api/owner/staff-pin' && method === 'DELETE') { d.sharedPin = false; save(d); return ok({ ok: true }); }
        if (p === '/api/owner/staff-pin' && method === 'PUT') { if (!/^[A-Za-z0-9]{4,8}$/.test(String(b.pin || ''))) return fail(400, 'PIN must be 4-8 letters or numbers.'); d.sharedPin = true; save(d); return ok({ ok: true }); }

        /* punch card */
        if (p === '/api/rewards' && method === 'GET') { var st0 = rw(d); return ok(st0.on ? cardOut(d, u.searchParams.get('card') || '') : { on: false }); }
        if (p === '/api/rewards/save' && method === 'POST') return ok({ ok: true, message: 'In the demo, no email is sent. On your page, this emails a link that keeps the card on any phone.' });
        if (p === '/api/rewards/owner' && method === 'GET') {
            var cs = Object.keys(rw(d) && d.cards).map(function (k) { return d.cards[k]; });
            return ok({ settings: rw(d), allowed: true, stats: { cards: 41 + cs.length, active: 33, rewardsUsed: 9 + cs.reduce(function (a, c) { return a + c.used; }, 0), stampsGiven: 186 + d.orders.filter(function (o) { return o.stamped; }).length } });
        }
        if (p === '/api/rewards/owner' && method === 'PUT') {
            var cur = rw(d), cl = function (v, lo, hi, df) { var n = Math.round(Number(v)); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : df; };
            d.rewards = { on: b.on === true, name: cur.name, every: cl(b.every, 3, 20, 8), minCents: cl(b.minCents, 0, 10000, 500), capCents: cl(b.capCents, 100, 10000, 1200) };
            save(d); emit('REWARDS_UPDATE', d.rewards.on ? d.rewards : { on: false });
            return ok({ settings: d.rewards });
        }

        /* deals */
        if (p === '/api/owner/deals' && method === 'GET') {
            var DC = window.DealsCore, IC1 = window.InsightsCore, dl = DC ? DC.normalize(d.deals || []) : [];
            return ok({ deals: dl, allowed: true, max: 6, runningNow: DC && IC1 ? DC.active(dl, IC1.parts(Date.now(), d.timezone)).map(function (x) { return x.id; }) : [] });
        }
        if (p === '/api/owner/deals' && method === 'PUT') {
            var DC2 = window.DealsCore, IC2 = window.InsightsCore;
            if (!DC2) return fail(503, 'Loading…');
            var nd = DC2.normalize(b.deals || []);
            for (var di = 0; di < nd.length; di++) {
                var x = nd[di];
                if (x.on && !x.days.length) return fail(400, 'Pick at least one day for “' + x.name + '”.');
                if (x.start === x.end) return fail(400, '“' + x.name + '” needs an end time different from its start.');
                if (x.on && x.scope !== 'all' && !(x.scope === 'categories' ? x.categories.length : x.items.length)) return fail(400, 'Pick what “' + x.name + '” applies to.');
            }
            d.deals = nd; save(d);
            emit('DEALS_UPDATE', { deals: nd.filter(function (x) { return x.on; }) });
            return ok({ deals: nd, runningNow: IC2 ? DC2.active(nd, IC2.parts(Date.now(), d.timezone)).map(function (x) { return x.id; }) : [] });
        }

        /* schedule */
        if (p === '/api/schedule' && method === 'GET') return ok({ stops: demoStops(d), timezone: d.timezone, followEnabled: true, locations: d.locations.map(function (l) { return l.name; }) });
        if (p === '/api/schedule/follow' && method === 'POST') return ok({ ok: true, message: 'Check your email and tap the link to confirm.' });
        if (p === '/api/schedule/owner/stops' && method === 'GET') { var IC0 = window.InsightsCore; return ok({ stops: demoStops(d), timezone: d.timezone, today: IC0 ? IC0.dateKey(IC0.parts(Date.now(), d.timezone)) : '' }); }
        if (p === '/api/schedule/owner/stops' && method === 'POST') {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(b.day || '')) return fail(400, 'Pick a date.');
            if (!b.start || !b.end) return fail(400, 'Set a start and end time.');
            if (b.start === b.end) return fail(400, 'The end time has to be different from the start.');
            if (!String(b.location || '').trim()) return fail(400, 'Where will you be?');
            demoStops(d);
            var weeks = Math.max(0, Math.min(12, parseInt(b.repeatWeeks, 10) || 0)), series = weeks ? 's' + Date.now() : null;
            for (var w = 0; w <= weeks; w++) {
                var a0 = b.day.split('-').map(Number), dd = new Date(Date.UTC(a0[0], a0[1] - 1, a0[2] + 7 * w));
                d.schedule.push({ id: d.nextStopId++, day: dd.toISOString().slice(0, 10), start: b.start, end: b.end, location: String(b.location).trim(), address: b.address || '', note: b.note || '', series: series });
            }
            save(d);
            return ok({ added: weeks + 1, stops: demoStops(d) }, 201);
        }
        if ((m = p.match(/^\/api\/schedule\/owner\/stops\/(\d+)$/)) && method === 'DELETE') {
            demoStops(d);
            var sx = d.schedule.filter(function (x) { return x.id === +m[1]; })[0];
            if (!sx) return fail(404, 'That stop is gone.');
            var before = d.schedule.length;
            d.schedule = d.schedule.filter(function (x) { return !(x.id === sx.id || (u.searchParams.get('following') === '1' && sx.series && x.series === sx.series && x.day >= sx.day)); });
            save(d);
            return ok({ removed: before - d.schedule.length, stops: demoStops(d) });
        }
        if (p === '/api/schedule/owner/followers') return ok({ count: 23, everywhere: 14, byLocation: { 'Brewery Row': 6, 'Saturday Farmers Market': 5 }, mailReady: true, openNextAt: d.followOpenAt ? d.followOpenAt + 6 * 3600000 : 0, weekNextAt: d.followWeekAt ? d.followWeekAt + 3 * 86400000 : 0 });
        if (p === '/api/schedule/owner/notify' && method === 'POST') {
            if (b.kind === 'open') { d.followOpenAt = Date.now(); save(d); return ok({ sent: 14 + (d.state.location === 'Brewery Row' ? 6 : 0) }); }
            if (b.kind === 'week') { if (d.followWeekAt && Date.now() - d.followWeekAt < 3 * 86400000) return fail(429, 'You sent your schedule less than 3 days ago.'); d.followWeekAt = Date.now(); save(d); return ok({ sent: 23 }); }
            return fail(400, 'Unknown message.');
        }

        /* insights (same math as the server) */
        if (p === '/api/owner/insights' || p === '/api/owner/insights/locations') {
            var IC = window.InsightsCore;
            if (!IC) return fail(503, 'Loading…');
            var rowsAll = history(d), tz = d.timezone;
            var inRange = function (a, z, loc) { return rowsAll.filter(function (r) { return r.t >= a && r.t < z && (loc === undefined || r.loc === loc); }); };
            if (p === '/api/owner/insights/locations') {
                var days = [30, 90, 365].indexOf(+u.searchParams.get('days')) >= 0 ? +u.searchParams.get('days') : 90;
                return ok({ days: days, timezone: tz, locations: IC.compareLocations(inRange(Date.now() - days * IC.DAY, Date.now() + 1), tz) });
            }
            var range = u.searchParams.get('range') || 'day', per = IC.period(range, u.searchParams.get('anchor') || '', tz);
            var lq = u.searchParams.get('location'), lsel = lq === null || lq === '*' ? undefined : lq;
            var out = IC.summarize(inRange(per.from, per.to, lsel), inRange(per.prevFrom, per.prevTo, lsel), per, tz);
            var seen = {}; rowsAll.forEach(function (r) { seen[r.loc] = 1; });
            return ok(Object.assign(out, { timezone: tz, allLocations: Object.keys(seen) }));
        }

        /* state */
        if (p === '/api/owner/state' && method === 'GET') return ok(Object.assign(stateOut(d), { crewNote: d.crewNote || '', crewNoteAt: d.crewNoteAt || 0 }));
        if (p === '/api/owner/crew-note' && method === 'PUT') {
            d.crewNote = String(b.note || '').trim().slice(0, 240); d.crewNoteAt = d.crewNote ? Date.now() : 0; save(d);
            emit('CREW_NOTE', { note: d.crewNote, at: d.crewNoteAt }, true);
            return ok({ note: d.crewNote, at: d.crewNoteAt });
        }
        if (p === '/api/owner/state' && method === 'PUT') {
            if (b.status !== undefined) {
                if (['open', 'closed'].indexOf(b.status) < 0) return fail(400, 'Invalid status.');
                if (b.status === 'open' && d.state.status !== 'open') { d.state.serviceStartedAt = Date.now(); d.state.waitLock = null; }
                d.state.status = b.status; emit('STORE_STATUS', { status: b.status });
            }
            var wn = function (x) { var n = parseInt(x, 10); return n >= 1 && n <= 90 ? n : NaN; };
            if (b.waitStart !== undefined) { var ws = b.waitStart === null ? null : wn(b.waitStart); if (ws !== ws) return fail(400, 'Starting wait must be 1 to 90 minutes.'); d.state.waitStart = ws; }
            if (b.waitLock !== undefined) { var wl = b.waitLock === null ? null : wn(b.waitLock); if (wl !== wl) return fail(400, 'Wait must be 1 to 90 minutes.'); d.state.waitLock = wl; }
            if (b.rush !== undefined) {
                var r = parseInt(b.rush, 10);
                if ([0, 15, 30].indexOf(r) < 0) return fail(400, 'Invalid rush value.');
                d.state.rush = r; emit('RUSH_MODE', { minutes: r });
            }
            if (b.location !== undefined) { d.state.location = String(b.location || ''); emit('LOCATION_UPDATE', { location: d.state.location }); }
            if (b.paused !== undefined) { d.state.paused = !!b.paused; emit('PAUSED', { paused: d.state.paused }); }
            save(d); emitWait(d);
            return ok(stateOut(d));
        }

        /* menu */
        if (p === '/api/owner/menu' && method === 'GET') return ok({ menu: menuFor(d, true), maxItems: MAX_ITEMS, out: (demoInv(d), d.out) });
        if ((m = p.match(/^\/api\/owner\/stock\/(\d+)$/)) && method === 'PUT') {
            demoInv(d); var sid = +m[1];
            if (!d.menu.some(function (x) { return x.id === sid; })) return fail(404, 'Item not found.');
            if (b.left === null || b.left === '') delete d.stock[sid];
            else { var nl = parseInt(b.left, 10); if (!(nl >= 0 && nl <= 9999)) return fail(400, 'Enter how many are left (0 to 9999), or leave it blank to stop counting.'); d.stock[sid] = nl; }
            save(d); announceStock(d, [sid]);
            return ok({ item: menuFor(d, true).filter(function (x) { return x.id === sid; })[0] });
        }
        if (p === '/api/owner/out' && method === 'PUT') {
            demoInv(d); var ing = String(b.ingredient || '').trim().slice(0, 30);
            if (!ing) return fail(400, 'Which ingredient?');
            d.out = d.out.filter(function (x) { return x.toLowerCase() !== ing.toLowerCase(); });
            if (b.out) d.out.push(ing);
            save(d); emit('MENU_UPDATE', { menu: menuFor(d, false) });
            return ok({ out: d.out, menu: menuFor(d, true) });
        }
        if (p === '/api/owner/menu-order' && method === 'PUT') {
            var ids = (b.ids || []).map(function (x) { return parseInt(x, 10); });
            var byId = {}; d.menu.forEach(function (x) { byId[x.id] = x; });
            if (ids.length !== d.menu.length || !ids.every(function (x) { return byId[x]; })) return fail(409, 'Your menu changed on another screen. Refresh and try again.');
            d.menu = ids.map(function (x) { return byId[x]; }); save(d);
            emit('MENU_UPDATE', { menu: menuFor(d, false) });
            return ok({ menu: menuFor(d, true) });
        }
        if (p === '/api/owner/upload') return fail(403, 'Photo uploads are turned off in the demo. Create a free page to add photos.');
        if (p === '/api/owner/hours' && method === 'PUT') {
            if (!Array.isArray(b.hours) || b.hours.length !== 7) return fail(400, 'Please fill in all seven days.');
            d.hours = b.hours.map(function (x) { return { closed: !!x.closed, open: String(x.open || '11:00'), close: String(x.close || '15:00') }; });
            d.timezone = String(b.timezone || d.timezone); save(d);
            emit('HOURS_UPDATE', { hours: d.hours, timezone: d.timezone });
            return ok({ hours: d.hours, timezone: d.timezone });
        }
        if (p === '/api/owner/orders/export.csv') {
            var cell = function (v) { v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
            var lines = ['Ticket,Date & time,Customer,Items,Notes,Total,Status'].concat(d.orders.map(function (o) {
                return [o.ticket, new Date(o.createdAt).toLocaleString(), o.name, o.summary, o.notes, o.total.toFixed(2), o.status].map(cell).join(',');
            }));
            return { status: 200, text: lines.join('\r\n') + '\r\n', type: 'text/csv' };
        }
        if (p === '/api/owner/menu' && method === 'POST') {
            if (d.menu.length >= MAX_ITEMS) return fail(400, 'Menus can have up to ' + MAX_ITEMS + ' items. Remove one to add another.');
            if (!String(b.name || '').trim()) return fail(400, 'Item name is required.');
            id = d.menu.reduce(function (mx, i) { return Math.max(mx, i.id); }, 0) + 1;
            var item = cleanItem(b, id); d.menu.push(item); save(d);
            emit('MENU_UPDATE', { menu: menuFor(d, false) });
            return ok({ item: item, menu: menuFor(d, true) }, 201);
        }
        if ((m = p.match(/^\/api\/owner\/menu\/(\d+)\/soldout$/)) && method === 'PATCH') {
            var it = d.menu.filter(function (x) { return x.id === parseInt(m[1], 10); })[0];
            if (!it) return fail(404, 'Item not found.');
            it.soldOut = !!b.soldOut; save(d);
            announceStock(d, [it.id]);
            return ok({ item: menuFor(d, true).filter(function (x) { return x.id === it.id; })[0] });
        }
        if ((m = p.match(/^\/api\/owner\/menu\/(\d+)$/))) {
            id = parseInt(m[1], 10);
            var ix = -1; d.menu.forEach(function (x, i) { if (x.id === id) ix = i; });
            if (ix < 0) return fail(404, 'Item not found.');
            if (method === 'PUT') d.menu[ix] = cleanItem(b, id, d.menu[ix]);
            else if (method === 'DELETE') d.menu.splice(ix, 1);
            else return fail(405, 'Not allowed.');
            if (method === 'DELETE') delete (d.stock || {})[id];
            save(d);
            emit('MENU_UPDATE', { menu: menuFor(d, false) });
            var omx = menuFor(d, true);
            return ok({ item: omx[ix], menu: omx });
        }

        /* locations */
        if (p === '/api/owner/locations' && method === 'GET') {
            return ok({
                active: d.locations.filter(function (l) { return !l.deleted; }).map(function (l) { return { id: l.id, name: l.name }; }),
                deleted: d.locations.filter(function (l) { return l.deleted; }).map(function (l) { return { id: l.id, name: l.name }; })
            });
        }
        if (p === '/api/owner/locations' && method === 'POST') {
            var name = String(b.name || '').trim().slice(0, 80);
            if (!name) return fail(400, 'Location name is required.');
            loc = { id: d.nextLocId++, name: name, deleted: false }; d.locations.push(loc); save(d);
            return ok({ id: loc.id, name: loc.name }, 201);
        }
        if ((m = p.match(/^\/api\/owner\/locations\/(\d+)(\/restore)?$/))) {
            loc = d.locations.filter(function (l) { return l.id === parseInt(m[1], 10); })[0];
            if (!loc) return fail(404, 'Not found.');
            if (m[2]) loc.deleted = false;
            else {
                loc.deleted = true;
                if (d.state.location === loc.name) { d.state.location = ''; emit('LOCATION_UPDATE', { location: '' }); }
            }
            save(d);
            return ok({ ok: true });
        }

        /* analytics */
        if (p === '/api/owner/analytics') {
            var since = parseInt(u.searchParams.get('since'), 10) || 0;
            var done = d.orders.filter(function (o) { return o.status === 'Fulfilled' && o.updatedAt >= since; });
            var rev = done.reduce(function (s, o) { return s + o.total; }, 0), counts = {};
            done.forEach(function (o) { o.items.forEach(function (i) { var k = i.name.replace(/ \(.*\)$/, ''); counts[k] = (counts[k] || 0) + i.qty; }); });
            var top = null; Object.keys(counts).forEach(function (k) { if (!top || counts[k] > counts[top]) top = k; });
            return ok({ revenue: round(rev), orders: done.length, avgOrder: done.length ? round(rev / done.length) : 0, topItem: top });
        }

        /* profile (works in the demo so people can see their own truck name) */
        if (p === '/api/owner/profile' && method === 'PUT') {
            var bn = String(b.businessName || '').trim();
            if (bn.length < 2 || bn.length > 60) return fail(400, 'Business name must be 2-60 characters.');
            d.vendor.businessName = bn;
            d.vendor.emoji = String(b.emoji || '').slice(0, 8);
            d.vendor.ownerIG = String(b.ownerIG || '').replace(/^@/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 30);
            d.vendor.ownerName = String(b.ownerName || '').trim().slice(0, 60);
            save(d);
            return ok({ ok: true });
        }

        /* Pro features show as locked in the demo (the demo truck is on the Free plan) */
        if (p === '/api/payments/status') return ok({ configured: true, pro: false, connected: false, chargesEnabled: false, payMode: 'window', effective: 'window' });
        if (p === '/api/sms/status') return ok({ configured: true, pro: false, verified: false, phone: '', pending: '', ownerMode: 'idle', customerReady: true, used: 0, limit: 1000 });
        if (/^\/api\/(payments|sms)\//.test(p)) return fail(403, 'Create a free page first, then upgrade to Pro to turn this on.');

        /* things a demo can't do */
        if (/^\/api\/owner\/(staff-pin|password|email|account)/.test(p)) return fail(403, DEMO_OFF);
        if (/^\/api\/billing\//.test(p)) return fail(403, 'Create a free page first, then you can upgrade to Pro from your dashboard.');

        return fail(404, 'Not found');
    }

    var realFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var u;
        try { u = new URL(url, location.href); } catch (e) { return realFetch(input, init); }
        if (u.origin !== location.origin || u.pathname.indexOf('/api/') !== 0) return realFetch(input, init);
        var method = (init && init.method) || 'GET', body = {};
        if (init && typeof init.body === 'string') { try { body = JSON.parse(init.body) || {}; } catch (e) {} }
        return new Promise(function (resolve) {
            // a tiny delay so the demo feels like a real network round trip
            setTimeout(function () {
                var r;
                try { r = handle(method, u, body); } catch (e) { console.error(e); r = fail(500, 'Something went wrong in the demo.'); }
                if (r.text != null) resolve(new Response(r.text, { status: r.status, headers: { 'Content-Type': r.type || 'text/plain' } }));
                else resolve(new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } }));
            }, 120);
        });
    };

    /* ---------------- keep navigation inside the demo ---------------- */
    var LINK_MAP = { '/': '/demo/customer', '/customer': '/demo/customer', '/customer.html': '/demo/customer', '/owner': '/demo/owner', '/owner.html': '/demo/owner' };
    document.addEventListener('click', function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        var to = LINK_MAP[a.getAttribute('href')];
        if (to) { e.preventDefault(); e.stopPropagation(); location.href = to; }
    }, true);

    /* ---------------- demo banner ---------------- */
    function css(el, s) { for (var k in s) el.style[k] = s[k]; return el; }
    function make(tag, text, style) { var el = document.createElement(tag); if (text) el.textContent = text; if (style) css(el, style); return el; }

    function banner() {
        var bar = make('div', '', { background: '#000000', borderBottom: '1px solid #26282b', color: '#dcdee1', fontFamily: "'Manrope', system-ui, -apple-system, sans-serif", fontSize: '12px', padding: '8px 12px', width: '100%', boxSizing: 'border-box', position: 'relative', zIndex: '30' }); // below the pages' pop-ups (z-50)
        var inner = make('div', '', { maxWidth: '28rem', margin: '0 auto' });

        var row1 = make('div', '', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' });
        var chip = make('span', 'LIVE DEMO', { background: '#dcdee1', color: '#0a0a0b', fontWeight: '800', fontSize: '10px', letterSpacing: '0.05em', padding: '3px 7px', borderRadius: '999px' });
        var toggle = make('div', '', { display: 'flex', background: '#1a1b1d', borderRadius: '10px', padding: '3px', gap: '3px' });
        [['Customer view', '/demo/customer', !isOwnerPage], ['Owner view', '/demo/owner', isOwnerPage]].forEach(function (t) {
            var b = make('a', t[0], { padding: '6px 10px', borderRadius: '7px', fontWeight: '700', textDecoration: 'none', fontSize: '12px', color: t[2] ? '#0a0a0b' : '#a3a6ab', background: t[2] ? '#dcdee1' : 'transparent' });
            b.href = t[1];
            b.setAttribute('data-demo-nav', '1');
            toggle.appendChild(b);
        });
        row1.appendChild(chip); row1.appendChild(toggle);

        var hint = make('div', isOwnerPage
            ? 'You are the truck owner. Tap Mark Ready on an order, then switch to Customer view to see their tracker update.'
            : 'You are a customer. Place an order, then switch to Owner view to see it land in the kitchen.',
            { marginTop: '6px', color: '#a3a6ab', lineHeight: '1.35' });

        var row2 = make('div', '', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' });
        var reset = make('button', '↺ Reset demo', { background: 'transparent', border: '0', color: '#c4c6ca', textDecoration: 'underline', cursor: 'pointer', fontSize: '11px', padding: '0' });
        reset.type = 'button';
        reset.addEventListener('click', function () { if (confirm('Reset the demo truck back to the start?')) resetDemo(); });
        var signup = make('a', 'Create my free page →', { color: '#0a0a0b', fontWeight: '700', textDecoration: 'none', background: '#dcdee1', padding: '5px 10px', borderRadius: '8px', fontSize: '11px' });
        signup.href = '/signup.html';
        row2.appendChild(reset); row2.appendChild(signup);

        inner.appendChild(row1); inner.appendChild(hint); inner.appendChild(row2);
        bar.appendChild(inner);
        document.body.insertBefore(bar, document.body.firstChild);
        document.title = (isOwnerPage ? 'Owner view' : 'Customer view') + ' — Live demo';
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner);
    else banner();
})();
