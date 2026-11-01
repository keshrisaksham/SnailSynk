// static/js/accent-boot.js - picks the accent colour class for <html> before the page paints.
// Load it synchronously in <head> with data-mode:
//   fresh   - a new random colour on every load (the main app); remembered for this tab so other pages can follow it
//   follow  - the colour the main app showed this tab, else the saved one (admin pages, text preview)
//   either  - like follow, but a random colour when nothing was shown yet (admin login, opened directly)
// A colour the visitor picked themselves (accentMode = fixed) always wins.
(function () {
    var POOL = ['red', 'blue', 'green', 'purple', 'orange'];
    var mode = (document.currentScript && document.currentScript.dataset.mode) || 'follow';
    var accent = 'red';
    try {
        accent = localStorage.getItem('accent') || 'red';
        if (localStorage.getItem('accentMode') !== 'fixed') {
            var shared = sessionStorage.getItem('accentSession');
            if (mode === 'fresh' || (mode === 'either' && !shared)) {
                accent = POOL[Math.floor(Math.random() * POOL.length)];
                sessionStorage.setItem('accentSession', accent);
            } else if (shared && POOL.indexOf(shared) !== -1) {
                accent = shared;
            }
        }
    } catch (e) { /* storage blocked - keep the default */ }
    document.documentElement.classList.add('accent-' + accent);
})();
