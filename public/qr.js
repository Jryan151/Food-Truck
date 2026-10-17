/**
 * qr.js — tiny QR code generator (byte mode, error correction level M).
 * Based on the algorithm in Project Nayuki's QR Code generator (MIT License).
 * Usage:  QR.svg('https://tacos.example.com', { size: 300 })  ->  '<svg ...>'
 */
(function (root) {
    'use strict';

    var ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
    var NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
    var FORMAT_ECC_M = 0;

    function rawDataModules(ver) {
        var r = (16 * ver + 128) * ver + 64;
        if (ver >= 2) {
            var n = Math.floor(ver / 7) + 2;
            r -= (25 * n - 10) * n - 55;
            if (ver >= 7) r -= 36;
        }
        return r;
    }
    function dataCodewords(ver) { return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver]; }

    function gfMul(x, y) {
        var z = 0;
        for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
        return z;
    }
    function rsDivisor(degree) {
        var res = []; for (var i = 0; i < degree - 1; i++) res.push(0); res.push(1);
        var root = 1;
        for (i = 0; i < degree; i++) {
            for (var j = 0; j < res.length; j++) { res[j] = gfMul(res[j], root); if (j + 1 < res.length) res[j] ^= res[j + 1]; }
            root = gfMul(root, 0x02);
        }
        return res;
    }
    function rsRemainder(data, div) {
        var res = div.map(function () { return 0; });
        data.forEach(function (b) {
            var f = b ^ res.shift(); res.push(0);
            div.forEach(function (c, i) { res[i] ^= gfMul(c, f); });
        });
        return res;
    }

    function utf8(str) {
        var out = [], s = unescape(encodeURIComponent(str));
        for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
        return out;
    }

    function encode(text) {
        var bytes = utf8(String(text)), ver, cap, used;
        for (ver = 1; ver <= 40; ver++) {
            cap = dataCodewords(ver) * 8;
            used = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
            if (used <= cap) break;
        }
        if (ver > 40) throw new Error('Text too long for a QR code');

        var bits = [];
        function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
        put(4, 4); put(bytes.length, ver <= 9 ? 8 : 16);
        bytes.forEach(function (b) { put(b, 8); });
        put(0, Math.min(4, cap - bits.length));
        put(0, (8 - bits.length % 8) % 8);
        for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
        var data = [];
        for (var i = 0; i < bits.length; i += 8) { var v = 0; for (var k = 0; k < 8; k++) v = (v << 1) | bits[i + k]; data.push(v); }

        // error correction + interleave
        var nb = NUM_BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver], raw = Math.floor(rawDataModules(ver) / 8);
        var numShort = nb - raw % nb, shortLen = Math.floor(raw / nb), div = rsDivisor(eccLen), blocks = [];
        for (i = 0, k = 0; i < nb; i++) {
            var dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
            k += dat.length;
            var ecc = rsRemainder(dat, div);
            if (i < numShort) dat.push(0);
            blocks.push(dat.concat(ecc));
        }
        var cw = [];
        for (i = 0; i < blocks[0].length; i++) for (var j = 0; j < blocks.length; j++) if (i !== shortLen - eccLen || j >= numShort) cw.push(blocks[j][i]);

        var size = ver * 4 + 17, mods = [], fn = [];
        for (i = 0; i < size; i++) { mods.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
        function setF(x, y, d) { mods[y][x] = d; fn[y][x] = true; }

        // function patterns
        for (i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
        function finder(x, y) {
            for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
                var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
                if (xx >= 0 && xx < size && yy >= 0 && yy < size) setF(xx, yy, d !== 2 && d !== 4);
            }
        }
        finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
        var align = [];
        if (ver > 1) {
            var na = Math.floor(ver / 7) + 2, step = Math.floor((ver * 8 + na * 3 + 5) / (na * 4 - 4)) * 2;
            align = [6];
            for (var pos = size - 7; align.length < na; pos -= step) align.splice(1, 0, pos);
        }
        align.forEach(function (ay, ai) {
            align.forEach(function (ax, aj) {
                if ((ai === 0 && aj === 0) || (ai === 0 && aj === align.length - 1) || (ai === align.length - 1 && aj === 0)) return;
                for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) setF(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            });
        });
        function formatBits(mask) {
            var d = (FORMAT_ECC_M << 3) | mask, rem = d;
            for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            var b = ((d << 10) | rem) ^ 0x5412, bit = function (n) { return ((b >>> n) & 1) !== 0; };
            for (i = 0; i <= 5; i++) setF(8, i, bit(i));
            setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
            for (i = 9; i < 15; i++) setF(14 - i, 8, bit(i));
            for (i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i));
            for (i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i));
            setF(8, size - 8, true);
        }
        formatBits(0);
        if (ver >= 7) {
            var rem = ver;
            for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
            var vb = (ver << 12) | rem;
            for (i = 0; i < 18; i++) {
                var bt = ((vb >>> i) & 1) !== 0, a = size - 11 + i % 3, b2 = Math.floor(i / 3);
                setF(a, b2, bt); setF(b2, a, bt);
            }
        }

        // data
        var bi = 0;
        for (var right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (var vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
                var x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
                if (!fn[y][x] && bi < cw.length * 8) { mods[y][x] = ((cw[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0; bi++; }
            }
        }

        function maskOn(m, x, y) {
            switch (m) {
                case 0: return (x + y) % 2 === 0;
                case 1: return y % 2 === 0;
                case 2: return x % 3 === 0;
                case 3: return (x + y) % 3 === 0;
                case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
                case 5: return x * y % 2 + x * y % 3 === 0;
                case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
                default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
            }
        }
        function applyMask(m) { for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) if (!fn[y][x] && maskOn(m, x, y)) mods[y][x] = !mods[y][x]; }
        function penalty() {
            var p = 0, x, y, run, dark = 0;
            for (y = 0; y < size; y++) { run = 1; for (x = 1; x <= size; x++) { if (x < size && mods[y][x] === mods[y][x - 1]) run++; else { if (run >= 5) p += run - 2; run = 1; } } }
            for (x = 0; x < size; x++) { run = 1; for (y = 1; y <= size; y++) { if (y < size && mods[y][x] === mods[y - 1][x]) run++; else { if (run >= 5) p += run - 2; run = 1; } } }
            for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) { var c = mods[y][x]; if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1]) p += 3; }
            for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (mods[y][x]) dark++;
            p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
            return p;
        }
        var best = 0, bestP = Infinity;
        for (var m = 0; m < 8; m++) {
            applyMask(m); formatBits(m);
            var pp = penalty(); if (pp < bestP) { bestP = pp; best = m; }
            applyMask(m); // undo
        }
        applyMask(best); formatBits(best);
        return { size: size, modules: mods };
    }

    function svg(text, opts) {
        opts = opts || {};
        var q = encode(text), border = 4, n = q.size + border * 2, path = [];
        for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) if (q.modules[y][x]) path.push('M' + (x + border) + ',' + (y + border) + 'h1v1h-1z');
        var px = opts.size || 256;
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges">' +
            '<rect width="100%" height="100%" fill="#ffffff"/><path d="' + path.join('') + '" fill="#000000"/></svg>';
    }

    var api = { encode: encode, svg: svg };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.QR = api;
})(this);
