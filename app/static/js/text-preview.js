// static/js/text-preview.js - the "open preview in a new tab" page.
// Shows either a snapshot of what was in the editor when the button was clicked (handed over through
// sessionStorage, with a short-lived localStorage copy as a fallback) or, when there is no snapshot, the shared
// buffer kept live. The tab title is fixed (see the template) so it is easy to spot among other tabs.
(function () {
    const HANDOFF_KEY = 'snailsynk.previewText';
    const HANDOFF_MAX_AGE_MS = 15000;   // a localStorage handoff is only trusted for this long

    const renderedView = document.getElementById('tpRenderedView');
    const rawView = document.getElementById('tpRawView');
    const sourceLabel = document.getElementById('tpSource');
    const btnRendered = document.getElementById('tpRendered');
    const btnRaw = document.getElementById('tpRaw');
    const btnCopy = document.getElementById('tpCopy');
    let currentText = '';
    let live = false;

    function show(text) {
        currentText = text || '';
        renderedView.innerHTML = window.SnailMarkdown.render(currentText);
        rawView.textContent = currentText;
    }

    function setMode(raw) {
        renderedView.hidden = raw;
        rawView.hidden = !raw;
        btnRendered.classList.toggle('active', !raw);
        btnRaw.classList.toggle('active', raw);
    }

    function readHandoff() {
        // sessionStorage is copied into a tab opened with window.open(), so it survives a refresh of this tab
        try {
            const own = sessionStorage.getItem(HANDOFF_KEY);
            if (own !== null) return JSON.parse(own).text;
        } catch (e) { /* ignore */ }
        try {
            const shared = JSON.parse(localStorage.getItem(HANDOFF_KEY) || 'null');
            if (shared && typeof shared.text === 'string' && Date.now() - shared.ts < HANDOFF_MAX_AGE_MS) {
                try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ text: shared.text })); } catch (e) { /* ignore */ }
                try { localStorage.removeItem(HANDOFF_KEY); } catch (e) { /* ignore */ }   // do not leave the text lying around
                return shared.text;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    async function useSharedBuffer() {
        live = true;
        try { sessionStorage.removeItem(HANDOFF_KEY); } catch (e) { /* ignore */ }
        sourceLabel.textContent = 'Shared buffer (live)';
        try {
            const response = await fetch('/api/shared-text');
            const result = await response.json();
            show(result.success ? result.text : '');
        } catch (err) {
            show('Could not load the shared buffer.');
        }
    }

    btnRendered.addEventListener('click', () => setMode(false));
    btnRaw.addEventListener('click', () => setMode(true));
    btnCopy.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(currentText);
        } catch (err) {   // clipboard API needs a secure context; fall back to selecting the raw text
            const ta = document.createElement('textarea');
            ta.value = currentText; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        const old = btnCopy.textContent;
        btnCopy.textContent = 'Copied!';
        setTimeout(() => { btnCopy.textContent = old; }, 1500);
    });

    // When showing the shared buffer, follow edits made on other devices
    if (typeof io === 'function') {
        io().on('text_updated', (data) => { if (live) show(data.text); });
    }

    const snapshot = readHandoff();
    if (snapshot !== null) {
        sourceLabel.textContent = 'Snapshot of your editor';
        show(snapshot);
    } else {
        useSharedBuffer();
    }
})();
