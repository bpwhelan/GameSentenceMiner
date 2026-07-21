// Shared JavaScript functionality across all pages

// Modal Management Functions
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('show');
        modal.style.display = 'flex';
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
        modal.style.display = 'none';
    }
}

// Initialize modal close functionality (backdrop clicks and ESC key)
function initializeModalHandlers() {
    // Close modals only if both mousedown and mouseup are on the backdrop
    document.querySelectorAll('.modal').forEach(modal => {
        let backdropMouseDown = false;
        modal.addEventListener('mousedown', (e) => {
            backdropMouseDown = (e.target === modal);
        });
        modal.addEventListener('mouseup', (e) => {
            if (backdropMouseDown && e.target === modal) {
                closeModal(modal.id);
            }
            backdropMouseDown = false;
        });
    });
    
    // Close modals on ESC key press
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const openModals = document.querySelectorAll('.modal.show');
            openModals.forEach(modal => {
                closeModal(modal.id);
            });
        }
    });
}

// API Helper Functions
async function fetchWithErrorHandling(url, options = {}) {
    try {
        const response = await fetch(url, options);
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
        }
        
        return { success: true, data, status: response.status };
    } catch (error) {
        console.error(`API Error (${url}):`, error);
        return { success: false, error: error.message, status: 0 };
    }
}

async function loadGamesList() {
    const result = await fetchWithErrorHandling('/api/games-list');
    if (result.success) {
        return result.data.games || [];
    }
    return [];
}

// UI Helper Functions
function showElement(element) {
    if (element) {
        element.style.display = '';
    }
}

function hideElement(element) {
    if (element) {
        element.style.display = 'none';
    }
}

function showElementFlex(element) {
    if (element) {
        element.style.display = 'flex';
    }
}

function showElementBlock(element) {
    if (element) {
        element.style.display = 'block';
    }
}

function toggleElement(element, show) {
    if (element) {
        element.style.display = show ? '' : 'none';
    }
}

function showLoadingState(container) {
    if (container) {
        container.innerHTML = `
            <div class="loading-indicator">
                <div class="spinner"></div>
                <span>Loading...</span>
            </div>
        `;
    }
}

function showErrorState(container, message) {
    if (container) {
        container.innerHTML = `
            <div class="error-message">
                <strong>Error:</strong> ${escapeHtml(message)}
            </div>
        `;
    }
}

// Form Validation Helpers
function validateRequired(value, fieldName) {
    if (!value || value.trim() === '') {
        throw new Error(`${fieldName} is required`);
    }
    return value.trim();
}

function validateNumber(value, fieldName, min = null, max = null) {
    const num = Number(value);
    if (isNaN(num)) {
        throw new Error(`${fieldName} must be a valid number`);
    }
    if (min !== null && num < min) {
        throw new Error(`${fieldName} must be at least ${min}`);
    }
    if (max !== null && num > max) {
        throw new Error(`${fieldName} must be at most ${max}`);
    }
    return num;
}

// Dark mode toggle functionality
function initializeThemeToggle() {
    const themeToggle = document.getElementById('themeToggle');
    const themeIcon = document.getElementById('themeIcon');
    const documentElement = document.documentElement;
    
    if (!themeToggle || !themeIcon) {
        console.warn('Theme toggle elements not found');
        return;
    }
    
    // Check for saved theme preference or default to browser preference
    function getPreferredTheme() {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme) {
            return savedTheme;
        }
        
        // Check browser preference
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return 'dark';
        }
        
        return 'light';
    }
    
    // Apply theme
    function applyTheme(theme) {
        if (theme === 'dark') {
            documentElement.setAttribute('data-theme', 'dark');
            themeIcon.textContent = '☀️';
            themeToggle.title = 'Switch to light mode';
        } else {
            documentElement.setAttribute('data-theme', 'light');
            themeIcon.textContent = '🌙';
            themeToggle.title = 'Switch to dark mode';
        }
    }
    
    // Initialize theme
    const currentTheme = getPreferredTheme();
    applyTheme(currentTheme);
    
    // Toggle theme on button click
    themeToggle.addEventListener('click', () => {
        const currentTheme = documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

        applyTheme(newTheme);
        localStorage.setItem('theme', newTheme);
        location.reload();
    });
    
    // Listen for browser theme changes
    if (window.matchMedia) {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        mediaQuery.addEventListener('change', (e) => {
            // Only auto-switch if user hasn't manually set a preference
            if (!localStorage.getItem('theme')) {
                applyTheme(e.matches ? 'dark' : 'light');
            }
        });
    }
}

