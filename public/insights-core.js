/* insights-core.js — the numbers behind the Insights tab.
   One copy of the math, used by the server (Node) and by the demo (browser), so they can never disagree.
   Money is whole cents throughout. Times are bucketed in the truck's own time zone. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InsightsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 24 * 60 * 60 * 1000;
  var fmtCache = {};

  function validTz(tz) {
    if (!tz) return 'UTC';
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'UTC'; }
  }

  /** Local calendar parts of a moment in a time zone: y, m (1-12), d, h (0-23), wd (0=Sun). */
  function parts(ms, tz) {
    tz = validTz(tz);
    var f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short'
    }));
    var o = {};
    f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    var wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday];
    return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, min: +o.minute, wd: wd };
  }

  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  function dateKey(p) { return p.y + '-' + pad(p.m) + '-' + pad(p.d); }

  /** The UTC moment of a local wall-clock time in tz (daylight-saving safe). */
  function zonedTime(y, m, d, h, mi, tz) {
    var want = Date.UTC(y, m - 1, d, h || 0, mi || 0), guess = want;
    for (var i = 0; i < 4; i++) {
      var p = parts(guess, tz);
      var asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
      if (asUtc === want) break;
      guess += want - asUtc;
    }
    return guess;
  }
  /** The UTC moment of local midnight on y-m-d in tz. */
  function zonedStart(y, m, d, tz) { return zonedTime(y, m, d, 0, 0, tz); }

  function addDaysYMD(y, m, d, n) { var t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }
  function parseYMD(s) { var a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return a ? { y: +a[1], m: +a[2], d: +a[3] } : null; }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** A day, week (Mon–Sun) or calendar month containing the anchor date, plus the one before it. */
  function period(range, anchor, tz, now) {
    now = now || Date.now();
    var a = parseYMD(anchor) || parts(now, tz);
    var start, len, label;
    if (range === 'week') {
      var wd = new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay();
      start = addDaysYMD(a.y, a.m, a.d, -((wd + 6) % 7));
      len = 7;
      var end = addDaysYMD(start.y, start.m, start.d, 6);
      label = MON[start.m - 1] + ' ' + start.d + ' – ' + (end.m !== start.m ? MON[end.m - 1] + ' ' : '') + end.d;
    } else if (range === 'month') {
      start = { y: a.y, m: a.m, d: 1 };
      len = new Date(Date.UTC(a.y, a.m, 0)).getUTCDate();
      label = MONTHS[a.m - 1] + ' ' + a.y;
    } else {
      range = 'day';
      start = { y: a.y, m: a.m, d: a.d };
      len = 1;
      label = new Date(Date.UTC(a.y, a.m - 1, a.d)).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
    var days = [];
    for (var i = 0; i < len; i++) { var x = addDaysYMD(start.y, start.m, start.d, i); days.push(x.y + '-' + pad(x.m) + '-' + pad(x.d)); }
    var after = addDaysYMD(start.y, start.m, start.d, len);
    var prevStart = range === 'month' ? { y: start.m === 1 ? start.y - 1 : start.y, m: start.m === 1 ? 12 : start.m - 1, d: 1 } : addDaysYMD(start.y, start.m, start.d, -len);
    var today = dateKey(parts(now, tz));
    return {
      range: range,
      label: label,
      from: zonedStart(start.y, start.m, start.d, tz),
      to: zonedStart(after.y, after.m, after.d, tz),
      prevFrom: zonedStart(prevStart.y, prevStart.m, prevStart.d, tz),
      prevTo: zonedStart(start.y, start.m, start.d, tz),
      days: days,
      isCurrent: days.indexOf(today) >= 0,
      prevAnchor: prevStart.y + '-' + pad(prevStart.m) + '-' + pad(prevStart.d),
      nextAnchor: after.y + '-' + pad(after.m) + '-' + pad(after.d),
      isFuture: days[0] > today
    };
  }

  /** "Street Tacos (3) (Asada)" → "Street Tacos (3)": options don't split an item's count. */
  function baseName(n) { return String(n || '').replace(/ \((?![0-9]+\))[^()]*\)$/, ''); }

  /** rows: [{ t: ms, cents, items: [{name, qty, price}], loc }] */
  function totals(rows) {
    var cents = 0, items = 0, costed = 0, cost = 0, lineCents = 0;
    rows.forEach(function (r) {
      cents += r.cents;
      (r.items || []).forEach(function (i) {
        var q = i.qty || 0, lc = Math.round((i.price || 0) * 100) * q;
        items += q; lineCents += lc;
        if (i.cost !== undefined && i.cost !== null) { costed += lc; cost += Math.round(i.cost * 100) * q; }
      });
    });
    return {
      cents: cents, orders: rows.length, items: items, avgCents: rows.length ? Math.round(cents / rows.length) : 0,
      // Profit only over items that have a food cost set; coverage says how much of the sales that is.
      costCents: cost, profitCents: costed - cost, marginPct: costed ? Math.round((costed - cost) / costed * 1000) / 10 : null,
      costCoverage: lineCents ? Math.round(costed / lineCents * 100) : 0
    };
  }

  /** Each item: sold, sales, food cost, profit and margin, best earners first. */
  function margins(rows) {
    var m = {};
    rows.forEach(function (r) {
      (r.items || []).forEach(function (i) {
        var k = baseName(i.name), e = m[k] || (m[k] = { name: k, qty: 0, cents: 0, costCents: 0, costedCents: 0 });
        var q = i.qty || 0, lc = Math.round((i.price || 0) * 100) * q;
        e.qty += q; e.cents += lc;
        if (i.cost !== undefined && i.cost !== null) { e.costCents += Math.round(i.cost * 100) * q; e.costedCents += lc; }
      });
    });
    return Object.keys(m).map(function (k) {
      var e = m[k], has = e.costedCents > 0;
      return { name: e.name, qty: e.qty, cents: e.cents, costCents: has ? e.costCents : null, profitCents: has ? e.costedCents - e.costCents : null, marginPct: has ? Math.round((e.costedCents - e.costCents) / e.costedCents * 1000) / 10 : null };
    }).sort(function (a, b) { return (b.profitCents === null ? -1e12 : b.profitCents) - (a.profitCents === null ? -1e12 : a.profitCents) || b.cents - a.cents; });
  }

  /**
   * What to expect: rows are past sales from the same weekday (and spot, when there's enough).
   * Gives the average orders and sales per day, the average orders in each hour, and a prep list.
   */
  function forecast(rows, tz) {
    var days = {}, hours = [], items = {};
    for (var h = 0; h < 24; h++) hours.push(0);
    rows.forEach(function (r) {
      var p = parts(r.t, tz); days[dateKey(p)] = 1; hours[p.h]++;
      (r.items || []).forEach(function (i) { var k = baseName(i.name); items[k] = (items[k] || 0) + (i.qty || 0); });
    });
    var n = Object.keys(days).length;
    if (!n) return { days: 0 };
    var t = totals(rows);
    var perHour = hours.map(function (c) { return Math.round(c / n * 10) / 10; });
    var best = 0; perHour.forEach(function (c, i) { if (c > perHour[best]) best = i; });
    return {
      days: n,
      orders: Math.round(t.orders / n),
      cents: Math.round(t.cents / n),
      perHour: perHour,
      busiestHour: perHour[best] ? best : null,
      prep: Object.keys(items).map(function (k) { return { name: k, qty: Math.round(items[k] / n) }; }).filter(function (x) { return x.qty > 0; }).sort(function (a, b) { return b.qty - a.qty; }).slice(0, 10)
    };
  }

  function change(now, before) {
    if (!before) return now ? null : 0; // null = nothing to compare against
    return Math.round(((now - before) / before) * 1000) / 10;
  }

  function topItems(rows, n) {
    var m = {};
    rows.forEach(function (r) {
      (r.items || []).forEach(function (i) {
        var k = baseName(i.name), e = m[k] || (m[k] = { name: k, qty: 0, cents: 0 });
        e.qty += i.qty || 0; e.cents += Math.round((i.price || 0) * 100) * (i.qty || 0);
      });
    });
    return Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.qty - a.qty || b.cents - a.cents; }).slice(0, n || 8);
  }

  function hourly(rows, tz) {
    var h = [];
    for (var i = 0; i < 24; i++) h.push({ hour: i, cents: 0, orders: 0, days: {} });
    rows.forEach(function (r) { var p = parts(r.t, tz), b = h[p.h]; b.cents += r.cents; b.orders++; b.days[dateKey(p)] = 1; });
    return h.map(function (b) {
      var d = Object.keys(b.days).length;
      return { hour: b.hour, cents: b.cents, orders: b.orders, days: d, avgCents: d ? Math.round(b.cents / d) : 0 };
    });
  }

  function best(list, key) { var top = null; list.forEach(function (x) { if (x[key] > 0 && (!top || x[key] > top[key])) top = x; }); return top; }

  /** Everything the Insights tab shows for one period. */
  function summarize(rows, prevRows, per, tz) {
    var tot = totals(rows), prev = totals(prevRows);
    var byDay = {};
    per.days.forEach(function (d) { byDay[d] = { date: d, cents: 0, orders: 0 }; });
    rows.forEach(function (r) { var k = dateKey(parts(r.t, tz)); if (byDay[k]) { byDay[k].cents += r.cents; byDay[k].orders++; } });
    var daily = per.days.map(function (d) { return byDay[d]; });
    var hrs = hourly(rows, tz);
    var locs = {};
    rows.forEach(function (r) { var k = r.loc || ''; var e = locs[k] || (locs[k] = { location: k, cents: 0, orders: 0 }); e.cents += r.cents; e.orders++; });
    var bestHour = best(hrs, 'cents');
    var bestDay = per.days.length > 1 ? best(daily, 'cents') : null;
    return {
      period: per,
      totals: tot,
      previous: prev,
      change: { cents: change(tot.cents, prev.cents), orders: change(tot.orders, prev.orders), avgCents: change(tot.avgCents, prev.avgCents) },
      hourly: hrs,
      daily: daily,
      daysWorked: daily.filter(function (d) { return d.orders > 0; }).length,
      bestHour: bestHour ? bestHour.hour : null,
      bestDay: bestDay ? bestDay.date : null,
      topItems: topItems(rows, 8),
      margins: margins(rows),
      locations: Object.keys(locs).map(function (k) { return locs[k]; }).sort(function (a, b) { return b.cents - a.cents; })
    };
  }

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /** Each location side by side, judged per day worked so a spot you visit twice isn't buried by one you visit daily. */
  function compareLocations(rows, tz) {
    var m = {};
    rows.forEach(function (r) {
      var k = r.loc || '';
      var e = m[k] || (m[k] = { location: k, rows: [], days: {}, wd: [0, 0, 0, 0, 0, 0, 0], wdDays: [{}, {}, {}, {}, {}, {}, {}] });
      var p = parts(r.t, tz), dk = dateKey(p);
      e.rows.push(r); e.days[dk] = 1; e.wd[p.wd] += r.cents; e.wdDays[p.wd][dk] = 1;
    });
    return Object.keys(m).map(function (k) {
      var e = m[k], t = totals(e.rows), days = Object.keys(e.days).length;
      var hrs = hourly(e.rows, tz), bh = best(hrs, 'avgCents');
      var wdAvg = e.wd.map(function (c, i) { var n = Object.keys(e.wdDays[i]).length; return { wd: i, avgCents: n ? Math.round(c / n) : 0 }; });
      var bw = best(wdAvg, 'avgCents');
      var top = topItems(e.rows, 1)[0];
      var span = e.rows.reduce(function (s, r) { return { a: Math.min(s.a, r.t), b: Math.max(s.b, r.t) }; }, { a: Infinity, b: 0 });
      return {
        location: k,
        daysWorked: days,
        cents: t.cents,
        orders: t.orders,
        avgCents: t.avgCents,
        perDayCents: days ? Math.round(t.cents / days) : 0,
        ordersPerDay: days ? Math.round((t.orders / days) * 10) / 10 : 0,
        bestHour: bh ? bh.hour : null,
        bestWeekday: bw ? WEEKDAYS[bw.wd] : null,
        topItem: top ? top.name : null,
        hourly: hrs.map(function (h) { return h.avgCents; }), // average per day worked, by hour
        lastVisit: span.b || null
      };
    }).sort(function (a, b) { return b.perDayCents - a.perDayCents; });
  }

  function hourLabel(h) { if (h === null || h === undefined) return '—'; var x = h % 12 || 12; return x + (h < 12 ? ' AM' : ' PM'); }

  return {
    DAY: DAY, parts: parts, dateKey: dateKey, zonedStart: zonedStart, zonedTime: zonedTime, period: period, baseName: baseName,
    totals: totals, summarize: summarize, margins: margins, forecast: forecast, compareLocations: compareLocations, hourLabel: hourLabel, validTz: validTz
  };
});
