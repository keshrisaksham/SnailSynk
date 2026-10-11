// static/js/admin-dashboard.js - Enhanced Dashboard with Tabbed UI

document.addEventListener('DOMContentLoaded', () => {
    // --- Sidebar Toggle (runs on ALL admin pages) ---
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('admin-sidebar');

    if (sidebarToggle && sidebar) {
        const savedState = localStorage.getItem('admin-sidebar-collapsed');
        if (savedState === 'true') {
            sidebar.classList.add('collapsed');
        }
        sidebarToggle.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
            localStorage.setItem('admin-sidebar-collapsed', sidebar.classList.contains('collapsed'));
        });
    }

    // Ensure we're on the monitoring page for the rest of the dashboard logic
    if (!document.getElementById('client-list-body')) return;

    // --- DOM Elements ---
    const clientListBody = document.getElementById('client-list-body');
    const blocklistBody = document.getElementById('blocklist-body');
    const logBody = document.getElementById('log-body');
    const blockIpForm = document.getElementById('block-ip-form');
    const ipInput = document.getElementById('ip-to-block-input');
    const toggleFormBtn = document.querySelector('.toggle-form-btn');
    const clientCountEl = document.getElementById('client-count');
    const blockedCountEl = document.getElementById('blocked-count');
    const totalLogsEl = document.getElementById('total-logs');
    const recentActivityEl = document.getElementById('recent-activity');
    const loadMoreBtn = document.getElementById('load-more-logs-btn');
    const logFooter = document.getElementById('log-footer');
    const clearLogsBtn = document.querySelector('.clear-logs-btn');
    const refreshClientsBtn = document.querySelector('.refresh-clients-btn');
    const logSearchInput = document.getElementById('log-search');
    const bufferHistoryList = document.getElementById('buffer-history-list');
    const bufferSearchInput = document.getElementById('buffer-search');
    const clearBufferBtn = document.querySelector('.clear-buffer-history-btn');

    // --- State ---
    let logOffset = 0;
    const logLimit = 20;
    let allLogs = [];
    let filteredLogs = [];
    let bufferHistory = [];

    // --- Tab Switching ---
    const tabBtns = document.querySelectorAll('.monitor-tab-btn');
    const tabPanels = document.querySelectorAll('.monitor-tab-panel');
    let chartsInitialized = false;

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            const tabLabel = btn.dataset.label || btn.textContent.trim();

            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanels.forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            const panel = document.getElementById(`tab-${tabId}`);
            if (panel) {
                panel.classList.add('active');
                // Update the panel title to show selected tab name
                const titleEl = panel.querySelector('.tab-panel-title');
                if (titleEl) titleEl.textContent = tabLabel;
            }

            // Lazy init charts when Activity Graph tab is first opened
            if (tabId === 'activity-graph' && !chartsInitialized) {
                chartsInitialized = true;
                setTimeout(() => initCharts(), 100);
            }

            // Save active tab
            localStorage.setItem('monitoring-active-tab', tabId);
        });
    });

    // Restore last active tab
    const savedTab = localStorage.getItem('monitoring-active-tab');
    if (savedTab) {
        const savedBtn = document.querySelector(`.monitor-tab-btn[data-tab="${savedTab}"]`);
        if (savedBtn) savedBtn.click();
    } else {
        // If no saved tab, init charts if activity graph is the default active tab
        const defaultActiveBtn = document.querySelector('.monitor-tab-btn.active');
        if (defaultActiveBtn && defaultActiveBtn.dataset.tab === 'activity-graph' && !chartsInitialized) {
            chartsInitialized = true;
            setTimeout(() => initCharts(), 100);
        }
    }

    // --- Socket.IO Connection ---
    const initializeSocket = () => {
        if (typeof io !== 'undefined') {
            const socket = io();
            socket.on('connect', () => console.log('Connected to server'));
            socket.on('client_update', () => loadClients());
            socket.on('blocklist_update', () => loadBlocklist());
            socket.on('action_log_update', () => {
                loadLogs(true);
                loadStats();
            });
            return socket;
        }
        return null;
    };
    const socket = initializeSocket();

    // --- API Functions ---
    const apiCall = async (endpoint, method = 'GET', body = null) => {
        const options = { method, headers: { 'Content-Type': 'application/json' } };
        if (body) options.body = JSON.stringify(body);
        try {
            const response = await fetch(`/admin/api/${endpoint}`, options);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return null;
        }
    };

    // --- Load Functions ---
    const loadClients = async () => {
        const data = await apiCall('clients');
        if (!data || !data.clients) return;
        clientCountEl.textContent = data.clients.length;
        if (data.clients.length === 0) {
            clientListBody.innerHTML = '<tr class="empty-row"><td colspan="3">No connected clients</td></tr>';
            return;
        }
        clientListBody.innerHTML = data.clients.map(client => `
            <tr style="animation: fadeIn 0.3s ease-out;">
                <td><code>${escapeHtml(client.ip)}</code></td>
                <td>${formatDate(client.connected_since)}</td>
                <td style="text-align: right;">
                    <button class="btn-sm btn-danger" onclick="blockClient('${escapeHtml(client.ip)}')" title="Block this IP">Block</button>
                </td>
            </tr>
        `).join('');
    };

    const loadBlocklist = async () => {
        const data = await apiCall('blocklist');
        if (!data || !data.blocked_ips) return;
        blockedCountEl.textContent = data.blocked_ips.length;
        if (data.blocked_ips.length === 0) {
            blocklistBody.innerHTML = '<tr class="empty-row"><td colspan="2">No blocked IPs</td></tr>';
            return;
        }
        blocklistBody.innerHTML = data.blocked_ips.map(ip => `
            <tr style="animation: fadeIn 0.3s ease-out;">
                <td><code>${escapeHtml(ip)}</code></td>
                <td style="text-align: right;">
                    <button class="btn-sm btn-danger" onclick="unblockIp('${escapeHtml(ip)}')" title="Unblock this IP">Unblock</button>
                </td>
            </tr>
        `).join('');
    };

    const loadStats = async () => {
        const data = await apiCall('stats');
        if (!data || !data.stats) return;
        totalLogsEl.textContent = data.stats.total_logs || 0;
        recentActivityEl.textContent = data.stats.recent_activity || 0;
    };

    const loadLogs = async (reset = false) => {
        if (reset) logOffset = 0;
        const data = await apiCall(`logs?offset=${logOffset}&limit=${logLimit}`);
        if (!data || !data.logs) return;
        if (logOffset === 0) {
            allLogs = data.logs;
            filteredLogs = data.logs;
            logBody.innerHTML = '';
        } else {
            allLogs = [...allLogs, ...data.logs];
            filteredLogs = [...filteredLogs, ...data.logs];
        }
        renderLogs(data.logs);
        logOffset += logLimit;
        logFooter.style.display = data.logs.length === logLimit ? 'flex' : 'none';
    };

    const renderLogs = (logs) => {
        if (logs.length === 0 && logOffset === 0) {
            logBody.innerHTML = '<tr class="empty-row"><td colspan="4">No actions logged yet</td></tr>';
            return;
        }
        logBody.innerHTML += logs.map(log => `
            <tr style="animation: fadeIn 0.3s ease-out;">
                <td><code>${new Date(log.timestamp).toLocaleString('en-US', { timeZone: 'UTC' })}</code></td>
                <td><code>${escapeHtml(log.ip_address || log.ip || 'Unknown')}</code></td>
                <td>${getActionBadge(log.action)}</td>
                <td style="text-align: right; max-width: 200px; overflow: auto;">
                    <code style="font-size: 0.8rem;">${escapeHtml(JSON.stringify(log.details || ''))}</code>
                </td>
            </tr>
        `).join('');
    };

    const getActionBadge = (action) => {
        const badges = {
            'PAGE_VIEW': '<span class="badge badge-info">Page View</span>',
            'IP_BLOCK': '<span class="badge badge-danger">IP Block</span>',
            'IP_UNBLOCK': '<span class="badge badge-success">IP Unblock</span>',
            'AI_CHAT': '<span class="badge badge-primary">AI Chat</span>',
            'FILE_UPLOAD': '<span class="badge badge-success">File Upload</span>',
            'FILE_DOWNLOAD': '<span class="badge badge-info">File Download</span>',
            'FILE_DELETE': '<span class="badge badge-danger">File Delete</span>',
            'FILE_LOCK': '<span class="badge badge-warning">File Lock</span>',
            'FILE_UNLOCK': '<span class="badge badge-success">File Unlock</span>',
            'FILE_DOWNLOAD_UNLOCKED': '<span class="badge badge-info">File Unlock & Download</span>',
            'FILE_DOWNLOAD_FAIL': '<span class="badge badge-danger">Download Failed</span>',
            'FILES_DOWNLOAD_ZIP': '<span class="badge badge-info">Zip Download</span>',
            'FILES_LOCK_BATCH': '<span class="badge badge-warning">Batch Lock</span>',
            'FILES_UNLOCK_BATCH': '<span class="badge badge-success">Batch Unlock</span>',
            'FILES_DELETE_BATCH': '<span class="badge badge-danger">Batch Delete</span>',
            'BUFFER_UPDATE': '<span class="badge badge-primary">Buffer Update</span>',
            'NOTE_SAVE': '<span class="badge badge-primary">Note Save</span>',
            'NOTE_CREATE': '<span class="badge badge-success">Note Create</span>',
            'NOTE_DELETE': '<span class="badge badge-danger">Note Delete</span>',
            'NOTE_RENAME': '<span class="badge badge-warning">Note Rename</span>',
            'NOTE_MOVE': '<span class="badge badge-info">Note Move</span>',
            'NOTE_DOWNLOAD': '<span class="badge badge-info">Note Download</span>',
            'NOTE_DELETE_BATCH': '<span class="badge badge-danger">Notes Batch Delete</span>',
            'AI_CHAT_STREAM': '<span class="badge badge-primary">AI Chat Stream</span>',
            'FOLDER_LOCK_REMOVED': '<span class="badge badge-success">Folder Lock Removed</span>',
        };
        return badges[action] || `<span class="badge badge-default">${escapeHtml(action)}</span>`;
    };

    // --- Buffer Chat History ---
    const loadBufferHistory = async () => {
        const data = await apiCall('buffer_history');
        if (!data || !data.history) return;
        bufferHistory = data.history;
        renderBufferHistory(bufferHistory);
    };

    const renderBufferHistory = (messages) => {
        if (!messages || messages.length === 0) {
            bufferHistoryList.innerHTML = `
                <div class="timeline-empty">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <p>No buffer messages yet. Messages committed to the Shared Text Buffer will appear here.</p>
                </div>
            `;
            return;
        }

        bufferHistoryList.innerHTML = messages.map((msg, idx) => {
            const truncated = msg.text.length > 300;
            const displayText = truncated ? msg.text.substring(0, 300) + '...' : msg.text;
            return `
            <div class="buffer-msg-card" data-id="${escapeHtml(msg.id)}" data-idx="${idx}">
                <div class="buffer-msg-header">
                    <div class="buffer-msg-meta">
                        <span>IP: <code>${escapeHtml(msg.ip || 'Unknown')}</code></span>
                        <span>${formatRelativeTime(msg.timestamp)}</span>
                    </div>
                    <div class="buffer-msg-actions">
                        <button class="btn-icon buffer-copy-btn" title="Copy message" data-idx="${idx}">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                        </button>
                        <button class="btn-icon buffer-edit-btn" title="Edit & Copy" data-idx="${idx}">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                            </svg>
                        </button>
                    </div>
                </div>
                <div class="buffer-msg-text${truncated ? '' : ' expanded'}">${escapeHtml(displayText)}</div>
                ${truncated ? `<button class="buffer-msg-expand visible" data-idx="${idx}">Show more</button>` : ''}
            </div>
        `;
        }).join('');

        // Attach copy handlers - use index to look up text from the messages array
        bufferHistoryList.querySelectorAll('.buffer-copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx);
                const text = messages[idx] ? messages[idx].text : '';
                navigator.clipboard.writeText(text).then(() => {
                    showNotification('Copied to clipboard', 'success');
                }).catch(() => showNotification('Failed to copy', 'error'));
            });
        });

        // Attach edit & copy handlers - use index to look up text
        bufferHistoryList.querySelectorAll('.buffer-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx);
                const text = messages[idx] ? messages[idx].text : '';
                openEditModal(text);
            });
        });

        // Attach expand handlers - use index to look up full text
        bufferHistoryList.querySelectorAll('.buffer-msg-expand').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx);
                const fullText = messages[idx] ? messages[idx].text : '';
                const card = btn.closest('.buffer-msg-card');
                const textEl = card.querySelector('.buffer-msg-text');
                if (textEl.classList.contains('expanded')) {
                    textEl.classList.remove('expanded');
                    const preview = fullText.substring(0, 300) + '...';
                    textEl.textContent = preview;
                    btn.textContent = 'Show more';
                } else {
                    textEl.classList.add('expanded');
                    textEl.textContent = fullText;
                    btn.textContent = 'Show less';
                }
            });
        });
    };

    // --- Edit & Copy Modal ---
    const editModal = document.getElementById('edit-copy-modal');
    const editTextarea = document.getElementById('edit-copy-textarea');
    const editCopyBtn = document.getElementById('edit-copy-btn');
    const closeEditModal = document.getElementById('close-edit-modal');

    const openEditModal = (text) => {
        editTextarea.value = text;
        editModal.style.display = 'flex';
    };

    if (closeEditModal) {
        closeEditModal.addEventListener('click', () => {
            editModal.style.display = 'none';
        });
    }
    if (editModal) {
        editModal.addEventListener('click', (e) => {
            if (e.target === editModal) editModal.style.display = 'none';
        });
    }
    if (editCopyBtn) {
        editCopyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(editTextarea.value).then(() => {
                showNotification('Copied to clipboard', 'success');
                editModal.style.display = 'none';
            }).catch(() => showNotification('Failed to copy', 'error'));
        });
    }

    // --- Event Listeners ---
    blockIpForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ip = ipInput.value.trim();
        if (!ip) return;
        const success = await apiCall('block_ip', 'POST', { ip });
        if (success) {
            ipInput.value = '';
            await loadBlocklist();
            await loadClients();
            showNotification('IP blocked successfully', 'success');
        }
    });

    if (toggleFormBtn) {
        toggleFormBtn.addEventListener('click', () => {
            blockIpForm.style.display = blockIpForm.style.display === 'none' ? 'flex' : 'none';
            toggleFormBtn.classList.toggle('active');
            if (blockIpForm.style.display === 'flex') ipInput.focus();
        });
    }

    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => loadLogs(false));
    }

    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', async () => {
            if (confirm('Are you sure you want to clear all action logs? This cannot be undone.')) {
                await apiCall('clear_logs', 'POST');
                await loadLogs(true);
                await loadStats();
                showNotification('Logs cleared successfully', 'info');
            }
        });
    }

    if (clearBufferBtn) {
        clearBufferBtn.addEventListener('click', async () => {
            if (confirm('Are you sure you want to clear all buffer chat history? This cannot be undone.')) {
                await apiCall('buffer_history/clear', 'POST');
                await loadBufferHistory();
                showNotification('Buffer history cleared', 'info');
            }
        });
    }

    if (refreshClientsBtn) {
        refreshClientsBtn.addEventListener('click', async () => {
            refreshClientsBtn.classList.add('spinning');
            await loadClients();
            setTimeout(() => refreshClientsBtn.classList.remove('spinning'), 1000);
        });
    }

    if (logSearchInput) {
        logSearchInput.addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase();
            if (!searchTerm) {
                filteredLogs = allLogs;
            } else {
                filteredLogs = allLogs.filter(log =>
                    log.ip_address.toLowerCase().includes(searchTerm) ||
                    log.action.toLowerCase().includes(searchTerm) ||
                    JSON.stringify(log.details).toLowerCase().includes(searchTerm)
                );
            }
            logBody.innerHTML = '';
            renderLogs(filteredLogs);
        });
    }

    if (bufferSearchInput) {
        bufferSearchInput.addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase();
            if (!searchTerm) {
                renderBufferHistory(bufferHistory);
            } else {
                const filtered = bufferHistory.filter(msg =>
                    msg.text.toLowerCase().includes(searchTerm) ||
                    (msg.ip || '').toLowerCase().includes(searchTerm)
                );
                renderBufferHistory(filtered);
            }
        });
    }

    // --- Global Functions ---
    window.blockClient = async (ip) => {
        const success = await apiCall('block_ip', 'POST', { ip });
        if (success) {
            await loadClients();
            await loadBlocklist();
            showNotification(`IP ${ip} blocked successfully`, 'success');
        }
    };

    window.unblockIp = async (ip) => {
        if (confirm(`Unblock IP ${ip}?`)) {
            const success = await apiCall('unblock_ip', 'POST', { ip });
            if (success) {
                await loadBlocklist();
                await loadClients();
                showNotification(`IP ${ip} unblocked successfully`, 'success');
            }
        }
    };

    // --- Utility Functions ---
    const formatDate = (dateString) => {
        try {
            if (!dateString) return 'Unknown';
            const date = new Date(dateString);
            if (isNaN(date.getTime())) return 'Invalid Date';
            return date.toLocaleString('en-US', {
                timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
        } catch (e) {
            return dateString || 'Unknown';
        }
    };

    const formatRelativeTime = (dateString) => {
        try {
            const date = new Date(dateString);
            const now = new Date();
            const diffMs = now - date;
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffDays = Math.floor(diffMs / 86400000);
            if (diffMins < 1) return 'Just now';
            if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
            if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
            if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
            return formatDate(dateString);
        } catch {
            return dateString;
        }
    };

    const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    const escapeAttr = (text) => {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    };

    const showNotification = (message, type = 'info') => {
        // Remove any existing toast
        const existing = document.querySelector('.toast-notification');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast-notification toast-${type}`;

        const icons = {
            success: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
            error: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
            info: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
            warning: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
        };

        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span class="toast-message">${message}</span>
        `;

        document.body.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => toast.classList.add('toast-visible'));

        // Auto remove after 3s
        setTimeout(() => {
            toast.classList.remove('toast-visible');
            toast.addEventListener('transitionend', () => toast.remove());
        }, 3000);
    };

    // --- Charts Initialization ---
    let actionTypesChart = null;
    let activityTimeChart = null;

    const initCharts = async () => {
        const data = await apiCall('logs?offset=0&limit=1000');
        if (!data || !data.logs || data.logs.length === 0) return;
        const logs = data.logs;
        const textColor = getComputedStyle(document.documentElement).getPropertyValue('--c-text-main').trim() || '#ffffff';
        const borderColor = getComputedStyle(document.documentElement).getPropertyValue('--c-border').trim() || 'rgba(255, 255, 255, 0.1)';

        // Action Types Distribution
        const actionCounts = {};
        logs.forEach(log => {
            const action = log.action || 'Unknown';
            actionCounts[action] = (actionCounts[action] || 0) + 1;
        });

        const actionTypesEl = document.getElementById('actionTypesChart');
        if (actionTypesEl) {
            if (actionTypesChart) actionTypesChart.destroy();
            actionTypesChart = new ApexCharts(actionTypesEl, {
                series: Object.values(actionCounts),
                chart: {
                    type: 'donut', height: 350,
                    fontFamily: "'Inter', 'Segoe UI', sans-serif",
                    toolbar: { show: false },
                    animations: { enabled: true, speed: 800 }
                },
                labels: Object.keys(actionCounts).map(k => k.replace(/_/g, ' ')),
                colors: ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#22d3ee', '#f472b6', '#818cf8'],
                legend: {
                    position: 'bottom', fontSize: '13px', fontWeight: 500,
                    labels: { colors: textColor, useSeriesColors: false },
                    markers: { width: 10, height: 10, radius: 10 },
                    itemMargin: { horizontal: 8, vertical: 4 },
                    horizontalAlign: 'left'
                },
                dataLabels: { enabled: false },
                plotOptions: { pie: { donut: { size: '65%', labels: { show: false } } } },
                stroke: { width: 2, colors: ['rgba(255, 255, 255, 0.1)'] },
                tooltip: { theme: 'dark', y: { formatter: val => val + ' actions' } },
                responsive: [{ breakpoint: 769, options: { chart: { height: 280 }, legend: { fontSize: '12px' } } }]
            });
            actionTypesChart.render();
        }

        // Activity Over Time
        const now = new Date();
        const last7Days = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date(now);
            date.setDate(date.getDate() - i);
            last7Days.push(date.toISOString().split('T')[0]);
        }
        const dailyCounts = {};
        last7Days.forEach(day => dailyCounts[day] = 0);
        logs.forEach(log => {
            if (log.timestamp) {
                const logDate = new Date(log.timestamp).toISOString().split('T')[0];
                if (dailyCounts.hasOwnProperty(logDate)) dailyCounts[logDate]++;
            }
        });

        const activityTimeEl = document.getElementById('activityTimeChart');
        if (activityTimeEl) {
            if (activityTimeChart) activityTimeChart.destroy();
            activityTimeChart = new ApexCharts(activityTimeEl, {
                series: [{ name: 'Actions', data: Object.values(dailyCounts) }],
                chart: {
                    type: 'area', height: 350,
                    fontFamily: "'Inter', 'Segoe UI', sans-serif",
                    toolbar: { show: false }, zoom: { enabled: false },
                    animations: { enabled: true, speed: 800 }
                },
                dataLabels: { enabled: false },
                stroke: { curve: 'smooth', width: 3, colors: ['#60a5fa'] },
                fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.5, opacityTo: 0.1, stops: [0, 90, 100] }, colors: ['#60a5fa'] },
                markers: { size: 5, colors: ['#60a5fa'], strokeColors: '#fff', strokeWidth: 2, hover: { size: 7 } },
                xaxis: {
                    categories: last7Days.map(d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })),
                    labels: { style: { colors: textColor, fontSize: '12px', fontWeight: 500 } },
                    axisBorder: { show: false }, axisTicks: { show: false }
                },
                yaxis: { labels: { style: { colors: textColor, fontSize: '12px', fontWeight: 500 } } },
                grid: { borderColor, strokeDashArray: 4, xaxis: { lines: { show: false } }, yaxis: { lines: { show: true } } },
                tooltip: { theme: 'dark', x: { show: true }, y: { formatter: val => val + ' actions' } }
            });
            activityTimeChart.render();
        }
    };

    // --- Initialize ---
    loadClients();
    loadBlocklist();
    loadStats();
    loadLogs();
    loadBufferHistory();

    // --- Reload Charts Button ---
    const reloadChartsBtn = document.getElementById('reloadChartsBtn');
    if (reloadChartsBtn) {
        reloadChartsBtn.addEventListener('click', async () => {
            reloadChartsBtn.classList.add('spinning');
            // Destroy existing charts
            if (actionTypesChart) { actionTypesChart.destroy(); actionTypesChart = null; }
            if (activityTimeChart) { activityTimeChart.destroy(); activityTimeChart = null; }
            chartsInitialized = true;
            await initCharts();
            setTimeout(() => reloadChartsBtn.classList.remove('spinning'), 1000);
        });
    }

    // Refresh data every 10 seconds
    setInterval(() => {
        loadClients();
        loadBlocklist();
        loadStats();
    }, 10000);
});

// CSS for animations and badges
const style = document.createElement('style');
style.textContent = `
    @keyframes fadeIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
    }

    .badge {
        display: inline-block;
        padding: 0.25rem 0.75rem;
        border-radius: 12px;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.025em;
    }

    .badge-primary { background: linear-gradient(135deg, #3b82f6, #60a5fa); color: white; }
    .badge-success { background: linear-gradient(135deg, #10b981, #34d399); color: white; }
    .badge-danger { background: linear-gradient(135deg, #ef4444, #f87171); color: white; }
    .badge-warning { background: linear-gradient(135deg, #f59e0b, #fbbf24); color: white; }
    .badge-info { background: linear-gradient(135deg, #8b5cf6, #a78bfa); color: white; }
    .badge-default { background: var(--c-surface); color: var(--c-text-main); border: 1px solid var(--c-border); }
`;
document.head.appendChild(style);
