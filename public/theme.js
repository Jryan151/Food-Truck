/**
 * theme.js — picks day or night before the page paints, so there's no flash.
 * 'auto' (default) follows the device; 'day' or 'night' is the owner's choice, remembered on this device.
 * Load in <head>, before the stylesheets: <script src="/theme.js"></script>
 */
(function () {
    'use strict';
    var KEY = 'ok_theme';
    var root = document.documentElement;

    function read() {
        try { var v = localStorage.getItem(KEY); return v === 'day' || v === 'night' ? v : 'auto'; } catch (e) { return 'auto'; }
    }
    function isNight(mode) {
        if (mode === 'night') return true;
        if (mode === 'day') return false;
        return !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    }
    // Keeps the phone's status bar color in step with the page.
    function paintBar(mode) {
        var color = isNight(mode) ? '#0a0a0b' : '#e8e9eb';
        var m = document.querySelector('meta[name="theme-color"]');
        if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; (document.head || root).appendChild(m); }
        m.setAttribute('content', color);
    }
    function apply(mode) {
        if (mode === 'day' || mode === 'night') root.setAttribute('data-theme', mode);
        else root.removeAttribute('data-theme');
        paintBar(mode);
    }

    apply(read());
    if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: light)');
        var onChange = function () { if (read() === 'auto') paintBar('auto'); };
        if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    }
    document.addEventListener('DOMContentLoaded', function () { paintBar(read()); });

    window.OKTheme = {
        get: read,
        isNight: function () { return isNight(read()); },
        set: function (mode) {
            try { if (mode === 'day' || mode === 'night') localStorage.setItem(KEY, mode); else localStorage.removeItem(KEY); } catch (e) {}
            apply(mode);
        }
    };
})();
