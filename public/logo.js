/**
 * logo.js — the truck's logo everywhere it appears (customer page, owner portal, QR sign).
 * A truck's "emoji" setting holds its logo: an emoji the owner picked, or empty = the universal
 * food-truck logo below. Change PRESETS to change the choices owners see in Settings.
 */
(function (root) {
    'use strict';

    // Universal food-truck mark. Uses the text color of wherever it's placed, so it works on dark and light.
    var TRUCK_SVG =
        '<svg viewBox="0 0 64 44" width="1em" height="1em" fill="currentColor" aria-hidden="true" style="width:1.4em;height:1.4em;display:block">' +
        '<rect x="3" y="8" width="38" height="25" rx="3.5"/>' +
        '<path d="M40 16h11.5a3 3 0 0 1 2.3 1.1l6.5 7.9a3 3 0 0 1 .7 1.9V31a2 2 0 0 1-2 2H40z"/>' +
        '<rect x="8" y="15" width="27" height="10" rx="1.5" fill="var(--logo-hole,#0a0a0b)"/>' +
        '<rect x="45" y="20" width="9" height="6" rx="1.2" fill="var(--logo-hole,#0a0a0b)"/>' +
        '<rect x="5" y="8" width="6" height="5" fill="var(--logo-hole,#0a0a0b)"/><rect x="17" y="8" width="6" height="5" fill="var(--logo-hole,#0a0a0b)"/><rect x="29" y="8" width="6" height="5" fill="var(--logo-hole,#0a0a0b)"/>' +
        '<circle cx="15" cy="34" r="6" fill="var(--logo-hole,#0a0a0b)"/><circle cx="15" cy="34" r="3.6"/>' +
        '<circle cx="50" cy="34" r="6" fill="var(--logo-hole,#0a0a0b)"/><circle cx="50" cy="34" r="3.6"/>' +
        '</svg>';

    // '' = the universal truck logo (default for every new truck).
    var PRESETS = ['', '🌮', '🌯', '🍔', '🍕', '🌭', '🍟', '🍗', '🍖', '🥩', '🍜', '🍣', '🥟', '🍛', '🥙', '🥪', '🥗', '🍤', '🦞', '🍩', '🧁', '🍦', '🥤', '🧋', '☕'];

    /** Puts the logo into an element. `hole` is the background color behind it (for the cut-outs).
        `brand` (optional, from the server): an uploaded logo wins, and its accent color rings the logo. */
    function setLogo(el, emoji, hole, brand) {
        if (!el) return;
        // The round frame the logo sits in (the element itself, or the circle around it).
        var ring = el.classList.contains('rounded-full') || el.classList.contains('sign-logo') ? el : (el.closest && el.closest('.rounded-full')) || el;
        ring.style.boxShadow = brand && /^#[0-9a-f]{6}$/i.test(brand.color || '') ? '0 0 0 3px ' + brand.color : '';
        if (brand && /^\/uploads\/[\w-]+\.(jpg|png|webp)$/.test(brand.logo || '')) {
            // An uploaded logo fills the circle edge to edge.
            if (ring !== el) { el.style.cssText += ';display:block;width:100%;height:100%;border-radius:50%;overflow:hidden'; ring.style.overflow = 'hidden'; }
            else el.style.overflow = 'hidden';
            el.innerHTML = '<img src="' + brand.logo + '" alt="" style="width:100%;height:100%;object-fit:cover;display:block">';
            return;
        }
        if (ring !== el) { el.style.display = ''; el.style.width = ''; el.style.height = ''; el.style.borderRadius = ''; }
        el.style.overflow = '';
        var e = String(emoji || '').trim();
        if (e) { el.textContent = e; return; }
        el.innerHTML = TRUCK_SVG;
        if (hole) el.style.setProperty('--logo-hole', hole);
    }

    root.TruckLogo = { svg: TRUCK_SVG, presets: PRESETS, set: setLogo };
})(this);