function syncStatsConfigFromSettings(settings) {
    if (!settings || typeof settings !== 'object') {
        return;
    }

    if (!window.statsConfig || typeof window.statsConfig !== 'object') {
        window.statsConfig = {};
    }

    const keyMap = {
        session_gap_seconds: 'sessionGapSeconds',
        day_rollover_hour: 'dayRolloverHour',
        streak_requirement_hours: 'streakRequirementHours',
        reading_hours_target: 'readingHoursTarget',
        character_count_target: 'characterCountTarget',
        games_target: 'gamesTarget',
        reading_hours_target_date: 'readingHoursTargetDate',
        character_count_target_date: 'characterCountTargetDate',
        games_target_date: 'gamesTargetDate',
        regex_out_punctuation: 'regexOutPunctuation',
        regex_out_repetitions: 'regexOutRepetitions',
        reading_time_adaptive_v2: 'readingTimeAdaptiveV2',
        extra_punctuation_regex: 'extraPunctuationRegex',
    };

    Object.entries(keyMap).forEach(([serverKey, clientKey]) => {
        if (Object.prototype.hasOwnProperty.call(settings, serverKey)) {
            window.statsConfig[clientKey] = settings[serverKey];
        }
    });
}

// Settings Modal Functionality (for pages that need it)
class SettingsManager {
    constructor() {
        this.initializeElements();
        this.attachEventListeners();
        if (this.tadokuCard) {
            this.loadTadokuSettings().catch(error => {
                console.error('Error loading Tadoku settings:', error);
                this.showTadokuError('Failed to load Tadoku settings');
            });
        }
    }
    
    initializeElements() {
        this.settingsToggle = document.getElementById('settingsToggle');
        this.settingsModal = document.getElementById('settingsModal');
        this.closeSettingsModal = document.getElementById('closeSettingsModal');
        this.cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
        this.saveSettingsBtn = document.getElementById('saveSettingsBtn');
        this.settingsError = document.getElementById('settingsError');
        this.settingsSuccess = document.getElementById('settingsSuccess');
        
        // Optional elements that may not exist on all pages
        this.sessionGapInput = document.getElementById('sessionGap');
        this.dayRolloverHourInput = document.getElementById('dayRolloverHour');
        this.streakRequirementInput = document.getElementById('streakRequirement');
        this.readingHoursTargetInput = document.getElementById('readingHoursTarget');
        this.characterCountTargetInput = document.getElementById('characterCountTarget');
        this.gamesTargetInput = document.getElementById('gamesTarget');
        this.readingHoursTargetDateInput = document.getElementById('readingHoursTargetDate');
        this.characterCountTargetDateInput = document.getElementById('characterCountTargetDate');
        this.gamesTargetDateInput = document.getElementById('gamesTargetDate');
        this.regexOutPunctuationInput = document.getElementById('regex_out_punctuation');
        this.regexOutRepetitionsInput = document.getElementById('regex_out_repetitions');
        this.readingTimeAdaptiveV2Input = document.getElementById('reading_time_adaptive_v2');
        this.extraPunctuationRegexInput = document.getElementById('extra_punctuation_regex');
        this.tadokuUsernameInput = document.getElementById('tadoku_username');
        this.tadokuPasswordInput = document.getElementById('tadoku_password');
        this.tadokuClearCredentialsInput = document.getElementById('tadoku_clear_credentials');
        this.tadokuLanguageCodeInput = document.getElementById('tadoku_language_code');
        this.tadokuDailySyncEnabledInput = document.getElementById('tadoku_daily_sync_enabled');
        this.tadokuDailySyncDeduplicateInput = document.getElementById('tadoku_daily_sync_deduplicate');
        this.tadokuManualSyncDeduplicateInput = document.getElementById('tadoku_manual_sync_deduplicate');
        this.tadokuPreviewBtn = document.getElementById('tadokuPreviewBtn');
        this.tadokuSyncBtn = document.getElementById('tadokuSyncBtn');
        this.tadokuPreviewSummary = document.getElementById('tadokuPreviewSummary');
        this.tadokuPreviewRows = document.getElementById('tadokuPreviewRows');
        this.tadokuCard = document.getElementById('tadokuSyncCard');
        this.tadokuSaveSettingsBtn = document.getElementById('tadokuSaveSettingsBtn');
        this.tadokuRefreshAuthBtn = document.getElementById('tadokuRefreshAuthBtn');
        this.tadokuSettingsError = document.getElementById('tadokuSettingsError');
        this.tadokuSettingsSuccess = document.getElementById('tadokuSettingsSuccess');
        this.tadokuConfigured = false;
    }
    
