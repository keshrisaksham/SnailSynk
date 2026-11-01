/**
 * BugByte Chat — static/js/chat.js
 * Full-featured AI chat interface with streaming, conversation management,
 * code blocks, math rendering, and funny bug-themed loading messages.
 */
document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    // ─── Admin Check ─────────────────────────────────────────────────────────
    const bbApp = document.querySelector('.bugbyte-app');
    const isAdmin = bbApp && bbApp.dataset.isAdmin === 'true';

    // ─── DOM References ──────────────────────────────────────────────────────
    const sidebar = document.getElementById('bbSidebar');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const newChatBtn = document.getElementById('newChatBtn');
    const convSearchInput = document.getElementById('convSearchInput');
    const convList = document.getElementById('convList');
    const messagesEl = document.getElementById('bbMessages');
    const welcomeEl = document.getElementById('bbWelcome');
    const input = document.getElementById('bbInput');
    const sendBtn = document.getElementById('bbSendBtn');
    const stopBtn = document.getElementById('bbStopBtn');
    const scrollBtn = document.getElementById('scrollBottomBtn');
    const imageBtn = document.getElementById('bbImageBtn');
    const imageInput = document.getElementById('bbImageInput');
    const imagePreview = document.getElementById('bbImagePreview');

    // ─── State ───────────────────────────────────────────────────────────────
    let currentConvId = null;
    let conversations = [];
    let messages = [];           // { role: 'user'|'ai', text: string }
    let isStreaming = false;
    let abortController = null;
    let autoScroll = true;
    let pendingImages = [];      // { name, base64, mimeType, dataUrl }

    // Funky bug loading messages
    const BUG_MESSAGES = [
        "🐛 Bugs are crawling through the code...",
        "🐜 Ants marching through your query...",
        "🐞 Beetles digging for answers...",
        "🦗 Crickets chirping while I think...",
        "🐝 Bees buzzing through the knowledge base...",
        "🕷️ Spiders weaving a response web...",
        "🐞 Ladybugs debugging your question...",
        "🦗 Mosquitos nibbling on the data...",
        "🐜 Cockroaches speed-reading the docs...",
        "🐜🐜🐜 Bug army assembling your answer...",
        "🦋 Caterpillar evolving into a response...",
        "🐛 Worms tunneling through databases...",
        "🐞 Dung beetles rolling up your answer...",
        "🕷️ Charlotte is writing your response...",
        "🐝 Honey, I'm cooking up a response!",
        "🐞 Bug squad is on the case!",
        "🐛 Inch-worming towards an answer...",
        "🦗 Cricket symphony while processing...",
        "🐞 Scarab beetles decrypting the knowledge...",
        "🐜 Fire ants igniting the AI neurons..."
    ];

    function getRandomBugMessage() {
        return BUG_MESSAGES[Math.floor(Math.random() * BUG_MESSAGES.length)];
    }

    // ─── Sidebar Toggle (Mobile) ─────────────────────────────────────────────
    let backdrop = document.querySelector('.bb-sidebar-backdrop');
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.className = 'bb-sidebar-backdrop';
        document.querySelector('.bugbyte-app').appendChild(backdrop);
    }

    function toggleSidebar() {
        if (sidebar) sidebar.classList.toggle('open');
        backdrop.classList.toggle('active');
    }

    if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebar);
    backdrop.addEventListener('click', () => {
        sidebar.classList.remove('open');
        backdrop.classList.remove('active');
    });

    // ─── Auto-Expanding Textarea ─────────────────────────────────────────────
    function autoResize() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    }

    input.addEventListener('input', autoResize);

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // ─── Image Upload & Paste ────────────────────────────────────────────────
    function readFileAsBase64(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result;
                const base64 = dataUrl.split(',')[1];
                resolve({ name: file.name, base64, mimeType: file.type, dataUrl });
            };
            reader.readAsDataURL(file);
        });
    }

    function renderImagePreview() {
        if (!imagePreview) return;
        imagePreview.innerHTML = '';
        if (pendingImages.length === 0) {
            imagePreview.style.display = 'none';
            return;
        }
        imagePreview.style.display = 'flex';
        pendingImages.forEach((img, idx) => {
            const item = document.createElement('div');
            item.className = 'bb-image-preview-item';
            item.innerHTML = `
                <img src="${img.dataUrl}" alt="${escapeHtml(img.name)}">
                <button class="bb-image-preview-remove" title="Remove">×</button>
            `;
            item.querySelector('.bb-image-preview-remove').addEventListener('click', () => {
                pendingImages.splice(idx, 1);
                renderImagePreview();
            });
            imagePreview.appendChild(item);
        });
    }

    async function addFiles(files) {
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            if (pendingImages.length >= 5) break; // max 5 images
            const imgData = await readFileAsBase64(file);
            pendingImages.push(imgData);
        }
        renderImagePreview();
    }

    if (imageBtn && imageInput) {
        imageBtn.addEventListener('click', () => imageInput.click());
        imageInput.addEventListener('change', () => {
            if (imageInput.files.length > 0) addFiles(imageInput.files);
            imageInput.value = ''; // reset so same file can be re-selected
        });
    }

    // Paste images from clipboard
    input.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const imageFiles = [];
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) imageFiles.push(file);
            }
        }
        if (imageFiles.length > 0) {
            e.preventDefault();
            addFiles(imageFiles);
        }
    });

    // ─── Scroll Management ───────────────────────────────────────────────────
    messagesEl.addEventListener('scroll', () => {
        const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
        autoScroll = distFromBottom < 60;
        scrollBtn.classList.toggle('visible', distFromBottom > 200);
    });

    scrollBtn.addEventListener('click', () => {
        messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
        autoScroll = true;
        scrollBtn.classList.remove('visible');
    });

    function scrollToBottom() {
        if (autoScroll) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    // ─── Markdown Rendering ──────────────────────────────────────────────────
    /**
     * Render markdown text, handling code blocks with syntax highlighting,
     * and math expressions with KaTeX.
     */
    function renderMarkdown(text) {
        // First extract code blocks to protect them
        const codeBlocks = [];
        let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const idx = codeBlocks.length;
            codeBlocks.push({ lang: lang || 'text', code: code.trimEnd() });
            return `%%CODEBLOCK_${idx}%%`;
        });

        // Extract math blocks
        const mathBlocks = [];
        processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
            const idx = mathBlocks.length;
            mathBlocks.push({ display: true, expr: math.trim() });
            return `%%MATHBLOCK_${idx}%%`;
        });
        processed = processed.replace(/\$([^\$\n]+)\$/g, (_, math) => {
            const idx = mathBlocks.length;
            mathBlocks.push({ display: false, expr: math.trim() });
            return `%%MATHBLOCK_${idx}%%`;
        });

        // Use marked.js if available
        let html;
        if (typeof marked !== 'undefined') {
            marked.setOptions({ breaks: true, gfm: true });
            html = sanitizeHtml(marked.parse(processed));
        } else {
            html = processed.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        }

        // Restore code blocks with fancy wrappers
        html = html.replace(/%%CODEBLOCK_(\d+)%%/g, (_, idx) => {
            const block = codeBlocks[parseInt(idx)];
            let highlighted;
            try {
                if (typeof hljs !== 'undefined' && block.lang !== 'text') {
                    highlighted = hljs.highlight(block.code, { language: block.lang, ignoreIllegals: true }).value;
                } else {
                    highlighted = escapeHtml(block.code);
                }
            } catch {
                highlighted = escapeHtml(block.code);
            }

            return `<div class="bb-code-block">
                <div class="bb-code-header">
                    <span class="bb-code-lang">${escapeHtml(block.lang)}</span>
                    <button class="bb-copy-code-btn" onclick="window._bbCopyCode(this)" data-code="${encodeURIComponent(block.code)}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        <span>Copy</span>
                    </button>
                </div>
                <pre><code class="language-${escapeHtml(block.lang)}">${highlighted}</code></pre>
            </div>`;
        });

        // Restore math blocks
        html = html.replace(/%%MATHBLOCK_(\d+)%%/g, (_, idx) => {
            const block = mathBlocks[parseInt(idx)];
            try {
                if (typeof katex !== 'undefined') {
                    return katex.renderToString(block.expr, {
                        displayMode: block.display,
                        throwOnError: false
                    });
                }
            } catch (e) {
                console.warn('KaTeX error:', e);
            }
            return block.display ? `<div class="katex-display">${escapeHtml(block.expr)}</div>` : `<code>${escapeHtml(block.expr)}</code>`;
        });

        return html;
    }

    // Untrusted markdown output is sanitized before our own (trusted) code/math blocks are re-inserted.
    function sanitizeHtml(html) {
        if (typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(html);
        return escapeHtml(html);
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Global copy code handler
    window._bbCopyCode = function (btn) {
        const code = decodeURIComponent(btn.dataset.code);
        navigator.clipboard.writeText(code).then(() => {
            const span = btn.querySelector('span');
            span.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => {
                span.textContent = 'Copy';
                btn.classList.remove('copied');
            }, 2000);
        });
    };

    // ─── Message Rendering ───────────────────────────────────────────────────
    function renderMessage(role, text, options = {}) {
        // Hide welcome screen
        if (welcomeEl) welcomeEl.style.display = 'none';

        const msg = document.createElement('div');
        msg.className = `bb-msg ${role}`;
        if (options.id) msg.dataset.msgId = options.id;

        const bubble = document.createElement('div');
        bubble.className = 'bb-msg-bubble';

        // Show images in user messages
        if (role === 'user' && options.images && options.images.length > 0) {
            const imgContainer = document.createElement('div');
            imgContainer.className = 'bb-msg-images';
            options.images.forEach(img => {
                const imgEl = document.createElement('img');
                imgEl.src = img.dataUrl;
                imgEl.alt = img.name || 'Attached image';
                imgContainer.appendChild(imgEl);
            });
            bubble.appendChild(imgContainer);
        }

        if (role === 'ai') {
            bubble.innerHTML = `<div class="md-content">${renderMarkdown(text)}</div>`;
        } else {
            const textNode = document.createElement('span');
            textNode.textContent = text;
            bubble.appendChild(textNode);
        }

        // Actions
        const actions = document.createElement('div');
        actions.className = 'bb-msg-actions';

        // Copy button — reads rendered text from the bubble so it works for streamed messages too
        const copyBtn = createActionBtn('Copy', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`);
        copyBtn.addEventListener('click', () => {
            const textToCopy = bubble.innerText || bubble.textContent || text;
            navigator.clipboard.writeText(textToCopy).then(() => {
                copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
                setTimeout(() => {
                    copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
                }, 2000);
            });
        });
        actions.appendChild(copyBtn);

        if (role === 'user') {
            // Edit button
            const editBtn = createActionBtn('Edit', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`);
            editBtn.addEventListener('click', () => editMessage(msg, text));
            actions.appendChild(editBtn);
        }

        if (role === 'ai' && !options.streaming) {
            // Regenerate button
            const regenBtn = createActionBtn('Regenerate', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`);
            regenBtn.addEventListener('click', () => regenerateResponse(msg));
            actions.appendChild(regenBtn);
        }

        // Timestamp
        const time = document.createElement('div');
        time.className = 'bb-msg-time';
        time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        msg.appendChild(bubble);
        msg.appendChild(actions);
        msg.appendChild(time);

        messagesEl.appendChild(msg);
        scrollToBottom();

        return msg;
    }

    function createActionBtn(title, svgHtml) {
        const btn = document.createElement('button');
        btn.className = 'bb-msg-action';
        btn.title = title;
        btn.innerHTML = svgHtml;
        return btn;
    }

    // ─── Loading Animation ───────────────────────────────────────────────────
    function showLoading() {
        const loading = document.createElement('div');
        loading.className = 'bb-loading';
        loading.id = 'bbLoading';
        loading.innerHTML = `
            <div class="bb-loading-bugs">
                <span class="bb-loading-bug">🐛</span>
                <span class="bb-loading-bug">🐜</span>
                <span class="bb-loading-bug">🐞</span>
            </div>
            <span class="bb-loading-text">${getRandomBugMessage()}</span>
        `;
        messagesEl.appendChild(loading);
        scrollToBottom();

        // Rotate bug messages while loading
        const interval = setInterval(() => {
            const textEl = loading.querySelector('.bb-loading-text');
            if (textEl) textEl.textContent = getRandomBugMessage();
        }, 3000);
        loading._interval = interval;
    }

    function hideLoading() {
        const loading = document.getElementById('bbLoading');
        if (loading) {
            if (loading._interval) clearInterval(loading._interval);
            loading.remove();
        }
    }

    // ─── Send Message ────────────────────────────────────────────────────────
    async function sendMessage(overrideText) {
        const text = overrideText || input.value.trim();
        if ((!text && pendingImages.length === 0) || isStreaming) return;

        // Capture attached images before clearing
        const attachedImages = [...pendingImages];
        pendingImages = [];
        renderImagePreview();

        // Add user message
        messages.push({ role: 'user', text });
        renderMessage('user', text, { images: attachedImages });

        if (!overrideText) {
            input.value = '';
            autoResize();
        }

        // Create conversation if none active (admin only)
        if (!currentConvId && isAdmin) {
            await createConversation(text.slice(0, 50));
        }

        // Show loading
        showLoading();
        isStreaming = true;
        sendBtn.style.display = 'none';
        stopBtn.style.display = 'flex';

        // Build history for Gemini API format
        const history = messages.slice(0, -1).map(m => ({
            role: m.role === 'user' ? 'user' : 'model',
            parts: [{ text: m.text }]
        }));

        // Build images payload for API
        const imagesPayload = attachedImages.map(img => ({
            base64: img.base64,
            mimeType: img.mimeType
        }));

        // Stream response
        abortController = new AbortController();
        let fullResponse = '';

        try {
            const response = await fetch('/api/ai-chat/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text || 'Describe this image.', history, images: imagesPayload }),
                signal: abortController.signal
            });

            hideLoading();

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Failed to get response');
            }

            // Create streaming AI message element
            const aiMsg = renderMessage('ai', '', { streaming: true });
            const bubble = aiMsg.querySelector('.bb-msg-bubble');
            bubble.innerHTML = '<div class="md-content bb-streaming-cursor"></div>';

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.type === 'chunk') {
                                fullResponse += data.content;
                                const mdContent = bubble.querySelector('.md-content');
                                mdContent.innerHTML = renderMarkdown(fullResponse);
                                mdContent.classList.add('bb-streaming-cursor');
                                scrollToBottom();
                            } else if (data.type === 'done') {
                                fullResponse = data.content;
                            } else if (data.type === 'error') {
                                throw new Error(data.content);
                            }
                        } catch (e) {
                            if (e.message && !e.message.includes('JSON')) throw e;
                        }
                    }
                }
            }

            // Finalize: remove cursor, re-render clean, add regen button
            const mdContent = bubble.querySelector('.md-content');
            mdContent.classList.remove('bb-streaming-cursor');
            mdContent.innerHTML = renderMarkdown(fullResponse);

            // Add regenerate button to actions
            const actionsDiv = aiMsg.querySelector('.bb-msg-actions');
            const regenBtn = createActionBtn('Regenerate', `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`);
            regenBtn.addEventListener('click', () => regenerateResponse(aiMsg));
            actionsDiv.appendChild(regenBtn);

            messages.push({ role: 'ai', text: fullResponse });
            if (isAdmin) saveCurrentConversation();

        } catch (err) {
            hideLoading();
            if (err.name === 'AbortError') {
                // User stopped generation
                if (fullResponse) {
                    messages.push({ role: 'ai', text: fullResponse + ' [stopped]' });
                    if (isAdmin) saveCurrentConversation();
                }
            } else {
                const errorMsg = document.createElement('div');
                errorMsg.className = 'bb-msg ai';
                errorMsg.innerHTML = `<div class="bb-msg-bubble" style="border-color: var(--c-error);">❌ ${escapeHtml(err.message)}</div>`;
                messagesEl.appendChild(errorMsg);
                scrollToBottom();
            }
        } finally {
            isStreaming = false;
            abortController = null;
            sendBtn.style.display = 'flex';
            stopBtn.style.display = 'none';
            input.focus();
        }
    }

    // Stop button
    stopBtn.addEventListener('click', () => {
        if (abortController) abortController.abort();
    });

    // Send button
    sendBtn.addEventListener('click', () => sendMessage());

    // ─── Edit & Regenerate ───────────────────────────────────────────────────
    function editMessage(msgEl, originalText) {
        input.value = originalText;
        input.focus();
        autoResize();

        // Remove this message and all messages after it
        const allMsgs = Array.from(messagesEl.querySelectorAll('.bb-msg'));
        const idx = allMsgs.indexOf(msgEl);
        if (idx >= 0) {
            for (let i = allMsgs.length - 1; i >= idx; i--) {
                allMsgs[i].remove();
            }
            messages = messages.slice(0, idx);
        }
    }

    function regenerateResponse(aiMsgEl) {
        // Find the user message just before this AI message
        const allMsgs = Array.from(messagesEl.querySelectorAll('.bb-msg'));
        const idx = allMsgs.indexOf(aiMsgEl);
        if (idx < 1) return;

        const prevUserMsg = allMsgs[idx - 1];
        const prevUserIdx = idx - 1;

        // Get the user text from messages array
        const userText = messages[prevUserIdx]?.text;
        if (!userText) return;

        // Remove the AI message and everything after it
        for (let i = allMsgs.length - 1; i >= idx; i--) {
            allMsgs[i].remove();
        }
        messages = messages.slice(0, idx);

        // Resend
        sendMessage(userText);
    }

    // ─── Conversation Management ─────────────────────────────────────────────
    async function loadConversations() {
        try {
            const res = await fetch('/api/conversations');
            const data = await res.json();
            conversations = data.conversations || [];
            renderConversationList();
        } catch (e) {
            console.error('Failed to load conversations:', e);
        }
    }

    function renderConversationList(filter = '') {
        if (!convList) return;
        convList.innerHTML = '';
        const filtered = conversations.filter(c =>
            c.title.toLowerCase().includes(filter.toLowerCase())
        );

        if (filtered.length === 0) {
            convList.innerHTML = '<div class="bb-conv-empty">No conversations yet</div>';
            return;
        }

        filtered.forEach(conv => {
            const item = document.createElement('div');
            item.className = `bb-conv-item${conv.id === currentConvId ? ' active' : ''}`;
            item.innerHTML = `
                <svg class="bb-conv-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <span class="bb-conv-title">${escapeHtml(conv.title)}</span>
                <div class="bb-conv-actions">
                    <button class="bb-conv-action-btn rename" title="Rename">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="bb-conv-action-btn delete" title="Delete">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                    </button>
                </div>
            `;

            // Click to load conversation
            item.addEventListener('click', (e) => {
                if (e.target.closest('.bb-conv-action-btn')) return;
                loadConversation(conv.id);
                // Close mobile sidebar
                if (sidebar) sidebar.classList.remove('open');
                backdrop.classList.remove('active');
            });

            // Rename
            item.querySelector('.rename').addEventListener('click', () => {
                const titleEl = item.querySelector('.bb-conv-title');
                const oldTitle = conv.title;
                const renameInput = document.createElement('input');
                renameInput.className = 'bb-rename-input';
                renameInput.value = oldTitle;
                titleEl.replaceWith(renameInput);
                renameInput.focus();
                renameInput.select();

                const finish = async () => {
                    const newTitle = renameInput.value.trim() || oldTitle;
                    const span = document.createElement('span');
                    span.className = 'bb-conv-title';
                    span.textContent = newTitle;
                    renameInput.replaceWith(span);
                    if (newTitle !== oldTitle) {
                        await fetch(`/api/conversations/${conv.id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ title: newTitle })
                        });
                        conv.title = newTitle;
                    }
                };

                renameInput.addEventListener('blur', finish);
                renameInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') renameInput.blur();
                    if (e.key === 'Escape') {
                        renameInput.value = oldTitle;
                        renameInput.blur();
                    }
                });
            });

            // Delete
            item.querySelector('.delete').addEventListener('click', async () => {
                if (!confirm(`Delete "${conv.title}"?`)) return;
                await fetch(`/api/conversations/${conv.id}`, { method: 'DELETE' });
                conversations = conversations.filter(c => c.id !== conv.id);
                if (currentConvId === conv.id) {
                    currentConvId = null;
                    messages = [];
                    clearChat();
                }
                renderConversationList();
            });

            convList.appendChild(item);
        });
    }

    // Search conversations
    if (convSearchInput) {
        convSearchInput.addEventListener('input', () => {
            renderConversationList(convSearchInput.value);
        });
    }

    async function createConversation(title) {
        try {
            const res = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: title || 'New Chat' })
            });
            const conv = await res.json();
            currentConvId = conv.id;
            conversations.unshift({
                id: conv.id,
                title: conv.title,
                created_at: conv.created_at,
                updated_at: conv.updated_at,
                message_count: 0
            });
            renderConversationList();
        } catch (e) {
            console.error('Failed to create conversation:', e);
        }
    }

    async function loadConversation(convId) {
        try {
            const res = await fetch(`/api/conversations/${convId}`);
            const data = await res.json();
            currentConvId = convId;
            messages = data.messages || [];

            // Clear and re-render messages
            clearChat();
            messages.forEach(m => renderMessage(m.role, m.text));

            // Update active state in sidebar
            document.querySelectorAll('.bb-conv-item').forEach(el => el.classList.remove('active'));
            const activeItem = Array.from(document.querySelectorAll('.bb-conv-item')).find(el => {
                const conv = conversations.find(c => c.id === convId);
                return conv && el.querySelector('.bb-conv-title')?.textContent === conv.title;
            });
            if (activeItem) activeItem.classList.add('active');

            renderConversationList();
        } catch (e) {
            console.error('Failed to load conversation:', e);
        }
    }

    async function saveCurrentConversation() {
        if (!currentConvId) return;
        try {
            // Auto-title from first user message
            const firstUser = messages.find(m => m.role === 'user');
            const title = firstUser ? firstUser.text.slice(0, 60) : 'New Chat';

            await fetch(`/api/conversations/${currentConvId}/messages`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages, title })
            });

            // Update sidebar
            const conv = conversations.find(c => c.id === currentConvId);
            if (conv) {
                conv.title = title;
                conv.updated_at = Date.now() / 1000;
                conv.message_count = messages.length;
            }
            renderConversationList();
        } catch (e) {
            console.error('Failed to save conversation:', e);
        }
    }

    function clearChat() {
        messagesEl.innerHTML = '';
        if (welcomeEl) {
            messagesEl.appendChild(welcomeEl);
            welcomeEl.style.display = '';
        }
    }

    // ─── New Chat ────────────────────────────────────────────────────────────
    if (newChatBtn) {
        newChatBtn.addEventListener('click', () => {
            currentConvId = null;
            messages = [];
            clearChat();
            input.value = '';
            autoResize();
            input.focus();
            renderConversationList();
            // Close mobile sidebar
            if (sidebar) sidebar.classList.remove('open');
            backdrop.classList.remove('active');
        });
    }

    // ─── Suggestion Chips ────────────────────────────────────────────────────
    document.querySelectorAll('.bb-suggestion').forEach(btn => {
        btn.addEventListener('click', () => {
            const prompt = btn.dataset.prompt;
            if (prompt) {
                input.value = prompt;
                autoResize();
                sendMessage();
            }
        });
    });

    // ─── Keyboard Shortcuts ──────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        // Ctrl/Cmd + Shift + N = New chat
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
            e.preventDefault();
            newChatBtn.click();
        }
    });

    // ─── Theme Toggle ────────────────────────────────────────────────────────
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            // Swap highlight.js themes
            const darkSheet = document.getElementById('hljs-dark-theme');
            const lightSheet = document.getElementById('hljs-light-theme');
            if (darkSheet) darkSheet.disabled = !isDark;
            if (lightSheet) lightSheet.disabled = isDark;
        });
    }

    // ─── Initialize ──────────────────────────────────────────────────────────
    if (isAdmin) loadConversations();
    input.focus();
});
