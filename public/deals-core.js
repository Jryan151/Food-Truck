/* deals-core.js — happy hour and other timed deals.
   One copy of the pricing rules, used by the server (which decides what is charged), the customer
   page (which shows it) and the demo. Deals never stack: the customer pays the lowest of the regular
   price, the item's sale price, or the best deal running right now. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DealsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_DEALS = 6;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var cents = function (n) { return Math.round((Number(n) || 0) * 100); };

  function clean(d, i) {
    d = d && typeof d === 'object' ? d : {};
    var kind = d.kind === 'amount' ? 'amount' : 'percent';
    var amount = Number(d.amount) || 0;
    amount = kind === 'percent' ? Math.max(1, Math.min(90, Math.round(amount))) : Math.max(0.25, Math.min(100, Math.round(amount * 100) / 100));
    var days = Array.isArray(d.days) ? d.days.map(Number).filter(function (x) { return x >= 0 && x <= 6; }) : [];
    var uniq = []; days.forEach(function (x) { if (uniq.indexOf(x) < 0) uniq.push(x); });
    return {
      id: String(d.id || 'd' + (i + 1)).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'd' + (i + 1),
      name: String(d.name || 'Happy hour').trim().slice(0, 40) || 'Happy hour',
      on: d.on !== false,
      days: uniq.sort(),
      start: TIME_RE.test(d.start) ? d.start : '15:00',
      end: TIME_RE.test(d.end) ? d.end : '17:00',
      kind: kind,
      amount: amount,
      scope: d.scope === 'categories' || d.scope === 'items' ? d.scope : 'all',
      categories: (Array.isArray(d.categories) ? d.categories : []).map(function (c) { return String(c).trim().slice(0, 40); }).filter(Boolean).slice(0, 30),
      items: (Array.isArray(d.items) ? d.items : []).map(Number).filter(function (x) { return x > 0; }).slice(0, 200)
    };
  }
  function normalize(list) { return (Array.isArray(list) ? list : []).slice(0, MAX_DEALS).map(clean); }

  /** Is the deal running at these local parts ({wd, h, min})? A window ending at or before it starts runs past midnight. */
  function running(d, p) {
    if (!d.on || !d.days.length) return false;
    var now = p.h * 60 + p.min;
    var a = +d.start.slice(0, 2) * 60 + +d.start.slice(3), b = +d.end.slice(0, 2) * 60 + +d.end.slice(3);
    if (b > a) return d.days.indexOf(p.wd) >= 0 && now >= a && now < b;
    // overnight: the evening part belongs to today, the early-morning part to yesterday's deal
    if (now >= a) return d.days.indexOf(p.wd) >= 0;
    return now < b && d.days.indexOf((p.wd + 6) % 7) >= 0;
  }
  function applies(d, item) {
    if (d.scope === 'all') return true;
    if (d.scope === 'categories') return d.categories.indexOf(item.category || '') >= 0;
    return d.items.indexOf(item.id) >= 0;
  }
  function active(deals, p) { return normalize(deals).filter(function (d) { return running(d, p); }); }

  /** Price of one unit. regularCents includes any option surcharge; saleCents is null when there's no sale.
      Returns { cents, deal (name or null), wasCents (the regular price, for a strike-through) }. */
  function price(item, regularCents, saleCents, running) {
    var best = saleCents !== null && saleCents !== undefined && saleCents < regularCents ? saleCents : regularCents, why = null;
    (running || []).forEach(function (d) {
      if (!applies(d, item)) return;
      var c = d.kind === 'percent' ? regularCents - Math.round(regularCents * d.amount / 100) : regularCents - cents(d.amount);
      c = Math.max(0, c);
      if (c < best) { best = c; why = d.name; }
    });
    return { cents: best, deal: why, wasCents: regularCents };
  }

  /** "20% off drinks", "$1 off tacos", "15% off everything" — the words on the banner. */
  function describe(d, menu) {
    var off = d.kind === 'percent' ? d.amount + '% off' : '$' + (d.amount % 1 ? d.amount.toFixed(2) : d.amount) + ' off';
    var what = 'everything';
    if (d.scope === 'categories') what = d.categories.join(', ') || 'selected items';
    else if (d.scope === 'items') {
      var names = (menu || []).filter(function (m) { return d.items.indexOf(m.id) >= 0; }).map(function (m) { return m.name; });
      what = names.length === 0 ? 'selected items' : names.length <= 2 ? names.join(' and ') : names.length + ' items';
    }
    return off + ' ' + what;
  }
  function time12(t) { var h = +t.slice(0, 2), m = +t.slice(3); return (h % 12 || 12) + (m ? ':' + (m < 10 ? '0' : '') + m : '') + (h < 12 ? ' AM' : ' PM'); }

  return { MAX_DEALS: MAX_DEALS, normalize: normalize, running: running, active: active, applies: applies, price: price, describe: describe, time12: time12 };
});