    attachEventListeners() {
        if (!this.settingsToggle || !this.settingsModal) {
            return; // Settings not available on this page
        }
        
        this.settingsToggle.addEventListener('click', () => this.openModal());
        
        if (this.closeSettingsModal) {
            this.closeSettingsModal.addEventListener('click', () => this.closeModal());
        }
        
        if (this.cancelSettingsBtn) {
            this.cancelSettingsBtn.addEventListener('click', () => this.closeModal());
        }
        
        if (this.saveSettingsBtn) {
            this.saveSettingsBtn.addEventListener('click', () => this.saveSettings());
        }
        if (this.tadokuSaveSettingsBtn) {
            this.tadokuSaveSettingsBtn.addEventListener('click', () => this.saveTadokuSettings());
        }
        if (this.tadokuRefreshAuthBtn) {
            this.tadokuRefreshAuthBtn.addEventListener('click', () => this.refreshTadokuAuth());
        }
        if (this.tadokuPreviewBtn) {
            this.tadokuPreviewBtn.addEventListener('click', () => this.loadTadokuPreview());
        }
        if (this.tadokuSyncBtn) {
            this.tadokuSyncBtn.addEventListener('click', () => this.queueTadokuSync());
        }
        if (this.tadokuManualSyncDeduplicateInput) {
            this.tadokuManualSyncDeduplicateInput.addEventListener('change', () => this.loadTadokuPreview());
        }
        
        // // Close modal when clicking outside
        // if (this.settingsModal) {
        //     this.settingsModal.addEventListener('click', (e) => {
        //         if (e.target === this.settingsModal) {
        //             this.closeModal();
        //         }
        //     });
        // }
        
        // Clear messages when user starts typing
        [
            this.sessionGapInput,
            this.dayRolloverHourInput,
            this.streakRequirementInput,
            this.readingHoursTargetInput,
            this.characterCountTargetInput,
            this.gamesTargetInput,
            this.readingHoursTargetDateInput,
            this.characterCountTargetDateInput,
            this.gamesTargetDateInput,
            this.regexOutPunctuationInput,
            this.regexOutRepetitionsInput,
            this.extraPunctuationRegexInput,
            this.tadokuUsernameInput,
            this.tadokuPasswordInput,
            this.tadokuClearCredentialsInput,
            this.tadokuLanguageCodeInput,
            this.tadokuDailySyncEnabledInput,
            this.tadokuDailySyncDeduplicateInput,
        ]
            .filter(Boolean)
            .forEach(input => {
                const eventName = input.type === 'checkbox' || input.type === 'date'
                    ? 'change'
                    : 'input';
                input.addEventListener(eventName, () => this.clearMessages());
            });
    }
    
    async openModal() {
        try {
            await this.loadCurrentSettings();
            this.showModal();
        } catch (error) {
            console.error('Error opening settings modal:', error);
            this.showError('Failed to load current settings');
        }
    }
    
    closeModal() {
        this.hideModal();
        this.clearMessages();
    }
    
    showModal() {
        if (this.settingsModal) {
            this.settingsModal.classList.add('show');
            this.settingsModal.style.display = 'flex';
        }
    }
    
    hideModal() {
        if (this.settingsModal) {
            this.settingsModal.classList.remove('show');
            this.settingsModal.style.display = 'none';
        }
    }
    
    async loadCurrentSettings() {
        const response = await fetch('/api/settings');
        if (!response.ok) {
            throw new Error('Failed to fetch settings');
        }
        
        const settings = await response.json();
        
        if (this.sessionGapInput) {
            this.sessionGapInput.value = settings.session_gap_seconds;
        }
        if (this.dayRolloverHourInput) {
            this.dayRolloverHourInput.value = settings.day_rollover_hour ?? 4;
        }
        if (this.streakRequirementInput) {
            this.streakRequirementInput.value = settings.streak_requirement_hours || 1;
        }
        if (this.readingHoursTargetInput) {
            this.readingHoursTargetInput.value = settings.reading_hours_target || 1500;
        }
        if (this.characterCountTargetInput) {
            this.characterCountTargetInput.value = settings.character_count_target || 25000000;
        }
        if (this.gamesTargetInput) {
            this.gamesTargetInput.value = settings.games_target || 100;
        }
        if (this.readingHoursTargetDateInput) {
            this.readingHoursTargetDateInput.value = settings.reading_hours_target_date || '';
        }
        if (this.characterCountTargetDateInput) {
            this.characterCountTargetDateInput.value = settings.character_count_target_date || '';
        }
        if (this.gamesTargetDateInput) {
            this.gamesTargetDateInput.value = settings.games_target_date || '';
        }
        if (this.regexOutPunctuationInput) {
            this.regexOutPunctuationInput.checked = settings.regex_out_punctuation;
        }
        if (this.regexOutRepetitionsInput) {
            this.regexOutRepetitionsInput.checked = settings.regex_out_repetitions;
        }
        if (this.readingTimeAdaptiveV2Input) {
            this.readingTimeAdaptiveV2Input.checked = settings.reading_time_adaptive_v2;
        }
        if (this.extraPunctuationRegexInput) {
            this.extraPunctuationRegexInput.value = settings.extra_punctuation_regex || '';
        }
    }
    
    async refreshHeatmapData(selectedYear) {
        try {
            if (typeof loadStatsData === 'function') {
                await loadStatsData(null, null);
            }
        } catch (error) {
            console.error('Error refreshing heatmap data:', error);
        }
    }
    
