// static/js/backbone.js

document.addEventListener('DOMContentLoaded', () => {

    // --- UTILITY FUNCTIONS ---
    function escapeHTML(str) {
        if (!str) return '';
        return str.replace(/[&<>"']/g, match => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[match]));
    }

    // The QR code is always drawn on a white square, so its modules must be dark. In the dark theme --c-primary is a
    // light colour, which would give an unscannable light-on-white code; so use the standard (light theme) accent.
    const QR_ACCENTS = { red: '#dc2626', blue: '#2563eb', green: '#16a34a', purple: '#7c3aed', orange: '#ea580c', black: '#171717' };

    function getAccentColor() {
        const cls = Array.from(document.documentElement.classList).find(c => c.startsWith('accent-'));
        const name = cls ? cls.slice('accent-'.length) : '';
        return QR_ACCENTS[name] || getComputedStyle(document.documentElement).getPropertyValue('--c-primary').trim();
    }

    async function fetchQrCode(type, payload = {}) {
        try {
            const response = await fetch('/api/qr_code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, color: getAccentColor(), ...payload })
            });
            if (!response.ok) throw new Error('Server returned an error.');
            const result = await response.json();
            if (result.success) {
                return result.svg;
            } else {
                throw new Error(result.error || 'Failed to generate QR code.');
            }
        } catch (error) {
            console.error(`Error fetching ${type} QR code:`, error);
            return '<p style="color:var(--c-error-text); font-size:0.8rem;">Could not load QR code.</p>';
        }
    };

    // --- THEME TOGGLE LOGIC (Shared Header) ---
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
        });
    }

    // --- ACCENT COLOR PICKER LOGIC ---
    const accentToggle = document.getElementById('accent-toggle');
    const accentPicker = document.getElementById('accent-picker');
    const accentOptions = document.querySelectorAll('.accent-option');

    // Apply saved accent on page load (already done in head, but set active state)
    const savedAccent = localStorage.getItem('accent') || 'red';
    accentOptions.forEach(opt => {
        if (opt.dataset.accent === savedAccent) {
            opt.classList.add('active');
        }
    });

    if (accentToggle && accentPicker) {
        // Toggle picker visibility
        accentToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            accentPicker.classList.toggle('visible');
        });

        // Handle accent selection
        accentOptions.forEach(option => {
            option.addEventListener('click', () => {
                const accent = option.dataset.accent;

                // Remove all accent classes and add the selected one
                document.documentElement.classList.remove(
                    'accent-red', 'accent-blue', 'accent-green',
                    'accent-purple', 'accent-orange', 'accent-black'
                );
                document.documentElement.classList.add(`accent-${accent}`);

                // Update active state
                accentOptions.forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');

                // Save to localStorage
                localStorage.setItem('accent', accent);

                // Close picker
                accentPicker.classList.remove('visible');
            });
        });

        // Close picker when clicking outside
        document.addEventListener('click', (e) => {
            if (!accentPicker.contains(e.target) && e.target !== accentToggle) {
                accentPicker.classList.remove('visible');
            }
        });
    }

    // --- FLASH MESSAGE HANDLING (Shared Base Template) ---
    function dismissMessage(messageElement) {
        if (messageElement) {
            messageElement.style.opacity = '0';
            setTimeout(() => messageElement.remove(), 300);
        }
    }

    function handleFlashMessages() {
        document.querySelectorAll('.flash-messages .close-flash').forEach(button => {
            button.addEventListener('click', (event) => {
                dismissMessage(event.target.parentElement);
            });
        });
        document.querySelectorAll('.flash-messages li').forEach(message => {
            setTimeout(() => dismissMessage(message), 5000);
        });
    }
    handleFlashMessages(); // Run on page load

    // --- GLOBAL ESCAPE KEY HANDLER FOR MODALS ---
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // Close all visible modals
            document.querySelectorAll('.modal-overlay.visible').forEach(modal => {
                modal.classList.remove('visible');
            });
        }
    });

    // --- CONNECT DEVICE MODAL LOGIC (Shared Header) ---
    const connectModal = document.getElementById('connectModal');
    if (connectModal) {
        const openConnectBtn = document.getElementById('connectBtn');
        const closeConnectBtn = document.getElementById('closeConnectModal');
        const showIpBtn = document.getElementById('showIpBtn');
        const showWifiBtn = document.getElementById('showWifiBtn');
        const ipConnectView = document.getElementById('ipConnectView');
        const wifiConnectView = document.getElementById('wifiConnectView');
        const ipQrContainer = document.getElementById('ipQrContainer');
        const wifiQrForm = document.getElementById('wifiQrForm');

        openConnectBtn.addEventListener('click', async () => {
            connectModal.classList.add('visible');
            ipQrContainer.innerHTML = '<div class="spinner"></div>';
            const svgCode = await fetchQrCode('ip');
            ipQrContainer.innerHTML = svgCode;
        });

        const closeModal = () => connectModal.classList.remove('visible');
        closeConnectBtn.addEventListener('click', closeModal);
        connectModal.addEventListener('click', (e) => {
            if (e.target === connectModal) closeModal();
        });

        showIpBtn.addEventListener('click', () => {
            ipConnectView.classList.remove('view-hidden');
            wifiConnectView.classList.add('view-hidden');
            showIpBtn.classList.add('active');
            showWifiBtn.classList.remove('active');
        });

        showWifiBtn.addEventListener('click', () => {
            ipConnectView.classList.add('view-hidden');
            wifiConnectView.classList.remove('view-hidden');
            showIpBtn.classList.remove('active');
            showWifiBtn.classList.add('active');
        });

        wifiQrForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const ssid = document.getElementById('wifiSSID').value;
            const password = document.getElementById('wifiPassword').value;
            const generateWifiQrBtn = document.getElementById('generateWifiQrBtn');
            const wifiQrContainer = document.getElementById('wifiQrContainer');

            generateWifiQrBtn.disabled = true;
            generateWifiQrBtn.textContent = 'Generating...';
            wifiQrContainer.innerHTML = '<div class="spinner"></div>';

            const svgCode = await fetchQrCode('wifi', { ssid, password });
            wifiQrContainer.innerHTML = svgCode;

            generateWifiQrBtn.disabled = false;
            generateWifiQrBtn.textContent = 'Generate QR Code';
        });
    }

    // --- COFFEE/FEEDBACK MODAL LOGIC (Shared Header) ---
    const coffeeModal = document.getElementById('coffeeModal');
    if (coffeeModal) {
        const openCoffeeBtn = document.getElementById('coffeeBtn');
        const closeCoffeeBtn = document.getElementById('closeCoffeeModal');
        const showFeedbackQrBtn = document.getElementById('showFeedbackQrBtn');
        const showSupportQrBtn = document.getElementById('showSupportQrBtn');
        const feedbackQrView = document.getElementById('feedbackQrView');
        const supportQrView = document.getElementById('supportQrView');
        const feedbackQrContainer = document.getElementById('feedbackQrContainer');
        const coffeeQrContainer = document.getElementById('coffeeQrContainer');

        let isFeedbackQrLoaded = false;
        let isSupportQrLoaded = false;

        openCoffeeBtn.addEventListener('click', async () => {
            coffeeModal.classList.add('visible');
            if (!isFeedbackQrLoaded) {
                feedbackQrContainer.innerHTML = '<div class="spinner"></div>';
                const svgCode = await fetchQrCode('instagram');
                feedbackQrContainer.innerHTML = svgCode;
                isFeedbackQrLoaded = true;
            }
        });

        showFeedbackQrBtn.addEventListener('click', () => {
            feedbackQrView.style.display = 'block';
            supportQrView.style.display = 'none';
            showFeedbackQrBtn.classList.add('active');
            showSupportQrBtn.classList.remove('active');
        });

        showSupportQrBtn.addEventListener('click', async () => {
            feedbackQrView.style.display = 'none';
            supportQrView.style.display = 'block';
            showFeedbackQrBtn.classList.remove('active');
            showSupportQrBtn.classList.add('active');

            if (!isSupportQrLoaded) {
                coffeeQrContainer.innerHTML = '<div class="spinner"></div>';
                const svgCode = await fetchQrCode('upi');
                coffeeQrContainer.innerHTML = svgCode;
                isSupportQrLoaded = true;
            }
        });

        const closeCoffeeModal = () => coffeeModal.classList.remove('visible');
        closeCoffeeBtn.addEventListener('click', closeCoffeeModal);
        coffeeModal.addEventListener('click', (e) => {
            if (e.target === coffeeModal) closeCoffeeModal();
        });
    }

    // Expose utility functions to other scripts by attaching them to the window object
    window.AppUtils = {
        escapeHTML
    };

    // --- SHARED SNAIL DIALOG UTILITIES ---
    // These are globally accessible via window.snailPrompt / window.snailConfirm

    /**
     * Show a prompt modal. Returns a Promise<string|null>.
     * @param {string} title - Modal title
     * @param {string} message - Modal message
     * @param {Object} opts - Options: { placeholder, defaultValue, type, confirmText }
     */
    window.snailPrompt = function (title, message, opts = {}) {
        return new Promise((resolve) => {
            const modal = document.getElementById('snailPromptModal');
            const titleEl = document.getElementById('snailPromptTitle');
            const messageEl = document.getElementById('snailPromptMessage');
            const inputEl = document.getElementById('snailPromptInput');
            const errorEl = document.getElementById('snailPromptError');
            const confirmBtn = document.getElementById('snailPromptConfirm');
            const cancelBtn = document.getElementById('snailPromptCancel');
            if (!modal) { resolve(null); return; }

            titleEl.textContent = title;
            messageEl.textContent = message;
            inputEl.type = opts.type || 'text';
            inputEl.placeholder = opts.placeholder || 'Enter value...';
            inputEl.value = opts.defaultValue || '';
            errorEl.textContent = '';
            confirmBtn.textContent = opts.confirmText || 'Confirm';
            modal.classList.add('visible');
            setTimeout(() => inputEl.focus(), 100);

            const handleConfirm = () => {
                const value = inputEl.value.trim();
                if (!value) {
                    errorEl.textContent = 'This field cannot be empty.';
                    return;
                }
                cleanup();
                resolve(value);
            };
            const handleCancel = () => { cleanup(); resolve(null); };
            const handleKeydown = (e) => {
                if (e.key === 'Enter') handleConfirm();
                if (e.key === 'Escape') handleCancel();
            };
            const handleOverlayClick = (e) => {
                if (e.target === modal) handleCancel();
            };
            const cleanup = () => {
                modal.classList.remove('visible');
                confirmBtn.removeEventListener('click', handleConfirm);
                cancelBtn.removeEventListener('click', handleCancel);
                inputEl.removeEventListener('keydown', handleKeydown);
                modal.removeEventListener('click', handleOverlayClick);
            };
            confirmBtn.addEventListener('click', handleConfirm);
            cancelBtn.addEventListener('click', handleCancel);
            inputEl.addEventListener('keydown', handleKeydown);
            modal.addEventListener('click', handleOverlayClick);
        });
    };

    /**
     * Show a select dropdown modal. Returns a Promise<string|null>.
     * @param {string} title - Modal title
     * @param {string} message - Modal message
     * @param {Array} options - Array of { label, value } objects. Include { label: 'Custom...', value: '__custom__' } for custom input.
     * @param {Object} opts - Options: { confirmText }
     */
    window.snailSelect = function (title, message, options = [], opts = {}) {
        return new Promise((resolve) => {
            const modal = document.getElementById('snailSelectModal');
            const titleEl = document.getElementById('snailSelectTitle');
            const messageEl = document.getElementById('snailSelectMessage');
            const selectEl = document.getElementById('snailSelectInput');
            const customInput = document.getElementById('snailSelectCustomInput');
            const errorEl = document.getElementById('snailSelectError');
            const confirmBtn = document.getElementById('snailSelectConfirm');
            const cancelBtn = document.getElementById('snailSelectCancel');
            if (!modal) { resolve(null); return; }

            titleEl.textContent = title;
            messageEl.textContent = message;
            errorEl.textContent = '';
            confirmBtn.textContent = opts.confirmText || 'Confirm';
            customInput.style.display = 'none';
            customInput.value = '';

            // Populate select options
            selectEl.innerHTML = '';
            options.forEach(opt => {
                const optionEl = document.createElement('option');
                optionEl.value = opt.value;
                optionEl.textContent = opt.label;
                selectEl.appendChild(optionEl);
            });

            modal.classList.add('visible');
            setTimeout(() => selectEl.focus(), 100);

            // Show/hide custom input based on selection
            const handleSelectChange = () => {
                if (selectEl.value === '__custom__') {
                    customInput.style.display = '';
                    setTimeout(() => customInput.focus(), 50);
                } else {
                    customInput.style.display = 'none';
                    customInput.value = '';
                }
                errorEl.textContent = '';
            };

            const handleConfirm = () => {
                let value = selectEl.value;
                if (value === '__custom__') {
                    value = customInput.value.trim();
                    if (!value || isNaN(parseFloat(value))) {
                        errorEl.textContent = 'Please enter a valid number.';
                        return;
                    }
                }
                cleanup();
                resolve(value);
            };
            const handleCancel = () => { cleanup(); resolve(null); };
            const handleKeydown = (e) => {
                if (e.key === 'Enter') handleConfirm();
                if (e.key === 'Escape') handleCancel();
            };
            const handleOverlayClick = (e) => {
                if (e.target === modal) handleCancel();
            };
            const cleanup = () => {
                modal.classList.remove('visible');
                selectEl.removeEventListener('change', handleSelectChange);
                confirmBtn.removeEventListener('click', handleConfirm);
                cancelBtn.removeEventListener('click', handleCancel);
                selectEl.removeEventListener('keydown', handleKeydown);
                customInput.removeEventListener('keydown', handleKeydown);
                modal.removeEventListener('click', handleOverlayClick);
            };
            selectEl.addEventListener('change', handleSelectChange);
            confirmBtn.addEventListener('click', handleConfirm);
            cancelBtn.addEventListener('click', handleCancel);
            selectEl.addEventListener('keydown', handleKeydown);
            customInput.addEventListener('keydown', handleKeydown);
            modal.addEventListener('click', handleOverlayClick);
        });
    };

    /**
     * Show a confirm modal. Returns a Promise<boolean>.
     * @param {string} title - Modal title
     * @param {string} message - Modal message
     * @param {Object} opts - Options: { danger, confirmText, cancelText }
     */
    window.snailConfirm = function (title, message, opts = {}) {
        return new Promise((resolve) => {
            const modal = document.getElementById('snailConfirmModal');
            const titleEl = document.getElementById('snailConfirmTitle');
            const messageEl = document.getElementById('snailConfirmMessage');
            const yesBtn = document.getElementById('snailConfirmYes');
            const noBtn = document.getElementById('snailConfirmNo');
            if (!modal) { resolve(false); return; }

            titleEl.textContent = title;
            messageEl.textContent = message;
            yesBtn.textContent = opts.confirmText || 'Yes';
            noBtn.textContent = opts.cancelText || 'Cancel';

            // Apply danger styling if requested
            yesBtn.classList.remove('snail-btn-primary', 'snail-btn-danger');
            yesBtn.classList.add(opts.danger ? 'snail-btn-danger' : 'snail-btn-primary');

            modal.classList.add('visible');

            const handleYes = () => { cleanup(); resolve(true); };
            const handleNo = () => { cleanup(); resolve(false); };
            const handleKeydown = (e) => {
                if (e.key === 'Escape') handleNo();
            };
            const handleOverlayClick = (e) => {
                if (e.target === modal) handleNo();
            };
            const cleanup = () => {
                modal.classList.remove('visible');
                yesBtn.removeEventListener('click', handleYes);
                noBtn.removeEventListener('click', handleNo);
                document.removeEventListener('keydown', handleKeydown);
                modal.removeEventListener('click', handleOverlayClick);
            };
            yesBtn.addEventListener('click', handleYes);
            noBtn.addEventListener('click', handleNo);
            document.addEventListener('keydown', handleKeydown);
            modal.addEventListener('click', handleOverlayClick);
        });
    };

    // --- MOBILE BOTTOM NAVIGATION ---
    const isMobile = () => window.innerWidth <= 768;

    const mobileBottomNav = document.getElementById('mobileBottomNav');
    const settingsSheet = document.getElementById('mobileSettingsSheet');
    const settingsBackdrop = document.getElementById('mobileSettingsBackdrop');

    if (mobileBottomNav) {
        const navTabs = mobileBottomNav.querySelectorAll('.mobile-nav-tab');
        const settingsTab = document.getElementById('navTabSettings');

        navTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                if (!isMobile()) return;

                // If it's the settings tab, toggle settings sheet
                if (tab === settingsTab) {
                    if (settingsSheet) {
                        settingsSheet.classList.toggle('visible');
                    }
                    // Mark active
                    navTabs.forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    return;
                }

                // Close settings sheet when navigating
                if (settingsSheet) settingsSheet.classList.remove('visible');

                // Set active tab
                navTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // Scroll to the target section
                const targetClass = tab.dataset.target;
                if (targetClass) {
                    let targetEl = null;
                    if (targetClass === 'shared-text-section') {
                        targetEl = document.querySelector('.shared-text-section');
                    } else if (targetClass === 'upload-section') {
                        targetEl = document.querySelector('.upload-section');
                    } else if (targetClass === 'download-section') {
                        targetEl = document.querySelector('.download-section');
                    }
                    if (targetEl) {
                        const headerHeight = document.querySelector('.app-header')?.offsetHeight || 56;
                        const y = targetEl.getBoundingClientRect().top + window.pageYOffset - headerHeight - 8;
                        window.scrollTo({ top: y, behavior: 'smooth' });
                    }
                }
            });
        });
    }

    // Close settings sheet when tapping backdrop
    if (settingsBackdrop) {
        settingsBackdrop.addEventListener('click', () => {
            if (settingsSheet) settingsSheet.classList.remove('visible');
        });
    }

    // --- MOBILE SETTINGS: THEME TOGGLE ---
    const mobileThemeToggle = document.getElementById('mobileThemeToggle');
    const mobileThemeLabel = mobileThemeToggle?.querySelector('.mobile-theme-label');

    function updateMobileThemeLabel() {
        if (mobileThemeLabel) {
            mobileThemeLabel.textContent = document.documentElement.classList.contains('dark') ? 'Dark Mode' : 'Light Mode';
        }
    }

    if (mobileThemeToggle) {
        updateMobileThemeLabel();
        mobileThemeToggle.addEventListener('click', () => {
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            updateMobileThemeLabel();
        });

        // Sync with header theme toggle changes
        if (themeToggle) {
            const origClickHandler = themeToggle.onclick; // won't work since we used addEventListener
            // Use MutationObserver to watch for class changes
            const observer = new MutationObserver(() => updateMobileThemeLabel());
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        }
    }

    // --- MOBILE SETTINGS: ACCENT PICKER ---
    const mobileAccentPicker = document.querySelector('.mobile-accent-picker');
    if (mobileAccentPicker) {
        const mobileAccentOptions = mobileAccentPicker.querySelectorAll('.accent-option');

        // Set initial active state
        const currentAccent = localStorage.getItem('accent') || 'red';
        mobileAccentOptions.forEach(opt => {
            if (opt.dataset.accent === currentAccent) {
                opt.classList.add('active');
            }
        });

        mobileAccentOptions.forEach(option => {
            option.addEventListener('click', () => {
                const accent = option.dataset.accent;

                // Remove all accent classes and add the selected one
                document.documentElement.classList.remove(
                    'accent-red', 'accent-blue', 'accent-green',
                    'accent-purple', 'accent-orange', 'accent-black'
                );
                document.documentElement.classList.add(`accent-${accent}`);

                // Update active state in BOTH pickers
                mobileAccentOptions.forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');

                // Sync header accent picker
                accentOptions.forEach(opt => {
                    opt.classList.remove('active');
                    if (opt.dataset.accent === accent) opt.classList.add('active');
                });

                localStorage.setItem('accent', accent);
            });
        });
    }

    // --- MOBILE SETTINGS: QUICK ACTIONS ---
    const mobileConnectBtn = document.getElementById('mobileConnectBtn');
    if (mobileConnectBtn) {
        mobileConnectBtn.addEventListener('click', () => {
            if (settingsSheet) settingsSheet.classList.remove('visible');
            // Trigger the existing connect button click
            const connectBtn = document.getElementById('connectBtn');
            if (connectBtn) connectBtn.click();
        });
    }

    const mobileCoffeeBtn = document.getElementById('mobileCoffeeBtn');
    if (mobileCoffeeBtn) {
        mobileCoffeeBtn.addEventListener('click', () => {
            if (settingsSheet) settingsSheet.classList.remove('visible');
            // Trigger the existing coffee button click
            const coffeeBtn = document.getElementById('coffeeBtn');
            if (coffeeBtn) coffeeBtn.click();
        });
    }
});