// static/js/notes-editor.js - the notes editor: Markdown, Obsidian style.
//
// You type plain Markdown. On every line except the one you are working on, the Markdown marks (#, **, `, [](),
// > ...) are hidden and the text is shown formatted ("live preview"); click or move into a line and its marks
// appear so you can edit them. Task boxes are clickable, images and rules are drawn in place, [[Note names]] link to
// other notes (Ctrl/Cmd+click), and the eye / </> buttons switch to a rendered reading view or a plain source view.
//
// Built on CodeMirror 5 (vendored in static/vendor/codemirror). Notes written by the old rich-text editor are stored as
// HTML; contentToMarkdown() converts those the first time they are opened (Turndown, static/js/turndown.js).
//
//   const editor = NotesEditor.create(element, { onChange, onOpenLink, onSave, onModeChange })
//   editor.getValue() / setValue(markdown) / setMode('live'|'source'|'reading') / refresh() / focus() / setStatus(kind, text)
//   NotesEditor.contentToMarkdown(raw) -> { markdown, converted }      NotesEditor.renderMarkdown(markdown) -> safe HTML
(function () {
    'use strict';

    // ---------------------------------------------------------------------------------------------------------
    // Markdown <-> HTML helpers
    // ---------------------------------------------------------------------------------------------------------
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // Notes saved by the old editor are HTML (<p>, <h2>, <ul> ...). Plain Markdown never starts with a block tag.
    function looksLikeHtml(raw) {
        return /^\s*<(p|h[1-6]|ul|ol|blockquote|pre|div)[\s>\/]/i.test(raw || '');
    }

    function htmlToMarkdown(html) {
        if (typeof TurndownService === 'undefined') {
            const div = document.createElement('div');
            div.innerHTML = html;
            return div.textContent || '';
        }
        const td = new TurndownService({
            headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced',
            emDelimiter: '*', strongDelimiter: '**', hr: '---'
        });
        // the old editor's code blocks were bare <pre> elements
        td.addRule('barePre', {
            filter: (n) => n.nodeName === 'PRE' && !n.querySelector('code'),
            replacement: (c, n) => '\n\n```\n' + n.textContent.replace(/\n$/, '') + '\n```\n\n'
        });
        td.addRule('strike', { filter: ['s', 'strike', 'del'], replacement: (c) => '~~' + c + '~~' });
        td.addRule('underline', { filter: ['u'], replacement: (c) => '<u>' + c + '</u>' });
        // indented list items were flat <li class="ql-indent-N"> elements
        td.addRule('indentedItem', {
            filter: (n) => n.nodeName === 'LI' && /ql-indent-\d/.test(n.className || ''),
            replacement: (content, node, options) => {
                const depth = parseInt(node.className.match(/ql-indent-(\d)/)[1], 10);
                const parent = node.parentNode;
                const marker = parent && parent.nodeName === 'OL'
                    ? (Array.prototype.indexOf.call(parent.children, node) + 1) + '. ' : options.bulletListMarker + ' ';
                content = content.replace(/^\n+/, '').replace(/\n+$/, '').replace(/\n/g, '\n    ');
                return '    '.repeat(depth) + marker + content + '\n';
            }
        });
        return td.turndown(html.replace(/<p><br\s*\/?><\/p>/gi, '<p></p>')).trim() + '\n';
    }

    function contentToMarkdown(raw) {
        raw = raw || '';
        if (looksLikeHtml(raw)) return { markdown: htmlToMarkdown(raw), converted: true };
        return { markdown: raw, converted: false };
    }

    // A table pasted from a terminal (┌──┬──┐ │ a │ b │ ├──┼──┤) is not Markdown: left alone it becomes one paragraph whose
    // long unbreakable runs of "─" overflow the page. Put each run of such lines in a code block so it lines up.
    const BOX_RE = /[\u2500-\u257F]/;
    function fenceBoxTables(md) {
        const out = [];
        let fence = '', box = null;
        const flush = () => { if (box) { out.push('', '```box', ...box, '```', ''); box = null; } };
        String(md || '').split('\n').forEach((line) => {
            const f = FENCE_RE.exec(line);
            if (f && (!fence || f[1][0] === fence)) { flush(); fence = fence ? '' : f[1][0]; out.push(line); return; }
            if (!fence && BOX_RE.test(line)) { (box = box || []).push(line); return; }
            flush();
            out.push(line);
        });
        flush();
        return out.join('\n');
    }

    // "text" followed by "---" is a Markdown heading underline; here it is always meant as a rule, so separate them.
    const DASH_RULE_RE = /^ {0,3}-{3,}[ \t]*$/;
    function splitRules(md) {
        const out = [];
        let fence = '';
        String(md || '').split('\n').forEach((line, i, all) => {
            const f = FENCE_RE.exec(line);
            if (f && (!fence || f[1][0] === fence)) fence = fence ? '' : f[1][0];
            else if (!fence && DASH_RULE_RE.test(line) && i > 0 && all[i - 1].trim() !== '') out.push('');
            out.push(line);
        });
        return out.join('\n');
    }

    function renderMarkdown(md) {
        const withLinks = splitRules(fenceBoxTables(md)).replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g,
            (m, target, alias) => `<a class="wikilink" href="#" data-target="${esc(target.trim())}">${esc((alias || target).trim())}</a>`);
        const html = (typeof marked !== 'undefined') ? marked.parse(withLinks, { gfm: true, breaks: false }) : '<pre>' + esc(md) + '</pre>';
        const safe = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(html) : html;
        return safe.replace(/<pre><code class="language-box">/g, '<pre class="md-box"><code>');
    }

    // ---------------------------------------------------------------------------------------------------------
    // The editor
    // ---------------------------------------------------------------------------------------------------------
    const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/;
    const TASK_RE = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s/;
    const FENCE_RE = /^\s{0,3}(```+|~~~+)/;
    const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
    const IMG_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;

    const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
    const TOOLS = [
        { id: 'heading', label: 'H', title: 'Heading (cycles # ## ###)', cmd: 'heading' },
        { id: 'bold', label: '<b>B</b>', title: 'Bold (Ctrl+B)', cmd: 'bold' },
        { id: 'italic', label: '<i>I</i>', title: 'Italic (Ctrl+I)', cmd: 'italic' },
        { id: 'strike', label: '<s>S</s>', title: 'Strikethrough (Ctrl+Shift+X)', cmd: 'strike' },
        { sep: true },
        { id: 'code', icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', title: 'Inline code (Ctrl+E)', cmd: 'code' },
        { id: 'quote', icon: '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.76-2-2-2H4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2h4"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.76-2-2-2h-4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2h4"/>', title: 'Quote', cmd: 'quote' },
        { sep: true },
        { id: 'ul', icon: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>', title: 'Bullet list', cmd: 'ul' },
        { id: 'ol', icon: '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>', title: 'Numbered list', cmd: 'ol' },
        { id: 'task', icon: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>', title: 'Checklist', cmd: 'task' },
        { sep: true },
        { id: 'link', icon: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>', title: 'Link (Ctrl+K)', cmd: 'link' },
        { id: 'wiki', label: '[[ ]]', title: 'Link to another note', cmd: 'wiki' },
        { id: 'image', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>', title: 'Image', cmd: 'image' }
    ];

    function create(mount, options) {
        options = options || {};
        mount.classList.add('md-shell', 'md-mode-live');
        mount.innerHTML = '';

        // ---- DOM -------------------------------------------------------------------------------------------
        const bar = document.createElement('div');
        bar.className = 'md-fmt';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'Formatting');
        TOOLS.forEach((t) => {
            if (t.sep) { const s = document.createElement('span'); s.className = 'md-fmt-sep'; bar.appendChild(s); return; }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'md-fmt-btn';
            b.dataset.tool = t.id;
            b.title = t.title;
            b.setAttribute('aria-label', t.title);
            b.innerHTML = t.icon ? svg(t.icon) : `<span class="md-fmt-text">${t.label}</span>`;
            b.addEventListener('mousedown', (e) => e.preventDefault());   // keep the cursor in the text
            b.addEventListener('click', () => run(t.cmd));
            bar.appendChild(b);
        });

        const body = document.createElement('div');
        body.className = 'md-body';
        const host = document.createElement('div');
        host.className = 'md-cm';
        const reading = document.createElement('div');
        reading.className = 'md-reading';
        reading.hidden = true;
        body.append(host, reading);

        const status = document.createElement('div');
        status.className = 'md-status';
        status.innerHTML = '<span class="md-stats"></span><span class="md-save" data-kind="saved"><i></i><b>Saved</b></span>';
        const statsEl = status.querySelector('.md-stats');
        const saveEl = status.querySelector('.md-save');

        mount.append(bar, body, status);

        // ---- CodeMirror ------------------------------------------------------------------------------------
        const wikiOverlay = {
            token(stream) {
                const ch = stream.peek();
                if (ch === '[' && stream.match(/^\[\[[^\]\n]+\]\]/)) return 'wikilink';
                if (ch === '#' && (stream.pos === 0 || /\s/.test(stream.string.charAt(stream.pos - 1))) && stream.match(/^#[A-Za-z][\w\/-]*/)) return 'mdtag';
                stream.next();
                while (stream.peek() != null && stream.peek() !== '[' && stream.peek() !== '#') stream.next();
                return null;
            }
        };
        // the Markdown mode turns "text" + "---" into a heading; hide a dash line from its look-ahead so it stays a rule
        CodeMirror.defineMode('snailmd', (config) => {
            const base = CodeMirror.getMode(config, { name: 'markdown', highlightFormatting: true, fencedCodeBlockHighlighting: true, taskLists: true, strikethrough: true });
            const mode = Object.create(base);
            mode.token = (stream, state) => {
                const look = stream.lookAhead;
                stream.lookAhead = function (n) {
                    const next = look.call(this, n);
                    return typeof next === 'string' && DASH_RULE_RE.test(next) ? '\u200b' + next : next;
                };
                try { return base.token(stream, state); } finally { delete stream.lookAhead; }
            };
            return CodeMirror.overlayMode(mode, wikiOverlay);
        });

        const cm = CodeMirror(host, {
            value: '',
            mode: 'snailmd',
            theme: 'snail',
            lineWrapping: true,
            styleActiveLine: { nonEmpty: true },
            placeholder: 'Start writing. Use # for headings, - for lists, [[ ]] to link notes.',
            inputStyle: 'contenteditable',
            spellcheck: true,
            indentUnit: 4,
            tabSize: 4,
            indentWithTabs: false,
            extraKeys: {
                'Enter': 'newlineAndIndentContinueMarkdownList',
                'Tab': (c) => { if (c.somethingSelected() || LIST_RE.test(c.getLine(c.getCursor().line))) c.execCommand('indentMore'); else c.replaceSelection('    '); },
                'Shift-Tab': 'indentLess',
                'Ctrl-B': () => run('bold'), 'Cmd-B': () => run('bold'),
                'Ctrl-I': () => run('italic'), 'Cmd-I': () => run('italic'),
                'Ctrl-Shift-X': () => run('strike'), 'Cmd-Shift-X': () => run('strike'),
                'Ctrl-E': () => run('code'), 'Cmd-E': () => run('code'),
                'Ctrl-K': () => run('link'), 'Cmd-K': () => run('link'),
                'Ctrl-S': () => { if (options.onSave) options.onSave(); }, 'Cmd-S': () => { if (options.onSave) options.onSave(); }
            }
        });

        // ---- formatting commands --------------------------------------------------------------------------
        function wrap(before, after) {
            after = after === undefined ? before : after;
            const doc = cm.getDoc();
            const from = doc.getCursor('from'), to = doc.getCursor('to');
            const text = doc.getRange(from, to);
            cm.operation(() => {
                if (text.length >= before.length + after.length && text.startsWith(before) && text.endsWith(after)) {
                    // the selection includes the marks: take them off
                    doc.replaceRange(text.slice(before.length, text.length - after.length), from, to);
                    doc.setSelection(from, doc.posFromIndex(doc.indexFromPos(from) + text.length - before.length - after.length));
                    return;
                }
                const left = doc.getRange({ line: from.line, ch: Math.max(0, from.ch - before.length) }, from);
                const right = doc.getRange(to, { line: to.line, ch: to.ch + after.length });
                const beforeThat = doc.getRange({ line: from.line, ch: Math.max(0, from.ch - before.length - 1) }, { line: from.line, ch: Math.max(0, from.ch - before.length) });
                if (left === before && right === after && !(before === '*' && beforeThat === '*')) {
                    // the marks sit just outside the selection: take them off
                    const start = { line: from.line, ch: from.ch - before.length };
                    doc.replaceRange(text, start, { line: to.line, ch: to.ch + after.length });
                    doc.setSelection(start, doc.posFromIndex(doc.indexFromPos(start) + text.length));
                    return;
                }
                if (!text) {
                    doc.replaceRange(before + after, from);
                    doc.setCursor({ line: from.line, ch: from.ch + before.length });
                } else {
                    doc.replaceRange(before + text + after, from, to);
                    const s = { line: from.line, ch: from.ch + before.length };
                    doc.setSelection(s, doc.posFromIndex(doc.indexFromPos(s) + text.length));
                }
            });
            cm.focus();
        }

        function selectedLines() {
            const out = new Set();
            cm.listSelections().forEach((r) => {
                const a = Math.min(r.anchor.line, r.head.line), b = Math.max(r.anchor.line, r.head.line);
                for (let i = a; i <= b; i++) out.add(i);
            });
            return Array.from(out).sort((x, y) => x - y);
        }

        const stripPrefix = (t) => t.replace(/^(\s*)(?:>\s?|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/, '$1');
        const KIND_TEST = {
            ul: (t) => /^\s*[-*+]\s+(?!\[[ xX]\]\s)/.test(t),
            ol: (t) => /^\s*\d+[.)]\s+/.test(t),
            task: (t) => /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s/.test(t),
            quote: (t) => /^\s*>/.test(t)
        };

        function linePrefix(kind) {
            const lines = selectedLines();
            const allHave = lines.every((n) => KIND_TEST[kind](cm.getLine(n)));
            cm.operation(() => {
                lines.forEach((n, i) => {
                    const text = cm.getLine(n);
                    const indent = (/^\s*/.exec(text) || [''])[0];
                    const rest = stripPrefix(text).slice(indent.length);
                    let next;
                    if (allHave) next = indent + rest;
                    else if (kind === 'ul') next = indent + '- ' + rest;
                    else if (kind === 'ol') next = indent + (i + 1) + '. ' + rest;
                    else if (kind === 'task') next = indent + '- [ ] ' + rest;
                    else next = '> ' + rest;
                    cm.replaceRange(next, { line: n, ch: 0 }, { line: n, ch: text.length });
                });
            });
            cm.focus();
        }

        function cycleHeading() {
            cm.operation(() => {
                selectedLines().forEach((n) => {
                    const text = cm.getLine(n);
                    const m = /^(#{1,6})\s+/.exec(text);
                    const level = m ? m[1].length : 0;
                    const next = level === 0 ? '# ' : (level >= 3 ? '' : '#'.repeat(level + 1) + ' ');
                    cm.replaceRange(next + text.replace(/^#{1,6}\s+/, ''), { line: n, ch: 0 }, { line: n, ch: text.length });
                });
            });
            cm.focus();
        }

        function insertLink(image) {
            const sel = cm.getSelection();
            const doc = cm.getDoc();
            const from = doc.getCursor('from');
            const lead = image ? '![' : '[';
            const text = sel || (image ? 'alt text' : 'link text');
            const snippet = `${lead}${text}](https://)`;
            cm.replaceSelection(snippet);
            // select the address so it can be typed straight over
            const startUrl = doc.indexFromPos(from) + lead.length + text.length + 2;
            doc.setSelection(doc.posFromIndex(startUrl), doc.posFromIndex(startUrl + 'https://'.length));
            cm.focus();
        }

        function run(cmd) {
            if (api.getMode() === 'reading') return;
            switch (cmd) {
                case 'heading': return cycleHeading();
                case 'bold': return wrap('**');
                case 'italic': return wrap('*');
                case 'strike': return wrap('~~');
                case 'code': return wrap('`');
                case 'quote': return linePrefix('quote');
                case 'ul': return linePrefix('ul');
                case 'ol': return linePrefix('ol');
                case 'task': return linePrefix('task');
                case 'link': return insertLink(false);
                case 'image': return insertLink(true);
                case 'wiki': return wrap('[[', ']]');
            }
        }

        // ---- live preview: line classes + widgets ---------------------------------------------------------
        const marks = [];
        const lineClasses = [];
        let mode = 'live';
        let scheduled = false;

        function addClass(line, where, cls) {
            lineClasses.push([cm.addLineClass(line, where, cls), where, cls]);
        }

        function clearDecorations() {
            marks.splice(0).forEach((m) => m.clear());
            lineClasses.splice(0).forEach(([h, w, c]) => cm.removeLineClass(h, w, c));
        }

        function widgetTask(line) {
            const el = document.createElement('span');
            el.className = 'md-task';
            el.setAttribute('role', 'checkbox');
            el.addEventListener('mousedown', (e) => e.preventDefault());
            el.addEventListener('click', (e) => {
                e.preventDefault();
                const text = cm.getLine(line);
                const m = TASK_RE.exec(text);
                if (!m) return;
                const at = m[1].length + m[2].length + 1 + 1;   // indent + marker + space + "["
                cm.replaceRange(m[3] === ' ' ? 'x' : ' ', { line, ch: at }, { line, ch: at + 1 });
            });
            return el;
        }

        function decorate() {
            scheduled = false;
            cm.operation(() => {
                clearDecorations();
                const doc = cm.getDoc();
                const last = doc.lastLine();

                // fenced code blocks (whole document: they decide what the other lines mean)
                const inCode = new Set();
                let open = -1, marker = '';
                for (let i = 0; i <= last; i++) {
                    const m = FENCE_RE.exec(doc.getLine(i));
                    if (!m) continue;
                    if (open < 0) { open = i; marker = m[1][0]; }
                    else if (m[1][0] === marker) {
                        for (let j = open; j <= i; j++) { inCode.add(j); addClass(j, 'wrap', 'cm-codeblock'); }
                        addClass(open, 'wrap', 'cm-codeblock-first');
                        addClass(i, 'wrap', 'cm-codeblock-last');
                        open = -1;
                    }
                }
                if (open >= 0) {
                    for (let j = open; j <= last; j++) { inCode.add(j); addClass(j, 'wrap', 'cm-codeblock'); }
                    addClass(open, 'wrap', 'cm-codeblock-first');
                    addClass(last, 'wrap', 'cm-codeblock-last');
                }

                const view = cm.getViewport();
                const active = new Set(selectedLines());
                for (let i = view.from; i < view.to; i++) {
                    if (inCode.has(i)) continue;
                    const text = doc.getLine(i);
                    if (text === undefined) continue;
                    if (/^\s{0,3}>/.test(text)) addClass(i, 'text', 'cm-quoteline');
                    if (BOX_RE.test(text)) addClass(i, 'text', 'cm-boxline');
                    if (mode !== 'live' || active.has(i)) continue;

                    const task = TASK_RE.exec(text);
                    if (task) {
                        const at = task[1].length + task[2].length + 1;
                        const el = widgetTask(i);
                        if (task[3] !== ' ') el.classList.add('is-checked');
                        el.setAttribute('aria-checked', task[3] !== ' ' ? 'true' : 'false');
                        marks.push(doc.markText({ line: i, ch: at }, { line: i, ch: at + 3 }, { replacedWith: el }));
                        addClass(i, 'text', 'cm-taskline');
                        continue;
                    }
                    if (HR_RE.test(text)) {
                        const el = document.createElement('div');
                        el.className = 'md-hr';
                        el.innerHTML = '<hr>';
                        marks.push(doc.markText({ line: i, ch: 0 }, { line: i, ch: text.length }, { replacedWith: el }));
                        continue;
                    }
                    const img = IMG_RE.exec(text.trim());
                    if (img && /^(https?:|data:image\/|\/)/i.test(img[2])) {
                        const el = document.createElement('span');
                        el.className = 'md-img';
                        const im = document.createElement('img');
                        im.alt = img[1];
                        im.src = img[2];
                        im.addEventListener('error', () => { el.classList.add('is-broken'); el.textContent = img[1] || 'Image could not be loaded'; });
                        el.appendChild(im);
                        marks.push(doc.markText({ line: i, ch: 0 }, { line: i, ch: text.length }, { replacedWith: el }));
                    }
                }
            });
        }

        function scheduleDecorate() {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(decorate);
        }

        // ---- toolbar state and statistics -----------------------------------------------------------------
        let statsTimer = null;
        function updateBar() {
            const cur = cm.getCursor('head');
            const line = cm.getLine(cur.line) || '';
            const type = ' ' + (cm.getTokenTypeAt(cur) || '') + ' ';
            const on = {
                heading: /^#{1,6}\s/.test(line),
                bold: /\sstrong\s/.test(type),
                italic: /\sem\s/.test(type),
                strike: /\sstrikethrough\s/.test(type),
                code: /\scomment\s/.test(type) && !/^\s*(```|~~~)/.test(line),
                quote: KIND_TEST.quote(line),
                ul: KIND_TEST.ul(line),
                ol: KIND_TEST.ol(line),
                task: KIND_TEST.task(line),
                link: /\slink\s/.test(type),
                wiki: /\swikilink\s/.test(type)
            };
            bar.querySelectorAll('.md-fmt-btn').forEach((b) => {
                const state = !!on[b.dataset.tool];
                b.classList.toggle('is-on', state);
                b.setAttribute('aria-pressed', state ? 'true' : 'false');
            });
        }

        function updateStats() {
            const text = cm.getValue();
            const words = (text.match(/\S+/g) || []).length;
            const cur = cm.getCursor();
            statsEl.textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${text.length.toLocaleString()} characters · Ln ${cur.line + 1}, Col ${cur.ch + 1}`;
        }

        // ---- numbered lists keep their numbers (like Word) ----------------------------------------------------
        // Delete an item from the middle of a numbered list and the items after it close the gap (1 2 4 5 -> 1 2 3 4).
        // It only happens when the list was a clean 1, 2, 3... run before the deletion, so numbers the user chose
        // themselves are left alone, and undoing the fix (Ctrl+Z) keeps it undone: undo/redo never trigger it.
        const ORDERED_ITEM_RE = /^(\s*)(\d+)([.)])\s/;
        const orderedItem = (n) => {
            const m = n >= 0 && n < cm.lineCount() ? ORDERED_ITEM_RE.exec(cm.getLine(n)) : null;
            return m ? { line: n, indent: m[1], num: parseInt(m[2], 10) } : null;
        };

        // the numbered items of the list that line `seed` belongs to (same indent; nested lines and blank lines are skipped over)
        function listRun(seed) {
            const first = orderedItem(seed);
            if (!first) return null;
            const indentOf = (t) => (/^\s*/.exec(t) || [''])[0];
            const scan = (from, step) => {
                const found = [];
                for (let n = from; n >= 0 && n < cm.lineCount(); n += step) {
                    const text = cm.getLine(n);
                    if (!text.trim()) continue;
                    const item = orderedItem(n);
                    if (item && item.indent === first.indent) { found.push(item); continue; }
                    if (indentOf(text).length > first.indent.length) continue;   // nested or continued under an item
                    break;
                }
                return found;
            };
            const before = scan(seed - 1, -1).reverse();
            const after = scan(seed + 1, 1);
            return [...before, first, ...after];
        }

        function renumberAfterDelete(change) {
            if (!change.removed || change.removed.length < 2) return;   // no line went away
            const at = change.from.line;
            for (const seed of [at + 1, at]) {
                const run = listRun(seed);
                if (!run || run.length < 2) continue;
                // where the numbers jump: that is where the deleted item was
                const jumps = [];
                for (let i = 1; i < run.length; i++) if (run[i].num !== run[i - 1].num + 1) jumps.push(i);
                let fixFrom = -1, start = 0;
                if (jumps.length === 1 && run[jumps[0]].num > run[jumps[0] - 1].num + 1 && run[jumps[0]].line <= at + 1) {
                    // if numbered items were deleted, the next one has to be exactly the number after them, or the user had
                    // numbered the list their own way and it stays as it is
                    const gone = change.removed.map((t) => ORDERED_ITEM_RE.exec(t)).filter((m) => m && m[1] === run[0].indent);
                    if (gone.length && parseInt(gone[gone.length - 1][2], 10) + 1 !== run[jumps[0]].num) continue;
                    fixFrom = jumps[0];
                    start = run[fixFrom - 1].num + 1;
                } else if (jumps.length === 0 && run[0].line <= at + 1) {
                    // the top of the list went: the next item takes the number the first deleted one had
                    const lost = change.removed.map((t) => ORDERED_ITEM_RE.exec(t)).find((m) => m && m[1] === run[0].indent);
                    if (lost && parseInt(lost[2], 10) < run[0].num) { fixFrom = 0; start = parseInt(lost[2], 10); }
                }
                if (fixFrom < 0) continue;
                cm.operation(() => {
                    for (let i = fixFrom; i < run.length; i++) {
                        const want = start + (i - fixFrom);
                        if (run[i].num === want) continue;
                        const ch = run[i].indent.length;
                        cm.replaceRange(String(want), { line: run[i].line, ch }, { line: run[i].line, ch: ch + String(run[i].num).length }, 'renumber');
                    }
                });
                return;
            }
        }

        cm.on('changes', (_cm, changes) => {
            if (cm.isReadOnly()) return;
            const edit = changes.find((c) => !['setValue', 'undo', 'redo', 'renumber'].includes(c.origin) && c.removed && c.removed.length > 1);
            if (!edit) return;
            // not inside the event: the document may not be changed from within its own change handlers
            Promise.resolve().then(() => renumberAfterDelete(edit));
        });

        let silent = false;
        cm.on('change', () => {
            scheduleDecorate();
            clearTimeout(statsTimer);
            statsTimer = setTimeout(updateStats, 150);
            if (!silent && options.onChange) options.onChange();
        });
        cm.on('cursorActivity', () => { scheduleDecorate(); updateBar(); updateStats(); });
        cm.on('viewportChange', scheduleDecorate);

        // Ctrl/Cmd+click on [[Note name]] opens that note
        cm.getWrapperElement().addEventListener('click', (e) => {
            if (!(e.ctrlKey || e.metaKey) || !options.onOpenLink) return;
            const pos = cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
            const text = cm.getLine(pos.line) || '';
            const re = /\[\[([^\]\n|]+)(?:\|[^\]\n]+)?\]\]/g;
            let m;
            while ((m = re.exec(text))) {
                if (pos.ch >= m.index && pos.ch <= m.index + m[0].length) {
                    e.preventDefault();
                    options.onOpenLink(m[1].trim());
                    return;
                }
            }
        });

        // reading view: [[links]] open the note, other links open in a new tab
        reading.addEventListener('click', (e) => {
            const a = e.target.closest('a');
            if (!a) return;
            if (a.classList.contains('wikilink')) {
                e.preventDefault();
                if (options.onOpenLink) options.onOpenLink(a.dataset.target);
            }
        });

        // ---- reading view: render, and let columns be resized like in Excel (drag the edge of a header) -------
        function addColumnResizers() {
            reading.querySelectorAll('table').forEach((table) => {
                const heads = Array.from(table.querySelectorAll('thead th'));
                if (!heads.length) return;
                const rows = Array.from(table.rows);
                const widthOf = (th) => Math.round(th.getBoundingClientRect().width);
                const setWidth = (col, px) => rows.forEach((r) => {
                    const c = r.cells[col];
                    if (!c) return;
                    const v = px ? px + 'px' : '';
                    c.style.width = v; c.style.minWidth = v; c.style.maxWidth = v;
                });
                let frozen = false;
                const freeze = () => {   // pin every column where it is, so only the dragged one moves
                    if (frozen) return;
                    frozen = true;
                    const w = heads.map(widthOf);
                    heads.forEach((h, i) => setWidth(i, w[i]));
                    table.classList.add('is-sized');
                };
                heads.forEach((th, col) => {
                    const grip = document.createElement('span');
                    grip.className = 'md-col-grip';
                    grip.title = 'Drag to resize. Double-click to fit the contents.';
                    grip.addEventListener('pointerdown', (e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        freeze();
                        const startX = e.clientX, startW = widthOf(th);
                        grip.setPointerCapture(e.pointerId);
                        grip.classList.add('is-dragging');
                        const move = (ev) => setWidth(col, Math.max(40, Math.round(startW + ev.clientX - startX)));
                        const up = () => {
                            grip.classList.remove('is-dragging');
                            grip.removeEventListener('pointermove', move);
                            grip.removeEventListener('pointerup', up);
                            grip.removeEventListener('pointercancel', up);
                        };
                        grip.addEventListener('pointermove', move);
                        grip.addEventListener('pointerup', up);
                        grip.addEventListener('pointercancel', up);
                    });
                    grip.addEventListener('dblclick', () => {   // fit to the longest cell, like Excel's auto-fit
                        freeze();
                        setWidth(col, 0);
                        rows.forEach((r) => { if (r.cells[col]) r.cells[col].style.whiteSpace = 'nowrap'; });
                        const fit = widthOf(th);
                        rows.forEach((r) => { if (r.cells[col]) r.cells[col].style.whiteSpace = ''; });
                        setWidth(col, Math.min(fit, 700));
                    });
                    th.appendChild(grip);
                });
            });
        }

        // ---- smooth mouse-wheel scrolling (notches become a glide; trackpads are already smooth, so left alone)
        function smoothWheel(el) {
            let target = 0, raf = 0;
            const step = () => {
                const diff = target - el.scrollTop;
                if (Math.abs(diff) < 0.5) { el.scrollTop = target; raf = 0; return; }
                el.scrollTop += diff * 0.18;
                raf = requestAnimationFrame(step);
            };
            el.addEventListener('wheel', (e) => {
                if (e.ctrlKey || e.shiftKey || e.deltaMode !== 0 || Math.abs(e.deltaY) < 50 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
                const max = el.scrollHeight - el.clientHeight;
                if (max <= 0) return;
                if (!raf) target = el.scrollTop;
                const next = Math.max(0, Math.min(max, target + e.deltaY));
                if (next === target && (next === 0 || next === max)) return;   // at an end: let the page react normally
                e.preventDefault();
                e.stopImmediatePropagation();   // CodeMirror's own wheel handler must not scroll as well
                target = next;
                if (!raf) raf = requestAnimationFrame(step);
            }, { passive: false, capture: true });
        }
        smoothWheel(cm.getScrollerElement());
        smoothWheel(reading);

        function renderReading() {
            reading.innerHTML = renderMarkdown(cm.getValue());
            reading.querySelectorAll('a:not(.wikilink)').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
            addColumnResizers();
        }

        // ---- public API ------------------------------------------------------------------------------------
        const api = {
            cm,
            getValue: () => cm.getValue(),
            setValue(markdown) {
                silent = true;
                cm.setValue(markdown || '');
                cm.clearHistory();
                cm.setCursor({ line: 0, ch: 0 });
                silent = false;
                if (mode === 'reading') renderReading();
                scheduleDecorate();
                updateStats();
                updateBar();
            },
            focus: () => cm.focus(),
            refresh() { cm.refresh(); scheduleDecorate(); },
            getMode: () => mode,
            setMode(next) {
                if (next === mode) return;
                mode = next;
                mount.classList.remove('md-mode-live', 'md-mode-source', 'md-mode-reading');
                mount.classList.add('md-mode-' + next);
                const isReading = next === 'reading';
                reading.hidden = !isReading;
                host.hidden = isReading;
                bar.hidden = isReading;
                if (isReading) {
                    renderReading();
                    reading.scrollTop = 0;
                } else {
                    cm.refresh();
                    scheduleDecorate();
                }
                if (options.onModeChange) options.onModeChange(next);
            },
            // kind: 'saved' | 'dirty' | 'saving' | 'info'
            setStatus(kind, text) {
                saveEl.dataset.kind = kind;
                saveEl.querySelector('b').textContent = text || ({ saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving...', info: '' }[kind] || '');
            }
        };

        setTimeout(() => { updateStats(); updateBar(); }, 0);
        return api;
    }

    window.NotesEditor = { create, contentToMarkdown, renderMarkdown, htmlToMarkdown };
})();