    async saveSettings() {
        try {
            this.clearMessages();
            
            const settings = {};

            if (this.sessionGapInput) {
                const sessionGap = parseInt(this.sessionGapInput.value);
                if (isNaN(sessionGap) || sessionGap < 0 || sessionGap > 7200) {
                    this.showError('Session gap must be between 0 and 7200 seconds (0 to 2 hours)');
                    return;
                }
                settings.session_gap_seconds = sessionGap;
            }

            if (this.dayRolloverHourInput) {
                const dayRolloverHour = parseInt(this.dayRolloverHourInput.value);
                if (isNaN(dayRolloverHour) || dayRolloverHour < 0 || dayRolloverHour > 23) {
                    this.showError('Day rollover hour must be between 0 and 23');
                    return;
                }
                settings.day_rollover_hour = dayRolloverHour;
            }
            
            if (this.streakRequirementInput) {
                const streakRequirement = parseFloat(this.streakRequirementInput.value);
                if (isNaN(streakRequirement) || streakRequirement < 0.01 || streakRequirement > 24) {
                    this.showError('Streak requirement must be between 0.01 and 24 hours');
                    return;
                }
                settings.streak_requirement_hours = streakRequirement;
            }
            
            if (this.readingHoursTargetInput) {
                const readingHoursTarget = parseInt(this.readingHoursTargetInput.value);
                if (isNaN(readingHoursTarget) || readingHoursTarget < 1 || readingHoursTarget > 10000) {
                    this.showError('Reading hours target must be between 1 and 10,000 hours');
                    return;
                }
                settings.reading_hours_target = readingHoursTarget;
            }
            
            if (this.characterCountTargetInput) {
                const characterCountTarget = parseInt(this.characterCountTargetInput.value);
                if (isNaN(characterCountTarget) || characterCountTarget < 1000 || characterCountTarget > 1000000000) {
                    this.showError('Character count target must be between 1,000 and 1,000,000,000 characters');
                    return;
                }
                settings.character_count_target = characterCountTarget;
            }
            
            if (this.gamesTargetInput) {
                const gamesTarget = parseInt(this.gamesTargetInput.value);
                if (isNaN(gamesTarget) || gamesTarget < 1 || gamesTarget > 1000) {
                    this.showError('Games target must be between 1 and 1,000');
                    return;
                }
                settings.games_target = gamesTarget;
            }
            
            // Add target date fields (optional)
            if (this.readingHoursTargetDateInput) {
                settings.reading_hours_target_date = this.readingHoursTargetDateInput.value || '';
            }
            
            if (this.characterCountTargetDateInput) {
                settings.character_count_target_date = this.characterCountTargetDateInput.value || '';
            }
            
            if (this.gamesTargetDateInput) {
                settings.games_target_date = this.gamesTargetDateInput.value || '';
            }

            if (this.regexOutPunctuationInput) {
                settings.regex_out_punctuation = this.regexOutPunctuationInput.checked;
            }
            
            if (this.regexOutRepetitionsInput) {
                settings.regex_out_repetitions = this.regexOutRepetitionsInput.checked;
            }

            if (this.readingTimeAdaptiveV2Input) {
                settings.reading_time_adaptive_v2 = this.readingTimeAdaptiveV2Input.checked;
            }

            if (this.extraPunctuationRegexInput) {
                settings.extra_punctuation_regex = this.extraPunctuationRegexInput.value.trim();
            }
            // Show loading state
            if (this.saveSettingsBtn) {
                this.saveSettingsBtn.disabled = true;
                this.saveSettingsBtn.textContent = 'Saving...';
            }
            
            const response = await fetch('/api/settings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(settings)
            });
            
            const result = await response.json();
            
            if (!response.ok) {
                throw new Error(result.error || 'Failed to save settings');
            }

            syncStatsConfigFromSettings(result);
            this.showSuccess('Settings saved successfully! Changes will apply to new calculations.');

            // Dispatch event to notify other components that settings were updated
            window.dispatchEvent(new CustomEvent('settingsUpdated', {
                detail: {
                    savedSettings: settings,
                    response: result,
                },
            }));
            
            // Auto-close modal after 2 seconds
            setTimeout(() => {
                this.closeModal();
            }, 2000);
            
        } catch (error) {
            console.error('Error saving settings:', error);
            this.showError(error.message || 'Failed to save settings');
        } finally {
            // Reset button state
            if (this.saveSettingsBtn) {
                this.saveSettingsBtn.disabled = false;
                this.saveSettingsBtn.textContent = 'Save Settings';
            }
        }
    }

    async saveTadokuSettings() {
        try {
            this.clearTadokuMessages();

            const languageCode = this.tadokuLanguageCodeInput?.value.trim().toLowerCase() || '';
            if (!/^[a-z]{3}$/.test(languageCode)) {
                this.showTadokuError('Tadoku language code must be a three-letter ISO 639-3 code');
                return;
            }

            const clearCredentials = Boolean(this.tadokuClearCredentialsInput?.checked);
            const settings = {
                tadoku_clear_credentials: clearCredentials,
                tadoku_language_code: languageCode,
                tadoku_daily_sync_enabled: Boolean(this.tadokuDailySyncEnabledInput?.checked),
                tadoku_daily_sync_deduplicate: Boolean(this.tadokuDailySyncDeduplicateInput?.checked),
            };
            if (!clearCredentials) {
                settings.tadoku_username = this.tadokuUsernameInput?.value.trim() || '';
            }
            const password = this.tadokuPasswordInput?.value || '';
            if (password && !clearCredentials) {
                settings.tadoku_password = password;
            }

            this.tadokuSaveSettingsBtn.disabled = true;
            this.tadokuSaveSettingsBtn.textContent = 'Saving…';

            const response = await fetch('/api/settings', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(settings),
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || 'Failed to save Tadoku settings');
            }

            this.tadokuConfigured = Boolean(result.tadoku_configured);
            if (this.tadokuPasswordInput) {
                this.tadokuPasswordInput.value = '';
                this.tadokuPasswordInput.placeholder = this.tadokuConfigured
                    ? 'Saved password (leave blank to keep)'
                    : 'Password';
            }
            if (this.tadokuClearCredentialsInput) {
                this.tadokuClearCredentialsInput.checked = false;
            }
            this.showTadokuSuccess('Tadoku settings saved successfully.');
            window.dispatchEvent(new CustomEvent('settingsUpdated', {
                detail: {
                    savedSettings: settings,
                    response: result,
                },
            }));
            await this.loadTadokuPreview();
        } catch (error) {
            console.error('Error saving Tadoku settings:', error);
            this.showTadokuError(error.message || 'Failed to save Tadoku settings');
        } finally {
            if (this.tadokuSaveSettingsBtn) {
                this.tadokuSaveSettingsBtn.disabled = false;
                this.tadokuSaveSettingsBtn.textContent = 'Save Tadoku settings';
            }
        }
    }

    async loadTadokuSettings() {
        const response = await fetch('/api/settings');
        if (!response.ok) {
            throw new Error('Failed to fetch Tadoku settings');
        }
        const settings = await response.json();

        if (this.tadokuUsernameInput) {
            this.tadokuUsernameInput.value = settings.tadoku_username || '';
        }
        if (this.tadokuPasswordInput) {
            this.tadokuPasswordInput.value = '';
            this.tadokuPasswordInput.placeholder = settings.tadoku_configured
                ? 'Saved password (leave blank to keep)'
                : 'Password';
        }
        if (this.tadokuClearCredentialsInput) {
            this.tadokuClearCredentialsInput.checked = false;
        }
        if (this.tadokuLanguageCodeInput) {
            this.tadokuLanguageCodeInput.value = settings.tadoku_language_code || 'jpn';
        }
        if (this.tadokuDailySyncEnabledInput) {
            this.tadokuDailySyncEnabledInput.checked = Boolean(settings.tadoku_daily_sync_enabled);
        }
        if (this.tadokuDailySyncDeduplicateInput) {
            this.tadokuDailySyncDeduplicateInput.checked = settings.tadoku_daily_sync_deduplicate !== false;
        }
        this.tadokuConfigured = Boolean(settings.tadoku_configured);
        await this.loadTadokuPreview();
    }

    async refreshTadokuAuth() {
        if (!this.tadokuRefreshAuthBtn) {
            return;
        }
        try {
            this.clearTadokuMessages();
            this.tadokuRefreshAuthBtn.disabled = true;
            this.tadokuRefreshAuthBtn.textContent = 'Refreshing…';
            const response = await fetch('/api/tadoku/auth/refresh', {method: 'POST'});
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || 'Failed to refresh Tadoku login');
            }
            this.tadokuConfigured = true;
            this.showTadokuSuccess('Tadoku login refreshed successfully.');
        } catch (error) {
            console.error('Error refreshing Tadoku login:', error);
            this.showTadokuError(error.message || 'Failed to refresh Tadoku login');
        } finally {
            this.tadokuRefreshAuthBtn.disabled = false;
            this.tadokuRefreshAuthBtn.textContent = 'Refresh Tadoku login';
        }
    }

    async loadTadokuPreview() {
        if (!this.tadokuPreviewSummary || !this.tadokuPreviewRows) {
            return;
        }
        const deduplicate = Boolean(this.tadokuManualSyncDeduplicateInput?.checked);
        this.tadokuPreviewSummary.textContent = 'Loading Tadoku preview…';
        this.tadokuPreviewRows.replaceChildren();
        if (this.tadokuSyncBtn) {
            this.tadokuSyncBtn.disabled = true;
        }
        try {
            const response = await fetch(`/api/tadoku/preview?deduplicate=${deduplicate}`);
            const preview = await response.json();
            if (!response.ok) {
                throw new Error(preview.error || 'Failed to load Tadoku preview');
            }
            this.tadokuConfigured = Boolean(preview.configured);
            const cleanupText = deduplicate
                ? `; ${preview.duplicates_excluded.toLocaleString()} new duplicate line(s) excluded`
                : '';
            this.tadokuPreviewSummary.textContent = `${preview.total_entries.toLocaleString()} game log(s), ${preview.total_characters.toLocaleString()} characters${cleanupText}`;
            preview.entries.forEach(entry => {
                const row = document.createElement('tr');
                [entry.game_name, entry.lines.toLocaleString(), entry.characters.toLocaleString()].forEach((value, index) => {
                    const cell = document.createElement('td');
                    cell.textContent = value;
                    cell.style.padding = '6px';
                    cell.style.borderBottom = '1px solid var(--border-color)';
                    if (index > 0) {
                        cell.style.textAlign = 'right';
                    }
                    row.appendChild(cell);
                });
                this.tadokuPreviewRows.appendChild(row);
            });
            if (this.tadokuSyncBtn) {
                const hasWork = preview.total_entries > 0
                    || (deduplicate && preview.duplicates_excluded > 0);
                this.tadokuSyncBtn.disabled = !hasWork
                    || (!this.tadokuConfigured && preview.total_entries > 0);
                this.tadokuSyncBtn.title = !this.tadokuConfigured && preview.total_entries > 0
                    ? 'Save a Tadoku session cookie before syncing'
                    : '';
            }
        } catch (error) {
            this.tadokuPreviewSummary.textContent = error.message || 'Failed to load Tadoku preview';
            this.showTadokuError(error.message || 'Failed to load Tadoku preview');
        }
    }

    async queueTadokuSync() {
        const deduplicate = Boolean(this.tadokuManualSyncDeduplicateInput?.checked);
        await this.loadTadokuPreview();
        if (!window.confirm('Send the previewed per-game character totals to Tadoku?')) {
            return;
        }
        if (this.tadokuSyncBtn) {
            this.tadokuSyncBtn.disabled = true;
            this.tadokuSyncBtn.textContent = 'Queueing…';
        }
        try {
            const response = await fetch('/api/tadoku/sync', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({deduplicate}),
            });
            const job = await response.json();
            if (!response.ok) {
                throw new Error(job.error || 'Failed to queue Tadoku sync');
            }
            await this.pollTadokuJob(job.job_id);
        } catch (error) {
            this.showTadokuError(error.message || 'Tadoku sync failed');
        } finally {
            if (this.tadokuSyncBtn) {
                this.tadokuSyncBtn.textContent = 'Queue manual sync';
            }
            await this.loadTadokuPreview();
        }
    }

    async pollTadokuJob(jobId) {
        while (true) {
            const response = await fetch(`/api/tadoku/jobs/${encodeURIComponent(jobId)}`);
            const job = await response.json();
            if (!response.ok) {
                throw new Error(job.error || 'Failed to read Tadoku sync status');
            }
            if (job.status === 'completed') {
                const result = job.result || {};
                this.showTadokuSuccess(`Sent ${Number(result.characters_sent || 0).toLocaleString()} characters in ${Number(result.entries_sent || 0).toLocaleString()} Tadoku game log(s).`);
                return;
            }
            if (job.status === 'failed') {
                throw new Error(job.error || 'Tadoku sync failed');
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    showError(message) {
        if (this.settingsError) {
            this.settingsError.textContent = message;
            this.settingsError.style.display = 'block';
        }
        if (this.settingsSuccess) {
            this.settingsSuccess.style.display = 'none';
        }
    }
    
    showSuccess(message) {
        if (this.settingsSuccess) {
            this.settingsSuccess.textContent = message;
            this.settingsSuccess.style.display = 'block';
        }
        if (this.settingsError) {
            this.settingsError.style.display = 'none';
        }
    }

    showTadokuError(message) {
        if (!this.tadokuSettingsError) {
            this.showError(message);
            return;
        }
        this.tadokuSettingsError.textContent = message;
        this.tadokuSettingsError.style.display = 'block';
        if (this.tadokuSettingsSuccess) {
            this.tadokuSettingsSuccess.style.display = 'none';
        }
    }

    showTadokuSuccess(message) {
        if (!this.tadokuSettingsSuccess) {
            this.showSuccess(message);
            return;
        }
        this.tadokuSettingsSuccess.textContent = message;
        this.tadokuSettingsSuccess.style.display = 'block';
        if (this.tadokuSettingsError) {
            this.tadokuSettingsError.style.display = 'none';
        }
    }

    clearTadokuMessages() {
        if (this.tadokuSettingsError) {
            this.tadokuSettingsError.style.display = 'none';
        }
        if (this.tadokuSettingsSuccess) {
            this.tadokuSettingsSuccess.style.display = 'none';
        }
    }
    
    clearMessages() {
        if (this.settingsError) {
            this.settingsError.style.display = 'none';
        }
        if (this.settingsSuccess) {
            this.settingsSuccess.style.display = 'none';
        }
        this.clearTadokuMessages();
    }
}

// Utility functions
function formatLargeNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
}

function escapeHtml(unsafe) {
    return String(unsafe == null ? '' : unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeJoinArray(arr, separator = ', ') {
    /**
     * Safely join an array with proper type checking and fallbacks.
     * Handles various data types that might be returned from API responses.
     *
     * @param {*} arr - The value to join (should be an array, but handles other types)
     * @param {string} separator - The separator to use for joining
     * @returns {string} - The joined string or appropriate fallback
     */
    if (!arr) {
        return '';
    }
    
    if (Array.isArray(arr)) {
        return arr.join(separator);
    }
    
    if (typeof arr === 'string') {
        return arr;
    }
    
    // Handle other types by converting to string
    return String(arr);
}

function logApiResponse(operation, response, result) {
    /**
     * Log API response details for debugging purposes.
     *
     * @param {string} operation - The operation being performed
     * @param {Response} response - The fetch response object
     * @param {*} result - The parsed JSON result
     */
    console.group(`🔍 API Response Debug: ${operation}`);
    console.log('Response status:', response.status, response.statusText);
    console.log('Response OK:', response.ok);
    console.log('Result object:', result);
    
    // Print FULL API response as formatted JSON
    console.log('%c📋 FULL API RESPONSE (JSON):', 'color: #00ff00; font-weight: bold; font-size: 14px;');
    console.log(JSON.stringify(result, null, 2));
    
    if (result && typeof result === 'object') {
        Object.keys(result).forEach(key => {
            const value = result[key];
            console.log(`${key}:`, {
                value,
                type: typeof value,
                isArray: Array.isArray(value),
                length: Array.isArray(value) ? value.length : 'N/A'
            });
        });
    }
    console.groupEnd();
}

// Screenshot functionality
function initializeScreenshotButton() {
    const screenshotButton = document.getElementById('screenshotToggle');
    
    if (!screenshotButton) {
        return; // Screenshot button not available on this page
    }
    
    screenshotButton.addEventListener('click', exportPageToPDF);
}

// Lazy-load libraries
let html2canvasLoaded = false;
let html2canvasLoading = false;
let jsPDFLoaded = false;
let jsPDFLoading = false;

// Lazy-load html2canvas
async function loadHtml2Canvas() {
    if (html2canvasLoaded) return true;
    if (html2canvasLoading) {
        return new Promise(resolve => {
            const check = setInterval(() => {
                if (html2canvasLoaded) {
                    clearInterval(check);
                    resolve(true);
                }
            }, 100);
        });
    }

    html2canvasLoading = true;
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
        script.onload = () => {
            html2canvasLoaded = true;
            html2canvasLoading = false;
            resolve(true);
        };
        script.onerror = () => {
            html2canvasLoading = false;
            reject(new Error('Failed to load html2canvas'));
        };
        document.head.appendChild(script);
    });
}

// Lazy-load jsPDF
async function loadJsPDF() {
    if (jsPDFLoaded) return true;
    if (jsPDFLoading) {
        return new Promise(resolve => {
            const check = setInterval(() => {
                if (jsPDFLoaded) {
                    clearInterval(check);
                    resolve(true);
                }
            }, 100);
        });
    }

    jsPDFLoading = true;
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
        script.onload = () => {
            jsPDFLoaded = true;
            jsPDFLoading = false;
            resolve(true);
        };
        script.onerror = () => {
            jsPDFLoading = false;
            reject(new Error('Failed to load jsPDF'));
        };
        document.head.appendChild(script);
    });
}

