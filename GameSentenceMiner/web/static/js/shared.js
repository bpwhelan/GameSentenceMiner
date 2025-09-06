// Shared JavaScript functionality across all pages

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
        this.heatmapYearSelect = document.getElementById('heatmapYear');
        this.streakRequirementInput = document.getElementById('streakRequirement');
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
        
        // Close modal when clicking outside
        if (this.settingsModal) {
            this.settingsModal.addEventListener('click', (e) => {
                if (e.target === this.settingsModal) {
                    this.closeModal();
                }
            });
        }
        
        // Clear messages when user starts typing
        [this.afkTimerInput, this.sessionGapInput, this.heatmapYearSelect, this.streakRequirementInput]
            .filter(Boolean)
            .forEach(input => {
                input.addEventListener('input', () => this.clearMessages());
            });
        
        // Handle year selection change
        if (this.heatmapYearSelect) {
            this.heatmapYearSelect.addEventListener('change', (e) => {
                const selectedYear = e.target.value;
                localStorage.setItem('selectedHeatmapYear', selectedYear);
                this.refreshHeatmapData(selectedYear);
            });
        }
    }
    
    async openModal() {
        try {
            await this.loadCurrentSettings();
            await this.loadAvailableYears();
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
        
        // Load saved year preference
        const savedYear = localStorage.getItem('selectedHeatmapYear') || 'all';
        if (this.heatmapYearSelect) {
            this.heatmapYearSelect.value = savedYear;
        }
    }
    
    async loadAvailableYears() {
        if (!this.heatmapYearSelect) return;
        
        try {
            const response = await fetch('/api/stats');
            if (!response.ok) throw new Error('Failed to fetch stats');
            
            const data = await response.json();
            const availableYears = Object.keys(data.heatmapData || {}).sort().reverse();
            
            // Clear existing options except "All Years"
            this.heatmapYearSelect.innerHTML = '<option value="all">All Years</option>';
            
            // Add available years
            availableYears.forEach(year => {
                const option = document.createElement('option');
                option.value = year;
                option.textContent = year;
                this.heatmapYearSelect.appendChild(option);
            });
            
            // Restore saved selection
            const savedYear = localStorage.getItem('selectedHeatmapYear') || 'all';
            this.heatmapYearSelect.value = savedYear;
            
        } catch (error) {
            console.error('Error loading available years:', error);
        }
    }
    
    async refreshHeatmapData(selectedYear) {
        try {
            if (typeof loadStatsData === 'function') {
                await loadStatsData(selectedYear);
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
                if (isNaN(afkTimer) || afkTimer < 30 || afkTimer > 600) {
                    this.showError('AFK timer must be between 30 and 600 seconds');
                    return;
                }
                settings.afk_timer_seconds = afkTimer;
            }
            
            if (this.sessionGapInput) {
                const sessionGap = parseInt(this.sessionGapInput.value);
                if (isNaN(sessionGap) || sessionGap < 300 || sessionGap > 7200) {
                    this.showError('Session gap must be between 300 and 7200 seconds');
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

// Initialize shared functionality when DOM loads
document.addEventListener('DOMContentLoaded', function() {
    // Initialize theme toggle
    initializeThemeToggle();
    
    // Initialize settings manager if settings toggle exists
    if (document.getElementById('settingsToggle')) {
        new SettingsManager();
    }
});

// Export for module use if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initializeThemeToggle,
        SettingsManager,
        formatLargeNumber,
        escapeHtml,
        escapeRegex
    };
}