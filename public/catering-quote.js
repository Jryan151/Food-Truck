/**
 * catering-quote.js — the one place catering prices are worked out.
 * Used by the server (to check and save every booking) and by the booking page (for the live quote),
 * so what a host sees is exactly what gets saved. All money is in whole cents.
 *
 * Rounding: each line (service, tax) is rounded to the nearest cent, halves rounding up.
 * Tax applies to food, minimum-order adjustment, service charge and travel.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CateringQuote = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var LIMITS = { packages: 8, tiers: 6, choices: 12, zones: 10, zips: 150, questions: 8, blocked: 200 };

    function int(v, d, min, max) {
        var n = Math.round(Number(v));
        if (!isFinite(n)) n = d;
        return Math.min(max, Math.max(min, n));
    }
    function num(v, d, min, max, places) {
        var n = Number(v);
        if (!isFinite(n)) n = d;
        var f = Math.pow(10, places);
        return Math.min(max, Math.max(min, Math.round(n * f) / f));
    }
    function str(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
    function cents(v) { return int(v, 0, 0, 10000000); }           // up to $100,000
    function slugId(s, i) { return (str(s, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item') + '-' + i; }

    /** Turns whatever was saved (or sent by the owner's browser) into clean, safe settings. */
    function normalizeSettings(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        var packages = (Array.isArray(raw.packages) ? raw.packages : []).slice(0, LIMITS.packages).map(function (p, i) {
            p = p || {};
            var tiers = (Array.isArray(p.tiers) ? p.tiers : []).slice(0, LIMITS.tiers).map(function (t) {
                return { minGuests: int(t && t.minGuests, 1, 1, 5000), priceCents: cents(t && t.priceCents) };
            }).filter(function (t) { return t.priceCents > 0; });
            tiers.sort(function (a, b) { return a.minGuests - b.minGuests; });
            // One price per guest count: keep the first of any duplicates.
            tiers = tiers.filter(function (t, j) { return j === 0 || t.minGuests !== tiers[j - 1].minGuests; });
            var choices = (Array.isArray(p.choices) ? p.choices : []).map(function (c) { return str(c, 40); }).filter(Boolean).slice(0, LIMITS.choices);
            return {
                id: str(p.id, 60) || slugId(p.name, i + 1),
                name: str(p.name, 60) || 'Package ' + (i + 1),
                desc: str(p.desc, 240),
                tiers: tiers,
                choiceLabel: str(p.choiceLabel, 60),
                choices: choices,
                chooseCount: int(p.chooseCount, 0, 0, choices.length),
                allowVegetarian: !!p.allowVegetarian
            };
        }).filter(function (p) { return p.tiers.length; });

        var zones = (Array.isArray(raw.zones) ? raw.zones : []).slice(0, LIMITS.zones).map(function (z, i) {
            z = z || {};
            var zips = (Array.isArray(z.zips) ? z.zips : String(z.zips || '').split(/[\s,]+/))
                .map(function (x) { return String(x).trim(); }).filter(function (x) { return /^\d{5}$/.test(x); });
            return { name: str(z.name, 60) || 'Zone ' + (i + 1), zips: zips.filter(function (x, j) { return zips.indexOf(x) === j; }).slice(0, LIMITS.zips), feeCents: cents(z.feeCents) };
        }).filter(function (z) { return z.zips.length; });

        var questions = (Array.isArray(raw.siteQuestions) ? raw.siteQuestions : []).slice(0, LIMITS.questions).map(function (q, i) {
            q = q || {};
            return { id: str(q.id, 60) || 'q' + (i + 1), question: str(q.question, 140), yesNote: str(q.yesNote, 160), noNote: str(q.noNote, 160), mustBeYes: !!q.mustBeYes };
        }).filter(function (q) { return q.question; });

        var blocked = (Array.isArray(raw.blockedDates) ? raw.blockedDates : [])
            .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d)); }).slice(0, LIMITS.blocked);

        var minGuests = int(raw.minGuests, 20, 1, 5000);
        return {
            enabled: !!raw.enabled,
            packages: packages,
            minGuests: minGuests,
            maxGuests: Math.max(minGuests, int(raw.maxGuests, 300, 1, 5000)),
            minSpendCents: cents(raw.minSpendCents),
            leadDays: int(raw.leadDays, 7, 0, 365),
            maxDaysAhead: int(raw.maxDaysAhead, 365, 7, 730),
            zones: zones,
            serviceChargePct: num(raw.serviceChargePct, 0, 0, 30, 2),
            taxPct: num(raw.taxPct, 0, 0, 15, 3),
            depositPct: int(raw.depositPct, 0, 0, 100),
            serviceHours: num(raw.serviceHours, 2, 0.5, 12, 1),
            maxEventsPerDay: int(raw.maxEventsPerDay, 1, 1, 10),
            finalCountDays: int(raw.finalCountDays, 7, 0, 60),
            blockedDates: blocked,
            siteQuestions: questions,
            cancellationPolicy: str(raw.cancellationPolicy, 600),
            notes: str(raw.notes, 600)
        };
    }

    /** Percent of an amount in cents, rounded to the nearest cent (halves up). Works for pct like 8.125. */
    function pctOf(amountCents, pct) {
        var milli = Math.round(pct * 1000);                       // 8.125% -> 8125
        return Math.floor((amountCents * milli + 50000) / 100000); // exact integer math, halves round up
    }

    function findZone(settings, zip) {
        zip = String(zip || '').trim();
        for (var i = 0; i < settings.zones.length; i++) if (settings.zones[i].zips.indexOf(zip) !== -1) return settings.zones[i];
        return null;
    }

    function tierFor(pkg, guests) {
        var t = pkg.tiers[0];
        for (var i = 0; i < pkg.tiers.length; i++) if (guests >= pkg.tiers[i].minGuests) t = pkg.tiers[i];
        return t;
    }

    /**
     * Works out a quote. input: { packageId, guests, zip, vegetarian }.
     * Returns { ok, problems: [{field, message}], lines: [{label, cents}], totals..., nextBreak }.
     */
    function computeQuote(settings, input) {
        settings = settings && settings.packages ? settings : normalizeSettings(settings);
        input = input || {};
        var problems = [];
        var pkg = null;
        for (var i = 0; i < settings.packages.length; i++) if (settings.packages[i].id === input.packageId) pkg = settings.packages[i];
        var guests = Math.round(Number(input.guests));
        if (!pkg) problems.push({ field: 'package', message: 'Choose a package.' });
        if (!isFinite(guests) || guests < 1) problems.push({ field: 'guests', message: 'Enter how many guests.' });
        else if (guests < settings.minGuests) problems.push({ field: 'guests', message: 'The minimum is ' + settings.minGuests + ' guests.' });
        else if (guests > settings.maxGuests) problems.push({ field: 'guests', message: 'For more than ' + settings.maxGuests + ' guests, ask for a custom quote below.' });
        var zip = String(input.zip || '').trim();
        var zone = null;
        if (!/^\d{5}$/.test(zip)) problems.push({ field: 'zip', message: 'Enter the 5-digit ZIP code of the event.' });
        else if (!(zone = findZone(settings, zip))) problems.push({ field: 'zip', message: 'We don’t usually travel to ' + zip + '. Ask for a custom quote below.' });
        var veg = Math.round(Number(input.vegetarian) || 0);
        if (veg < 0) veg = 0;
        if (pkg && !pkg.allowVegetarian) veg = 0;
        if (isFinite(guests) && veg > guests) problems.push({ field: 'vegetarian', message: 'Vegetarian plates can’t be more than the guest count.' });

        var out = { ok: false, problems: problems, lines: [], guests: guests, vegetarian: veg, packageId: pkg ? pkg.id : null, zone: zone ? zone.name : null };
        if (!pkg || !isFinite(guests) || guests < 1) return out;

        var tier = tierFor(pkg, guests);
        var food = tier.priceCents * guests;
        out.perGuestCents = tier.priceCents;
        out.lines.push({ key: 'food', label: pkg.name + ' · ' + guests + ' × ' + money(tier.priceCents), cents: food });
        if (tier !== pkg.tiers[0]) out.tierNote = 'You’re in the ' + tier.minGuests + '+ guest price break';
        var nextTier = null;
        for (var j = 0; j < pkg.tiers.length; j++) if (pkg.tiers[j].minGuests > guests) { nextTier = pkg.tiers[j]; break; }
        if (nextTier && nextTier.priceCents < tier.priceCents) out.nextBreak = { guests: nextTier.minGuests, perGuestCents: nextTier.priceCents };

        var minAdj = settings.minSpendCents > food ? settings.minSpendCents - food : 0;
        if (minAdj) out.lines.push({ key: 'minimum', label: 'Minimum order adjustment', cents: minAdj });
        var base = food + minAdj;
        var service = settings.serviceChargePct ? pctOf(base, settings.serviceChargePct) : 0;
        if (service) out.lines.push({ key: 'service', label: 'Service · ' + trimPct(settings.serviceChargePct) + '%', cents: service });
        var travel = zone ? zone.feeCents : 0;
        if (zone) out.lines.push({ key: 'travel', label: 'Travel · ' + zone.name, cents: travel });
        var taxable = base + service + travel;
        var tax = settings.taxPct ? pctOf(taxable, settings.taxPct) : 0;
        if (tax) out.lines.push({ key: 'tax', label: 'Tax · ' + trimPct(settings.taxPct) + '%', cents: tax });

        out.subtotalCents = base;
        out.serviceCents = service;
        out.travelCents = travel;
        out.taxCents = tax;
        out.totalCents = taxable + tax;
        out.depositCents = settings.depositPct ? pctOf(out.totalCents, settings.depositPct) : 0;
        out.ok = problems.length === 0;
        return out;
    }

    function trimPct(p) { return String(Math.round(p * 1000) / 1000); }

    function money(c) {
        var neg = c < 0; c = Math.abs(Math.round(c));
        var s = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + String(c % 100).padStart(2, '0');
        return (neg ? '-$' : '$') + s;
    }

    /* ---------- dates (all as YYYY-MM-DD strings in the truck's time zone) ---------- */
    function todayIn(tz) {
        try {
            var p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
            return p;
        } catch (e) { return new Date().toISOString().slice(0, 10); }
    }
    function addDays(ymd, n) {
        var d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
    }
    function validDate(ymd) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return false;
        var d = new Date(ymd + 'T12:00:00Z');
        return !isNaN(d) && d.toISOString().slice(0, 10) === ymd;
    }
    /** Checks a date against the rules. Returns null if fine, or a message. */
    function checkDate(settings, ymd, today, fullDates) {
        if (!validDate(ymd)) return 'Choose a date.';
        var earliest = addDays(today, settings.leadDays);
        if (ymd < earliest) return settings.leadDays ? 'Please book at least ' + settings.leadDays + ' days ahead. The earliest date is ' + earliest + '.' : 'Choose a date from today on.';
        if (ymd > addDays(today, settings.maxDaysAhead)) return 'That’s further ahead than we take bookings.';
        if (settings.blockedDates.indexOf(ymd) !== -1) return 'We’re not available that day.';
        if (fullDates && fullDates.indexOf(ymd) !== -1) return 'That day is already booked.';
        return null;
    }

    return { normalizeSettings: normalizeSettings, computeQuote: computeQuote, pctOf: pctOf, money: money, findZone: findZone, todayIn: todayIn, addDays: addDays, validDate: validDate, checkDate: checkDate };
});
