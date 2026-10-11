// static/js/index.js
// --- UTILITY: Robust clipboard copy with fallbacks (works on Linux/HTTP) ---
async function copyToClipboard(text) {
    // Try modern clipboard API first (requires HTTPS or localhost)
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.warn('Clipboard API failed:', err);
        }
    }

    // Fallback: execCommand with temporary textarea (works on HTTP)
    try {
        const tempTextArea = document.createElement('textarea');
        tempTextArea.value = text;
        tempTextArea.style.position = 'fixed';
        tempTextArea.style.left = '-9999px';
        tempTextArea.style.top = '0';
        tempTextArea.setAttribute('readonly', '');
        document.body.appendChild(tempTextArea);
        tempTextArea.focus();
        tempTextArea.setSelectionRange(0, text.length);
        const copied = document.execCommand('copy');
        document.body.removeChild(tempTextArea);
        if (copied) return true;
    } catch (err) {
        console.warn('execCommand copy failed:', err);
    }

    return false;
}

// --- UTILITY: Create a flash message ---
// Escape text for safe use inside HTML text or quoted attribute values.
function escapeHtmlText(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Sanitize an HTML string that came from untrusted text (markdown of shared text, AI replies).
// If DOMPurify failed to load, fall back to showing the text literally rather than rendering it.
function sanitizeHtml(html) {
    if (typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(html);
    return escapeHtmlText(html);
}

function flash(message, category = 'info') {
    const flashMessagesContainer = document.querySelector('.flash-messages') || document.createElement('ul');
    if (!document.querySelector('.flash-messages')) {
        flashMessagesContainer.className = 'flash-messages';
        document.body.appendChild(flashMessagesContainer);
    }
    const li = document.createElement('li');
    li.className = category;
    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;   // never interpret messages (they can contain file names) as HTML
    const closeEl = document.createElement('button');
    closeEl.className = 'close-flash';
    closeEl.textContent = '×';
    li.append(msgSpan, closeEl);
    flashMessagesContainer.prepend(li);
    const closeBtn = li.querySelector('.close-flash');
    const dismiss = () => { li.style.opacity = '0'; setTimeout(() => li.remove(), 300); };
    closeBtn.addEventListener('click', dismiss);
    setTimeout(dismiss, 5000);
}

// --- UTILITY: Format bytes to human readable string ---
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// --- UTILITY: Format speed (bytes/sec) ---
function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond < 1024) {
        return bytesPerSecond.toFixed(0) + ' B/s';
    }
    return formatBytes(bytesPerSecond) + '/s';
}