// Capture page and export as PDF
async function exportPageToPDF() {
    try {
        console.log('Starting PDF export...');
        
        // Load libraries
        if (typeof html2canvas === 'undefined') {
            console.log('Loading html2canvas...');
            await loadHtml2Canvas();
        }
        if (typeof window.jspdf === 'undefined') {
            console.log('Loading jsPDF...');
            await loadJsPDF();
        }

        const { jsPDF } = window.jspdf;

        // Create timestamped filename
        const now = new Date();
        const timestamp =
            now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0') + '_' +
            String(now.getHours()).padStart(2, '0') + '-' +
            String(now.getMinutes()).padStart(2, '0') + '-' +
            String(now.getSeconds()).padStart(2, '0');
        const filename = `GSM_STATS_${timestamp}.pdf`;

        console.log('Capturing page screenshot...');
        // Take a screenshot of the full page with high quality for sharp text
        const canvas = await html2canvas(document.body, {
            useCORS: true,
            allowTaint: true,
            scale: 2.5,  // Higher scale for sharper text (2.5x resolution)
            scrollX: 0,
            scrollY: 0,
            width: document.body.scrollWidth,
            height: document.body.scrollHeight,
            logging: false,
            imageTimeout: 0,
            removeContainer: true
        });

        console.log('Converting to image...');
        // Use JPEG with high quality for better file size vs quality balance
        const imgData = canvas.toDataURL('image/jpeg', 0.80);

        console.log('Creating PDF...');
        // PDF setup (A4)
        const pdf = new jsPDF('p', 'pt', 'a4');
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();

        const imgWidth = pageWidth;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;

        let heightLeft = imgHeight;
        let position = 0;

        // Add first page with SLOW compression for better quality
        pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight, undefined, 'SLOW');
        heightLeft -= pageHeight;

        // Add more pages if needed
        while (heightLeft > 0) {
            position = heightLeft - imgHeight;
            pdf.addPage();
            pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight, undefined, 'SLOW');
            heightLeft -= pageHeight;
        }

        console.log('Saving PDF...');
        // Download
        pdf.save(filename);
        console.log('PDF export complete!');

    } catch (error) {
        console.error('PDF export failed:', error);
        alert('Failed to export PDF: ' + error.message);
    }
}


