// Enhanced Notes Editor with Search, Context Menu, Download, Rename, Duplicate
document.addEventListener('DOMContentLoaded', () => {
    if (!document.getElementById('notesList')) return;

    // Elements
    const notesList = document.getElementById('notesList');
    const newNoteBtn = document.getElementById('newNoteBtn');
    const newFolderBtn = document.getElementById('newFolderBtn');
    const editorPlaceholder = document.getElementById('editorPlaceholder');
    const editorContainer = document.getElementById('editorContainer');
    const noteTitle = document.getElementById('noteTitle');
    const saveBtn = document.getElementById('saveBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const exportPdfBtn = document.getElementById('exportPdfBtn');
    const searchInput = document.getElementById('searchNotes');
    const unsavedModal = document.getElementById('unsavedModal');
    const modalSaveBtn = document.getElementById('modalSaveBtn');
    const modalDiscardBtn = document.getElementById('modalDiscardBtn');
    const modalCancelBtn = document.getElementById('modalCancelBtn');
    const promptModal = document.getElementById('promptModal');
    const promptTitle = document.getElementById('promptTitle');
    const promptMessage = document.getElementById('promptMessage');
    const promptInput = document.getElementById('promptInput');
    const promptConfirmBtn = document.getElementById('promptConfirmBtn');
    const promptCancelBtn = document.getElementById('promptCancelBtn');
    const confirmModal = document.getElementById('confirmModal');
    const confirmTitle = document.getElementById('confirmTitle');
    const confirmMessage = document.getElementById('confirmMessage');
    const confirmYesBtn = document.getElementById('confirmYesBtn');
    const confirmNoBtn = document.getElementById('confirmNoBtn');
    const confirmIcon = document.getElementById('confirmIcon');
    const folderPickerModal = document.getElementById('folderPickerModal');
    const folderPickerList = document.getElementById('folderPickerList');
    const folderPickerTitle = document.getElementById('folderPickerTitle');
    const folderPickerMessage = document.getElementById('folderPickerMessage');

    // State
    let editor;
    let currentNote = null;
    let notes = [];
    let selectedNotes = new Set();
    let hasUnsavedChanges = false;
    let originalContent = '';

    // The Markdown editor (static/js/notes-editor.js)
    const previewBtn = document.getElementById('previewBtn');
    const markdownBtn = document.getElementById('markdownBtn');

    editor = NotesEditor.create(document.getElementById('editor'), {
        onChange: () => {
            if (!currentNote) return;
            hasUnsavedChanges = editor.getValue() !== originalContent;
            editor.setStatus(hasUnsavedChanges ? 'dirty' : 'saved');
        },
        onSave: () => { if (currentNote) saveNote(); },
        onOpenLink: (name) => openWikiLink(name),
        onModeChange: (mode) => {
            previewBtn.classList.toggle('active', mode === 'reading');
            markdownBtn.classList.toggle('active', mode === 'source');
        }
    });

    // [[Note name]] links: open the note, or offer to create it
    function findNoteByName(name) {
        const want = name.trim().toLowerCase().replace(/\.md$/, '');
        let hit = null;
        (function walk(items) {
            for (const it of items || []) {
                if (it.type === 'folder') walk(it.children);
                else if (!hit && it.name.replace(/\.md$/i, '').toLowerCase() === want) hit = it.path;
            }
        })(rootTree);
        return hit;
    }

    async function openWikiLink(name) {
        const existing = findNoteByName(name);
        if (existing) {
            await loadNote(existing);
            return;
        }
        const clean = name.replace(/[\\/]/g, '-').trim();
        if (!clean) return;
        const ok = await showConfirmModal('Create note', `"${clean}" doesn't exist yet. Create it?`, { confirmText: 'Create', cancelText: 'Cancel' });
        if (!ok) return;
        try {
            await api('item', 'POST', { path: `${clean}.md`, type: 'file' });
            await loadNotes();
            await loadNote(`${clean}.md`);
        } catch (error) {
            alert('Failed to create note');
        }
    }

    // Custom modal for unsaved changes
    function showUnsavedModal() {
        return new Promise((resolve) => {
            unsavedModal.classList.add('visible');

            const handleSave = () => {
                cleanup();
                resolve('save');
            };

            const handleDiscard = () => {
                cleanup();
                resolve('discard');
            };

            const handleCancel = () => {
                cleanup();
                resolve('cancel');
            };

            const handleOverlayClick = (e) => {
                if (e.target === unsavedModal) handleCancel();
            };

            const cleanup = () => {
                unsavedModal.classList.remove('visible');
                modalSaveBtn.removeEventListener('click', handleSave);
                modalDiscardBtn.removeEventListener('click', handleDiscard);
                modalCancelBtn.removeEventListener('click', handleCancel);
                unsavedModal.removeEventListener('click', handleOverlayClick);
            };

            modalSaveBtn.addEventListener('click', handleSave);
            modalDiscardBtn.addEventListener('click', handleDiscard);
            modalCancelBtn.addEventListener('click', handleCancel);
            unsavedModal.addEventListener('click', handleOverlayClick);
        });
    }

    // Custom prompt modal
    function showPromptModal(title, message, defaultValue = '') {
        return new Promise((resolve) => {
            promptTitle.textContent = title;
            promptMessage.textContent = message;
            promptInput.value = defaultValue;
            promptInput.placeholder = 'Enter name...';
            promptModal.classList.add('visible');

            // Focus input after animation
            setTimeout(() => promptInput.focus(), 100);

            const handleConfirm = () => {
                const value = promptInput.value.trim();
                cleanup();
                resolve(value || null);
            };

            const handleCancel = () => {
                cleanup();
                resolve(null);
            };

            const handleKeydown = (e) => {
                if (e.key === 'Enter') handleConfirm();
                if (e.key === 'Escape') handleCancel();
            };

            const handleOverlayClick = (e) => {
                if (e.target === promptModal) handleCancel();
            };

            const cleanup = () => {
                promptModal.classList.remove('visible');
                promptConfirmBtn.removeEventListener('click', handleConfirm);
                promptCancelBtn.removeEventListener('click', handleCancel);
                promptInput.removeEventListener('keydown', handleKeydown);
                promptModal.removeEventListener('click', handleOverlayClick);
            };

            promptConfirmBtn.addEventListener('click', handleConfirm);
            promptCancelBtn.addEventListener('click', handleCancel);
            promptInput.addEventListener('keydown', handleKeydown);
            promptModal.addEventListener('click', handleOverlayClick);
        });
    }

    // Custom confirm modal with options
    function showConfirmModal(title, message, options = {}) {
        return new Promise((resolve) => {
            confirmTitle.textContent = title;
            confirmMessage.textContent = message;

            // Set button text
            confirmYesBtn.textContent = options.confirmText || 'Confirm';
            confirmNoBtn.textContent = options.cancelText || 'Cancel';

            // Apply danger styling if needed
            if (options.danger) {
                confirmYesBtn.classList.remove('btn-primary');
                confirmYesBtn.classList.add('btn-danger');
                confirmIcon.innerHTML = '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>';
            } else {
                confirmYesBtn.classList.remove('btn-danger');
                confirmYesBtn.classList.add('btn-primary');
                confirmIcon.innerHTML = '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>';
            }

            confirmModal.classList.add('visible');

            const handleYes = () => {
                cleanup();
                resolve(true);
            };

            const handleNo = () => {
                cleanup();
                resolve(false);
            };

            const handleKeydown = (e) => {
                if (e.key === 'Escape') handleNo();
            };

            const handleOverlayClick = (e) => {
                if (e.target === confirmModal) handleNo();
            };

            const cleanup = () => {
                confirmModal.classList.remove('visible');
                confirmYesBtn.removeEventListener('click', handleYes);
                confirmNoBtn.removeEventListener('click', handleNo);
                document.removeEventListener('keydown', handleKeydown);
                confirmModal.removeEventListener('click', handleOverlayClick);
            };

            confirmYesBtn.addEventListener('click', handleYes);
            confirmNoBtn.addEventListener('click', handleNo);
            document.addEventListener('keydown', handleKeydown);
            confirmModal.addEventListener('click', handleOverlayClick);
        });
    }

    // Folder picker modal
    // `folders` are folder paths ("A", "A/B"); nested ones are indented. `rootLabel` names the top-level choice.
    function showFolderPickerModal(title, message, folders, rootLabel = 'No Folder (root)') {
        return new Promise((resolve) => {
            folderPickerTitle.textContent = title;
            folderPickerMessage.textContent = message;
            folderPickerList.innerHTML = '';

            // "No Folder" option
            const rootBtn = document.createElement('button');
            rootBtn.className = 'folder-picker-item root-option';
            rootBtn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                    <polyline points="9 22 9 12 15 12 15 22"/>
                </svg>
                <span>${escapeHtml(rootLabel)}</span>
            `;
            rootBtn.addEventListener('click', () => { cleanup(); resolve(''); });
            folderPickerList.appendChild(rootBtn);

            // Folder buttons
            folders.forEach(name => {
                const btn = document.createElement('button');
                btn.className = 'folder-picker-item';
                btn.style.paddingLeft = `${1 + (name.split('/').length - 1) * 1.25}rem`;
                btn.innerHTML = `
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span>${escapeHtml(name.split('/').pop())}</span>
                `;
                btn.title = name;
                btn.addEventListener('click', () => { cleanup(); resolve(name); });
                folderPickerList.appendChild(btn);
            });

            folderPickerModal.classList.add('visible');

            const handleKeydown = (e) => {
                if (e.key === 'Escape') { cleanup(); resolve(null); }
            };

            const handleOverlayClick = (e) => {
                if (e.target === folderPickerModal) { cleanup(); resolve(null); }
            };

            const cleanup = () => {
                folderPickerModal.classList.remove('visible');
                document.removeEventListener('keydown', handleKeydown);
                folderPickerModal.removeEventListener('click', handleOverlayClick);
            };

            document.addEventListener('keydown', handleKeydown);
            folderPickerModal.addEventListener('click', handleOverlayClick);
        });
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // API
    async function api(endpoint, method = 'GET', body = null) {
        const options = { method, headers: { 'Content-Type': 'application/json' } };
        if (body) options.body = JSON.stringify(body);
        const res = await fetch(`/admin/api/notes/${endpoint}`, options);
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    }

    // ----- which folders are closed: kept on the server (instance/notes_ui.json), so the tree looks the same after a
    // reload or a restart, and in any browser. Folders are open unless closed here.
    let collapsedFolders = new Set();
    let collapsedLoaded = false;
    let saveCollapsedTimer = null;

    function saveCollapsed() {
        clearTimeout(saveCollapsedTimer);
        saveCollapsedTimer = setTimeout(() => {
            api('ui', 'POST', { collapsed: Array.from(collapsedFolders) }).catch(() => { /* the tree still works; it just won't be remembered */ });
        }, 250);
    }

    // forget folders that were deleted or renamed
    function pruneCollapsed() {
        const existing = new Set();
        (function walk(items) {
            for (const it of items || []) {
                if (it.type === 'folder') { existing.add(it.path); walk(it.children); }
            }
        })(rootTree);
        let changed = false;
        for (const path of Array.from(collapsedFolders)) {
            if (!existing.has(path)) { collapsedFolders.delete(path); changed = true; }
        }
        if (changed) saveCollapsed();
    }

    function hasCollapsedAncestor(path) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) {
            if (collapsedFolders.has(parts.slice(0, i).join('/'))) return true;
        }
        return false;
    }

    // one place decides what is shown: folders that are closed hide their contents, and a search shows every match
    // (closed or not)
    function applyVisibility() {
        const query = searchInput.value.trim().toLowerCase();
        document.querySelectorAll('#notesList .note-item').forEach((item) => {
            const path = item.dataset.path || '';
            if (item.classList.contains('folder')) item.classList.toggle('collapsed', collapsedFolders.has(path));
            let hide;
            if (query) {
                const titleEl = item.querySelector('.note-item-title');
                const folderEl = item.querySelector('.folder-name');
                const text = (titleEl ? titleEl.textContent : folderEl ? folderEl.textContent : '').toLowerCase();
                hide = !text.includes(query);
            } else {
                hide = hasCollapsedAncestor(path);
            }
            item.classList.toggle('hidden', hide);
        });
    }

    // opening a note (a link, a new note, ...) opens the folders it sits in
    function revealNote(path) {
        const parts = path.split('/');
        let changed = false;
        for (let i = 1; i < parts.length; i++) {
            if (collapsedFolders.delete(parts.slice(0, i).join('/'))) changed = true;
        }
        if (changed) { saveCollapsed(); applyVisibility(); }
    }

    // Load notes list
    let rootTree = [];
    let currentFilter = 'all';

    async function loadNotes() {
        try {
            const data = await api('tree');
            rootTree = data.tree;
            if (!collapsedLoaded) {
                collapsedFolders = new Set(Array.isArray(data.collapsed) ? data.collapsed : []);
                collapsedLoaded = true;
            }
            pruneCollapsed();
            renderNotesList();
            updateFilterDropdown();
        } catch (error) {
            console.error('Failed to load notes:', error);
            notesList.innerHTML = '<p class="loading">Failed to load notes</p>';
        }
    }

    function renderNotesList() {
        if (!rootTree || rootTree.length === 0) {
            notesList.innerHTML = '<p class="loading">No notes yet</p>';
            return;
        }

        let html = '';

        function renderItems(items, level = 0) {
            // Sort: folders first, then files
            const sorted = [...items].sort((a, b) => {
                if (a.type === b.type) return a.name.localeCompare(b.name);
                return a.type === 'folder' ? -1 : 1;
            });

            sorted.forEach(item => {

                if (item.type === 'folder') {
                    // Check if we should show this folder based on filter
                    if (currentFilter !== 'all' && item.name !== currentFilter && level === 0) return;

                    html += `<div class="note-item folder" data-path="${item.path}" style="--lvl: ${level}" draggable="true">
                        <svg class="folder-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        <svg class="folder-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        <span class="folder-name">${item.name}</span>
                    </div>`;

                    if (item.children) {
                        renderItems(item.children, level + 1);
                    }
                } else {
                    // If filtering, only show if parent matches or we are inside a matching folder
                    if (currentFilter !== 'all') {
                        const parts = item.path.split('/');
                        if (parts[0] !== currentFilter) return;
                    }

                    html += `<div class="note-item" data-path="${item.path}" data-type="file" style="--lvl: ${level}" draggable="true">
                        <svg class="note-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        <input type="checkbox" class="note-checkbox" data-path="${item.path}">
                        <div class="note-item-title" title="${item.name}">${item.name.replace(/\.md$/i, '')}</div>
                    </div>`;
                }
            });
        }

        renderItems(rootTree);
        notesList.innerHTML = html;
        closeContextMenu();
        applyVisibility();
    }

    function updateFilterDropdown() {
        // Get unique folder names from top level of tree
        const folderNames = new Set();
        rootTree.forEach(item => {
            if (item.type === 'folder') {
                folderNames.add(item.name);
            }
        });

        if (folderNames.size === 0) return;

        let filterContainer = document.getElementById('filterContainer');
        if (!filterContainer) {
            filterContainer = document.createElement('div');
            filterContainer.id = 'filterContainer';
            filterContainer.className = 'filter-container';
            const searchContainer = document.querySelector('.search-container');
            searchContainer.parentNode.insertBefore(filterContainer, searchContainer.nextSibling);
        }

        let html = `
            <label for="folderFilter" class="filter-label">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                </svg>
                Filter:
            </label>
            <select id="folderFilter" class="filter-select">
                <option value="all">All Notes</option>
        `;

        Array.from(folderNames).sort().forEach(folder => {
            html += `<option value="${folder}">${folder}</option>`;
        });

        html += `</select>`;
        filterContainer.innerHTML = html;

        const filterSelect = document.getElementById('folderFilter');
        if (filterSelect) {
            filterSelect.value = currentFilter;
            filterSelect.addEventListener('change', (e) => {
                currentFilter = e.target.value;
                renderNotesList();
            });
        }
    }

    // Search functionality
    searchInput.addEventListener('input', applyVisibility);

    // Load note
    async function loadNote(path) {
        // Check for unsaved changes before switching
        if (hasUnsavedChanges && currentNote) {
            const choice = await showUnsavedModal();

            if (choice === 'save') {
                await saveNote();
            } else if (choice === 'cancel') {
                return; // Don't switch notes
            }
            // 'discard' falls through to load the new note
            hasUnsavedChanges = false;
        }

        try {
            const data = await api(`note?path=${encodeURIComponent(path)}`);
            currentNote = path;
            noteTitle.value = path.split('/').pop().replace('.md', '');
            // notes written by the old rich-text editor are HTML: convert them to Markdown on the way in
            const { markdown, converted } = NotesEditor.contentToMarkdown(data.content);
            editor.setValue(markdown);
            originalContent = markdown; // Store original for change detection
            hasUnsavedChanges = false;
            if (converted) editor.setStatus('info', 'Converted to Markdown. Save to keep it.');
            else editor.setStatus('saved');

            editorPlaceholder.style.display = 'none';
            editorContainer.style.display = 'flex';
            editor.refresh();

            document.querySelectorAll('.note-item').forEach(item => {
                item.classList.toggle('active', item.dataset.path === path);
            });
            revealNote(path);

            // Switch to editor view on mobile
            showMobileEditor();
            // the editor pane is only displayed now (on a phone it was hidden until the line above), so measure again
            editor.refresh();
        } catch (error) {
            alert('Failed to load note');
        }
    }

    // Save note
    async function saveNote() {
        if (!currentNote) return;
        try {
            saveBtn.textContent = 'Saving...';
            saveBtn.disabled = true;
            editor.setStatus('saving');
            const markdown = editor.getValue();
            await api('note', 'POST', {
                path: currentNote,
                content: markdown
            });
            originalContent = markdown; // Update original content after save
            hasUnsavedChanges = false;
            editor.setStatus('saved');
            saveBtn.textContent = 'Saved!';
            setTimeout(() => { saveBtn.textContent = 'Save'; }, 1000);
        } catch (error) {
            alert('Failed to save');
            saveBtn.textContent = 'Save';
        } finally {
            saveBtn.disabled = false;
        }
    }

    // Create note
    async function createNote() {
        const folderNames = [];
        if (rootTree) {
            rootTree.forEach(item => {
                if (item.type === 'folder') {
                    folderNames.push(item.name);
                }
            });
        }

        let folder = '';

        if (folderNames.length > 0) {
            const selected = await showFolderPickerModal(
                'Create Note',
                'Select where to create the note:',
                folderNames
            );
            if (selected === null) return; // cancelled
            if (selected) folder = selected + '/';
        }

        const name = await showPromptModal('New Note', 'Enter note name (without .md):');
        if (!name) return;
        const path = `${folder}${name}.md`;

        try {
            await api('item', 'POST', { path, type: 'file' });
            await loadNotes();
            await loadNote(path);
        } catch (error) {
            alert('Failed to create note');
        }
    }

    // Create folder
    async function createFolder() {
        const name = await showPromptModal('New Folder', 'Enter folder name:');
        if (!name) return;

        try {
            await api('item', 'POST', { path: name, type: 'folder' });
            await loadNotes();
        } catch (error) {
            alert('Failed to create folder');
        }
    }

    // Delete note
    async function deleteNote(path = currentNote) {
        if (!path) return;
        const confirmed = await showConfirmModal(
            'Delete Note',
            'Are you sure you want to delete this note? This action cannot be undone.',
            { confirmText: 'Delete', cancelText: 'Keep', danger: true }
        );
        if (!confirmed) return;

        try {
            await api('item', 'DELETE', { path });
            if (path === currentNote) {
                editorContainer.style.display = 'none';
                editorPlaceholder.style.display = 'flex';
                currentNote = null;
            }
            await loadNotes();
        } catch (error) {
            alert('Failed to delete');
        }
    }

    // Rename note
    async function renameNote(path) {
        const oldName = path.split('/').pop().replace('.md', '');
        const newName = await showPromptModal('Rename Note', 'Enter new name:', oldName);
        if (!newName || newName === oldName) return;

        try {
            await api('item', 'PUT', {
                old_path: path,
                new_name: `${newName}.md`
            });
            await loadNotes();
            const newPath = path.replace(oldName + '.md', newName + '.md');
            if (path === currentNote) {
                await loadNote(newPath);
            }
        } catch (error) {
            alert('Failed to rename');
        }
    }

    // Duplicate note
    async function duplicateNote(path) {
        const oldName = path.split('/').pop().replace('.md', '');
        const newName = await showPromptModal('Duplicate Note', 'Enter name for the copy:', `${oldName} (copy)`);
        if (!newName) return;

        try {
            // Load original content
            const data = await api(`note?path=${encodeURIComponent(path)}`);
            // Create new note
            await api('item', 'POST', { path: `${newName}.md`, type: 'file' });
            // Save content to new note
            await api('note', 'POST', {
                path: `${newName}.md`,
                content: data.content
            });
            await loadNotes();
        } catch (error) {
            alert('Failed to duplicate');
        }
    }

    // Download note
    async function downloadNote(path = currentNote) {
        if (!path) return;
        try {
            // Fetch note content from API
            const data = await api(`note?path=${encodeURIComponent(path)}`);

            // Notes from the old editor are HTML: hand out proper Markdown either way
            const markdownContent = NotesEditor.contentToMarkdown(data.content).markdown;

            // Create and download markdown file
            const blob = new Blob([markdownContent], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = path.split('/').pop(); // Keep .md extension
            a.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            alert('Failed to download note');
        }
    }

    // Export note as PDF
    async function exportNoteToPdf(path = currentNote) {
        if (!path) return;
        try {
            const data = await api(`note?path=${encodeURIComponent(path)}`);
            const filename = path.split('/').pop().replace('.md', '.pdf');

            // Render the Markdown and style it for the page
            const container = document.createElement('div');
            container.innerHTML = NotesEditor.renderMarkdown(NotesEditor.contentToMarkdown(data.content).markdown);
            container.style.padding = '20px';
            container.style.fontFamily = 'Arial, sans-serif';
            container.style.fontSize = '12pt';
            container.style.lineHeight = '1.6';
            container.style.color = '#222';
            container.style.background = '#fff';
            container.querySelectorAll('pre').forEach((el) => { el.style.background = '#f3f4f6'; el.style.padding = '10px'; el.style.borderRadius = '6px'; el.style.whiteSpace = 'pre-wrap'; });
            container.querySelectorAll('code').forEach((el) => { el.style.fontFamily = 'Consolas, monospace'; });
            container.querySelectorAll('blockquote').forEach((el) => { el.style.borderLeft = '3px solid #bbb'; el.style.margin = '0.8em 0'; el.style.paddingLeft = '12px'; el.style.color = '#555'; });
            container.querySelectorAll('table').forEach((el) => { el.style.borderCollapse = 'collapse'; });
            container.querySelectorAll('th, td').forEach((el) => { el.style.border = '1px solid #ccc'; el.style.padding = '4px 8px'; });
            container.querySelectorAll('img').forEach((el) => { el.style.maxWidth = '100%'; });

            const opt = {
                margin: 15,
                filename: filename,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };

            await html2pdf().set(opt).from(container).save();
        } catch (error) {
            console.error('PDF export error:', error);
            alert('Failed to export PDF');
        }
    }

    // ===== Right-click menu =====
    // One menu for files, folders, several selected notes and empty space, in the same style as the Download Directory's
    // menu on the home page. Shift + right-click still gives the browser's own menu.
    const ctxMenu = document.createElement('div');
    ctxMenu.id = 'notesContextMenu';
    ctxMenu.className = 'dir-context-menu';
    ctxMenu.setAttribute('role', 'menu');
    ctxMenu.tabIndex = -1;
    ctxMenu.hidden = true;
    document.body.appendChild(ctxMenu);
    let ctxTargetRow = null;

    const ICONS = {
        open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        newNote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
        newFolder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>',
        folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
        rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
        duplicate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15h6"/><path d="M9 11h6"/></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
        move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M8 14h8"/><polyline points="13 11 16 14 13 17"/></svg>',
        expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg>',
        collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 11 12 6 17 11"/><polyline points="7 18 12 13 17 18"/></svg>',
        refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
    };

    function closeContextMenu() {
        if (ctxMenu.hidden) return;
        ctxMenu.hidden = true;
        ctxMenu.replaceChildren();
        if (ctxTargetRow) ctxTargetRow.classList.remove('context-target');
        ctxTargetRow = null;
    }

    function ctxItem(label, icon, onActivate, danger = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dir-ctx-item' + (danger ? ' danger' : '');
        button.setAttribute('role', 'menuitem');
        if (icon) button.insertAdjacentHTML('afterbegin', icon);
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

    function showMenuAt(x, y, nodes) {
        ctxMenu.replaceChildren(...nodes);
        ctxMenu.style.left = '0px';
        ctxMenu.style.top = '0px';
        ctxMenu.hidden = false;
        const width = ctxMenu.offsetWidth, height = ctxMenu.offsetHeight;
        let left = x, top = y;
        // keep it on screen: flip to the other side of the pointer when there is no room
        if (left + width > window.innerWidth - 8) left = Math.max(8, x - width);
        if (left < 8) left = 8;
        if (top + height > window.innerHeight - 8) top = Math.max(8, y - height);
        if (top < 8) top = 8;
        ctxMenu.style.left = `${left}px`;
        ctxMenu.style.top = `${top}px`;
        ctxMenu.focus({ preventScroll: true });
    }

    // --- folder actions the menu needs ---
    async function createNoteInFolder(folderPath) {
        const name = await showPromptModal('New Note', `Create note in ${folderPath}/ (without .md):`);
        if (!name) return;
        const path = `${folderPath}/${name.replace(/[\\/]/g, '-')}.md`;
        try {
            await api('item', 'POST', { path, type: 'file' });
            await loadNotes();
            await loadNote(path);
        } catch (error) {
            alert('Failed to create note');
        }
    }

    async function createSubfolder(folderPath) {
        const name = await showPromptModal('New Folder', `Create folder inside ${folderPath}/:`);
        if (!name) return;
        try {
            await api('item', 'POST', { path: `${folderPath}/${name.replace(/[\\/]/g, '-')}`, type: 'folder' });
            await loadNotes();
        } catch (error) {
            alert('Failed to create folder');
        }
    }

    async function renameFolder(folderPath) {
        const oldName = folderPath.split('/').pop();
        const newName = await showPromptModal('Rename Folder', 'Enter new name:', oldName);
        if (!newName || newName === oldName) return;
        try {
            await api('item', 'PUT', { old_path: folderPath, new_name: newName });
            const dir = folderPath.includes('/') ? folderPath.slice(0, folderPath.lastIndexOf('/') + 1) : '';
            const newPath = dir + newName;
            // the closed/open state, and the open note, follow the folder to its new name
            const moved = (p) => (p === folderPath || p.startsWith(folderPath + '/')) ? newPath + p.slice(folderPath.length) : p;
            collapsedFolders = new Set(Array.from(collapsedFolders).map(moved));
            saveCollapsed();
            if (currentNote) currentNote = moved(currentNote);
            await loadNotes();
            document.querySelectorAll('.note-item').forEach((item) => item.classList.toggle('active', item.dataset.path === currentNote));
        } catch (error) {
            alert('Could not rename the folder. Is there already one with that name?');
        }
    }

    async function deleteFolder(folderPath) {
        const confirmed = await showConfirmModal(
            'Delete Folder',
            `Delete "${folderPath.split('/').pop()}" and everything in it? This action cannot be undone.`,
            { confirmText: 'Delete', cancelText: 'Keep', danger: true }
        );
        if (!confirmed) return;
        try {
            await api('item', 'DELETE', { path: folderPath });
            if (currentNote && currentNote.startsWith(folderPath + '/')) {
                editorContainer.style.display = 'none';
                editorPlaceholder.style.display = 'flex';
                currentNote = null;
                hasUnsavedChanges = false;
            }
            await loadNotes();
        } catch (error) {
            alert('Failed to delete the folder');
        }
    }

    function toggleFolder(folderPath) {
        if (collapsedFolders.has(folderPath)) collapsedFolders.delete(folderPath);
        else collapsedFolders.add(folderPath);
        saveCollapsed();
        applyVisibility();
    }

    function setAllFolders(collapse) {
        collapsedFolders = new Set();
        if (collapse) {
            (function walk(items) {
                for (const it of items || []) {
                    if (it.type === 'folder') { collapsedFolders.add(it.path); walk(it.children); }
                }
            })(rootTree);
        }
        saveCollapsed();
        applyVisibility();
    }

    // --- the menus ---
    function buildFileMenu(path) {
        return [
            ctxHeading(path.split('/').pop().replace(/\.md$/i, '')),
            ctxItem('Open', ICONS.open, () => loadNote(path)),
            ctxItem('Rename…', ICONS.rename, () => renameNote(path)),
            ctxItem('Duplicate…', ICONS.duplicate, () => duplicateNote(path)),
            ctxItem('Move to…', ICONS.move, () => promptMoveItems([path])),
            ctxItem('Download as Markdown', ICONS.download, () => downloadNote(path)),
            ctxItem('Export as PDF', ICONS.pdf, () => exportNoteToPdf(path)),
            ctxSeparator(),
            ctxItem('Delete', ICONS.trash, () => deleteNote(path), true)
        ];
    }

    function buildFolderMenu(path) {
        const closed = collapsedFolders.has(path);
        return [
            ctxHeading(path.split('/').pop()),
            ctxItem('New note here…', ICONS.newNote, () => createNoteInFolder(path)),
            ctxItem('New subfolder…', ICONS.newFolder, () => createSubfolder(path)),
            ctxSeparator(),
            ctxItem(closed ? 'Open folder' : 'Close folder', closed ? ICONS.expand : ICONS.collapse, () => toggleFolder(path)),
            ctxItem('Rename…', ICONS.rename, () => renameFolder(path)),
            ctxItem('Move to…', ICONS.move, () => promptMoveItems([path])),
            ctxSeparator(),
            ctxItem('Delete folder', ICONS.trash, () => deleteFolder(path), true)
        ];
    }

    function buildBatchMenu(count) {
        return [
            ctxHeading(`${count} notes selected`),
            ctxItem('Move to…', ICONS.move, () => promptMoveItems(Array.from(selectedNotes))),
            ctxItem('Download as Markdown', ICONS.download, () => batchDownload()),
            ctxItem('Export as PDF', ICONS.pdf, () => batchExportPdf()),
            ctxSeparator(),
            ctxItem('Delete', ICONS.trash, () => batchDelete(), true)
        ];
    }

    function buildBlankMenu() {
        return [
            ctxHeading('Notes'),
            ctxItem('New note…', ICONS.newNote, () => createNote()),
            ctxItem('New folder…', ICONS.newFolder, () => createFolder()),
            ctxSeparator(),
            ctxItem('Open all folders', ICONS.expand, () => setAllFolders(false)),
            ctxItem('Close all folders', ICONS.collapse, () => setAllFolders(true)),
            ctxItem('Refresh', ICONS.refresh, () => loadNotes())
        ];
    }

    function openContextMenuFor(row, x, y) {
        closeContextMenu();
        let nodes;
        if (!row) {
            nodes = buildBlankMenu();
        } else {
            ctxTargetRow = row;
            row.classList.add('context-target');
            const path = row.dataset.path;
            if (row.classList.contains('folder')) nodes = buildFolderMenu(path);
            else if (selectedNotes.size > 1 && selectedNotes.has(path)) nodes = buildBatchMenu(selectedNotes.size);
            else nodes = buildFileMenu(path);
        }
        showMenuAt(x, y, nodes);
    }

    notesList.addEventListener('contextmenu', (e) => {
        if (e.shiftKey) return;   // Shift + right-click: the browser's normal menu
        e.preventDefault();
        const row = e.target.closest('.note-item');
        openContextMenuFor(row && row.dataset.path ? row : null, e.clientX, e.clientY);
    });

    // anything else closes it; a right-click outside the list shows the browser's own menu as usual
    document.addEventListener('mousedown', (e) => { if (!ctxMenu.hidden && !e.target.closest('#notesContextMenu')) closeContextMenu(); });
    document.addEventListener('contextmenu', (e) => { if (!e.target.closest('#notesList') && !e.target.closest('#notesContextMenu')) closeContextMenu(); });
    window.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('blur', closeContextMenu);
    document.addEventListener('keydown', (e) => {
        if (ctxMenu.hidden) return;
        if (e.key === 'Escape') { closeContextMenu(); return; }
        const items = Array.from(ctxMenu.querySelectorAll('.dir-ctx-item'));
        if (!items.length) return;
        const index = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(index + 1) % items.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
        else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    });


    // ===== Moving notes and folders =====
    // Used by "Move to…" (right-click menu, selection bar) and by drag and drop.
    function parentOf(path) {
        return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    }

    function itemLabel(path) {
        return path.split('/').pop().replace(/\.md$/i, '');
    }

    // can `path` go into folder `dest`? Not if it is already there, or if it is a folder and `dest` is inside it
    function canMoveInto(path, dest) {
        return parentOf(path) !== dest && dest !== path && !dest.startsWith(path + '/');
    }

    // what actually has to move: drops no-ops, and items that already travel inside a folder that is moving too
    function movablePaths(paths, dest) {
        const valid = paths.filter((p) => canMoveInto(p, dest));
        return valid.filter((p) => !valid.some((q) => q !== p && p.startsWith(q + '/')));
    }

    function describeMove(paths, dest) {
        const what = paths.length === 1 ? `"${itemLabel(paths[0])}"` : `${paths.length} items`;
        return `Move ${what} to ${dest ? `"${dest}"` : 'the top level'}?`;
    }

    // every folder in the tree, in tree order, minus the ones that can't take any of `paths`
    function folderChoices(paths) {
        const out = [];
        (function walk(items) {
            const sorted = [...(items || [])].filter((i) => i.type === 'folder').sort((a, b) => a.name.localeCompare(b.name));
            for (const it of sorted) {
                if (!paths.some((p) => it.path === p || it.path.startsWith(p + '/'))) out.push(it.path);
                walk(it.children);
            }
        })(rootTree);
        return out;
    }

    async function promptMoveItems(paths) {
        if (!paths.length) return;
        const folders = folderChoices(paths);
        const what = paths.length === 1 ? `"${itemLabel(paths[0])}"` : `${paths.length} items`;
        const dest = await showFolderPickerModal('Move to…', `Choose where to move ${what}:`, folders, 'Top level (no folder)');
        if (dest === null) return;   // cancelled
        await moveItems(paths, dest);
    }

    async function moveItems(paths, dest) {
        const toMove = movablePaths(paths, dest);
        if (!toMove.length) return;

        const moved = new Map();   // old path -> new path
        const failures = [];
        for (const source of toMove) {
            try {
                const res = await fetch('/admin/api/notes/move', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source_path: source, dest_path: dest })   // dest is the target *folder*
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data.success === false) throw new Error(data.error || 'Move failed');
                const name = source.split('/').pop();
                moved.set(source, dest ? `${dest}/${name}` : name);
            } catch (error) {
                failures.push(`${itemLabel(source)}: ${error.message}`);
            }
        }

        if (moved.size) {
            // the open note and the closed/open folders follow whatever moved
            const follow = (p) => {
                for (const [from, to] of moved) {
                    if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length);
                }
                return p;
            };
            collapsedFolders = new Set(Array.from(collapsedFolders).map(follow));
            if (currentNote) currentNote = follow(currentNote);
            if (dest) {
                // show the result: open the folder it went into (and the ones around it)
                const parts = dest.split('/');
                for (let i = 1; i <= parts.length; i++) collapsedFolders.delete(parts.slice(0, i).join('/'));
            }
            saveCollapsed();
            clearSelection();   // the selected paths are stale now
            await loadNotes();
            document.querySelectorAll('.note-item').forEach((item) => item.classList.toggle('active', item.dataset.path === currentNote));
        }
        if (failures.length) alert('Could not move:\n' + failures.join('\n'));
    }

    // ----- drag and drop -----
    // Drop on a folder to move into it, on a note to move next to it, on empty space to move to the top level.
    // Everything the drop needs is captured up front: `dragend` fires before an async drop handler gets its answer.
    let draggedPaths = null;

    function dropFolderFor(e) {
        const row = e.target.closest ? e.target.closest('.note-item') : null;
        if (!row || !row.dataset.path) return '';
        return row.classList.contains('folder') ? row.dataset.path : parentOf(row.dataset.path);
    }

    function clearDropHighlight() {
        notesList.classList.remove('drop-zone-active');
        notesList.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    }

    notesList.addEventListener('dragstart', (e) => {
        const row = e.target.closest ? e.target.closest('.note-item') : null;
        if (!row || !row.dataset.path) return;
        const path = row.dataset.path;
        // dragging one of several ticked notes takes all of them
        if (!row.classList.contains('folder') && selectedNotes.size > 1 && selectedNotes.has(path)) draggedPaths = Array.from(selectedNotes);
        else draggedPaths = [path];
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', draggedPaths.join('\n'));   // Firefox won't start a drag without data
        row.classList.add('dragging');
        closeContextMenu();
    });

    notesList.addEventListener('dragend', () => {
        draggedPaths = null;
        clearDropHighlight();
        notesList.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    });

    notesList.addEventListener('dragover', (e) => {
        if (!draggedPaths) return;
        const dest = dropFolderFor(e);
        clearDropHighlight();
        if (!movablePaths(draggedPaths, dest).length) {
            e.dataTransfer.dropEffect = 'none';
            return;   // no preventDefault: not a drop target
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const folderRow = dest ? Array.from(notesList.querySelectorAll('.note-item.folder')).find((r) => r.dataset.path === dest) : null;
        if (folderRow) folderRow.classList.add('drop-target');
        else notesList.classList.add('drop-zone-active');
    });

    notesList.addEventListener('dragleave', (e) => {
        if (!notesList.contains(e.relatedTarget)) clearDropHighlight();
    });

    notesList.addEventListener('drop', async (e) => {
        if (!draggedPaths) return;
        e.preventDefault();
        clearDropHighlight();
        const paths = draggedPaths.slice();
        const dest = dropFolderFor(e);
        const toMove = movablePaths(paths, dest);
        if (!toMove.length) return;

        const confirmed = await showConfirmModal('Move', describeMove(toMove, dest), { confirmText: 'Move Here', cancelText: 'Cancel' });
        if (confirmed) await moveItems(toMove, dest);
    });

    // Multi-select functionality
    notesList.addEventListener('change', (e) => {
        if (e.target.classList.contains('note-checkbox')) {
            const path = e.target.dataset.path;
            if (e.target.checked) {
                selectedNotes.add(path);
            } else {
                selectedNotes.delete(path);
            }
            updateBatchActions();
        }
    });

    function updateBatchActions() {
        const count = selectedNotes.size;
        if (count > 0) {
            // Show batch action buttons
            if (!document.getElementById('batchActions')) {
                const batchDiv = document.createElement('div');
                batchDiv.id = 'batchActions';
                batchDiv.className = 'batch-actions';
                batchDiv.innerHTML = `
                    <span class="batch-count">${count} selected</span>
                    <button id="batchMove" class="btn btn-sm" title="Move selected notes to a folder">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                            <path d="M8 14h8"/><polyline points="13 11 16 14 13 17"/>
                        </svg>
                    </button>
                    <button id="batchDownload" class="btn btn-sm" title="Download selected notes">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                    </button>
                    <button id="batchExportPdf" class="btn btn-sm" title="Export selected as PDF">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <path d="M9 15h6" />
                            <path d="M9 11h6" />
                        </svg>
                    </button>
                    <button id="batchDelete" class="btn btn-sm btn-danger" title="Delete selected notes">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                    <button id="clearSelection" class="btn btn-sm" title="Clear selection">Clear</button>
                `;
                document.querySelector('.notes-sidebar').insertBefore(batchDiv, notesList);

                document.getElementById('batchMove').addEventListener('click', () => promptMoveItems(Array.from(selectedNotes)));
                document.getElementById('batchDownload').addEventListener('click', batchDownload);
                document.getElementById('batchExportPdf').addEventListener('click', batchExportPdf);
                document.getElementById('batchDelete').addEventListener('click', batchDelete);
                document.getElementById('clearSelection').addEventListener('click', clearSelection);
            } else {
                document.querySelector('.batch-count').textContent = `${count} selected`;
            }
        } else {
            document.getElementById('batchActions')?.remove();
        }
    }

    async function batchDownload() {
        for (const path of selectedNotes) {
            try {
                const data = await api(`note?path=${encodeURIComponent(path)}`);

                const markdownContent = NotesEditor.contentToMarkdown(data.content).markdown;

                const blob = new Blob([markdownContent], { type: 'text/markdown' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = path.split('/').pop(); // Keep .md extension
                a.click();
                URL.revokeObjectURL(url);

                // Small delay between downloads
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error('Failed to download:', path);
            }
        }
    }

    async function batchExportPdf() {
        for (const path of selectedNotes) {
            try {
                await exportNoteToPdf(path);
                // Delay between PDF exports to avoid browser issues
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                console.error('Failed to export PDF:', path);
            }
        }
    }

    async function batchDelete() {
        const confirmed = await showConfirmModal(
            'Delete Notes',
            `Are you sure you want to delete ${selectedNotes.size} notes? This action cannot be undone.`,
            { confirmText: 'Delete All', cancelText: 'Keep', danger: true }
        );
        if (!confirmed) return;

        for (const path of selectedNotes) {
            try {
                await api('item', 'DELETE', { path });
            } catch (error) {
                console.error('Failed to delete:', path);
            }
        }

        clearSelection();
        await loadNotes();
        if (selectedNotes.has(currentNote)) {
            editorContainer.style.display = 'none';
            editorPlaceholder.style.display = 'flex';
            currentNote = null;
        }
    }

    function clearSelection() {
        selectedNotes.clear();
        document.querySelectorAll('.note-checkbox').forEach(cb => cb.checked = false);
        updateBatchActions();
    }

    // Events
    notesList.addEventListener('click', (e) => {
        // Ignore checkbox clicks
        if (e.target.classList.contains('note-checkbox')) return;

        const item = e.target.closest('.note-item');
        if (!item) return;

        // Handle folder toggle
        if (item.classList.contains('folder')) {
            e.preventDefault();
            e.stopPropagation();
            const folderPath = item.dataset.path;
            if (collapsedFolders.has(folderPath)) collapsedFolders.delete(folderPath);
            else collapsedFolders.add(folderPath);
            saveCollapsed();
            applyVisibility();
            return;
        }

        // Handle file click
        if (item.dataset.path && item.dataset.type !== 'folder') {
            loadNote(item.dataset.path);
        }
    });

    newNoteBtn.addEventListener('click', createNote);
    newFolderBtn.addEventListener('click', createFolder);
    saveBtn.addEventListener('click', saveNote);
    deleteBtn.addEventListener('click', () => deleteNote());
    downloadBtn.addEventListener('click', () => downloadNote());
    exportPdfBtn.addEventListener('click', () => exportNoteToPdf());

    // Reading view (eye) and source view (</>): each toggles back to the normal live-preview editing
    previewBtn.addEventListener('click', () => {
        editor.setMode(editor.getMode() === 'reading' ? 'live' : 'reading');
    });

    markdownBtn.addEventListener('click', () => {
        editor.setMode(editor.getMode() === 'source' ? 'live' : 'source');
    });

    // The big title is the file name: Enter or clicking away renames the note (unsaved edits stay in the editor)
    noteTitle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); noteTitle.blur(); }
    });
    noteTitle.addEventListener('change', async () => {
        if (!currentNote) return;
        const oldName = currentNote.split('/').pop().replace(/\.md$/, '');
        const newName = noteTitle.value.trim().replace(/[\\/]/g, '-');
        if (!newName || newName === oldName) { noteTitle.value = oldName; return; }
        try {
            await api('item', 'PUT', { old_path: currentNote, new_name: `${newName}.md` });
            const dir = currentNote.includes('/') ? currentNote.slice(0, currentNote.lastIndexOf('/') + 1) : '';
            currentNote = `${dir}${newName}.md`;
            noteTitle.value = newName;
            await loadNotes();
            document.querySelectorAll('.note-item').forEach((item) => item.classList.toggle('active', item.dataset.path === currentNote));
        } catch (error) {
            alert('Could not rename the note. Is there already one with that name?');
            noteTitle.value = oldName;
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented) return;   // the editor handles Ctrl+S itself while it has focus
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            if (currentNote) saveNote();
        }
    });

    // ===== MOBILE VIEW SWITCHING =====
    const notesContainer = document.querySelector('.notes-container');
    const mobileEditorBack = document.getElementById('mobileEditorBack');
    const mobileMoreBtn = document.getElementById('mobileMoreBtn');
    const mobileMoreMenu = document.getElementById('mobileMoreMenu');

    function isMobile() {
        return window.innerWidth <= 768;
    }

    function showMobileEditor() {
        if (isMobile() && notesContainer) {
            // one history entry per open note, so the phone's back button / gesture closes the note (back to the list)
            // instead of leaving the notes page
            if (!notesContainer.classList.contains('mobile-editor-active')) {
                try { history.pushState({ noteEditor: true }, ''); } catch (e) { /* history unavailable: back button just leaves */ }
            }
            notesContainer.classList.add('mobile-editor-active');
        }
    }

    function hideMobileEditor() {
        if (notesContainer) {
            notesContainer.classList.remove('mobile-editor-active');
        }
    }

    // Back button - return to notes list
    if (mobileEditorBack) {
        mobileEditorBack.addEventListener('click', (e) => {
            e.preventDefault();
            if (history.state && history.state.noteEditor) history.back();   // popstate below closes it
            else hideMobileEditor();
        });
    }

    window.addEventListener('popstate', () => {
        if (notesContainer && notesContainer.classList.contains('mobile-editor-active')) hideMobileEditor();
    });

    // Three-dot menu toggle
    if (mobileMoreBtn && mobileMoreMenu) {
        mobileMoreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            mobileMoreMenu.classList.toggle('visible');
        });

        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!mobileMoreMenu.contains(e.target) && !mobileMoreBtn.contains(e.target)) {
                mobileMoreMenu.classList.remove('visible');
            }
        });

        // Handle menu actions
        mobileMoreMenu.addEventListener('click', async (e) => {
            const item = e.target.closest('.mobile-more-item');
            if (!item) return;

            const action = item.dataset.action;
            mobileMoreMenu.classList.remove('visible');

            switch (action) {
                case 'preview':
                    previewBtn.click();
                    break;
                case 'markdown':
                    markdownBtn.click();
                    break;
                case 'download':
                    await downloadNote();
                    break;
                case 'exportPdf':
                    await exportNoteToPdf();
                    break;
                case 'delete':
                    await deleteNote();
                    // After deleting, go back to list on mobile
                    if (isMobile()) hideMobileEditor();
                    break;
            }
        });
    }

    // Handle window resize (switching between mobile/desktop)
    window.addEventListener('resize', () => {
        if (!isMobile()) {
            // When switching to desktop, remove mobile-active class
            hideMobileEditor();
        }
    });

    // Init
    loadNotes();
});