// --- UTILITY: Format seconds to time string ---
function formatTime(seconds) {
    if (seconds === Infinity || isNaN(seconds)) return '--:--';
    if (seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}


document.addEventListener('DOMContentLoaded', () => {
    // Guard Clause: Only run this script on the main page
    if (!document.getElementById('sharedTextArea')) {
        return;
    }

    const PIN_LIMIT = 10;
    const socket = io();

    // --- DOM ELEMENT SELECTION ---
    const sharedTextArea = document.getElementById('sharedTextArea');
    const commitBtn = document.getElementById('commitBtn');
    const selectBtn = document.getElementById('selectBtn');
    const clearBtn = document.getElementById('clearBtn');
    const pasteBtn = document.getElementById('pasteBtn');
    const pinBtn = document.getElementById('pinBtn');
    const clipboardStatus = document.getElementById('clipboardStatus');
    const textMeta = document.getElementById('textMeta');
    const selectTextAction = document.getElementById('selectTextAction');
    const viewBtnShared = document.getElementById('viewBtnShared');
    const viewBtnPinned = document.getElementById('viewBtnPinned');
    const sharedTextView = document.getElementById('shared-text-view');
    const pinnedMessagesView = document.getElementById('pinned-messages-view');
    const pinnedMessagesContainer = document.getElementById('pinned-messages-container');
    const bufferTitle = document.getElementById('buffer-title');
    const fileListBody = document.getElementById('file-list-body');
    const downloadSectionPanel = document.querySelector('.download-section .panel-body');

    // Folder navigation state
    let currentPath = '';

    // AI Chat Elements
    const viewBtnAiChat = document.getElementById('viewBtnAiChat');
    const aiChatView = document.getElementById('ai-chat-view');
    const aiChatMessages = document.getElementById('aiChatMessages');
    const aiChatInput = document.getElementById('aiChatInput');
    const aiChatSendBtn = document.getElementById('aiChatSendBtn');

    // View State
    let currentView = 'shared'; // 'shared' | 'pinned' | 'ai'
    let aiChatHistory = [];

    // AI Chat scrollbar auto-hide functionality
    let aiChatScrollTimeout = null;
    if (aiChatMessages) {
        aiChatMessages.addEventListener('scroll', () => {
            aiChatMessages.classList.add('scrolling');
            clearTimeout(aiChatScrollTimeout);
            aiChatScrollTimeout = setTimeout(() => {
                aiChatMessages.classList.remove('scrolling');
            }, 5000);
        });
    }

    // Markdown Editor Elements
    const editorBtn = document.getElementById('editorBtn');

    // Markdown Editor State
    let isEditorMode = false;
    let easyMDEInstance = null;

    // Markdown Preview Elements and State
    const previewBtn = document.getElementById('previewBtn');
    const markdownPreview = document.getElementById('markdownPreview');
    let isPreviewMode = false;

    // --- WEBSOCKET EVENT LISTENERS ---
    socket.on('text_updated', (data) => {
        if (sharedTextArea) {
            if (isEditorMode && easyMDEInstance) {
                // Update editor content if in editor mode
                easyMDEInstance.value(data.text);
            } else {
                // Update textarea if in plain text mode
                sharedTextArea.value = data.text;
            }
            updateTextMeta();
            setStatus('[OK] Buffer synced from another client.', 'info');
        }
    });
    socket.on('pins_updated', (data) => {
        renderPinnedMessages(data.pins);
        updatePinButtonState(data.pins.length);
    });
    socket.on('file_list_updated', (data) => {
        // Only re-render if the broadcast is for the path we're currently viewing
        const broadcastPath = data.path || '';
        if (broadcastPath !== currentPath) return;
        if (data.files && fileListBody) {
            flash('File list has been updated in real-time.', 'info');
            renderFileList(data.files);
            reinitializeFileActions();
        } else if (data.files && !fileListBody) {
            window.location.reload();
        }
    });

    // --- STATUS & UTILITY FUNCTIONS ---
    function setStatus(message, type = 'info', duration = 4000) {
        if (clipboardStatus) {
            clipboardStatus.textContent = message;
            clipboardStatus.className = 'clipboard-status';
            clipboardStatus.classList.add(`status-${type}`);
            setTimeout(() => {
                if (clipboardStatus.textContent === message) {
                    clipboardStatus.textContent = '';
                    clipboardStatus.className = 'clipboard-status';
                }
            }, duration);
        }
    }

    function selectText(element) {
        if (!element) return;
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }

    // --- DYNAMIC FILE LIST RENDERING ---
    function renderFileList(items = []) {
        if (!fileListBody) return;

        const isAdmin = !!document.getElementById('lockSelectedBtn');
        fileListBody.innerHTML = '';

        if (items.length === 0 && currentPath === '') {
            fileListBody.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 2rem; color: var(--c-text-muted);">No files or folders. Upload a file or create a folder to get started!</td></tr>';
            return;
        }
        if (items.length === 0 && currentPath !== '') {
            fileListBody.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 2rem; color: var(--c-text-muted);">This folder is empty.</td></tr>';
            return;
        }

        let rowsHtml = '';
        items.forEach(item => {
            if (item.type === 'folder') {
                const folderLocked = item.is_locked;
                const folderLockBtn = isAdmin ? `
                    <button type="button" class="btn-icon folder-lock-btn" title="${folderLocked ? 'Unlock Folder' : 'Lock Folder'}" data-folder-path="${item.encoded_name}" data-locked="${folderLocked}">
                        ${folderLocked
                        ? `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`
                        : `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>`
                    }
                    </button>` : '';
                const folderDownloadBtn = isAdmin ? `
                    <button type="button" class="btn-icon folder-download-btn" title="Download folder ${escapeHtmlText(item.name)}" data-folder-name="${escapeHtmlText(item.name)}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    </button>` : '';
                const folderRenameBtn = isAdmin ? `
                    <button type="button" class="btn-icon rename-folder-btn" title="Rename folder ${escapeHtmlText(item.name)}" data-folder-name="${escapeHtmlText(item.name)}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path><path d="m15 5 4 4"></path></svg>
                    </button>` : '';
                const folderDeleteBtn = isAdmin ? `
                    <button type="button" class="btn-icon delete-folder-btn" title="Delete folder ${escapeHtmlText(item.name)}" data-folder-name="${escapeHtmlText(item.name)}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>` : '';
                const folderShareBtn = isAdmin ? `
                    <button type="button" class="btn-icon file-share-btn" title="Share folder ${escapeHtmlText(item.name)}" data-filename="${escapeHtmlText(item.name)}" data-type="folder">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                    </button>` : '';
                const lockedBadge = folderLocked ? ' <span style="color:var(--c-text-muted); font-size:0.75rem;">🔒</span>' : '';
                const isFav = item.is_favorite;
                const favClass = isFav ? ' favorite-row' : '';
                rowsHtml += `
                    <tr data-file-row="${item.encoded_name}" data-sort-name="${escapeHtmlText(item.name.toLowerCase())}" data-sort-date="${item.mtime}" data-sort-size="${item.size || 0}" data-favorite="${isFav ? 'true' : 'false'}" data-type="folder" class="folder-row${favClass}">
                        <td style="text-align: center;"><input type="checkbox" name="selected_files" value="${escapeHtmlText(item.name)}" class="file-checkbox"${isAdmin ? '' : ' disabled'}></td>
                        <td>
                            <a href="javascript:void(0)" class="folder-link" data-folder-name="${escapeHtmlText(item.name)}" data-folder-path="${item.encoded_name}" title="Open ${escapeHtmlText(item.name)}">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="folder-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                                ${escapeHtmlText(item.name)}${lockedBadge}
                            </a>
                        </td>
                        <td class="index-file-actions">${folderDownloadBtn}${folderLockBtn}${folderRenameBtn}${folderDeleteBtn}${folderShareBtn}</td>
                    </tr>`;
            } else {
                const lockedAttr = item.is_locked ? 'true' : 'false';
                const lockTitle = item.is_locked ? 'Unlock File' : 'Lock File';
                const lockIcon = item.is_locked
                    ? `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`
                    : `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>`;
                // Copy-image button: visible for all users, but only for image files
                const imgExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
                const fileExt = item.name.includes('.') ? item.name.substring(item.name.lastIndexOf('.')).toLowerCase() : '';
                const openImgBtn = imgExts.includes(fileExt) ? `
                    <button type="button" class="btn-icon file-open-img-btn" title="Open image in a new tab" data-filename="${item.encoded_name}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                    </button>` : '';
                const copyImgBtn = imgExts.includes(fileExt) ? `
                    <button type="button" class="btn-icon file-copy-img-btn" title="Copy image to clipboard" data-filename="${item.encoded_name}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>` : '';
                const adminButtons = isAdmin ? `
                    <button type="button" class="btn-icon rename-file-btn" title="Rename ${escapeHtmlText(item.name)}" data-filename="${escapeHtmlText(item.name)}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path><path d="m15 5 4 4"></path></svg>
                    </button>
                    <button type="button" class="btn-icon file-move-btn" title="Move ${escapeHtmlText(item.name)}" data-filename="${escapeHtmlText(item.name)}" data-encoded="${item.encoded_name}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M10 14L21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg>
                    </button>
                    <button type="button" class="btn-icon file-lock-btn" title="${lockTitle}" data-filename="${item.encoded_name}">${lockIcon}</button>
                    <button type="button" class="btn-icon delete-file-btn" title="Delete ${escapeHtmlText(item.name)}" data-filename="${item.encoded_name}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                    <button type="button" class="btn-icon file-share-btn" title="Share ${escapeHtmlText(item.name)}" data-filename="${escapeHtmlText(item.name)}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                    </button>
                    <button type="button" class="btn-icon file-favorite-btn${item.is_favorite ? ' active' : ''}" title="${item.is_favorite ? 'Unstar' : 'Star'} ${escapeHtmlText(item.name)}" data-filename="${escapeHtmlText(item.name)}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${item.is_favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                    </button>` : '';
                const fileFavClass = item.is_favorite ? ' favorite-row' : '';
                rowsHtml += `
                    <tr data-file-row="${item.encoded_name}" data-sort-name="${escapeHtmlText(item.name.toLowerCase())}" data-sort-date="${item.mtime}" data-sort-size="${item.size || 0}" data-favorite="${item.is_favorite ? 'true' : 'false'}" data-type="file" class="${fileFavClass}">
                        <td style="text-align: center;"><input type="checkbox" name="selected_files" value="${escapeHtmlText(item.name)}" class="file-checkbox"></td>
                        <td><a href="/files/${item.encoded_name}" download title="Download ${escapeHtmlText(item.name)}" class="file-link-preview" data-filename="${item.encoded_name}" data-locked="${lockedAttr}">${escapeHtmlText(item.name)}</a></td>
                        <td class="index-file-actions">
                            <a href="/files/${item.encoded_name}" class="btn-icon file-download-link" title="Download ${escapeHtmlText(item.name)}" data-filename="${item.encoded_name}" data-locked="${lockedAttr}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></a>
                            ${openImgBtn}
                            ${copyImgBtn}
                            ${adminButtons}
                        </td>
                    </tr>`;
            }
        });
        rowsHtml += '<tr id="noResultsRow" style="display: none;"><td colspan="3" style="text-align: center;">No matching files found.</td></tr>';
        fileListBody.innerHTML = rowsHtml;
    }

    function reinitializeFileActions() {
        ensureMoreButtons();
        updateDownloadSelectedButtonState();
        rebindImagePreviews();
        rebindSearchAndSort();
        bindFolderActions();
        bindLockedFileHandlers();
    }

    // --- LOCKED FILE DOWNLOAD INTERCEPTION ---
    function bindLockedFileHandlers() {
        // Intercept clicks on locked file links (filename click and download button) — applies to ALL users
        document.querySelectorAll('.file-link-preview[data-locked="true"], .file-download-link[data-locked="true"]').forEach(link => {
            if (link.dataset.lockHandlerBound === 'true') return;
            link.dataset.lockHandlerBound = 'true';

            link.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const encodedFilename = link.dataset.filename;
                const filepath = currentPath ? `${currentPath}/${decodeURIComponent(encodedFilename)}` : decodeURIComponent(encodedFilename);

                const password = await snailPrompt(
                    '🔒 File Locked',
                    'This file is encrypted. Enter the password to download it:',
                    { type: 'password', placeholder: 'Enter password...', confirmText: 'Unlock & Download' }
                );
                if (!password) return;

                try {
                    const verifyRes = await fetch('/api/file/verify_password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filepath, password })
                    });
                    const verifyData = await verifyRes.json();
                    if (verifyRes.ok && verifyData.success) {
                        flash('File unlocked. Starting download...', 'success');
                        // Now trigger the actual download
                        window.location.href = `/files/${encodedFilename}`;
                    } else {
                        flash(`[ERR] ${verifyData.error || 'Incorrect password.'}`, 'error');
                    }
                } catch (err) {
                    console.error('Error verifying file password:', err);
                    flash('[ERR] Failed to verify password.', 'error');
                }
            });
        });
    }

    // --- FOLDER NAVIGATION ---
    function navigateToFolder(path) {
        // Don't update currentPath or breadcrumbs until we confirm access
        fetch(`/api/files/list?path=${encodeURIComponent(path)}`)
            .then(async res => {
                const data = await res.json();

                if (!res.ok && data.is_locked) {
                    // Folder is locked — prompt user for password
                    const password = await snailPrompt(
                        '🔒 Folder Locked',
                        'This folder is encrypted. Enter the password to access it:',
                        { type: 'password', placeholder: 'Enter password...', confirmText: 'Unlock' }
                    );
                    if (!password) return; // User cancelled

                    // Verify password with backend
                    const verifyRes = await fetch('/api/folder/verify_password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path, password })
                    });
                    const verifyData = await verifyRes.json();
                    if (verifyRes.ok && verifyData.success) {
                        flash('Folder unlocked successfully.', 'success');
                        // Retry navigation now that the folder is unlocked in the session
                        navigateToFolder(path);
                    } else {
                        flash(`[ERR] ${verifyData.error || 'Incorrect password.'}`, 'error');
                    }
                    return;
                }

                if (data.success) {
                    // Access granted — now update state
                    currentPath = path;
                    const uploadSubpath = document.getElementById('uploadSubpath');
                    const downloadSubpath = document.getElementById('downloadSubpath');
                    if (uploadSubpath) uploadSubpath.value = path;
                    if (downloadSubpath) downloadSubpath.value = path;

                    const uploadDesc = document.querySelector('.upload-section .section-description');
                    if (uploadDesc) {
                        uploadDesc.textContent = path
                            ? `Uploading to folder: ${path}`
                            : 'Select or drag files or folders to upload to the shared directory.';
                    }

                    renderBreadcrumbs(path);
                    renderFileList(data.files);
                    reinitializeFileActions();

                    const uploadSection = document.querySelector('.upload-section');
                    const isAdminUser = !!document.getElementById('lockSelectedBtn');
                    if (uploadSection) {
                        if (!isAdminUser && data.is_folder_locked) {
                            uploadSection.style.display = 'none';
                        } else {
                            uploadSection.style.display = '';
                        }
                    }
                } else {
                    flash(`[ERR] ${data.error || 'Failed to load folder.'}`, 'error');
                }
            })
            .catch(err => {
                console.error('Error navigating to folder:', err);
                flash('[ERR] Failed to load folder.', 'error');
            });
    }

    function renderBreadcrumbs(path) {
        const breadcrumbNav = document.getElementById('breadcrumbNav');
        if (!breadcrumbNav) return;

        const homeIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:1rem;height:1rem;"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`;

        let html = `<span class="breadcrumb-item breadcrumb-root ${path === '' ? 'breadcrumb-active' : ''}" data-path="">${homeIcon} Root</span>`;

        if (path) {
            const parts = path.split('/');
            let accumulated = '';
            parts.forEach((part, i) => {
                accumulated += (i > 0 ? '/' : '') + part;
                const isLast = i === parts.length - 1;
                html += `<span class="breadcrumb-separator">/</span>`;
                html += `<span class="breadcrumb-item ${isLast ? 'breadcrumb-active' : ''}" data-path="${escapeHtmlText(accumulated)}">${escapeHtmlText(part)}</span>`;
            });
        }
        breadcrumbNav.innerHTML = html;

        // Bind click on breadcrumb items
        breadcrumbNav.querySelectorAll('.breadcrumb-item').forEach(item => {
            item.addEventListener('click', () => {
                const targetPath = item.dataset.path;
                navigateToFolder(targetPath);
            });
        });
    }

    function bindFolderActions() {
        // Folder link clicks (navigate into)
        document.querySelectorAll('.folder-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const folderPath = decodeURIComponent(link.dataset.folderPath);
                navigateToFolder(folderPath);
            });
        });

        // Folder delete buttons
        document.querySelectorAll('.delete-folder-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const folderName = btn.dataset.folderName;
                const confirmed = await snailConfirm('Delete Folder', `Are you sure you want to permanently delete the folder "${folderName}" and ALL its contents?`, { danger: true, confirmText: 'Delete' });
                if (!confirmed) return;
                setStatus(`[INFO] Deleting folder '${folderName}'...`, 'info', 60000);
                try {
                    const response = await fetch('/api/folder/delete', {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: currentPath, name: folderName })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || 'Failed to delete folder.');
                    setStatus(`[OK] Folder '${folderName}' deleted.`, 'success');
                } catch (error) {
                    console.error('Error deleting folder:', error);
                    setStatus(`[ERR] ${error.message}`, 'error');
                }
            });
        });

        // Folder lock/unlock buttons (admin only)
        document.querySelectorAll('.folder-lock-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const folderPath = decodeURIComponent(btn.dataset.folderPath);
                const isLocked = btn.dataset.locked === 'true';
                if (isLocked) {
                    const confirmed = await snailConfirm('Remove Folder Lock', `Are you sure you want to remove the lock from this folder?`);
                    if (!confirmed) return;
                    setStatus('[INFO] Removing folder lock...', 'info', 60000);
                    try {
                        const response = await fetch('/api/folder/remove_lock', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: folderPath })
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.error || 'Failed to remove folder lock.');
                        setStatus(`[OK] ${result.message}`, 'success');
                    } catch (error) {
                        console.error('Error removing folder lock:', error);
                        setStatus(`[ERR] ${error.message}`, 'error');
                    }
                } else {
                    const password = await snailPrompt('Lock Folder', 'Enter a password to lock this folder:', { type: 'password', placeholder: 'Enter password...', confirmText: 'Lock' });
                    if (!password) return;
                    setStatus('[INFO] Locking folder...', 'info', 60000);
                    try {
                        const response = await fetch('/api/folder/lock', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: folderPath, password })
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.error || 'Failed to lock folder.');
                        setStatus(`[OK] ${result.message}`, 'success');
                    } catch (error) {
                        console.error('Error locking folder:', error);
                        setStatus(`[ERR] ${error.message}`, 'error');
                    }
                }
            });
        });

        // File move buttons (admin only)
        document.querySelectorAll('.file-move-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const filename = btn.dataset.filename;
                openMoveModal(filename, currentPath);
            });
        });

        // File rename buttons (admin only)
        document.querySelectorAll('.rename-file-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const oldName = btn.dataset.filename;
                const newName = await snailPrompt('Rename File', `Enter a new name for "${oldName}":`, { placeholder: oldName, confirmText: 'Rename', defaultValue: oldName });
                if (!newName || newName === oldName) return;
                setStatus(`[INFO] Renaming '${oldName}'...`, 'info', 60000);
                try {
                    const response = await fetch('/api/file/rename', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: currentPath, old_name: oldName, new_name: newName })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || 'Failed to rename file.');
                    setStatus(`[OK] ${result.message}`, 'success');
                } catch (error) {
                    console.error('Error renaming file:', error);
                    setStatus(`[ERR] ${error.message}`, 'error');
                }
            });
        });

        // Folder rename buttons (admin only)
        document.querySelectorAll('.rename-folder-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const oldName = btn.dataset.folderName;
                const newName = await snailPrompt('Rename Folder', `Enter a new name for "${oldName}":`, { placeholder: oldName, confirmText: 'Rename', defaultValue: oldName });
                if (!newName || newName === oldName) return;
                setStatus(`[INFO] Renaming folder '${oldName}'...`, 'info', 60000);
                try {
                    const response = await fetch('/api/folder/rename', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: currentPath, old_name: oldName, new_name: newName })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || 'Failed to rename folder.');
                    setStatus(`[OK] ${result.message}`, 'success');
                } catch (error) {
                    console.error('Error renaming folder:', error);
                    setStatus(`[ERR] ${error.message}`, 'error');
                }
            });
        });

        // Folder download buttons
        document.querySelectorAll('.folder-download-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const folderName = btn.dataset.folderName;
                setStatus(`[INFO] Downloading folder '${folderName}' as ZIP...`, 'info', 60000);
                try {
                    const response = await fetch('/api/folder/download', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: currentPath, folder_name: folderName })
                    });
                    if (!response.ok) {
                        const result = await response.json();
                        throw new Error(result.error || 'Failed to download folder.');
                    }
                    const blob = await response.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `${folderName}.zip`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    window.URL.revokeObjectURL(url);
                    setStatus(`[OK] Folder '${folderName}' downloaded.`, 'success');
                } catch (error) {
                    console.error('Error downloading folder:', error);
                    setStatus(`[ERR] ${error.message}`, 'error');
                }
            });
        });

        // File share buttons (admin only)
        document.querySelectorAll('.file-share-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const filename = btn.dataset.filename;
                const filepath = currentPath ? `${currentPath}/${filename}` : filename;
                const expiryOptions = [
                    { label: '30 Minutes', value: '0.5' },
                    { label: '4 Hours', value: '4' },
                    { label: '8 Hours', value: '8' },
                    { label: '12 Hours', value: '12' },
                    { label: '16 Hours', value: '16' },
                    { label: '20 Hours', value: '20' },
                    { label: '24 Hours', value: '24' },
                    { label: 'No Expiry', value: '' },
                    { label: 'Custom...', value: '__custom__' }
                ];
                const expiryInput = await snailSelect('Share Link', `Create a shareable link for "${filename}". Choose an expiry time:`, expiryOptions, { confirmText: 'Create Link' });
                if (expiryInput === null) return; // cancelled
                const expiry_hours = expiryInput && !isNaN(parseFloat(expiryInput)) ? parseFloat(expiryInput) : null;
                setStatus(`[INFO] Creating share link...`, 'info', 60000);
                try {
                    const response = await fetch('/api/file/share', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filepath, expiry_hours })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || 'Failed to create share link.');
                    const shareUrl = result.url;
                    try {
                        await navigator.clipboard.writeText(shareUrl);
                        setStatus(`[OK] Share link copied to clipboard!`, 'success');
                    } catch {
                        setStatus(`[OK] Share link: ${shareUrl}`, 'success', 30000);
                    }
                } catch (error) {
                    console.error('Error creating share link:', error);
                    setStatus(`[ERR] ${error.message}`, 'error');
                }
            });
        });

        // File favorite buttons (admin only)
        document.querySelectorAll('.file-favorite-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const filename = btn.dataset.filename;
                const filepath = currentPath ? `${currentPath}/${filename}` : filename;
                try {
                    const response = await fetch('/api/file/favorite', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filepath, path: currentPath })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || 'Failed to toggle favorite.');
                    const action = result.favorited ? 'Starred' : 'Unstarred';
                    setStatus(`[OK] ${action} '${filename}'.`, 'success');
                } catch (error) {
                    console.error('Error toggling favorite:', error);
                    setStatus(`[ERR] ${error.message}`, 'error');
                }
            });
        });

        // Open image in a new tab (all users): served inline by /view/, with the same lock rules as downloading
        document.querySelectorAll('.file-open-img-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.open(`/view/${btn.dataset.filename}`, '_blank', 'noopener');
            });
        });

        // Copy image to clipboard buttons (all users)
        document.querySelectorAll('.file-copy-img-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const encodedFilename = btn.dataset.filename;
                const decodedFilename = decodeURIComponent(encodedFilename);
                setStatus(`[INFO] Copying image '${decodedFilename}' to clipboard...`, 'info', 10000);
                try {
                    // Fetch the image as base64 via the preview API
                    const previewRes = await fetch(`/api/preview/${encodedFilename}`);
                    if (!previewRes.ok) {
                        const errData = await previewRes.json().catch(() => ({}));
                        throw new Error(errData.error || 'Failed to fetch image.');
                    }
                    const previewData = await previewRes.json();
                    if (!previewData.success || !previewData.data) {
                        throw new Error('Image data not available.');
                    }
                    // Convert base64 data URI to blob
                    const dataUri = previewData.data;
                    const res = await fetch(dataUri);
                    const blob = await res.blob();
                    // Clipboard API requires image/png for best compatibility
                    let clipboardBlob = blob;
                    if (blob.type !== 'image/png') {
                        // Convert to PNG via canvas for clipboard compatibility
                        const img = new Image();
                        const loadPromise = new Promise((resolve, reject) => {
                            img.onload = resolve;
                            img.onerror = () => reject(new Error('Failed to load image for conversion.'));
                        });
                        img.src = dataUri;
                        await loadPromise;
                        const canvas = document.createElement('canvas');
                        canvas.width = img.naturalWidth;
                        canvas.height = img.naturalHeight;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0);
                        clipboardBlob = await new Promise((resolve, reject) => {
                            canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas conversion failed.')), 'image/png');
                        });
                    }
                    // Write to clipboard
                    if (navigator.clipboard && navigator.clipboard.write) {
                        await navigator.clipboard.write([
                            new ClipboardItem({ 'image/png': clipboardBlob })
                        ]);
                        setStatus(`[OK] Image copied to clipboard!`, 'success');
                        flash('[OK] Image copied to clipboard!', 'success');
                    } else {
                        throw new Error('Clipboard API not supported. Try using HTTPS.');
                    }
                } catch (error) {
                    console.error('Error copying image to clipboard:', error);
                    setStatus(`[ERR] ${error.message}`, 'error');
                }
            });
        });
    }

    // New Folder button handler
    const newFolderBtn = document.getElementById('newFolderBtn');
    if (newFolderBtn) {
        newFolderBtn.addEventListener('click', async () => {
            const folderName = await snailPrompt('New Folder', 'Enter a name for the new folder:', { placeholder: 'Folder name...', confirmText: 'Create' });
            if (!folderName) return;
            setStatus(`[INFO] Creating folder '${folderName}'...`, 'info', 60000);
            try {
                const response = await fetch('/api/folder/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: currentPath, name: folderName })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Failed to create folder.');
                setStatus(`[OK] ${result.message}`, 'success');
            } catch (error) {
                console.error('Error creating folder:', error);
                setStatus(`[ERR] ${error.message}`, 'error');
            }
        });
    }

    // Note: server-rendered folder actions are bound once by initializePage() -> reinitializeFileActions().
    // Binding them here too attached every handler twice (e.g. folder ZIP downloaded twice).

    function rebindImagePreviews() {
        const imagePreviewPopup = document.getElementById('imagePreviewPopup');
        if (!imagePreviewPopup) return;
        const supportedImageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
        let previewFetchTimeout;

        const positionPreviewPopup = (mouseEvent) => {
            const img = imagePreviewPopup.querySelector('img');
            if (!img || !img.complete) {
                requestAnimationFrame(() => positionPreviewPopup(mouseEvent));
                return;
            }
            const popupWidth = imagePreviewPopup.offsetWidth;
            const popupHeight = imagePreviewPopup.offsetHeight;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const cursorPadding = 15;
            let top = mouseEvent.clientY + cursorPadding;
            let left = mouseEvent.clientX + cursorPadding;
            if (left + popupWidth > viewportWidth) { left = mouseEvent.clientX - popupWidth - cursorPadding; }
            if (top + popupHeight > viewportHeight) { top = mouseEvent.clientY - popupHeight - cursorPadding; }
            imagePreviewPopup.style.top = `${top}px`;
            imagePreviewPopup.style.left = `${left}px`;
        };

        // Get fresh file links (these are newly rendered so no old listeners exist)
        const fileLinks = document.querySelectorAll('.file-link-preview');

        fileLinks.forEach(link => {
            // Mark as having preview bound to avoid duplicate bindings
            if (link.dataset.previewBound === 'true') return;
            link.dataset.previewBound = 'true';

            link.addEventListener('mouseenter', (e) => {
                if (link.dataset.locked === 'true') return;
                const encodedFilename = link.dataset.filename;
                const filename = decodeURIComponent(encodedFilename);
                const extension = filename.substring(filename.lastIndexOf('.')).toLowerCase();
                if (!supportedImageExtensions.includes(extension)) { return; }
                clearTimeout(previewFetchTimeout);
                previewFetchTimeout = setTimeout(async () => {
                    try {
                        const response = await fetch(`/api/preview/${encodedFilename}`);
                        if (!response.ok) return;
                        const result = await response.json();
                        if (result.success && result.data) {
                            imagePreviewPopup.innerHTML = `<img src="${result.data}" alt="Preview">`;
                            positionPreviewPopup(e);
                            imagePreviewPopup.classList.add('visible');
                        }
                    } catch (error) { console.error('Error fetching image preview:', error); }
                }, 100);
            });
            link.addEventListener('mouseleave', () => {
                clearTimeout(previewFetchTimeout);
                imagePreviewPopup.classList.remove('visible');
                setTimeout(() => { if (!imagePreviewPopup.classList.contains('visible')) { imagePreviewPopup.innerHTML = ''; } }, 200);
            });
            link.addEventListener('mousemove', (e) => {
                if (imagePreviewPopup.classList.contains('visible')) { positionPreviewPopup(e); }
            });
        });
    }

    function rebindSearchAndSort() {
        // Re-run the sort function to order the new list using the custom dropdown
        if (typeof sortTableRowsCustom === 'function') {
            sortTableRowsCustom();
        }

        // Re-apply the current search query
        const searchInput = document.getElementById('searchInput');
        if (searchInput && searchInput.value) {
            searchInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        }
    }

    // --- FILE UPLOAD LOGIC (files and whole folders) ---
    const uploadForm = document.getElementById('uploadForm');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    const uploadButton = document.getElementById('uploadButton');
    const chooseButton = document.getElementById('chooseButton');
    const chooseFolderButton = document.getElementById('chooseFolderButton');
    const clearUploadBtn = document.getElementById('clearUploadBtn');
    const fileDropZone = document.getElementById('fileDropZone');
    const fullPageDropZone = document.getElementById('fullPageDropZone');
    const progressContainer = document.getElementById('uploadProgressContainer');
    const progressBar = document.getElementById('uploadProgressBar');
    let currentUploadXhr = null;      // the request in flight, so Cancel can abort it
    let uploadCancelled = false;
    let uploadInProgress = false;
    let droppedSelection = null;      // {files, folders} when folders were dragged in (inputs can't hold those)

    const MAX_FOLDER_FILES = 20000;                 // refuse absurdly big drops instead of freezing the tab
    const BATCH_MAX_FILES = 100;                    // one request per ~100 files / ~64 MB: keeps each request small
    const BATCH_MAX_BYTES = 64 * 1024 * 1024;       // and lets very large folders upload without one giant request
    const JUNK_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
    const isJunkFile = name => JUNK_FILE_NAMES.has(String(name).toLowerCase());

    // What is currently selected: loose files plus folders [{name, items: [{file, path}]}].
    // `path` is the file's path inside the folder it came from, e.g. "photos/2024/a.jpg".
    function getSelection() {
        if (droppedSelection) return droppedSelection;
        const files = fileInput ? Array.from(fileInput.files) : [];
        const folders = [];
        if (folderInput && folderInput.files.length) {
            const byName = new Map();
            for (const file of folderInput.files) {
                const path = file.webkitRelativePath || file.name;
                if (isJunkFile(file.name)) continue;
                const top = path.split('/')[0];
                if (!byName.has(top)) byName.set(top, []);
                byName.get(top).push({ file, path });
            }
            byName.forEach((items, name) => folders.push({ name, items }));
        }
        return { files, folders };
    }

    function selectionTotals(sel) {
        const folderFiles = sel.folders.reduce((n, f) => n + f.items.length, 0);
        const bytes = sel.files.reduce((n, f) => n + f.size, 0) +
            sel.folders.reduce((n, f) => n + f.items.reduce((m, i) => m + i.file.size, 0), 0);
        return { count: sel.files.length + folderFiles, folderFiles, bytes };
    }

    function fileUploaded() {
        if (!fileInput || !uploadButton || !chooseButton || !fileDropZone) return;
        const sel = getSelection();
        const totals = selectionTotals(sel);
        const hasSelection = sel.files.length > 0 || sel.folders.length > 0;
        if (hasSelection) {
            fileDropZone.classList.add('file-selected');
            const shorten = n => n.length > 25 ? n.substring(0, 22) + '...' : n;
            const labels = [
                ...sel.folders.map(f => `📁 ${shorten(f.name)} (${f.items.length} file${f.items.length === 1 ? '' : 's'})`),
                ...sel.files.map(f => shorten(f.name))
            ];
            const shown = labels.slice(0, 6).map(escapeHtmlText).join(', ') + (labels.length > 6 ? ` and ${labels.length - 6} more` : '');
            fileDropZone.innerHTML = `<p><strong>Selected:</strong> ${shown}</p>`;
            chooseButton.textContent = 'Choose Another';
            if (sel.folders.length && !sel.files.length) {
                uploadButton.textContent = sel.folders.length === 1 ? 'Upload Folder' : `Upload ${sel.folders.length} Folders`;
            } else {
                uploadButton.textContent = `Upload ${totals.count > 1 || sel.folders.length ? (sel.folders.length + sel.files.length) + ' Items' : 'Now'}`;
            }
            uploadButton.disabled = false;
            if (clearUploadBtn) {
                clearUploadBtn.style.display = 'inline-flex';
                clearUploadBtn.textContent = 'Clear';
            }
        } else {
            fileDropZone.classList.remove('file-selected');
            fileDropZone.innerHTML = '<p><strong>Drag & drop files or folders here</strong> or click to select</p>';
            chooseButton.textContent = 'Choose File';
            uploadButton.textContent = 'Upload';
            uploadButton.disabled = true;
            if (clearUploadBtn) {
                clearUploadBtn.style.display = 'none';
            }
        }
    }

    function clearFileSelection() {
        droppedSelection = null;
        if (folderInput) folderInput.value = '';
        if (fileInput) fileInput.value = '';
        fileUploaded();
    }

    // Choosing files and choosing a folder are alternatives: picking one replaces the other
    if (fileInput) fileInput.addEventListener('change', () => { droppedSelection = null; if (folderInput) folderInput.value = ''; fileUploaded(); });
    if (folderInput) folderInput.addEventListener('change', () => {
        droppedSelection = null; if (fileInput) fileInput.value = '';
        if (folderInput.files.length === 0) { fileUploaded(); return; }
        if (folderInput.files.length > MAX_FOLDER_FILES) {
            flash(`[ERR] That folder has ${folderInput.files.length.toLocaleString()} files; the limit is ${MAX_FOLDER_FILES.toLocaleString()}. Upload it in parts or zip it first.`, 'error');
            folderInput.value = '';
        }
        fileUploaded();
    });

    // --- Reading dropped folders (the file inputs cannot receive these) ---
    function readAllEntries(reader) {
        return new Promise((resolve, reject) => {
            const all = [];
            const readMore = () => reader.readEntries(batch => {
                if (!batch.length) return resolve(all);
                all.push(...batch);
                readMore();            // readEntries returns at most ~100 entries per call
            }, reject);
            readMore();
        });
    }
    const entryToFile = entry => new Promise((resolve, reject) => entry.file(resolve, reject));

    async function walkEntry(entry, prefix, out, limit) {
        if (out.length > limit) return;
        if (entry.isFile) {
            if (isJunkFile(entry.name)) return;
            out.push({ file: await entryToFile(entry), path: prefix + entry.name });
        } else if (entry.isDirectory) {
            const children = await readAllEntries(entry.createReader());
            for (const child of children) await walkEntry(child, `${prefix}${entry.name}/`, out, limit);
        }
    }

    // Returns {files, folders}, or null when the drop holds plain files only (the normal path handles those).
    async function selectionFromDrop(dataTransfer) {
        const items = dataTransfer.items ? Array.from(dataTransfer.items).filter(i => i.kind === 'file') : [];
        const entries = items.map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
        if (!entries.some(e => e.isDirectory)) return null;
        const sel = { files: [], folders: [] };
        let total = 0;
        for (const entry of entries) {
            if (entry.isDirectory) {
                const collected = [];
                await walkEntry(entry, '', collected, MAX_FOLDER_FILES - total);
                total += collected.length;
                if (total > MAX_FOLDER_FILES) {
                    flash(`[ERR] Too many files in the dropped folders (limit ${MAX_FOLDER_FILES.toLocaleString()}). Upload them in parts or zip them first.`, 'error');
                    return { files: [], folders: [] };
                }
                sel.folders.push({ name: entry.name, items: collected });
            } else if (!isJunkFile(entry.name)) {
                sel.files.push(await entryToFile(entry));
                total++;
            }
        }
        return sel;
    }

    async function handleDrop(dataTransfer) {
        if (uploadInProgress) { flash('[INFO] Wait for the current upload to finish, or cancel it first.', 'info'); return; }
        let sel = null;
        try { sel = await selectionFromDrop(dataTransfer); }
        catch (err) { console.error('Could not read the dropped folder:', err); flash('[ERR] Could not read the dropped folder.', 'error'); return; }
        if (sel) {                       // folders were dropped
            if (folderInput) folderInput.value = '';
            if (fileInput) fileInput.value = '';
            droppedSelection = (sel.files.length || sel.folders.length) ? sel : null;
        } else {                         // plain files, as before
            droppedSelection = null;
            if (folderInput) folderInput.value = '';
            fileInput.files = dataTransfer.files;
        }
        fileUploaded();
    }

    if (fileDropZone) {
        fileDropZone.addEventListener('dragover', (e) => { e.preventDefault(); fileDropZone.classList.add('drag-over'); });
        fileDropZone.addEventListener('dragleave', () => { fileDropZone.classList.remove('drag-over'); });
        fileDropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            fileDropZone.classList.remove('drag-over');
            handleDrop(e.dataTransfer);
        });
        fileDropZone.addEventListener('click', () => { document.getElementById('fileInput').click(); });
    }

    if (fullPageDropZone && fileInput) {
        let dragCounter = 0;
        window.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; fullPageDropZone.classList.add('active'); });
        window.addEventListener('dragover', (e) => { e.preventDefault(); });
        window.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter === 0) { fullPageDropZone.classList.remove('active'); } });
        window.addEventListener('drop', (e) => {
            e.preventDefault();
            dragCounter = 0;
            fullPageDropZone.classList.remove('active');
            if (e.target.id !== 'fileDropZone' && !fileDropZone.contains(e.target)) {
                handleDrop(e.dataTransfer);
            }
        });
    }

    // --- Sending ---
    // Split [{file, path?}] into requests of at most BATCH_MAX_FILES files / BATCH_MAX_BYTES bytes
    function makeBatches(items) {
        const batches = [];
        let current = [], bytes = 0;
        for (const item of items) {
            if (current.length && (current.length >= BATCH_MAX_FILES || bytes + item.file.size > BATCH_MAX_BYTES)) {
                batches.push(current); current = []; bytes = 0;
            }
            current.push(item); bytes += item.file.size;
        }
        if (current.length) batches.push(current);
        return batches;
    }

    // One XMLHttpRequest as a promise. onProgress(loadedBytesOfThisRequest). Resolves {status, json}.
    function sendRequest(url, formData, { folderBatch = false, onProgress } = {}) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            currentUploadXhr = xhr;
            xhr.open('POST', url, true);
            if (folderBatch) xhr.setRequestHeader('X-Snail-Folder-Upload', '1');
            xhr.upload.addEventListener('progress', (event) => { if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total); });
            xhr.onload = () => {
                currentUploadXhr = null;
                let json = null;
                try { json = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
                resolve({ status: xhr.status, json, text: xhr.responseText });
            };
            xhr.onerror = () => { currentUploadXhr = null; reject(new Error('network')); };
            xhr.onabort = () => { currentUploadXhr = null; reject(new Error('aborted')); };
            xhr.send(formData);
        });
    }

    async function postJson(url, body) {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        let json = null;
        try { json = await response.json(); } catch (e) { /* ignore */ }
        return { ok: response.ok, json };
    }

    if (uploadForm) {
        uploadForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (uploadInProgress) return;
            const sel = getSelection();
            const totals = selectionTotals(sel);
            if (!totals.count && !sel.folders.length) return;
            if (!totals.count) { flash('[INFO] The selected folder has no files in it, so there is nothing to upload.', 'info'); return; }

            const subpathInput = document.getElementById('uploadSubpath');
            const subpath = subpathInput && subpathInput.value ? subpathInput.value : '';

            uploadInProgress = true;
            uploadCancelled = false;
            uploadButton.disabled = true;
            uploadButton.textContent = 'Uploading...';
            if (progressContainer) progressContainer.style.display = 'block';
            if (progressBar) progressBar.style.width = '0%';
            const speedEl = document.getElementById('uploadSpeed');
            const progressBytesEl = document.getElementById('uploadProgressBytes');
            const etaEl = document.getElementById('uploadEta');
            const labelEl = progressContainer ? progressContainer.querySelector('.progress-bar-label') : null;
            if (speedEl) speedEl.textContent = '0 KB/s';
            if (progressBytesEl) progressBytesEl.textContent = '0 Bytes / ' + formatBytes(totals.bytes);
            if (etaEl) etaEl.textContent = '--:--';
            if (clearUploadBtn) { clearUploadBtn.textContent = 'Cancel'; clearUploadBtn.style.display = 'inline-flex'; }

            // One progress bar for everything: bytes finished in earlier requests + bytes of the current one
            const startTime = Date.now();
            let doneBytes = 0;
            const showProgress = (loadedNow) => {
                const loaded = doneBytes + loadedNow;
                const percent = totals.bytes ? Math.min(100, (loaded / totals.bytes) * 100) : 100;
                if (progressBar) progressBar.style.width = percent + '%';
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = elapsed > 0 ? loaded / elapsed : 0;
                if (speedEl) speedEl.textContent = speed > 0 ? formatSpeed(speed) : '0 KB/s';
                if (progressBytesEl) progressBytesEl.textContent = `${formatBytes(loaded)} / ${formatBytes(totals.bytes)}`;
                if (etaEl) etaEl.textContent = speed > 0 ? formatTime((totals.bytes - loaded) / speed) : '--:--';
            };
            // Progress events count multipart overhead too, so scale a request's events to the file bytes it carries
            const progressFor = (batchBytes) => (loaded, total) => showProgress(total ? Math.min(batchBytes, batchBytes * (loaded / total)) : 0);

            const problems = [];     // human-readable things that went wrong
            let uploadedFiles = 0, failedFiles = 0;
            const summary = [];
            try {
                // 1. loose files: a single request, exactly as before
                if (sel.files.length) {
                    if (labelEl) labelEl.textContent = 'Uploading...';
                    const fd = new FormData();
                    sel.files.forEach(f => fd.append('file', f));
                    if (subpath) fd.append('subpath', subpath);
                    const batchBytes = sel.files.reduce((n, f) => n + f.size, 0);
                    const res = await sendRequest(uploadForm.action, fd, { onProgress: progressFor(batchBytes) });
                    doneBytes += batchBytes;
                    if (res.status >= 200 && res.status < 400) { uploadedFiles += sel.files.length; summary.push(sel.files.length === 1 ? 'file' : `${sel.files.length} files`); }
                    else { failedFiles += sel.files.length; problems.push(`Files: server responded with status ${res.status}.`); }
                }

                // 2. each folder: create it, send its files in batches, report the result
                for (const folder of sel.folders) {
                    if (uploadCancelled) break;
                    const folderBytes = folder.items.reduce((n, i) => n + i.file.size, 0);
                    const folderStart = Date.now();
                    if (labelEl) labelEl.textContent = `Uploading folder "${folder.name}"...`;
                    const started = await postJson('/api/upload/folder/start', { path: subpath, name: folder.name, files: folder.items.length, bytes: folderBytes });
                    if (!started.ok || !started.json || !started.json.success) {
                        failedFiles += folder.items.length;
                        problems.push(`"${folder.name}": ${(started.json && started.json.error) || 'could not create the folder on the server.'}`);
                        doneBytes += folderBytes;
                        continue;
                    }
                    const targetName = started.json.name, targetPath = started.json.path;
                    let folderUploaded = 0, folderFailed = 0, folderDoneBytes = 0, outcome = 'done';
                    for (const batch of makeBatches(folder.items)) {
                        if (uploadCancelled) { outcome = 'cancelled'; break; }
                        const batchBytes = batch.reduce((n, i) => n + i.file.size, 0);
                        const fd = new FormData();
                        fd.append('subpath', targetPath);
                        for (const item of batch) {
                            fd.append('file', item.file, item.file.name);
                            // path inside the new folder: drop the leading folder name that every path starts with
                            fd.append('relpaths', item.path.split('/').slice(1).join('/') || item.file.name);
                        }
                        try {
                            const res = await sendRequest(uploadForm.action, fd, { folderBatch: true, onProgress: progressFor(batchBytes) });
                            const errors = (res.json && res.json.messages && res.json.messages.error) || [];
                            const okCount = (res.json && res.json.messages && res.json.messages.success) ? res.json.messages.success.length : 0;
                            if (res.status >= 200 && res.status < 400) {
                                folderUploaded += okCount;
                                const lost = Math.max(batch.length - okCount - batch.filter(i => isJunkFile(i.file.name)).length, 0);
                                folderFailed += lost;
                                if (lost && errors.length) problems.push(`"${folder.name}": ${errors[0]}`);
                            } else {
                                folderFailed += batch.length;
                                problems.push(`"${folder.name}": server responded with status ${res.status}.`);
                                outcome = 'error';
                            }
                        } catch (err) {
                            if (err.message === 'aborted') { outcome = 'cancelled'; folderFailed += batch.length; break; }
                            folderFailed += batch.length; outcome = 'error';
                            problems.push(`"${folder.name}": network error during upload.`);
                            doneBytes += batchBytes; folderDoneBytes += batchBytes;
                            break;
                        }
                        doneBytes += batchBytes; folderDoneBytes += batchBytes;
                    }
                    uploadedFiles += folderUploaded; failedFiles += folderFailed;
                    if (outcome !== 'cancelled' && folderFailed) outcome = 'error';
                    try {
                        await postJson('/api/upload/folder/finish', { path: subpath, name: targetName, uploaded: folderUploaded, failed: folderFailed, bytes: folderDoneBytes, seconds: (Date.now() - folderStart) / 1000, outcome });
                    } catch (err) { /* only the terminal report is lost */ }
                    if (outcome === 'cancelled') { uploadCancelled = true; break; }
                    if (folderFailed === 0) summary.push(`folder "${targetName}" (${folderUploaded} file${folderUploaded === 1 ? '' : 's'})`);
                }
            } catch (err) {
                if (err.message === 'aborted') uploadCancelled = true;
                else problems.push('A network error occurred during the upload.');
            }

            currentUploadXhr = null;
            uploadInProgress = false;
            if (progressContainer) progressContainer.style.display = 'none';
            if (labelEl) labelEl.textContent = 'Uploading...';
            // The WebSocket 'file_list_updated' event re-renders the list for everyone
            if (uploadCancelled) {
                flash(uploadedFiles ? `[INFO] Upload cancelled after ${uploadedFiles} file${uploadedFiles === 1 ? '' : 's'} had been uploaded.` : '[INFO] Upload cancelled.', 'info');
                clearFileSelection();
            } else if (problems.length) {
                flash(`[ERR] ${uploadedFiles ? `${uploadedFiles} uploaded, ${failedFiles} failed. ` : ''}${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more, see the console)` : ''}`, 'error');
                console.error('Upload problems:', problems);
                uploadButton.disabled = false;
                fileUploaded();
            } else {
                flash(summary.length === 1 && sel.folders.length === 1 && !sel.files.length ? `Uploaded ${summary[0]}.` : 'Upload successful!', 'success');
                clearFileSelection();
            }
        });
    }

    // Clear/Cancel upload button handler
    if (clearUploadBtn) {
        clearUploadBtn.addEventListener('click', () => {
            if (uploadInProgress) {
                // Cancel the upload: stop the request in flight; the loop sees the flag and stops sending more
                uploadCancelled = true;
                if (currentUploadXhr) currentUploadXhr.abort();
            } else {
                clearFileSelection();
            }
        });
    }

    // --- CONTENT MANAGEMENT (SHARED TEXT) LOGIC ---
    const isLocal = ['localhost', '127.0.0.1', ''].includes(window.location.hostname.toLowerCase());
    if (selectTextAction) { selectTextAction.textContent = isLocal ? 'copies to clipboard' : 'copies to clipboard'; }
    function updateTextMeta() { if (sharedTextArea && textMeta) { const charCount = sharedTextArea.value.length; textMeta.textContent = `${charCount} chars`; updatePinButtonState(); } }
    async function loadSharedText() { if (!sharedTextArea) return; try { const response = await fetch('/api/shared-text'); if (!response.ok) throw new Error(`Server error: ${response.status}`); const result = await response.json(); if (result.success) { sharedTextArea.value = result.text; updateTextMeta(); } else { throw new Error(result.error || 'Unknown server error'); } } catch (error) { console.error('Error loading shared text:', error); setStatus(`[ERR] Load failed: ${error.message}`, 'error'); sharedTextArea.value = 'Error loading content.'; sharedTextArea.disabled = true; if (commitBtn) commitBtn.disabled = true; } }
    async function commitSharedText() { if (!sharedTextArea || !commitBtn) return; const textToSend = isEditorMode && easyMDEInstance ? easyMDEInstance.value() : sharedTextArea.value; commitBtn.disabled = true; commitBtn.textContent = 'Committing...'; setStatus('', 'info'); try { const response = await fetch('/api/shared-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: textToSend }), }); if (!response.ok) throw new Error(`Server error: ${response.status}`); const result = await response.json(); if (result.success) { setStatus('[OK] Buffer updated.', 'success'); } else { throw new Error(result.error || 'Unknown server error'); } } catch (error) { console.error('Error committing shared text:', error); setStatus(`[ERR] Commit failed: ${error.message}`, 'error'); } finally { commitBtn.disabled = false; commitBtn.textContent = 'Commit'; } }
    function clearSharedText() {
        if (sharedTextArea) {
            if (isEditorMode && easyMDEInstance) { easyMDEInstance.value(''); } else { sharedTextArea.value = ''; }
            // Exit preview mode if active
            if (isPreviewMode) {
                isPreviewMode = false;
                markdownPreview.classList.add('view-hidden');
                markdownPreview.innerHTML = '';
                sharedTextArea.classList.remove('preview-active');
                previewBtn.classList.remove('active');
            }
            updateTextMeta(); commitSharedText(); setStatus('[OK] Buffer cleared.', 'success');
        }
    }
    async function selectSharedText() {
        if (!sharedTextArea || !selectBtn) return;
        setStatus('', 'info');
        const textToCopy = sharedTextArea.value;
        if (!textToCopy) {
            setStatus('[INFO] Buffer is empty, nothing to copy.', 'info');
            return;
        }
        selectBtn.disabled = true;
        selectBtn.textContent = 'Copying...';

        let copied = false;

        // Try modern clipboard API first
        if (navigator.clipboard && navigator.clipboard.writeText) {
            try {
                await navigator.clipboard.writeText(textToCopy);
                copied = true;
            } catch (err) {
                console.warn('Clipboard API failed:', err);
            }
        }

        // Fallback: Use execCommand with temporary textarea (mobile-friendly)
        if (!copied) {
            try {
                const tempTextArea = document.createElement('textarea');
                tempTextArea.value = textToCopy;
                tempTextArea.style.position = 'fixed';
                tempTextArea.style.left = '-9999px';
                tempTextArea.style.top = '0';
                tempTextArea.setAttribute('readonly', '');
                document.body.appendChild(tempTextArea);

                // Select for iOS
                tempTextArea.focus();
                tempTextArea.setSelectionRange(0, textToCopy.length);

                copied = document.execCommand('copy');
                document.body.removeChild(tempTextArea);
            } catch (err) {
                console.warn('execCommand copy failed:', err);
            }
        }

        if (copied) {
            setStatus('[OK] Text copied to clipboard.', 'success');
            flash('[OK] Text copied!', 'success');
        } else {
            // Ultimate fallback: select text in the textarea
            sharedTextArea.focus();
            sharedTextArea.setSelectionRange(0, sharedTextArea.value.length);
            setStatus('[INFO] Text selected. Long-press and tap Copy.', 'info');
        }

        selectBtn.disabled = false;
        selectBtn.textContent = 'Select';
    }

    // --- PINNED MESSAGES LOGIC ---
    function updatePinButtonState(pinCount) { if (!pinBtn) return; const currentPinCount = pinCount ?? (pinnedMessagesContainer.children.length - (pinnedMessagesContainer.querySelector('.no-pins-message') ? 1 : 0)); const isTextAreaEmpty = sharedTextArea.value.trim() === ''; if (currentPinCount >= PIN_LIMIT) { pinBtn.disabled = true; pinBtn.title = `Pin limit of ${PIN_LIMIT} reached.`; } else if (isTextAreaEmpty) { pinBtn.disabled = true; pinBtn.title = 'Cannot pin empty text.'; } else { pinBtn.disabled = false; pinBtn.title = 'Pin the current text'; } }
    async function handlePinClick() { const textToPin = sharedTextArea.value; if (textToPin.trim() === '' || pinBtn.disabled) return; pinBtn.disabled = true; try { const response = await fetch('/api/pins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: textToPin }), }); const result = await response.json(); if (!result.success) { throw new Error(result.error || 'Failed to pin message.'); } flash('[OK] Message pinned successfully.', 'success'); setStatus('[OK] Message pinned.', 'success'); } catch (error) { console.error('Error pinning message:', error); setStatus(`[ERR] ${error.message}`, 'error'); } }
    async function handleUnpinClick(pinId) { try { const response = await fetch(`/api/pins/${pinId}`, { method: 'DELETE' }); const result = await response.json(); if (!result.success) { throw new Error(result.error || 'Failed to unpin message.'); } setStatus('[OK] Message unpinned.', 'success'); } catch (error) { console.error('Error unpinning message:', error); setStatus(`[ERR] ${error.message}`, 'error'); } }
    function renderPinnedMessages(pins = []) {
        if (!pinnedMessagesContainer) return;
        pinnedMessagesContainer.innerHTML = '';
        if (pins.length === 0) {
            pinnedMessagesContainer.innerHTML = '<p class="no-pins-message">No pinned messages. Type something in the shared buffer and click "Pin" to save it here.</p>';
            return;
        }
        pins.forEach(pin => {
            const card = document.createElement('div');
            card.className = 'pin-card';
            card.dataset.id = pin.id;

            const content = document.createElement('div');
            content.className = 'pin-card-content';
            content.textContent = pin.text;
            card.appendChild(content);

            const actions = document.createElement('div');
            actions.className = 'pin-card-actions';
            actions.innerHTML = `<button class="btn btn-secondary copy-pin-btn" title="Copy to Clipboard">Copy</button><button class="btn btn-secondary enlarge-pin-btn" title="Expand/Collapse">Enlarge</button><button class="btn btn-icon unpin-btn" title="Unpin Message"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>`;
            card.appendChild(actions);

            pinnedMessagesContainer.appendChild(card);
        });
    }
    function switchView(view) {
        currentView = view;
        // Hide all views
        sharedTextView.classList.add('view-hidden');
        pinnedMessagesView.classList.add('view-hidden');
        aiChatView.classList.add('view-hidden');
        // Deactivate all buttons
        if (viewBtnShared) viewBtnShared.classList.remove('active');
        if (viewBtnPinned) viewBtnPinned.classList.remove('active');
        if (viewBtnAiChat) viewBtnAiChat.classList.remove('active');
        // Show the selected view
        if (view === 'shared') {
            sharedTextView.classList.remove('view-hidden');
            if (viewBtnShared) viewBtnShared.classList.add('active');
            bufferTitle.textContent = 'Shared Text Buffer';
        } else if (view === 'pinned') {
            pinnedMessagesView.classList.remove('view-hidden');
            if (viewBtnPinned) viewBtnPinned.classList.add('active');
            bufferTitle.textContent = 'Pinned Buffer';
        } else if (view === 'ai') {
            aiChatView.classList.remove('view-hidden');
            if (viewBtnAiChat) viewBtnAiChat.classList.add('active');
            bufferTitle.textContent = 'AI Chat';
        }
    }
    // Backward-compat alias
    function toggleViews() { switchView(currentView); }

    if (pinnedMessagesContainer) {
        pinnedMessagesContainer.addEventListener('click', async (e) => {
            const copyBtn = e.target.closest('.copy-pin-btn');
            const enlargeBtn = e.target.closest('.enlarge-pin-btn');
            const unpinBtn = e.target.closest('.unpin-btn');
            if (copyBtn) { const card = copyBtn.closest('.pin-card'); const content = card.querySelector('.pin-card-content').textContent; const copied = await copyToClipboard(content); if (copied) { flash('[OK] Pinned text copied.', 'success'); } else { flash('[ERR] Failed to copy.', 'error'); } }
            if (enlargeBtn) {
                const card = enlargeBtn.closest('.pin-card');
                const content = card.querySelector('.pin-card-content');
                const isExpanded = content.classList.toggle('expanded');
                enlargeBtn.textContent = isExpanded ? 'Collapse' : 'Enlarge';
            }
            if (unpinBtn) { const card = unpinBtn.closest('.pin-card'); const pinId = card.dataset.id; if (pinId) { handleUnpinClick(pinId); } }
        });
    }

    // Clear All Pins button
    const clearAllPinsBtn = document.getElementById('clearAllPinsBtn');
    if (clearAllPinsBtn) {
        clearAllPinsBtn.addEventListener('click', async () => {
            try {
                const response = await fetch('/api/pins/clear', { method: 'DELETE' });
                const result = await response.json();
                if (!result.success) { throw new Error(result.error || 'Failed to clear pins.'); }
                flash('[OK] All pins cleared.', 'success');
            } catch (error) {
                console.error('Error clearing pins:', error);
                flash(`[ERR] ${error.message}`, 'error');
            }
        });
    }

    // --- FILE LIST MANAGEMENT (DELETE, LOCK, SEARCH, SELECT) ---
    const downloadTableBody = document.querySelector('#downloadSelectedForm tbody');
    if (downloadTableBody) {
        downloadTableBody.addEventListener('click', async (e) => {
            const deleteButton = e.target.closest('.delete-file-btn');
            if (!deleteButton) return;
            const encodedFilename = deleteButton.dataset.filename;
            const decodedFilename = decodeURIComponent(encodedFilename);
            if (!confirm(`Are you sure you want to permanently delete the file:\n\n${decodedFilename}`)) { return; }
            setStatus(`[INFO] Deleting '${decodedFilename}'...`, 'info', 60000);
            try {
                const response = await fetch(`/delete/${encodedFilename}`, { method: 'DELETE' });
                const result = await response.json();
                if (!response.ok) { throw new Error(result.error || `Server responded with status ${response.status}`); }
                // No longer need to manually remove row, the websocket update will handle it.
                setStatus(`[OK] File '${decodedFilename}' was deleted.`, 'success');
            } catch (error) {
                console.error('Error deleting file:', error);
                setStatus(`[ERR] Failed to delete file: ${error.message}`, 'error');
            }
        });
    }

    function updateDownloadSelectedButtonState() {
        const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
        const selectAllFilesCheckbox = document.getElementById('selectAllFilesCheckbox');
        const fileCheckboxes = document.querySelectorAll('.file-checkbox:not(:disabled)');

        if (!downloadSelectedBtn || !fileCheckboxes) return;
        const anySelected = Array.from(fileCheckboxes).some(cb => cb.checked);
        downloadSelectedBtn.disabled = !anySelected;

        const lockSelectedBtn = document.getElementById('lockSelectedBtn');
        const unlockSelectedBtn = document.getElementById('unlockSelectedBtn');
        const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
        const moveSelectedBtn = document.getElementById('moveSelectedBtn');
        if (lockSelectedBtn) lockSelectedBtn.disabled = !anySelected;
        if (unlockSelectedBtn) unlockSelectedBtn.disabled = !anySelected;
        if (deleteSelectedBtn) deleteSelectedBtn.disabled = !anySelected;
        if (moveSelectedBtn) moveSelectedBtn.disabled = !anySelected;
        const shareSelectedBtn = document.getElementById('shareSelectedBtn');
        if (shareSelectedBtn) shareSelectedBtn.disabled = !anySelected;

        if (selectAllFilesCheckbox) {
            const visibleCheckboxes = Array.from(fileCheckboxes).filter(cb => !cb.closest('tr').classList.contains('row-hidden'));
            if (visibleCheckboxes.length === 0) {
                selectAllFilesCheckbox.checked = false;
            } else {
                selectAllFilesCheckbox.checked = visibleCheckboxes.every(cb => cb.checked);
            }
        }
    }
    document.body.addEventListener('change', (e) => {
        if (e.target.matches('#selectAllFilesCheckbox')) {
            const fileCheckboxes = document.querySelectorAll('.file-checkbox:not(:disabled)');
            fileCheckboxes.forEach(cb => {
                if (!cb.closest('tr').classList.contains('row-hidden')) {
                    cb.checked = e.target.checked;
                }
            });
            updateDownloadSelectedButtonState();
        }
        if (e.target.matches('.file-checkbox')) {
            updateDownloadSelectedButtonState();
        }
    });

    // --- DROPDOWN MENUS (sort / group / view) ---
    // One shared open/close behaviour: opening a menu closes the others; outside click or Escape closes all.
    const dirMenus = [];
    function closeDirMenus(except) {
        dirMenus.forEach(m => {
            if (m.panel === except) return;
            m.panel.classList.remove('visible');
            m.btn.setAttribute('aria-expanded', 'false');
        });
    }
    function registerDirMenu(btn, panel, onPick, pickSelector) {
        if (!btn || !panel) return;
        dirMenus.push({ btn, panel });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = !panel.classList.contains('visible');
            closeDirMenus(panel);
            panel.classList.toggle('visible', open);
            btn.setAttribute('aria-expanded', String(open));
        });
        panel.addEventListener('click', (e) => {
            const option = e.target.closest(pickSelector);
            if (!option) return;
            onPick(option);
            closeDirMenus();
        });
    }
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-sort-dropdown')) closeDirMenus();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDirMenus(); });

    // --- SORT / GROUP / FILTER STATE (remembered between visits) ---
    const sortToggleBtn = document.getElementById('sortToggleBtn');
    const sortOptionsPanel = document.getElementById('sortOptions');
    const groupToggleBtn = document.getElementById('groupToggleBtn');
    const groupOptionsPanel = document.getElementById('groupOptions');
    // ".v2": the defaults changed (group by Type, Details view), so choices saved under the old keys are ignored once
    const SORT_PREFS_KEY = 'snailsynk.dirSortGroup.v2';
    const VALID_SORTS = ['name-asc', 'name-desc', 'date-desc', 'date-asc', 'size-desc', 'size-asc'];
    const VALID_GROUPS = ['folders-first', 'files-first', 'by-type', 'by-date'];
    const DEFAULT_GROUP = 'by-type';
    let currentSortValue = 'date-desc';      // default sort
    let currentGroupValue = DEFAULT_GROUP;   // default group
    let currentFilterValue = 'all';          // 'all' or 'favorites-only'
    try {
        const saved = JSON.parse(localStorage.getItem(SORT_PREFS_KEY) || '{}');
        if (VALID_SORTS.includes(saved.sort)) currentSortValue = saved.sort;
        if (VALID_GROUPS.includes(saved.group)) currentGroupValue = saved.group;
        if (saved.filter === 'favorites-only') currentFilterValue = 'favorites-only';
    } catch (e) { /* storage blocked or corrupt: use defaults */ }

    function saveSortPrefs() {
        try { localStorage.setItem(SORT_PREFS_KEY, JSON.stringify({ sort: currentSortValue, group: currentGroupValue, filter: currentFilterValue })); } catch (e) { /* ignore */ }
    }

    // Reflect the current state in the menus and in the sortable column headers
    function syncSortMenus() {
        if (sortOptionsPanel) {
            sortOptionsPanel.querySelectorAll('.custom-sort-option[data-value]').forEach(o => o.classList.toggle('active', o.dataset.value === currentSortValue));
            sortOptionsPanel.querySelectorAll('.custom-sort-option[data-filter]').forEach(o => o.classList.toggle('active', currentFilterValue === o.dataset.filter));
        }
        if (groupOptionsPanel) {
            groupOptionsPanel.querySelectorAll('.custom-sort-option[data-group]').forEach(o => o.classList.toggle('active', o.dataset.group === currentGroupValue));
        }
        document.querySelectorAll('#downloadSelectedForm th[data-sort-key]').forEach(th => {
            const key = th.dataset.sortKey;
            th.dataset.sortDir = currentSortValue.startsWith(key + '-') ? currentSortValue.split('-')[1] : '';
        });
        if (sortToggleBtn) sortToggleBtn.classList.toggle('has-filter', currentFilterValue !== 'all');
        if (groupToggleBtn) groupToggleBtn.classList.toggle('has-filter', currentGroupValue !== DEFAULT_GROUP);
    }

    function setSort(value) { currentSortValue = value; syncSortMenus(); saveSortPrefs(); sortTableRowsCustom(); }

    registerDirMenu(sortToggleBtn, sortOptionsPanel, (option) => {
        if (option.dataset.value) {
            currentSortValue = option.dataset.value;
        } else if (option.dataset.filter) {
            currentFilterValue = currentFilterValue === option.dataset.filter ? 'all' : option.dataset.filter;
        }
        syncSortMenus(); saveSortPrefs(); sortTableRowsCustom();
    }, '.custom-sort-option');

    registerDirMenu(groupToggleBtn, groupOptionsPanel, (option) => {
        currentGroupValue = option.dataset.group;
        syncSortMenus(); saveSortPrefs(); sortTableRowsCustom();
    }, '.custom-sort-option[data-group]');

    // Clicking a column header (Filename / Size / Modified) sorts by it; click again to reverse.
    const directoryForm = document.getElementById('downloadSelectedForm');
    if (directoryForm) {
        directoryForm.addEventListener('click', (e) => {
            const th = e.target.closest('th[data-sort-key]');
            if (!th) return;
            const key = th.dataset.sortKey;
            if (currentSortValue.startsWith(key + '-')) {
                setSort(`${key}-${currentSortValue.endsWith('asc') ? 'desc' : 'asc'}`);
            } else {
                setSort(key === 'name' ? 'name-asc' : `${key}-desc`);   // sensible first direction per column
            }
        });
    }

    // --- DOWNLOAD DIRECTORY VIEW STYLE (list / details / grid) ---
    // Pure CSS does the work: we only set data-view on the container, so it applies equally to the
    // server-rendered rows and to rows re-rendered by real-time updates. The choice is remembered.
    const viewStyleBtn = document.getElementById('viewStyleBtn');
    const viewStyleOptions = document.getElementById('viewStyleOptions');
    const directoryContainer = document.querySelector('#downloadSelectedForm .download-container');
    const DIRECTORY_VIEW_KEY = 'snailsynk.downloadView.v2';   // v2: Details became the default view
    const DIRECTORY_VIEWS = ['list', 'details', 'grid'];
    const DEFAULT_VIEW = 'details';

    function applyDirectoryView(view, remember = true) {
        if (!DIRECTORY_VIEWS.includes(view)) view = DEFAULT_VIEW;
        if (directoryContainer) {
            directoryContainer.dataset.view = view;
            directoryContainer.classList.toggle('is-admin', !!document.getElementById('lockSelectedBtn'));
        }
        if (viewStyleOptions) {
            viewStyleOptions.querySelectorAll('.view-style-option').forEach(o => {
                const isActive = o.dataset.view === view;
                o.classList.toggle('active', isActive);
                if (isActive && viewStyleBtn) {
                    // The button shows the icon of the current view
                    viewStyleBtn.innerHTML = o.querySelector('svg').outerHTML;
                    viewStyleBtn.title = `View style: ${o.textContent.trim()} (click to change)`;
                }
            });
        }
        if (remember) { try { localStorage.setItem(DIRECTORY_VIEW_KEY, view); } catch (e) { /* storage blocked: fine */ } }
    }

    if (viewStyleBtn && viewStyleOptions && directoryContainer) {
        let savedView = DEFAULT_VIEW;
        try { savedView = localStorage.getItem(DIRECTORY_VIEW_KEY) || DEFAULT_VIEW; } catch (e) { /* ignore */ }
        applyDirectoryView(savedView, false);
        registerDirMenu(viewStyleBtn, viewStyleOptions, (option) => applyDirectoryView(option.dataset.view), '.view-style-option');
    }
    syncSortMenus();

    // --- RIGHT-CLICK MENU FOR THE DOWNLOAD DIRECTORY ---
    // Only inside the file list. Each menu entry simply triggers the matching (now hidden) button of the row, so all
    // the real logic (rename, move, lock, share, delete...) stays in one place. Shift + right-click still gives the
    // browser's own menu, and on touch screens the "⋯" button on every row opens the same menu.
    const dirContextMenu = document.createElement('div');
    dirContextMenu.id = 'dirContextMenu';
    dirContextMenu.className = 'dir-context-menu';
    dirContextMenu.setAttribute('role', 'menu');
    dirContextMenu.tabIndex = -1;
    dirContextMenu.hidden = true;
    document.body.appendChild(dirContextMenu);
    let contextTargetRow = null;

    function closeContextMenu() {
        if (dirContextMenu.hidden) return;
        dirContextMenu.hidden = true;
        dirContextMenu.replaceChildren();
        if (contextTargetRow) contextTargetRow.classList.remove('context-target');
        contextTargetRow = null;
    }

    function ctxItem(label, svgHtml, onActivate, danger = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dir-ctx-item' + (danger ? ' danger' : '');
        button.setAttribute('role', 'menuitem');
        if (svgHtml) button.insertAdjacentHTML('afterbegin', svgHtml);
        const text = document.createElement('span');
        text.textContent = label;
        button.appendChild(text);
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            closeContextMenu();
            onActivate();
        });
        return button;
    }
    function ctxHeading(text) {
        const heading = document.createElement('div');
        heading.className = 'dir-ctx-heading';
        heading.textContent = text;
        return heading;
    }
    function ctxSeparator() {
        const separator = document.createElement('div');
        separator.className = 'dir-ctx-separator';
        separator.setAttribute('role', 'separator');
        return separator;
    }

    // [selector of the row's own button, label, group, danger]. Only entries whose button exists in the row are shown
    // (guests have fewer buttons than admins, folders fewer than files), and a separator is drawn between groups.
    const ROW_MENU = [
        { sel: '.folder-link', label: () => 'Open', group: 1 },
        { sel: '.file-download-link', label: () => 'Download', group: 1 },
        { sel: '.folder-download-btn', label: () => 'Download as ZIP', group: 1 },
        { sel: '.file-open-img-btn', label: () => 'Open image in new tab', group: 1 },
        { sel: '.file-copy-img-btn', label: () => 'Copy image', group: 1 },
        { sel: '.file-share-btn', label: () => 'Create share link…', group: 2 },
        { sel: '.file-favorite-btn', label: b => (b.classList.contains('active') ? 'Remove from favourites' : 'Add to favourites'), group: 2 },
        { sel: '.rename-file-btn, .rename-folder-btn', label: () => 'Rename…', group: 3 },
        { sel: '.file-move-btn', label: () => 'Move…', group: 3 },
        { sel: '.file-lock-btn, .folder-lock-btn', label: b => (/^unlock/i.test(b.title) ? 'Unlock…' : 'Lock with password…'), group: 3 },
        { sel: '.delete-file-btn, .delete-folder-btn', label: () => 'Delete', group: 4, danger: true },
    ];

    function rowMenuEntries(row) {
        return ROW_MENU.map(entry => ({ entry, button: row.querySelector(entry.sel) })).filter(x => x.button);
    }

    function buildRowMenu(row) {
        const nodes = [];
        const nameLink = row.querySelector('td:nth-child(2) a');
        nodes.push(ctxHeading(nameLink ? nameLink.textContent.trim() : 'Item'));
        let lastGroup = null;
        rowMenuEntries(row).forEach(({ entry, button }) => {
            if (lastGroup !== null && entry.group !== lastGroup) nodes.push(ctxSeparator());
            lastGroup = entry.group;
            const icon = button.querySelector('svg');
            nodes.push(ctxItem(entry.label(button), icon ? icon.outerHTML : '', () => button.click(), !!entry.danger));
        });
        return nodes;
    }

    // Several rows ticked and one of them right-clicked: offer the bulk actions of the bar under the list
    function buildBatchMenu(count) {
        const nodes = [ctxHeading(`${count} items selected`)];
        const bulk = [
            ['downloadSelectedBtn', 'Download as ZIP', false], ['shareSelectedBtn', 'Create share links…', false],
            ['moveSelectedBtn', 'Move…', false], ['lockSelectedBtn', 'Lock with password…', false],
            ['unlockSelectedBtn', 'Unlock…', false], ['deleteSelectedBtn', 'Delete', true],
        ];
        bulk.forEach(([id, label, danger]) => {
            const button = document.getElementById(id);
            if (!button || button.disabled) return;
            if (danger) nodes.push(ctxSeparator());
            const icon = button.querySelector('svg');
            nodes.push(ctxItem(label, icon ? icon.outerHTML : '', () => button.click(), danger));
        });
        return nodes;
    }

    // Right-click on empty space (or a group heading) inside the list
    function buildBlankMenu() {
        const nodes = [ctxHeading('Download Directory')];
        const folderIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>';
        const checkIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>';
        const refreshIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
        const newFolder = document.getElementById('newFolderBtn');
        if (newFolder) nodes.push(ctxItem('New folder…', folderIcon, () => newFolder.click()));
        const selectAll = document.getElementById('selectAllFilesCheckbox');
        if (selectAll && fileListBody && fileListBody.querySelector('tr[data-file-row]')) {
            nodes.push(ctxItem(selectAll.checked ? 'Deselect all' : 'Select all', checkIcon, () => selectAll.click()));
        }
        nodes.push(ctxItem('Refresh', refreshIcon, () => navigateToFolder(currentPath)));
        return nodes;
    }

    function showContextMenu(x, y, nodes, anchorRight = false) {
        dirContextMenu.replaceChildren(...nodes);
        dirContextMenu.style.left = '0px';
        dirContextMenu.style.top = '0px';
        dirContextMenu.hidden = false;
        const width = dirContextMenu.offsetWidth, height = dirContextMenu.offsetHeight;
        let left = anchorRight ? x - width : x;
        let top = y;
        // keep it on screen: flip to the other side of the pointer when there is no room
        if (left + width > window.innerWidth - 8) left = Math.max(8, x - width);
        if (left < 8) left = 8;
        if (top + height > window.innerHeight - 8) top = Math.max(8, y - height);
        if (top < 8) top = 8;
        dirContextMenu.style.left = `${left}px`;
        dirContextMenu.style.top = `${top}px`;
        dirContextMenu.focus({ preventScroll: true });
    }

    function openContextMenuFor(row, x, y, anchorRight = false) {
        closeContextMenu();
        let nodes;
        if (row) {
            contextTargetRow = row;
            row.classList.add('context-target');
            const checked = document.querySelectorAll('#file-list-body .file-checkbox:checked');
            const checkbox = row.querySelector('.file-checkbox');
            nodes = (checkbox && checkbox.checked && checked.length > 1) ? buildBatchMenu(checked.length) : buildRowMenu(row);
        } else {
            nodes = buildBlankMenu();
        }
        if (nodes.length <= 1) return;   // nothing to offer: leave it to the browser
        showContextMenu(x, y, nodes, anchorRight);
    }

    if (directoryContainer) {
        directoryContainer.addEventListener('contextmenu', (e) => {
            if (e.shiftKey) return;                      // Shift + right-click: the browser's normal menu
            const row = e.target.closest('tr[data-file-row]');
            if (row) {
                const checked = document.querySelectorAll('#file-list-body .file-checkbox:checked').length;
                const rowIsPartOfBatch = checked > 1 && row.querySelector('.file-checkbox') && row.querySelector('.file-checkbox').checked;
                // a menu with a single entry is pointless: leave those rows to the browser's own menu
                if (!rowIsPartOfBatch && rowMenuEntries(row).length < 2) { closeContextMenu(); return; }
            }
            e.preventDefault();
            openContextMenuFor(row, e.clientX, e.clientY);
        });
    }
    // Anything else closes the menu; a right-click outside the list shows the browser's own menu as usual
    document.addEventListener('mousedown', (e) => { if (!dirContextMenu.hidden && !e.target.closest('#dirContextMenu')) closeContextMenu(); });
    document.addEventListener('contextmenu', (e) => { if (!e.target.closest('#downloadSelectedForm .download-container') && !e.target.closest('#dirContextMenu')) closeContextMenu(); });
    window.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('blur', closeContextMenu);
    document.addEventListener('keydown', (e) => {
        if (dirContextMenu.hidden) return;
        if (e.key === 'Escape') { closeContextMenu(); return; }
        const items = Array.from(dirContextMenu.querySelectorAll('.dir-ctx-item'));
        const index = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(index + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
        else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    });

    // The "⋯" button at the end of each row opens the same menu (for touch screens and for discoverability)
    function ensureMoreButtons() {
        closeContextMenu();   // the rows this menu belonged to may just have been replaced
        document.querySelectorAll('#file-list-body tr[data-file-row] td.index-file-actions').forEach(cell => {
            if (cell.querySelector('.file-more-btn')) return;
            const row = cell.closest('tr');
            if (rowMenuEntries(row).length < 2) return;   // nothing beyond the one visible action
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn-icon file-more-btn';
            button.title = 'More actions (or right-click the row)';
            button.setAttribute('aria-haspopup', 'menu');
            button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>';
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const box = button.getBoundingClientRect();
                openContextMenuFor(row, box.right, box.bottom + 4, true);
            });
            cell.appendChild(button);
        });
    }

    // Extension → category mapping for "Group by Type"
    const TYPE_CATEGORY_MAP = {
        // Images
        png: 'Images', jpg: 'Images', jpeg: 'Images', gif: 'Images', webp: 'Images',
        svg: 'Images', bmp: 'Images', ico: 'Images', tiff: 'Images', tif: 'Images', heic: 'Images', avif: 'Images',
        // Videos
        mp4: 'Videos', mkv: 'Videos', avi: 'Videos', mov: 'Videos', wmv: 'Videos',
        flv: 'Videos', webm: 'Videos', m4v: 'Videos', '3gp': 'Videos', ts: 'Videos',
        // Audio
        mp3: 'Audio', wav: 'Audio', flac: 'Audio', aac: 'Audio', ogg: 'Audio',
        m4a: 'Audio', wma: 'Audio', opus: 'Audio', aiff: 'Audio',
        // Documents
        pdf: 'Documents', doc: 'Documents', docx: 'Documents', odt: 'Documents',
        xls: 'Documents', xlsx: 'Documents', ods: 'Documents', ppt: 'Documents',
        pptx: 'Documents', odp: 'Documents', txt: 'Documents', rtf: 'Documents', md: 'Documents',
        // Archives
        zip: 'Archives', rar: 'Archives', '7z': 'Archives', tar: 'Archives',
        gz: 'Archives', bz2: 'Archives', xz: 'Archives', iso: 'Archives', cab: 'Archives',
        // Code / Scripts
        js: 'Code', ts: 'Code', py: 'Code', html: 'Code', css: 'Code', json: 'Code',
        xml: 'Code', sh: 'Code', bat: 'Code', php: 'Code', rb: 'Code', java: 'Code',
        c: 'Code', cpp: 'Code', cs: 'Code', go: 'Code', rs: 'Code', kt: 'Code',
        swift: 'Code', yml: 'Code', yaml: 'Code', toml: 'Code', ini: 'Code', env: 'Code',
        // Data
        csv: 'Data', tsv: 'Data', sql: 'Data', db: 'Data', sqlite: 'Data',
        // Executables / System
        exe: 'Executables', msi: 'Executables', dmg: 'Executables', deb: 'Executables',
        apk: 'Executables', appimage: 'Executables', bin: 'Executables',
    };
    // Ordered display of type group labels
    const TYPE_CATEGORY_ORDER = ['Folders', 'Images', 'Videos', 'Audio', 'Documents', 'Archives', 'Code', 'Data', 'Executables', 'Other'];

    function getTypeCategory(row) {
        if (row.dataset.type === 'folder') return 'Folders';
        // Derive the extension from the name itself: rows rebuilt by renderFileList() carry no data-ext
        const name = row.dataset.sortName || '';
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
        return TYPE_CATEGORY_MAP[ext] || 'Other';
    }

    // Ordered display of date group labels
    const DATE_CATEGORY_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];
    function getDateCategory(row) {
        const modified = new Date(parseFloat(row.dataset.sortDate) * 1000);
        const now = new Date();
        const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const daysAgo = Math.round((dayStart(now) - dayStart(modified)) / 86400000);
        if (daysAgo <= 0) return 'Today';
        if (daysAgo === 1) return 'Yesterday';
        if (daysAgo <= 7) return 'Previous 7 days';
        if (daysAgo <= 30) return 'Previous 30 days';
        return 'Older';
    }

    // --- Size / date text shown in the Details view (and under names in Grid view) ---
    function formatFileSize(bytes) {
        let n = Number(bytes) || 0;
        if (n < 1024) return `${n} B`;
        const units = ['KB', 'MB', 'GB', 'TB'];
        let i = -1;
        do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
        return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
    }
    // Short form for this year ("Oct 11, 7:58 AM"); older files show the year instead of the time
    const metaDateThisYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const metaDateOlder = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const formatMetaDate = when => (when.getFullYear() === new Date().getFullYear() ? metaDateThisYear : metaDateOlder).format(when);
    // Rows come from two places (the server template and renderFileList), so add the info cells here,
    // once, from the data-* attributes both already carry. They stay hidden outside Details/Grid view.
    function decorateRowMeta(row) {
        const cell = row.querySelector('td:nth-child(2)');
        if (!cell || cell.querySelector('.file-meta')) return;
        const size = document.createElement('span');
        size.className = 'file-meta file-meta-size';
        size.textContent = formatFileSize(row.dataset.sortSize);
        const date = document.createElement('span');
        date.className = 'file-meta file-meta-date';
        const mtime = parseFloat(row.dataset.sortDate);
        if (Number.isFinite(mtime)) {
            const when = new Date(mtime * 1000);
            date.textContent = formatMetaDate(when);
            date.title = when.toLocaleString();
        }
        cell.append(size, date);
    }

    // Which rows are visible = search text AND the favourites filter. Done in one place so that
    // sorting, searching and filtering never undo each other.
    function applyRowVisibility() {
        if (!fileListBody) return;
        const input = document.getElementById('searchInput');
        const query = input ? input.value.toLowerCase().trim() : '';
        const rows = fileListBody.querySelectorAll('tr[data-file-row]');
        let visible = 0;
        rows.forEach(row => {
            const link = row.querySelector('td:nth-child(2) a');
            const name = link ? link.textContent.toLowerCase() : '';
            const hide = (query && !name.includes(query)) ||
                (currentFilterValue === 'favorites-only' && row.dataset.favorite !== 'true');
            row.classList.toggle('row-hidden', !!hide);
            if (!hide) visible++;
        });
        const noResultsRow = document.getElementById('noResultsRow');
        if (noResultsRow) noResultsRow.style.display = (rows.length > 0 && visible === 0) ? '' : 'none';
        // Hide group headings that have nothing left under them
        let heading = null, visibleUnder = 0;
        const closeHeading = () => { if (heading) heading.classList.toggle('row-hidden', visibleUnder === 0); };
        fileListBody.querySelectorAll(':scope > tr').forEach(tr => {
            if (tr.classList.contains('type-group-separator')) { closeHeading(); heading = tr; visibleUnder = 0; }
            else if (tr.hasAttribute('data-file-row') && !tr.classList.contains('row-hidden')) visibleUnder++;
        });
        closeHeading();
        updateDownloadSelectedButtonState();
    }

    const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });   // file2 before file10

    function sortTableRowsCustom() {
        if (!fileListBody) return;

        // Remove any existing group heading rows from a previous call
        fileListBody.querySelectorAll('.type-group-separator').forEach(el => el.remove());

        const rows = Array.from(fileListBody.querySelectorAll('tr[data-file-row]'));
        rows.forEach(decorateRowMeta);

        // 1. Sort by the selected criterion (ties fall back to the name so the order is stable)
        const byName = (a, b) => nameCollator.compare(a.dataset.sortName, b.dataset.sortName);
        const num = (row, key) => parseFloat(row.dataset[key]) || 0;
        rows.sort((a, b) => {
            switch (currentSortValue) {
                case 'name-asc': return byName(a, b);
                case 'name-desc': return byName(b, a);
                case 'date-asc': return (num(a, 'sortDate') - num(b, 'sortDate')) || byName(a, b);
                case 'size-asc': return (num(a, 'sortSize') - num(b, 'sortSize')) || byName(a, b);
                case 'size-desc': return (num(b, 'sortSize') - num(a, 'sortSize')) || byName(a, b);
                case 'date-desc': default: return (num(b, 'sortDate') - num(a, 'sortDate')) || byName(a, b);
            }
        });

        // 2. Group. Favourites float to the top (of the list, or of each group heading)
        const favFirst = list => [...list.filter(r => r.dataset.favorite === 'true'), ...list.filter(r => r.dataset.favorite !== 'true')];
        const bucketed = (categoryOf, order) => {
            const buckets = {};
            order.forEach(cat => { buckets[cat] = []; });
            rows.forEach(r => { (buckets[categoryOf(r)] = buckets[categoryOf(r)] || []).push(r); });
            const out = [];
            order.forEach(cat => {
                if (buckets[cat].length > 0) {
                    out.push({ isSeparator: true, label: cat, count: buckets[cat].length });
                    favFirst(buckets[cat]).forEach(r => out.push(r));
                }
            });
            return out;
        };
        let sorted;
        const isFolder = r => r.dataset.type === 'folder';
        if (currentGroupValue === 'folders-first') {
            sorted = favFirst([...rows.filter(isFolder), ...rows.filter(r => !isFolder(r))]);
        } else if (currentGroupValue === 'files-first') {
            sorted = favFirst([...rows.filter(r => !isFolder(r)), ...rows.filter(isFolder)]);
        } else if (currentGroupValue === 'by-type') {
            sorted = bucketed(getTypeCategory, TYPE_CATEGORY_ORDER);
        } else if (currentGroupValue === 'by-date') {
            sorted = bucketed(getDateCategory, DATE_CATEGORY_ORDER);
        } else {
            sorted = favFirst(rows);
        }

        // 3. Render rows, inserting a heading row before each group
        sorted.forEach(item => {
            if (item.isSeparator) {
                const sepRow = document.createElement('tr');
                sepRow.className = 'type-group-separator';
                const cell = document.createElement('td');
                cell.colSpan = 3;
                cell.className = 'type-group-label';
                const label = document.createElement('span');
                label.textContent = item.label;
                const count = document.createElement('span');
                count.className = 'type-group-count';
                count.textContent = item.count;
                cell.append(label, count);
                sepRow.appendChild(cell);
                fileListBody.appendChild(sepRow);
            } else {
                fileListBody.appendChild(item);
            }
        });
        const noResultsRow = document.getElementById('noResultsRow');
        if (noResultsRow) fileListBody.appendChild(noResultsRow);   // keep it last
        applyRowVisibility();
    }
    const searchToggleBtn = document.getElementById('searchToggleBtn');
    const searchContainer = document.getElementById('searchContainer');
    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');

    if (searchToggleBtn && searchContainer && searchInput) {
        searchToggleBtn.addEventListener('click', () => { searchContainer.classList.toggle('visible'); if (searchContainer.classList.contains('visible')) { searchInput.focus(); } else { searchInput.blur(); } });
        searchInput.addEventListener('input', () => {
            clearSearchBtn.classList.toggle('visible', searchInput.value.trim().length > 0);
            applyRowVisibility();
        });
        clearSearchBtn.addEventListener('click', () => { searchInput.value = ''; searchInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true })); searchInput.focus(); });
    }

    // --- DYNAMIC SCROLL BUTTONS ---
    const scrollPageBtn = document.getElementById('scrollPageBtn');
    const scrollBufferBtn = document.getElementById('scrollBufferBtn');
    if (scrollPageBtn) { const updatePageScrollBtn = () => { const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight; scrollPageBtn.classList.toggle('visible', scrollableHeight > 50); const atBottom = window.scrollY > scrollableHeight - 50; scrollPageBtn.classList.toggle('scroll-to-top', atBottom); scrollPageBtn.title = atBottom ? 'Scroll to Top' : 'Scroll to Bottom'; }; scrollPageBtn.addEventListener('click', () => { window.scrollTo({ top: scrollPageBtn.classList.contains('scroll-to-top') ? 0 : document.body.scrollHeight, behavior: 'smooth' }); }); window.addEventListener('scroll', updatePageScrollBtn, { passive: true }); updatePageScrollBtn(); }
    if (scrollBufferBtn && sharedTextArea) { const updateBufferScrollBtn = () => { const scrollableHeight = sharedTextArea.scrollHeight - sharedTextArea.clientHeight; scrollBufferBtn.classList.toggle('visible', scrollableHeight > 10); const atBottom = sharedTextArea.scrollTop > scrollableHeight - 10; scrollBufferBtn.classList.toggle('scroll-to-top', atBottom); scrollBufferBtn.title = atBottom ? 'Scroll to Top' : 'Scroll to End'; }; scrollBufferBtn.addEventListener('click', () => { sharedTextArea.scrollTo({ top: scrollBufferBtn.classList.contains('scroll-to-top') ? 0 : sharedTextArea.scrollHeight, behavior: 'smooth' }); }); sharedTextArea.addEventListener('scroll', updateBufferScrollBtn, { passive: true }); sharedTextArea.addEventListener('input', updateBufferScrollBtn); updateBufferScrollBtn(); scrollBufferBtn.handler = updateBufferScrollBtn; }

    // --- FILE LOCKING & PASSWORD MODAL ---
    const passwordModal = document.getElementById('passwordModal');
    const passwordModalForm = document.getElementById('passwordModalForm');
    const closePasswordModalBtn = document.getElementById('closePasswordModal');
    const passwordModalFilename = document.getElementById('passwordModalFilename');
    const filePasswordInput = document.getElementById('filePasswordInput');
    const passwordModalError = document.getElementById('passwordModalError');
    const downloadTable = document.getElementById('downloadSelectedForm');

    function openPasswordModal(filename) { passwordModalFilename.value = filename; filePasswordInput.value = ''; passwordModalError.textContent = ''; passwordModal.classList.add('visible'); filePasswordInput.focus(); }
    function closePasswordModal() { passwordModal.classList.remove('visible'); }

    if (passwordModal) { closePasswordModalBtn.addEventListener('click', closePasswordModal); passwordModal.addEventListener('click', (e) => { if (e.target === passwordModal) closePasswordModal(); }); }

    if (downloadTable) {
        downloadTable.addEventListener('click', async (e) => {
            // Guard: ignore clicks on folder action buttons to prevent double-download
            if (e.target.closest('.folder-download-btn, .rename-folder-btn, .delete-folder-btn, .folder-lock-btn, .file-share-btn')) return;
            const downloadLink = e.target.closest('.file-download-link');
            const lockButton = e.target.closest('.file-lock-btn');
            if (downloadLink) {
                e.preventDefault();
                const filename = downloadLink.dataset.filename;
                try {
                    const response = await fetch(`/api/file/status/${filename}`);
                    const data = await response.json();
                    if (data.locked) { openPasswordModal(filename); }
                    else { window.location.href = downloadLink.href; }
                } catch (error) { console.error("Failed to check file status:", error); setStatus('[ERR] Could not verify file status.', 'error'); }
            }
            if (lockButton) {
                const filename = lockButton.dataset.filename;
                const isCurrentlyLocked = lockButton.title.includes('Unlock');
                if (isCurrentlyLocked) {
                    const confirmed = await snailConfirm('Unlock File', `Are you sure you want to unlock "${decodeURIComponent(filename)}"?`);
                    if (confirmed) {
                        await fetch(`/api/file/unlock/${filename}`, { method: 'POST' });
                    }
                } else {
                    const password = await snailPrompt('Lock File', `Enter a password to lock "${decodeURIComponent(filename)}":`, { type: 'password', placeholder: 'Enter password...', confirmText: 'Lock' });
                    if (password) {
                        await fetch(`/api/file/lock/${filename}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
                    }
                }
            }
        });
    }

    if (passwordModalForm) {
        passwordModalForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const filename = passwordModalFilename.value;
            const password = filePasswordInput.value;
            const submitBtn = passwordModalForm.querySelector('button[type="submit"]');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Verifying...';
            passwordModalError.textContent = '';
            try {
                const response = await fetch(`/api/file/download_locked/${filename}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
                if (response.ok) {
                    const blob = await response.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.style.display = 'none';
                    a.href = url;
                    a.download = decodeURIComponent(filename);
                    document.body.appendChild(a);
                    a.click();
                    window.URL.revokeObjectURL(url);
                    a.remove();
                    closePasswordModal();
                } else if (response.status === 403) {
                    passwordModalError.textContent = 'Incorrect password. Please try again.';
                } else {
                    const result = await response.json();
                    passwordModalError.textContent = result.error || 'An unexpected error occurred.';
                }
            } catch (error) { passwordModalError.textContent = 'Network error. Please try again.'; }
            finally { submitBtn.disabled = false; submitBtn.textContent = 'Download'; }
        });
    }

    // --- FILE MOVE MODAL ---
    const moveFileModal = document.getElementById('moveFileModal');
    const closeMoveModalBtn = document.getElementById('closeMoveModal');
    const folderPickerList = document.getElementById('folderPickerList');
    const confirmMoveBtn = document.getElementById('confirmMoveBtn');
    const moveFileSource = document.getElementById('moveFileSource');
    const moveFileName = document.getElementById('moveFileName');
    const moveModalError = document.getElementById('moveModalError');
    let selectedDestPath = null;
    let batchMoveFilenames = null; // null = single mode, array = batch mode

    function openMoveModal(filename, sourcePath, batchFilenames) {
        if (!moveFileModal) return;
        moveFileName.value = filename || '';
        moveFileSource.value = sourcePath;
        moveModalError.textContent = '';
        confirmMoveBtn.disabled = true;
        selectedDestPath = null;
        batchMoveFilenames = batchFilenames || null;
        folderPickerList.innerHTML = '<div class="spinner"></div>';
        moveFileModal.classList.add('visible');

        // Fetch all folders
        fetch('/api/folders/list')
            .then(res => res.json())
            .then(data => {
                if (!data.success) throw new Error(data.error || 'Failed to load folders.');
                const folderIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
                folderPickerList.innerHTML = data.folders.map(f =>
                    `<button class="folder-picker-item" data-path="${escapeHtmlText(f.path)}" title="${escapeHtmlText(f.name || 'Root')}">${folderIcon} ${escapeHtmlText(f.name || 'Root')}</button>`
                ).join('');

                // Bind click on each folder item
                folderPickerList.querySelectorAll('.folder-picker-item').forEach(item => {
                    item.addEventListener('click', () => {
                        folderPickerList.querySelectorAll('.folder-picker-item').forEach(i => i.classList.remove('selected'));
                        item.classList.add('selected');
                        selectedDestPath = item.dataset.path;
                        confirmMoveBtn.disabled = false;
                        moveModalError.textContent = '';
                    });
                });
            })
            .catch(err => {
                folderPickerList.innerHTML = `<p style="padding:1rem; color:var(--c-error-text);">Error loading folders.</p>`;
                console.error('Error fetching folders:', err);
            });
    }

    function closeMoveModal() {
        if (moveFileModal) moveFileModal.classList.remove('visible');
    }

    if (moveFileModal) {
        closeMoveModalBtn.addEventListener('click', closeMoveModal);
        moveFileModal.addEventListener('click', (e) => { if (e.target === moveFileModal) closeMoveModal(); });
    }

    if (confirmMoveBtn) {
        confirmMoveBtn.addEventListener('click', async () => {
            if (selectedDestPath === null) return;
            const sourcePath = moveFileSource.value;

            // Don't move to the same folder
            if (selectedDestPath === sourcePath) {
                moveModalError.textContent = 'File is already in this folder.';
                return;
            }

            confirmMoveBtn.disabled = true;
            confirmMoveBtn.textContent = 'Moving...';
            moveModalError.textContent = '';
            try {
                if (batchMoveFilenames && batchMoveFilenames.length > 0) {
                    // Batch move
                    const response = await fetch('/api/files/move_batch', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filenames: batchMoveFilenames, source_path: sourcePath, dest_path: selectedDestPath })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || 'Failed to move files.');
                    closeMoveModal();
                    const movedCount = result.details?.moved?.length || 0;
                    const failedCount = result.details?.failed?.length || 0;
                    let msg = `[OK] Moved ${movedCount} file(s).`;
                    if (failedCount > 0) msg += ` ${failedCount} file(s) failed.`;
                    setStatus(msg, failedCount > 0 ? 'warning' : 'success');
                } else {
                    // Single file move
                    const filename = moveFileName.value;
                    const response = await fetch('/api/file/move', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filename, source_path: sourcePath, dest_path: selectedDestPath })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || 'Failed to move file.');
                    closeMoveModal();
                    setStatus(`[OK] ${result.message}`, 'success');
                }
            } catch (error) {
                moveModalError.textContent = error.message;
                console.error('Error moving file:', error);
            } finally {
                confirmMoveBtn.disabled = false;
                confirmMoveBtn.textContent = 'Move Here';
            }
        });
    }

    // --- INITIAL PAGE LOAD SETUP ---
    function initializePage() {
        loadSharedText().then(() => { if (scrollBufferBtn && scrollBufferBtn.handler) setTimeout(() => scrollBufferBtn.handler(), 100); });
        updateTextMeta();
        fileUploaded();
        switchView('shared');
        if (document.getElementById('downloadSelectedForm')) {
            reinitializeFileActions();
        }
        if (commitBtn) commitBtn.addEventListener('click', commitSharedText);
        if (selectBtn) selectBtn.addEventListener('click', selectSharedText);
        if (clearBtn) clearBtn.addEventListener('click', clearSharedText);
        if (pasteBtn) {
            pasteBtn.addEventListener('click', async () => {
                try {
                    let pastedText = null;
                    if (navigator.clipboard && navigator.clipboard.readText) {
                        try {
                            pastedText = await navigator.clipboard.readText();
                        } catch (err) {
                            console.warn('Clipboard readText failed:', err);
                        }
                    }
                    if (pastedText !== null) {
                        if (isEditorMode && easyMDEInstance) {
                            const current = easyMDEInstance.value();
                            easyMDEInstance.value(current + pastedText);
                        } else {
                            sharedTextArea.value += pastedText;
                        }
                        updateTextMeta();
                        setStatus('[OK] Text pasted from clipboard.', 'success');
                    } else {
                        setStatus('[INFO] Could not read clipboard. Use Ctrl+V to paste.', 'info');
                    }
                } catch (error) {
                    console.error('Paste failed:', error);
                    setStatus('[INFO] Could not read clipboard. Use Ctrl+V to paste.', 'info');
                }
            });
        }
        if (pinBtn) pinBtn.addEventListener('click', handlePinClick);
        if (viewBtnShared) viewBtnShared.addEventListener('click', () => switchView('shared'));
        if (viewBtnPinned) viewBtnPinned.addEventListener('click', () => switchView('pinned'));
        if (viewBtnAiChat) viewBtnAiChat.addEventListener('click', () => switchView('ai'));

        // --- QOL: Enter to Commit, Shift+Enter for Newline ---
        if (sharedTextArea && commitBtn) {
            sharedTextArea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitBtn.click();
                }
            });
        }

        // --- QOL: Paste Image from Clipboard to Upload ---
        if (sharedTextArea && fileInput) {
            document.addEventListener('paste', (e) => {
                const items = (e.clipboardData || window.clipboardData).items;
                if (!items) return;

                for (let i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('image') !== -1) {
                        const imageFile = items[i].getAsFile();
                        if (imageFile) {
                            e.preventDefault();

                            const now = new Date();
                            const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

                            const year = now.getFullYear();
                            const month = monthNames[now.getMonth()];
                            const day = String(now.getDate()).padStart(2, '0');
                            const hours = String(now.getHours()).padStart(2, '0');
                            const minutes = String(now.getMinutes()).padStart(2, '0');
                            const seconds = String(now.getSeconds()).padStart(2, '0');

                            const timestamp = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
                            const fileExtension = imageFile.type.split('/')[1] || 'png';
                            const newFilename = `Picture-${timestamp}.${fileExtension}`;

                            const newFile = new File([imageFile], newFilename, { type: imageFile.type });

                            const dataTransfer = new DataTransfer();
                            dataTransfer.items.add(newFile);
                            droppedSelection = null; if (folderInput) folderInput.value = '';   // a pasted image replaces any folder selection
                            fileInput.files = dataTransfer.files;

                            fileUploaded();
                            setStatus('[OK] Image from clipboard is ready to upload.', 'success');

                            break;
                        }
                    }
                }
            });
        }

        // --- BATCH ACTIONS (LOCK/UNLOCK/DELETE) ---
        const lockSelectedBtn = document.getElementById('lockSelectedBtn');
        const unlockSelectedBtn = document.getElementById('unlockSelectedBtn');
        const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');

        if (lockSelectedBtn) {
            lockSelectedBtn.addEventListener('click', async () => {
                const selectedFiles = Array.from(document.querySelectorAll('.file-checkbox:checked')).map(cb => cb.value);
                if (selectedFiles.length === 0) return;
                const password = await snailPrompt('Lock Files', `Enter a password to lock the ${selectedFiles.length} selected file(s):`, { type: 'password', placeholder: 'Enter password...', confirmText: 'Lock' });
                if (password) {
                    try {
                        const response = await fetch('/api/files/lock_batch', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filenames: selectedFiles, password: password, subpath: currentPath })
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.error || 'Server error');
                        flash(`[OK] ${result.details.locked.length} file(s) locked successfully.`, 'success');
                        if (result.details.failed.length > 0) flash(`[WARN] ${result.details.failed.length} file(s) could not be locked.`, 'warning');
                        // No reload needed
                    } catch (error) { flash(`[ERR] Lock operation failed: ${error.message}`, 'error'); }
                }
            });
        }

        if (unlockSelectedBtn) {
            unlockSelectedBtn.addEventListener('click', async () => {
                const selectedFiles = Array.from(document.querySelectorAll('.file-checkbox:checked')).map(cb => cb.value);
                if (selectedFiles.length === 0) return;
                const password = await snailPrompt('Unlock Files', `Enter the password to unlock the ${selectedFiles.length} selected file(s):`, { type: 'password', placeholder: 'Enter password...', confirmText: 'Unlock' });
                if (password) {
                    try {
                        const response = await fetch('/api/files/unlock_batch', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filenames: selectedFiles, password: password, subpath: currentPath })
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.error || 'Server error');
                        flash(`[OK] ${result.details.unlocked.length} file(s) unlocked successfully.`, 'success');
                        if (result.details.failed.length > 0) flash(`[WARN] ${result.details.failed.length} file(s) failed to unlock (wrong password or not locked).`, 'warning');
                        // No reload needed
                    } catch (error) { flash(`[ERR] Unlock operation failed: ${error.message}`, 'error'); }
                }
            });
        }

        if (deleteSelectedBtn) {
            deleteSelectedBtn.addEventListener('click', async () => {
                const selectedCheckboxes = document.querySelectorAll('.file-checkbox:checked');
                const selectedFiles = Array.from(selectedCheckboxes).map(cb => cb.value);
                if (selectedFiles.length === 0) return;
                const fileListString = selectedFiles.map(name => `- ${decodeURIComponent(name)}`).join('\n');
                if (confirm(`Are you sure you want to permanently delete these ${selectedFiles.length} files?\n\n${fileListString}`)) {
                    try {
                        const response = await fetch('/api/files/delete_batch', {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filenames: selectedFiles, subpath: currentPath })
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.error || 'Server error');
                        flash(`[OK] ${result.details.deleted.length} file(s) deleted successfully.`, 'success');
                        if (result.details.failed.length > 0) flash(`[WARN] ${result.details.failed.length} file(s) could not be deleted.`, 'warning');
                        // No manual removal needed
                    } catch (error) { flash(`[ERR] Delete operation failed: ${error.message}`, 'error'); }
                }
            });
        }

        // Batch move
        const moveSelectedBtnEl = document.getElementById('moveSelectedBtn');
        if (moveSelectedBtnEl) {
            moveSelectedBtnEl.addEventListener('click', () => {
                const selectedFiles = Array.from(document.querySelectorAll('.file-checkbox:checked')).map(cb => cb.value);
                if (selectedFiles.length === 0) return;
                openMoveModal(null, currentPath, selectedFiles);
            });
        }

        // Batch share
        const shareSelectedBtnEl = document.getElementById('shareSelectedBtn');
        if (shareSelectedBtnEl) {
            shareSelectedBtnEl.addEventListener('click', async () => {
                const selectedFiles = Array.from(document.querySelectorAll('.file-checkbox:checked')).map(cb => cb.value);
                if (selectedFiles.length === 0) return;
                const expiryOptions = [
                    { label: '30 Minutes', value: '0.5' },
                    { label: '4 Hours', value: '4' },
                    { label: '8 Hours', value: '8' },
                    { label: '12 Hours', value: '12' },
                    { label: '16 Hours', value: '16' },
                    { label: '20 Hours', value: '20' },
                    { label: '24 Hours', value: '24' },
                    { label: 'No Expiry', value: '' },
                    { label: 'Custom...', value: '__custom__' }
                ];
                const expiryInput = await snailSelect('Share Selected', `Create share links for ${selectedFiles.length} item(s). Choose an expiry time:`, expiryOptions, { confirmText: 'Create Links' });
                if (expiryInput === null) return;
                const expiry_hours = expiryInput && !isNaN(parseFloat(expiryInput)) ? parseFloat(expiryInput) : null;
                setStatus(`[INFO] Creating ${selectedFiles.length} share link(s)...`, 'info', 60000);
                let successCount = 0;
                let lastUrl = '';
                const sharedLinks = [];
                for (const filename of selectedFiles) {
                    const filepath = currentPath ? `${currentPath}/${filename}` : filename;
                    try {
                        const response = await fetch('/api/file/share', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filepath, expiry_hours })
                        });
                        const result = await response.json();
                        if (response.ok) {
                            successCount++;
                            lastUrl = result.url;
                            sharedLinks.push(lastUrl);
                        }
                    } catch (error) { console.error(`Error sharing ${filename}:`, error); }
                }
                if (successCount === 1) {
                    try {
                        await navigator.clipboard.writeText(lastUrl);
                        setStatus(`[OK] Share link copied to clipboard!`, 'success');
                    } catch {
                        prompt("Share link created:", lastUrl);
                    }
                } else if (successCount > 0) {
                    const linkList = sharedLinks.join('\n');
                    // Create a simple custom modal or use a prompt-like display for multiple links
                    // We can reuse snailSelect or snailAlert if we had one.
                    // For now, let's use a simple alert/prompt workaround or custom HTML injection
                    // Actually, let's just use snailSelect's modal structure but adapting it, 
                    // or simpler: just use snailAlert if it exists, or a custom approach.
                    // Since we don't have a dedicated "show text" modal, let's use a textarea in a snailPrompt-ish way?
                    // Or just a simple alert for now? No, alert is ugly.
                    // Let's use the existing snailConfirm but with a textarea? No.
                    // Let's just create a quick custom modal content for showing links.
                    const linksHtml = sharedLinks.map(link => `<div style="margin-bottom:0.5rem"><a href="${link}" target="_blank" style="word-break:break-all">${link}</a></div>`).join('');

                    // Simple custom modal for links
                    const modal = document.createElement('div');
                    modal.className = 'modal-overlay open';
                    modal.innerHTML = `
                        <div class="modal-content" style="max-width: 600px">
                            <div class="modal-header">
                                <h3>${successCount} Share Links Created</h3>
                                <button class="close-modal">&times;</button>
                            </div>
                            <div class="modal-body">
                                <p>Here are your share links:</p>
                                <textarea style="width:100%; height:150px; margin-top:0.5rem; font-family:monospace; padding:0.5rem" readonly>${sharedLinks.join('\n')}</textarea>
                                <div style="margin-top:0.5rem; font-size:0.85rem; color:var(--c-text-muted)">
                                    ${linksHtml}
                                </div>
                            </div>
                            <div class="modal-footer">
                                <button class="btn btn-primary" id="copyAllBtn">Copy All</button>
                                <button class="btn btn-secondary close-modal-btn">Close</button>
                            </div>
                        </div>
                    `;
                    document.body.appendChild(modal);

                    const close = () => modal.remove();
                    modal.querySelector('.close-modal').onclick = close;
                    modal.querySelector('.close-modal-btn').onclick = close;
                    modal.querySelector('#copyAllBtn').onclick = () => {
                        navigator.clipboard.writeText(sharedLinks.join('\n'));
                        setStatus('All links copied!', 'success');
                    };
                } else {
                    setStatus(`[ERR] Failed to create share links.`, 'error');
                }
            });
        }

        // --- AI CHAT FUNCTIONALITY ---
        function parseMarkdown(text) {
            // Use marked.js for proper markdown rendering
            if (typeof marked !== 'undefined') {
                marked.setOptions({
                    breaks: true,
                    gfm: true
                });
                return sanitizeHtml(marked.parse(text));
            }
            // Minimal fallback if marked.js fails to load
            return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function toggleAiChatMode() {
            if (currentView === 'ai') {
                switchView('shared');
            } else {
                switchView('ai');
            }
        }

        function renderAiChatMessage(message, sender) {
            const messageDiv = document.createElement('div');
            messageDiv.className = `ai-chat-message ${sender}`;

            const bubble = document.createElement('div');
            bubble.className = 'ai-chat-bubble';

            // Use innerHTML for AI messages to render markdown, textContent for user messages
            if (sender === 'ai') {
                bubble.innerHTML = '<div class="markdown-content">' + parseMarkdown(message) + '</div>';
            } else {
                bubble.textContent = message;
            }

            // Create action buttons container
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'ai-chat-actions';

            // Copy button icon SVGs
            const copyIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
            const checkIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

            // Copy button (for both user and AI messages)
            const copyBtn = document.createElement('button');
            copyBtn.className = 'ai-chat-action-btn copy-btn';
            copyBtn.title = 'Copy message';
            copyBtn.innerHTML = copyIconSvg;
            copyBtn.addEventListener('click', async () => {
                const copied = await copyToClipboard(message);
                if (copied) {
                    copyBtn.innerHTML = checkIconSvg;
                    flash('[OK] Message copied to clipboard.', 'success');
                    setTimeout(() => { copyBtn.innerHTML = copyIconSvg; }, 2000);
                } else {
                    flash('[ERR] Failed to copy.', 'error');
                }
            });
            actionsDiv.appendChild(copyBtn);

            if (sender === 'user') {
                // Edit button for user messages
                const editBtn = document.createElement('button');
                editBtn.className = 'ai-chat-action-btn edit-btn';
                editBtn.title = 'Edit message';
                editBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
                editBtn.addEventListener('click', () => {
                    aiChatInput.value = message;
                    aiChatInput.focus();
                    flash('[OK] Message loaded in input. Edit and resend.', 'info');
                });
                actionsDiv.appendChild(editBtn);
            }

            const timestamp = document.createElement('div');
            timestamp.className = 'ai-chat-timestamp';
            const now = new Date();
            timestamp.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            messageDiv.appendChild(bubble);
            messageDiv.appendChild(actionsDiv);
            messageDiv.appendChild(timestamp);

            // Remove empty state if it exists
            const emptyState = aiChatMessages.querySelector('.ai-chat-empty');
            if (emptyState) {
                emptyState.remove();
            }

            aiChatMessages.appendChild(messageDiv);
            aiChatMessages.scrollTop = aiChatMessages.scrollHeight;
        }

        const AI_CHAT_BUG_MESSAGES = [
            "🐛 Bugs are crawling through the code...",
            "🐜 Ants marching through your query...",
            "🐞 Beetles digging for answers...",
            "🦗 Crickets chirping while I think...",
            "🐝 Bees buzzing through the knowledge base...",
            "🕷️ Spiders weaving a response web...",
            "🐞 Ladybugs debugging your question...",
            "🐜🐜🐜 Bug army assembling your answer...",
            "🦋 Caterpillar evolving into a response...",
            "🐛 Worms tunneling through databases...",
            "🕷️ Charlotte is writing your response...",
            "🐝 Honey, I'm cooking up a response!",
            "🐞 Bug squad is on the case!",
        ];

        function getRandomAiChatBugMessage() {
            return AI_CHAT_BUG_MESSAGES[Math.floor(Math.random() * AI_CHAT_BUG_MESSAGES.length)];
        }

        function showAiChatLoading() {
            const loadingDiv = document.createElement('div');
            loadingDiv.className = 'ai-chat-loading';
            loadingDiv.id = 'aiChatLoading';
            loadingDiv.innerHTML = `
                <div class="ai-chat-loading-bugs">
                    <span class="ai-chat-loading-bug">🐛</span>
                    <span class="ai-chat-loading-bug">🐜</span>
                    <span class="ai-chat-loading-bug">🐞</span>
                </div>
                <span class="ai-chat-loading-text">${getRandomAiChatBugMessage()}</span>
            `;
            aiChatMessages.appendChild(loadingDiv);
            aiChatMessages.scrollTop = aiChatMessages.scrollHeight;

            // Rotate bug messages while loading
            const interval = setInterval(() => {
                const textEl = loadingDiv.querySelector('.ai-chat-loading-text');
                if (textEl) textEl.textContent = getRandomAiChatBugMessage();
            }, 3000);
            loadingDiv._interval = interval;
        }

        function hideAiChatLoading() {
            const loadingDiv = document.getElementById('aiChatLoading');
            if (loadingDiv) {
                if (loadingDiv._interval) clearInterval(loadingDiv._interval);
                loadingDiv.remove();
            }
        }

        async function sendAiChatMessage() {
            const message = aiChatInput.value.trim();
            if (!message || aiChatSendBtn.disabled) return;

            // Disable input while processing
            aiChatInput.disabled = true;
            aiChatSendBtn.disabled = true;

            // Render user message
            renderAiChatMessage(message, 'user');
            aiChatInput.value = '';

            // Show loading indicator
            showAiChatLoading();

            try {
                const response = await fetch('/api/ai-chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: message,
                        history: aiChatHistory
                    })
                });

                const result = await response.json();
                hideAiChatLoading();

                if (result.success) {
                    // Render AI response
                    renderAiChatMessage(result.response, 'ai');

                    // Update chat history for context
                    aiChatHistory.push({
                        role: 'user',
                        parts: [{ text: message }]
                    });
                    aiChatHistory.push({
                        role: 'model',
                        parts: [{ text: result.response }]
                    });

                    // Keep only last 10 exchanges (20 messages) for context
                    if (aiChatHistory.length > 20) {
                        aiChatHistory = aiChatHistory.slice(-20);
                    }
                } else {
                    // Show error message
                    const errorDiv = document.createElement('div');
                    errorDiv.className = 'ai-chat-message ai';
                    errorDiv.innerHTML = `
                        <div class="ai-chat-bubble" style="border-color: var(--c-error); color: var(--c-error-text);">
                            ❌ ${result.error || 'Failed to get AI response'}
                        </div>
                    `;
                    aiChatMessages.appendChild(errorDiv);
                    aiChatMessages.scrollTop = aiChatMessages.scrollHeight;
                }
            } catch (error) {
                hideAiChatLoading();
                console.error('Error sending AI chat message:', error);

                const errorDiv = document.createElement('div');
                errorDiv.className = 'ai-chat-message ai';
                errorDiv.innerHTML = `
                    <div class="ai-chat-bubble" style="border-color: var(--c-error); color: var(--c-error-text);">
                        ❌ Network error. Please check your connection and try again.
                    </div>
                `;
                aiChatMessages.appendChild(errorDiv);
                aiChatMessages.scrollTop = aiChatMessages.scrollHeight;
            } finally {
                // Re-enable input
                aiChatInput.disabled = false;
                aiChatSendBtn.disabled = false;
                aiChatInput.focus();
            }
        }

        // AI Chat toggle is handled by viewBtnAiChat click listener bound above

        if (aiChatSendBtn) {
            aiChatSendBtn.addEventListener('click', sendAiChatMessage);
        }

        if (aiChatInput) {
            aiChatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendAiChatMessage();
                }
            });

            // Auto-resize textarea as user types
            aiChatInput.addEventListener('input', () => {
                aiChatInput.style.height = 'auto';
                aiChatInput.style.height = Math.min(aiChatInput.scrollHeight, 80) + 'px';
            });
        }

        // Reset Chat Button
        const resetChatBtn = document.getElementById('resetChatBtn');
        if (resetChatBtn) {
            resetChatBtn.addEventListener('click', () => {
                // Clear chat history
                aiChatHistory = [];

                // Clear messages and restore empty state
                if (aiChatMessages) {
                    aiChatMessages.innerHTML = `
                        <div class="ai-chat-empty">
                            <div class="ai-chat-empty-icon">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                                    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                                </svg>
                            </div>
                            <p class="ai-chat-empty-title">Chat with <span class="ai-chat-gradient-text">Gemini AI</span></p>
                            <p class="ai-chat-empty-subtitle">Ask anything — code, ideas, or questions.</p>
                        </div>
                    `;
                }

                // Clear input
                if (aiChatInput) {
                    aiChatInput.value = '';
                }

                flash('[OK] Chat reset.', 'success');
            });
        }

        // --- MARKDOWN EDITOR FUNCTIONALITY ---
        function toggleEditorMode() {
            isEditorMode = !isEditorMode;

            if (isEditorMode) {
                // Exit preview mode first if active
                if (isPreviewMode) {
                    isPreviewMode = false;
                    markdownPreview.classList.add('view-hidden');
                    sharedTextArea.classList.remove('preview-active');
                    previewBtn.classList.remove('active');
                }

                // Hide the preview button (EasyMDE has its own)
                if (previewBtn) {
                    previewBtn.style.display = 'none';
                }

                // Switch to editor mode
                initializeMarkdownEditor();
                editorBtn.textContent = 'Plain Text';
                editorBtn.classList.add('active');
            } else {
                // Switch back to plain text mode
                destroyMarkdownEditor();
                editorBtn.textContent = 'Editor';
                editorBtn.classList.remove('active');

                // Show the preview button again
                if (previewBtn) {
                    previewBtn.style.display = '';
                }
            }
        }

        function initializeMarkdownEditor() {
            if (easyMDEInstance) return; // Already initialized

            easyMDEInstance = new EasyMDE({
                element: sharedTextArea,
                spellChecker: false,
                autofocus: true,
                placeholder: "Type your markdown here...",
                status: ['lines', 'words', 'cursor'],
                toolbar: [
                    'bold', 'italic', 'heading', '|',
                    'quote', 'unordered-list', 'ordered-list', '|',
                    'link', 'image', '|',
                    'preview', '|',
                    {
                        name: 'download',
                        action: function downloadMarkdown(editor) {
                            const content = editor.value();
                            if (!content.trim()) {
                                flash('[INFO] Nothing to download - editor is empty.', 'info');
                                return;
                            }

                            // Create sanitized filename with timestamp (no directory traversal possible)
                            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                            const filename = `note_${timestamp}.md`;

                            // Create blob and trigger download
                            const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement('a');
                            link.href = url;
                            link.download = filename;
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                            URL.revokeObjectURL(url);

                            flash('[OK] Markdown file downloaded.', 'success');
                        },
                        className: 'fa fa-download',
                        title: 'Download as Markdown'
                    }
                ],
                renderingConfig: {
                    codeSyntaxHighlighting: true,
                },
                // Sync editor changes with textarea
                onChange: () => {
                    updateTextMeta();
                }
            });
        }

        function destroyMarkdownEditor() {
            if (easyMDEInstance) {
                const content = easyMDEInstance.value();
                easyMDEInstance.toTextArea();
                easyMDEInstance = null;
                sharedTextArea.value = content;
                updateTextMeta();
            }
        }

        // Editor button event listener
        if (editorBtn) {
            editorBtn.addEventListener('click', toggleEditorMode);
        }

        // --- MARKDOWN PREVIEW FUNCTIONALITY ---
        function togglePreviewMode() {
            isPreviewMode = !isPreviewMode;

            if (isPreviewMode) {
                // Exit editor mode first if active
                if (isEditorMode) {
                    destroyMarkdownEditor();
                    isEditorMode = false;
                    editorBtn.textContent = 'Editor';
                    editorBtn.classList.remove('active');
                }

                // Get text content and parse markdown
                const textContent = sharedTextArea.value;
                const parsedHtml = parseMarkdownExtended(textContent);

                // Show preview, hide textarea
                markdownPreview.innerHTML = sanitizeHtml(parsedHtml);
                markdownPreview.classList.remove('view-hidden');
                sharedTextArea.classList.add('preview-active');

                previewBtn.classList.add('active');
            } else {
                // Hide preview, show textarea
                markdownPreview.classList.add('view-hidden');
                sharedTextArea.classList.remove('preview-active');

                previewBtn.classList.remove('active');
            }
        }

        // Extended markdown parser for preview (more comprehensive than AI chat parser)
        function parseMarkdownExtended(text) {
            // The renderer is shared with the "open preview in a new tab" page: see markdown-preview.js
            return window.SnailMarkdown ? window.SnailMarkdown.parse(text) : escapeHtml(text || '');
        }

        // Preview button event listener
        if (previewBtn) {
            previewBtn.addEventListener('click', togglePreviewMode);
        }

        // Open the preview in its own tab. The tab shows a snapshot of what is in the editor right now (even if it
        // is not committed yet): it is handed over via sessionStorage, which a window.open() tab inherits, plus a
        // short-lived localStorage copy as a fallback. Both are cleaned up once the tab has taken the text.
        const previewNewTabBtn = document.getElementById('previewNewTabBtn');
        if (previewNewTabBtn) {
            previewNewTabBtn.addEventListener('click', () => {
                const text = isEditorMode && easyMDEInstance ? easyMDEInstance.value() : sharedTextArea.value;
                if (!text.trim()) { setStatus('[INFO] Nothing to preview yet. Type or paste some text first.', 'info'); return; }
                const KEY = 'snailsynk.previewText';
                try { sessionStorage.setItem(KEY, JSON.stringify({ text })); } catch (err) { /* blocked or full: the fallback below still works */ }
                try {
                    localStorage.setItem(KEY, JSON.stringify({ text, ts: Date.now() }));
                    setTimeout(() => { try { localStorage.removeItem(KEY); } catch (err) { /* ignore */ } }, 20000);
                } catch (err) { /* storage full: the tab will show the saved shared buffer instead */ }
                window.open('/preview/text', '_blank');
            });
        }
    }

    initializePage();
}); 