// ================================
// Time Format Utilities
// ================================

// Default to raw hours (true = show "1500h", false = show "2d 3h")
window.globalUseRawHours = true;

window.formatTimeHuman = function(hours) {
    if (!hours || hours <= 0) return '0h';
    if (hours < 1) {
        const minutes = Math.round(hours * 60);
        return minutes + 'm';
    } else if (hours < 24) {
        const wholeHours = Math.floor(hours);
        const minutes = Math.round((hours - wholeHours) * 60);
        return minutes > 0 ? wholeHours + 'h ' + minutes + 'm' : wholeHours + 'h';
    } else {
        const days = Math.floor(hours / 24);
        const remainingHours = Math.floor(hours % 24);
        return remainingHours > 0 ? days + 'd ' + remainingHours + 'h' : days + 'd';
    }
};

window.formatTimeRaw = function(hours) {
    if (!hours || hours <= 0) return '0h';
    if (hours < 1) {
        const minutes = Math.round(hours * 60);
        return minutes > 0 ? minutes + 'm' : '<1m';
    }
    const roundedHours = Math.round(hours * 10) / 10;
    return roundedHours.toString() + 'h';
};

window.formatTime = function(hours) {
    return window.globalUseRawHours ? window.formatTimeRaw(hours) : window.formatTimeHuman(hours);
};

