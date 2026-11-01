// static/js/background-fx.js - the animated background (see background-fx.css).
//   computer: eases a spotlight and a grid highlight toward the mouse. Every per-move update is a GPU transform (or a
//             repaint of one small box), and the animation frame loop only runs while something is still moving, so an
//             idle page costs nothing.
//   phone / tablet: the glows are drawn and drifted by CSS alone; this file only creates them.
// Which one you see is decided in the stylesheet (touch / narrow screen vs mouse), so resizing or rotating just works.
(function () {
    if (document.getElementById('bgfx')) return;
    var root = document.createElement('div');
    root.id = 'bgfx';
    root.className = 'bgfx';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML =
        '<div class="bgfx-orb-wrap a"><div class="bgfx-orb"></div></div>' +
        '<div class="bgfx-orb-wrap b"><div class="bgfx-orb"></div></div>' +
        '<div class="bgfx-orb-wrap c"><div class="bgfx-orb"></div></div>' +
        '<div class="bgfx-grid"></div>' +
        '<div class="bgfx-glow"></div>';
    document.body.insertBefore(root, document.body.firstChild);

    var glow = root.querySelector('.bgfx-glow');
    var grid = root.querySelector('.bgfx-grid');
    var GRID_BOX = 480;                                   // keep in sync with .bgfx-grid in background-fx.css
    var target = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    var current = { x: target.x, y: target.y };
    var running = false;

    function frame() {
        // ease toward the pointer: ~12% of the remaining distance per frame feels soft rather than glued on
        current.x += (target.x - current.x) * 0.12;
        current.y += (target.y - current.y) * 0.12;
        glow.style.transform = 'translate3d(' + current.x.toFixed(1) + 'px,' + current.y.toFixed(1) + 'px,0)';
        // grid highlight: whole-pixel position so the lines stay crisp, and the pattern shifted so its lines stay
        // exactly on the page's own 20px grid wherever the box is
        var gx = Math.round(current.x) - GRID_BOX / 2, gy = Math.round(current.y) - GRID_BOX / 2;
        grid.style.transform = 'translate3d(' + gx + 'px,' + gy + 'px,0)';
        grid.style.backgroundPosition = (((-gx % 20) + 20) % 20) + 'px ' + (((-gy % 20) + 20) % 20) + 'px';
        if (Math.abs(target.x - current.x) > 0.3 || Math.abs(target.y - current.y) > 0.3) {
            requestAnimationFrame(frame);
        } else {
            running = false;                              // settled: stop until the mouse moves again
        }
    }

    // (This runs even when the OS asks for "reduce motion": it only moves while you move the mouse, which is you
    // choosing to move it. The drifting glows are the part that holds still for those users, in the stylesheet.)
    window.addEventListener('pointermove', function (e) {
        if (e.pointerType && e.pointerType !== 'mouse') return;   // fingers and pens don't get a spotlight
        target.x = e.clientX;
        target.y = e.clientY;
        if (!root.classList.contains('active')) {
            current.x = target.x; current.y = target.y;           // first move: appear in place instead of flying in
            root.classList.add('active');
        }
        if (!running) { running = true; requestAnimationFrame(frame); }
    }, { passive: true });

    // when the pointer leaves the window, fade the cursor effects out; they return on the next move
    document.addEventListener('mouseleave', function () { root.classList.remove('active'); });
})();
