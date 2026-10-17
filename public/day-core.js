/* day-core.js — the truck's day, worked out the same way on the server and in the demo.
   Customer feedback patterns, prep nudges from sold-out history, weather heads-ups, quiet hours,
   and the words of the day summary. No dependencies; uses InsightsCore for time zones. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./insights-core'));
  else root.DayCore = factory(root.InsightsCore);
})(typeof self !== 'undefined' ? self : this, function (I) {
  'use strict';
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var TAGS_DOWN = ['Took too long', 'Cold', 'Wrong order', 'Taste', 'Portion'];
  var TAGS_UP = ['Fast', 'Delicious', 'Friendly', 'Good value'];

  function clock(min) { var h = Math.floor(min / 60), m = min % 60; return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; }
  function partOfDay(h) { return h < 11 ? 'in the morning' : h < 14 ? 'at lunch' : h < 17 ? 'in the afternoon' : 'in the evening'; }

  /**
   * Feedback as patterns, not one-off complaints.
   * rows: [{ vote: 1|-1, tags: [], comment, at, items: ['Birria Taco', ...] }], prevRows: the period before.
   */
  function feedbackPatterns(rows, prevRows, tz) {
    var up = 0, down = 0, tagCount = {}, tagHours = {}, items = {}, hours = {};
    rows.forEach(function (r) {
      var h = I.parts(r.at, tz).h;
      if (r.vote > 0) up++; else down++;
      (r.tags || []).forEach(function (t) {
        var k = (r.vote > 0 ? '+' : '-') + t;
        tagCount[k] = (tagCount[k] || 0) + 1;
        (tagHours[k] = tagHours[k] || []).push(h);
      });
      var seen = {};
      (r.items || []).forEach(function (n) {
        if (seen[n]) return; seen[n] = 1;
        var e = items[n] || (items[n] = { name: n, up: 0, down: 0 });
        if (r.vote > 0) e.up++; else e.down++;
      });
      var hb = hours[h] || (hours[h] = { hour: h, up: 0, down: 0 }); if (r.vote > 0) hb.up++; else hb.down++;
    });
    var total = up + down;
    var pUp = 0, pDown = 0; (prevRows || []).forEach(function (r) { if (r.vote > 0) pUp++; else pDown++; });
    var patterns = [];
    // A complaint that keeps coming back, and when it happens.
    Object.keys(tagCount).filter(function (k) { return k[0] === '-' && tagCount[k] >= 2; }).sort(function (a, b) { return tagCount[b] - tagCount[a]; }).forEach(function (k) {
      var hs = tagHours[k], byPart = {};
      hs.forEach(function (h) { var p = partOfDay(h); byPart[p] = (byPart[p] || 0) + 1; });
      var topPart = Object.keys(byPart).sort(function (a, b) { return byPart[b] - byPart[a]; })[0];
      var when = byPart[topPart] >= Math.ceil(hs.length * 0.6) && hs.length >= 2 ? (byPart[topPart] === hs.length ? ', all ' : ', mostly ') + topPart : '';
      patterns.push({ kind: 'tag', tone: 'bad', text: '“' + k.slice(1) + '” ' + tagCount[k] + ' times' + when + '.' });
    });
    // An item that shows up in unhappy orders far more than in happy ones.
    var downShare = total ? down / total : 0;
    Object.keys(items).map(function (n) { return items[n]; }).forEach(function (e) {
      var n = e.up + e.down;
      if (e.down >= 2 && n >= 3 && e.down / n >= Math.max(0.5, downShare * 2)) patterns.push({ kind: 'item', tone: 'bad', text: e.name + ': ' + e.down + ' of ' + n + ' orders with it got a thumbs down.' });
    });
    Object.keys(tagCount).filter(function (k) { return k[0] === '+' && tagCount[k] >= 3; }).sort(function (a, b) { return tagCount[b] - tagCount[a]; }).slice(0, 1).forEach(function (k) {
      patterns.push({ kind: 'praise', tone: 'good', text: '“' + k.slice(1) + '” ' + tagCount[k] + ' times.' });
    });
    return {
      up: up, down: down, total: total,
      happyPct: total ? Math.round(up / total * 100) : null,
      prevHappyPct: pUp + pDown ? Math.round(pUp / (pUp + pDown) * 100) : null,
      patterns: patterns.slice(0, 4),
      comments: rows.filter(function (r) { return r.comment; }).sort(function (a, b) { return b.at - a.at; }).slice(0, 6)
        .map(function (r) { return { vote: r.vote, comment: r.comment, at: r.at, items: (r.items || []).slice(0, 3) }; })
    };
  }

  /**
   * "You sold out of birria by 1:10 PM the last three Fridays. Prep more, or set a limit?"
   * soldOuts: [{ itemId, name, at }] (first time each item ran out each day), for the last several weeks.
   * day: 'YYYY-MM-DD' to advise for. Needs 3 of the last 4 same weekdays.
   */
  function prepNudges(soldOuts, day, tz) {
    var ymd = day.split('-').map(Number), wd = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2])).getUTCDay();
    var dayStart = I.zonedStart(ymd[0], ymd[1], ymd[2], tz);
    var keys = [];
    for (var k = 1; k <= 4; k++) { var p = I.parts(dayStart - k * 7 * I.DAY + 12 * 3600000, tz); keys.push(I.dateKey(p)); }
    var by = {};
    soldOuts.forEach(function (s) {
      var p = I.parts(s.at, tz), dk = I.dateKey(p);
      if (p.wd !== wd || keys.indexOf(dk) < 0) return;
      var e = by[s.itemId] || (by[s.itemId] = { itemId: s.itemId, name: s.name, days: {}, mins: [] });
      if (!e.days[dk]) { e.days[dk] = 1; e.mins.push(p.h * 60 + p.min); }
    });
    var out = [];
    Object.keys(by).forEach(function (id) {
      var e = by[id], n = Object.keys(e.days).length;
      if (n < 3) return;
      var streak = 0; for (var i = 0; i < keys.length && e.days[keys[i]]; i++) streak++;
      var t = median(e.mins), rounded = Math.ceil(t / 10) * 10;
      out.push({
        itemId: e.itemId, name: e.name, days: n, byMinutes: t,
        text: 'You sold out of ' + e.name + ' by ' + clock(Math.min(rounded, 23 * 60 + 50)) + ' ' + (streak === n ? 'the last ' + ['', 'one', 'two', 'three', 'four'][n] + ' ' + WEEKDAYS[wd] + 's' : n + ' of the last 4 ' + WEEKDAYS[wd] + 's') + '. Prep more, or set a limit?'
      });
    });
    return out.sort(function (a, b) { return a.byMinutes - b.byMinutes; });
  }

  /** daily: { date, rainPct, maxF, minF, windMph }. Returns a heads-up or null. */
  function weatherHeadsUp(d, when) {
    if (!d) return null;
    var w = when || 'tomorrow';
    if (d.rainPct >= 60) return { kind: 'rain', text: 'Rain likely ' + w + ' (' + d.rainPct + '%). Shorten hours or prep less?' };
    if (d.maxF >= 105) return { kind: 'heat', text: 'Very hot ' + w + ' (' + Math.round(d.maxF) + '°F). Extra cold drinks, and expect a slow afternoon.' };
    if (d.windMph >= 30) return { kind: 'wind', text: 'Strong wind ' + w + ' (' + Math.round(d.windMph) + ' mph). Secure the awning and signs.' };
    if (d.maxF <= 45) return { kind: 'cold', text: 'Cold ' + w + ' (high of ' + Math.round(d.maxF) + '°F). Hot items will sell; cold ones less.' };
    return null;
  }

  /**
   * Quiet hours: { on, from: 'close' | 'HH:MM', until: 'HH:MM' }. closeHHMM is today's posted closing time.
   * Returns 0 if not quiet now, else the time quiet hours end.
   */
  function quietUntil(q, now, tz, closeHHMM) {
    if (!q || !q.on) return 0;
    var p = I.parts(now, tz), nowM = p.h * 60 + p.min;
    var from = q.from === 'close' ? (closeHHMM || '21:00') : q.from;
    var f = /^(\d\d):(\d\d)$/.exec(from), u = /^(\d\d):(\d\d)$/.exec(q.until || '08:00');
    if (!f || !u) return 0;
    var fm = +f[1] * 60 + +f[2], um = +u[1] * 60 + +u[2];
    var quiet = fm > um ? (nowM >= fm || nowM < um) : (nowM >= fm && nowM < um);
    if (!quiet) return 0;
    var addDay = nowM >= um ? 1 : 0;
    var t = new Date(Date.UTC(p.y, p.m - 1, p.d + addDay));
    return I.zonedTime(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), Math.floor(um / 60), um % 60, tz);
  }

  function money(c) { return '$' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /** The day summary as a few plain lines (email and the morning card use the same words). */
  function summaryLines(s) {
    var lines = [];
    if (!s.orders) { lines.push('No orders.'); return lines; }
    var vs = s.lastWeek && s.lastWeek.cents ? Math.round((s.cents - s.lastWeek.cents) / s.lastWeek.cents * 100) : null;
    // A tiny last week makes percentages silly (+2,000%): then just say what last week was.
    var cmp = vs === null ? '' : Math.abs(vs) > 300 ? ' (last ' + s.weekday + ': ' + money(s.lastWeek.cents) + ')' : ' (' + (vs >= 0 ? '+' : '') + vs + '% vs last ' + s.weekday + ')';
    lines.push(s.orders + ' order' + (s.orders === 1 ? '' : 's') + ' · ' + money(s.cents) + cmp);
    if (s.top) lines.push('Top item: ' + s.top.name + ' (' + s.top.qty + ')');
    if (s.busiest !== null && s.busiest !== undefined) lines.push('Busiest: ' + I.hourLabel(s.busiest) + (s.slowest !== null && s.slowest !== undefined && s.slowest !== s.busiest ? ' · slowest: ' + I.hourLabel(s.slowest) : ''));
    if (s.feedback && s.feedback.total) lines.push('Customers: 👍 ' + s.feedback.up + ' · 👎 ' + s.feedback.down + (s.feedback.patterns && s.feedback.patterns[0] && s.feedback.patterns[0].tone === 'bad' ? ' — ' + s.feedback.patterns[0].text : ''));
    if (s.soldOut && s.soldOut.length) lines.push('Sold out: ' + s.soldOut.map(function (x) { return x.name + ' at ' + x.time; }).join(', '));
    return lines;
  }

  return { feedbackPatterns: feedbackPatterns, prepNudges: prepNudges, weatherHeadsUp: weatherHeadsUp, quietUntil: quietUntil, summaryLines: summaryLines, TAGS_DOWN: TAGS_DOWN, TAGS_UP: TAGS_UP, clock: clock };
});
