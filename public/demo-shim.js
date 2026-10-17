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

    function FakeEventSource(url) {
        var self = this;
        this.url = url; this.readyState = 0; this._staff = isOwnerPage;
        this.onopen = null; this.onmessage = null; this.onerror = null;
        sources.push(this);
        setTimeout(function () {
            if (self.readyState === 2) return;
            self.readyState = 1;
            if (typeof self.onopen === 'function') self.onopen({});
            var st = load().state;
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
            photo: b.photo != null ? String(b.photo) : (prev.photo || ''),
            soldOut: !!prev.soldOut
        };
    }

    function vendorPublic(d) {
        return {
            isDemo: false, businessName: d.vendor.businessName, slug: SLUG, customDomain: null,
            ownerIG: d.vendor.ownerIG, emoji: d.vendor.emoji, menu: d.menu, state: d.state,
            showBranding: true, pinOnly: false, hours: d.hours, timezone: d.timezone, payMode: 'window', smsReady: false
        };
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
            var item = d.menu.filter(function (m) { return m.id === parseInt(l.id, 10); })[0];
            var qty = parseInt(l.qty, 10);
            if (!item) return fail(400, 'An item in your cart is no longer on the menu.');
            if (item.soldOut) return fail(409, item.name + ' is sold out.');
            if (!(qty >= 1 && qty <= 50)) return fail(400, 'Invalid quantity.');
            var label = item.name, unit = item.salePrice > 0 ? item.salePrice : item.price;
            if (item.meats) {
                var choices = item.meats.split(',').map(function (m) { return m.trim(); }).filter(Boolean);
                var idx = l.meat ? choices.indexOf(String(l.meat)) : 0;
                if (idx < 0) return fail(400, 'Invalid option selected.');
                if (idx > 0) unit += item.premiumSurcharge || 0;
                if (choices[idx]) label += ' (' + choices[idx] + ')';
            }
            if (item.options && item.options.length && l.option) label += ' (' + l.option + ')';
            unit = round(unit);
            items.push({ id: item.id, name: label, qty: qty, price: unit });
            total += unit * qty; prep += item.prep * qty;
        }
        var now = Date.now(), id = d.nextOrderId++, ticket = d.nextTicket++;
        var o = {
            id: id, ticket: ticket, token: 'demo-' + id + '-' + Math.random().toString(36).slice(2, 8), name: String(b.customerName || '').trim().slice(0, 40) || 'Guest',
            items: items, summary: items.map(function (x) { return x.qty + 'x ' + x.name; }).join(', '),
            notes: String(b.notes || '').trim().slice(0, 300), total: round(total), status: 'Preparing', createdAt: now, updatedAt: now,
            allergy: String(b.allergy || '').trim().slice(0, 120), allergyAck: false
        };
        o.tag = o.token;
        d.orders.push(o); save(d);
        emit('ORDER_NEW', o, true);
        return ok({ ticket: o.ticket, token: o.token, tag: o.tag, status: o.status, total: o.total, estimatedMinutes: prep + (d.state.rush || 0) }, 201);
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
            return ok({ orders: d.orders.filter(function (o) { return toks.indexOf(o.token) >= 0; }).map(function (o) { return { ticket: o.ticket, token: o.token, name: o.name, status: o.status }; }) });
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
            o.status = next; o.updatedAt = Date.now(); save(d);
            emit('ORDER_UPDATE', o, true);
            emit('ORDER_STATUS', { tag: o.tag, status: o.status });
            return ok({ order: o });
        }

        /* state */
        if (p === '/api/owner/state' && method === 'GET') return ok(Object.assign({}, d.state, { crewNote: d.crewNote || '', crewNoteAt: d.crewNoteAt || 0 }));
        if (p === '/api/owner/crew-note' && method === 'PUT') {
            d.crewNote = String(b.note || '').trim().slice(0, 240); d.crewNoteAt = d.crewNote ? Date.now() : 0; save(d);
            emit('CREW_NOTE', { note: d.crewNote, at: d.crewNoteAt }, true);
            return ok({ note: d.crewNote, at: d.crewNoteAt });
        }
        if (p === '/api/owner/state' && method === 'PUT') {
            if (b.status !== undefined) {
                if (['open', 'closed'].indexOf(b.status) < 0) return fail(400, 'Invalid status.');
                d.state.status = b.status; emit('STORE_STATUS', { status: b.status });
            }
            if (b.rush !== undefined) {
                var r = parseInt(b.rush, 10);
                if ([0, 15, 30].indexOf(r) < 0) return fail(400, 'Invalid rush value.');
                d.state.rush = r; emit('RUSH_MODE', { minutes: r });
            }
            if (b.location !== undefined) { d.state.location = String(b.location || ''); emit('LOCATION_UPDATE', { location: d.state.location }); }
            if (b.paused !== undefined) { d.state.paused = !!b.paused; emit('PAUSED', { paused: d.state.paused }); }
            save(d);
            return ok(d.state);
        }

        /* menu */
        if (p === '/api/owner/menu' && method === 'GET') return ok({ menu: d.menu, maxItems: MAX_ITEMS });
        if (p === '/api/owner/menu-order' && method === 'PUT') {
            var ids = (b.ids || []).map(function (x) { return parseInt(x, 10); });
            var byId = {}; d.menu.forEach(function (x) { byId[x.id] = x; });
            if (ids.length !== d.menu.length || !ids.every(function (x) { return byId[x]; })) return fail(409, 'Your menu changed on another screen. Refresh and try again.');
            d.menu = ids.map(function (x) { return byId[x]; }); save(d);
            emit('MENU_UPDATE', { menu: d.menu });
            return ok({ menu: d.menu });
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
            emit('MENU_UPDATE', { menu: d.menu });
            return ok({ item: item, menu: d.menu }, 201);
        }
        if ((m = p.match(/^\/api\/owner\/menu\/(\d+)\/soldout$/)) && method === 'PATCH') {
            var it = d.menu.filter(function (x) { return x.id === parseInt(m[1], 10); })[0];
            if (!it) return fail(404, 'Item not found.');
            it.soldOut = !!b.soldOut; save(d);
            emit('SOLD_OUT', { itemId: it.id, soldOut: it.soldOut });
            return ok({ item: it });
        }
        if ((m = p.match(/^\/api\/owner\/menu\/(\d+)$/))) {
            id = parseInt(m[1], 10);
            var ix = -1; d.menu.forEach(function (x, i) { if (x.id === id) ix = i; });
            if (ix < 0) return fail(404, 'Item not found.');
            if (method === 'PUT') d.menu[ix] = cleanItem(b, id, d.menu[ix]);
            else if (method === 'DELETE') d.menu.splice(ix, 1);
            else return fail(405, 'Not allowed.');
            save(d);
            emit('MENU_UPDATE', { menu: d.menu });
            return ok({ item: d.menu[ix], menu: d.menu });
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