function updateTimeFormatCheckbox(useRawHours) {
    const checkbox = document.getElementById('useRawHoursToggle');
    if (!checkbox) return;
    checkbox.checked = useRawHours;
    const label = document.getElementById('timeFormatLabel');
    if (label) {
        label.textContent = useRawHours ? 'Use raw hours (e.g. 2.5h)' : 'Use human-readable (e.g. 2h 30m)';
    }
}

async function initializeTimeFormatToggle() {
    // Load preference from server
    try {
        const response = await fetch('/api/goals/current');
        if (response.ok) {
            const data = await response.json();
            const pref = data.goals_settings?.useRawHours;
            // Default to true (raw hours) if not set
            window.globalUseRawHours = pref === undefined || pref === null ? true : pref;
        }
    } catch (e) {
        console.warn('Could not load time format preference, defaulting to raw hours:', e);
        window.globalUseRawHours = true;
    }

    updateTimeFormatCheckbox(window.globalUseRawHours);

    if (!window.skipInitialTimeDisplayRefresh) {
        // Re-render page time displays with loaded preference.
        // Page-specific JS registers window.refreshTimeDisplays in its own DOMContentLoaded
        // handler which may not have run yet when this async fetch resolves, so retry for a
        // short window using requestAnimationFrame before giving up.
        (function tryRefresh(attempts) {
            if (typeof window.refreshTimeDisplays === 'function') {
                window.refreshTimeDisplays();
            } else if (attempts > 0) {
                requestAnimationFrame(function() { tryRefresh(attempts - 1); });
            }
        })(30); // ~30 frames ≈ 500 ms at 60 fps — more than enough for page JS to register
    }

    // Wire up the checkbox
    const checkbox = document.getElementById('useRawHoursToggle');
    if (!checkbox) return;
    checkbox.addEventListener('change', async function() {
        window.globalUseRawHours = checkbox.checked;
        updateTimeFormatCheckbox(window.globalUseRawHours);

        // Refresh all time displays on the page
        if (typeof window.refreshTimeDisplays === 'function') {
            window.refreshTimeDisplays();
        }

        // Persist preference to server
        try {
            await fetch('/api/goals/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ partial_settings: { useRawHours: window.globalUseRawHours } })
            });
        } catch (e) {
            console.warn('Could not save time format preference:', e);
        }
    });
}

// Initialize shared functionality when DOM loads
document.addEventListener('DOMContentLoaded', function() {
    // Initialize theme toggle
    initializeThemeToggle();
    
    // Initialize modal handlers
    initializeModalHandlers();
    
    // Initialize screenshot button
    initializeScreenshotButton();
    
    // Initialize settings manager if settings toggle exists and we're not on the goals page
    // Goals page has its own settings handling
    if (document.getElementById('settingsToggle') && !window.location.pathname.includes('/goals')) {
        new SettingsManager();
    }

    // Initialize time format toggle (async - loads preference from server)
    initializeTimeFormatToggle();
});
