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

// Settings Modal Functionality (for pages that need it)
class SettingsManager {
    constructor() {
        this.initializeElements();
        this.attachEventListeners();
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
        this.afkTimerInput = document.getElementById('afkTimer');
        this.sessionGapInput = document.getElementById('sessionGap');
        this.streakRequirementInput = document.getElementById('streakRequirement');
        this.readingHoursTargetInput = document.getElementById('readingHoursTarget');
        this.characterCountTargetInput = document.getElementById('characterCountTarget');
        this.gamesTargetInput = document.getElementById('gamesTarget');
        this.readingHoursTargetDateInput = document.getElementById('readingHoursTargetDate');
        this.characterCountTargetDateInput = document.getElementById('characterCountTargetDate');
        this.gamesTargetDateInput = document.getElementById('gamesTargetDate');
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
        
        // // Close modal when clicking outside
        // if (this.settingsModal) {
        //     this.settingsModal.addEventListener('click', (e) => {
        //         if (e.target === this.settingsModal) {
        //             this.closeModal();
        //         }
        //     });
        // }
        
        // Clear messages when user starts typing
        [this.afkTimerInput, this.sessionGapInput, this.streakRequirementInput,
         this.readingHoursTargetInput, this.characterCountTargetInput, this.gamesTargetInput]
            .filter(Boolean)
            .forEach(input => {
                input.addEventListener('input', () => this.clearMessages());
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
        
        if (this.afkTimerInput) {
            this.afkTimerInput.value = settings.afk_timer_seconds;
        }
        if (this.sessionGapInput) {
            this.sessionGapInput.value = settings.session_gap_seconds;
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
    }
    
    async refreshHeatmapData(selectedYear) {
        try {
            if (typeof loadStatsData === 'function') {
                await loadStatsData(start_timestamp = null, end_timestamp = null);
            }
        } catch (error) {
            console.error('Error refreshing heatmap data:', error);
        }
    }
    
    async saveSettings() {
        try {
            this.clearMessages();
            
            const settings = {};
            
            if (this.afkTimerInput) {
                const afkTimer = parseInt(this.afkTimerInput.value);
                if (isNaN(afkTimer) || afkTimer < 0 || afkTimer > 600) {
                    this.showError('AFK timer must be between 0 and 600 seconds');
                    return;
                }
                settings.afk_timer_seconds = afkTimer;
            }
            
            if (this.sessionGapInput) {
                const sessionGap = parseInt(this.sessionGapInput.value);
                if (isNaN(sessionGap) || sessionGap < 0 || sessionGap > 7200) {
                    this.showError('Session gap must be between 0 and 7200 seconds (0 to 2 hours)');
                    return;
                }
                settings.session_gap_seconds = sessionGap;
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
            
            this.showSuccess('Settings saved successfully! Changes will apply to new calculations.');
            
            // Dispatch event to notify other components that settings were updated
            window.dispatchEvent(new CustomEvent('settingsUpdated'));
            
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
    
    clearMessages() {
        if (this.settingsError) {
            this.settingsError.style.display = 'none';
        }
        if (this.settingsSuccess) {
            this.settingsSuccess.style.display = 'none';
        }
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
    return unsafe
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
    
    screenshotButton.addEventListener('click', takeScreenshot);
}

async function takeScreenshot() {
    try {
        // Check if html2canvas is available
        if (typeof html2canvas === 'undefined') {
            console.error('html2canvas library not loaded');
            return;
        }
        
        // Generate timestamp for filename
        const now = new Date();
        const timestamp = now.getFullYear() + '-' +
                         String(now.getMonth() + 1).padStart(2, '0') + '-' +
                         String(now.getDate()).padStart(2, '0') + '_' +
                         String(now.getHours()).padStart(2, '0') + '-' +
                         String(now.getMinutes()).padStart(2, '0') + '-' +
                         String(now.getSeconds()).padStart(2, '0');
        
        const filename = `screenshot_${timestamp}.png`;
        
        // Capture the entire page
        const canvas = await html2canvas(document.body, {
            useCORS: true,
            allowTaint: true,
            scale: 1,
            scrollX: 0,
            scrollY: 0,
            width: document.body.scrollWidth,
            height: document.body.scrollHeight
        });
        
        // Convert canvas to blob
        canvas.toBlob(function(blob) {
            // Create download link
            const link = document.createElement('a');
            link.download = filename;
            link.href = URL.createObjectURL(blob);
            
            // Trigger download
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            // Clean up the URL object after a short delay to avoid race condition
            setTimeout(function() {
                URL.revokeObjectURL(link.href);
            }, 100);
        }, 'image/png');
        
    } catch (error) {
        console.error('Screenshot failed:', error);
    }
}

// Initialize shared functionality when DOM loads
document.addEventListener('DOMContentLoaded', function() {
    // Initialize theme toggle
    initializeThemeToggle();
    
    // Initialize modal handlers
    initializeModalHandlers();
    
    // Initialize screenshot button
    initializeScreenshotButton();
    
    // Initialize settings manager if settings toggle exists
    if (document.getElementById('settingsToggle')) {
        new SettingsManager();
    }
});