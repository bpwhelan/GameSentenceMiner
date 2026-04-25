// Database Management JavaScript - Main Entry Point
// Dependencies: All database modules must be loaded before this file

// localStorage key for Yomitan dictionary game count
const YOMITAN_GAME_COUNT_KEY = 'yomitanDictGameCount';
const YOMITAN_GAME_COUNT_DEFAULT = 3;

// localStorage key for Yomitan dictionary spoiler level
const YOMITAN_SPOILER_LEVEL_KEY = 'yomitanDictSpoilerLevel';
const YOMITAN_SPOILER_LEVEL_DEFAULT = 0;

/**
 * Lightweight DatabaseManager class that orchestrates all database modules
 */
class DatabaseManager {
    constructor() {
        this.selectedGames = new Set();
        this.mergeTargetGame = null; // Track the first game selected for merge operations
        this.statsExportFormats = [];
        this.statsExportPollTimer = null;
        this.activeStatsExportJobId = null;
        this.initializePage();
    }
    
    /**
     * Initialize the database management page
     */
    async initializePage() {
        // Attach event handlers synchronously FIRST so buttons work immediately
        this.attachEventHandlers();
        this.initializeYomitanGameCount();
        this.initializeYomitanSpoilerLevel();
        this.initializeStatsExportDateDefaults();
        await this.loadStatsExportFormats();
        
        // Then load async data (dashboard stats)
        await this.loadDashboardStats();
    }
    
    /**
     * Initialize Yomitan game count from localStorage
     */
    initializeYomitanGameCount() {
        const gameCountInput = document.getElementById('yomitanGameCount');
        if (!gameCountInput) return;
        
        // Load saved value from localStorage
        const savedValue = localStorage.getItem(YOMITAN_GAME_COUNT_KEY);
        if (savedValue !== null) {
            const parsedValue = parseInt(savedValue, 10);
            if (!isNaN(parsedValue) && parsedValue >= 1 && parsedValue <= 999) {
                gameCountInput.value = parsedValue;
            }
        }
        
        // Save to localStorage on change
        gameCountInput.addEventListener('change', () => {
            let value = parseInt(gameCountInput.value, 10);
            
            // Clamp to valid range
            if (isNaN(value) || value < 1) value = 1;
            if (value > 999) value = 999;
            
            gameCountInput.value = value;
            localStorage.setItem(YOMITAN_GAME_COUNT_KEY, value.toString());
        });
        
        // Also handle input event for immediate feedback
        gameCountInput.addEventListener('input', () => {
            let value = parseInt(gameCountInput.value, 10);
            if (!isNaN(value) && value >= 1 && value <= 999) {
                localStorage.setItem(YOMITAN_GAME_COUNT_KEY, value.toString());
            }
        });
    }
    
    /**
     * Initialize Yomitan spoiler level from localStorage
     */
    initializeYomitanSpoilerLevel() {
        const spoilerLevelSelect = document.getElementById('yomitanSpoilerLevel');
        if (!spoilerLevelSelect) return;
        
        // Load saved value from localStorage
        const savedValue = localStorage.getItem(YOMITAN_SPOILER_LEVEL_KEY);
        if (savedValue !== null) {
            const parsedValue = parseInt(savedValue, 10);
            if (!isNaN(parsedValue) && parsedValue >= 0 && parsedValue <= 2) {
                spoilerLevelSelect.value = parsedValue;
            }
        }
        
        // Save to localStorage on change
        spoilerLevelSelect.addEventListener('change', () => {
            let value = parseInt(spoilerLevelSelect.value, 10);
            
            // Clamp to valid range
            if (isNaN(value) || value < 0) value = 0;
            if (value > 2) value = 2;
            
            spoilerLevelSelect.value = value;
            localStorage.setItem(YOMITAN_SPOILER_LEVEL_KEY, value.toString());
        });
        
        // Also handle input event for immediate feedback
        spoilerLevelSelect.addEventListener('input', () => {
            let value = parseInt(spoilerLevelSelect.value, 10);
            if (!isNaN(value) && value >= 0 && value <= 2) {
                localStorage.setItem(YOMITAN_SPOILER_LEVEL_KEY, value.toString());
            }
        });
    }
    
    /**
     * Attach event handlers for all database functionality
     */
    attachEventHandlers() {
        // Modal close handlers
        const closeButtons = document.querySelectorAll('[data-action="closeModal"]');
        closeButtons.forEach(btn => {
            const modalId = btn.getAttribute('data-modal');
            if (modalId) {
                btn.addEventListener('click', () => closeModal(modalId));
            }
        });
        
        // Yomitan dictionary download handler
        const downloadBtn = document.querySelector('[data-action="downloadYomitanDict"]');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', () => this.downloadYomitanDict());
        }

        // Frequency dictionary download handler
        const freqDictBtn = document.querySelector('[data-action="downloadFreqDict"]');
        if (freqDictBtn) {
            freqDictBtn.addEventListener('click', () => this.downloadFreqDict());
        }

        // Check tokenization status for frequency dict card
        this.checkFreqDictAvailability();

        // Initialize all module event handlers
        if (typeof initializeTabHandlers === 'function') {
            initializeTabHandlers();
        }
        
        if (typeof initializeGameDataFilters === 'function') {
            initializeGameDataFilters();
        }
        
        if (typeof initializeBulkOperations === 'function') {
            initializeBulkOperations();
        }
        
        if (typeof initializeTextManagement === 'function') {
            initializeTextManagement();
        }
        
        if (typeof initializeJitenIntegration === 'function') {
            initializeJitenIntegration();
        }
        
        if (typeof initializeGameOperations === 'function') {
            initializeGameOperations();
        }
        
        if (typeof initializeDatabasePopups === 'function') {
            initializeDatabasePopups();
        }

        const statsExportScope = document.getElementById('statsExportScope');
        if (statsExportScope) {
            statsExportScope.addEventListener('change', () => this.updateStatsExportScopeVisibility());
        }

        const statsExportFormat = document.getElementById('statsExportFormat');
        if (statsExportFormat) {
            statsExportFormat.addEventListener('change', () => this.updateStatsExportFormatDescription());
        }

        const statsExportBtn = document.getElementById('startStatsExportBtn');
        if (statsExportBtn) {
            statsExportBtn.addEventListener('click', () => this.startStatsExport());
        }
    }

    initializeStatsExportDateDefaults() {
        const today = new Date().toISOString().split('T')[0];
        const startDateInput = document.getElementById('statsExportStartDate');
        const endDateInput = document.getElementById('statsExportEndDate');

        if (startDateInput && !startDateInput.value) {
            startDateInput.value = today;
        }
        if (endDateInput && !endDateInput.value) {
            endDateInput.value = today;
        }

        this.updateStatsExportScopeVisibility();
    }

    async loadStatsExportFormats() {
        const formatSelect = document.getElementById('statsExportFormat');
        const startButton = document.getElementById('startStatsExportBtn');
        if (!formatSelect || !startButton) {
            return;
        }

        try {
            const response = await fetch('/api/stats-export/formats');
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to load export formats');
            }

            this.statsExportFormats = Array.isArray(data.formats) ? data.formats : [];
            formatSelect.innerHTML = '';

            if (this.statsExportFormats.length === 0) {
                formatSelect.innerHTML = '<option value="">No export formats available</option>';
                startButton.disabled = true;
                return;
            }

            this.statsExportFormats.forEach((format, index) => {
                const option = document.createElement('option');
                option.value = format.id;
                option.textContent = format.label;
                if (index === 0) {
                    option.selected = true;
                }
                formatSelect.appendChild(option);
            });

            startButton.disabled = false;
            this.updateStatsExportFormatDescription();
        } catch (error) {
            console.error('Error loading stats export formats:', error);
            formatSelect.innerHTML = '<option value="">Failed to load formats</option>';
            startButton.disabled = true;
            this.setStatsExportStatus('error', 'Failed to load export formats. Refresh the page and try again.');
        }
    }

    updateStatsExportScopeVisibility() {
        const scopeSelect = document.getElementById('statsExportScope');
        const customRangeContainer = document.getElementById('statsExportCustomRange');
        if (!scopeSelect || !customRangeContainer) {
            return;
        }

        customRangeContainer.style.display = !scopeSelect.disabled && scopeSelect.value === 'custom' ? 'flex' : 'none';
    }

    updateStatsExportFormatDescription() {
        const formatSelect = document.getElementById('statsExportFormat');
        const descriptionElement = document.getElementById('statsExportFormatDescription');
        if (!formatSelect || !descriptionElement) {
            return;
        }

        const selectedFormat = this.statsExportFormats.find(format => format.id === formatSelect.value);
        if (selectedFormat && selectedFormat.description) {
            descriptionElement.textContent = selectedFormat.description;
            descriptionElement.style.display = 'block';
        } else {
            descriptionElement.style.display = 'none';
            descriptionElement.textContent = '';
        }

        this.updateStatsExportOptionVisibility(selectedFormat);
    }

    updateStatsExportOptionVisibility(selectedFormat = null) {
        const activeFormat = selectedFormat || this.statsExportFormats.find(format => format.id === document.getElementById('statsExportFormat')?.value);
        const scopeSelect = document.getElementById('statsExportScope');
        const startDateInput = document.getElementById('statsExportStartDate');
        const endDateInput = document.getElementById('statsExportEndDate');
        const includeExternalRow = document.getElementById('statsExportIncludeExternalRow');
        const includeExternalCheckbox = document.getElementById('statsExportIncludeExternal');
        const supportsDateRange = activeFormat ? activeFormat.supports_date_range !== false : true;
        const supportsExternalStats = activeFormat ? activeFormat.supports_external_stats !== false : true;

        if (scopeSelect) {
            scopeSelect.disabled = !supportsDateRange;
            if (!supportsDateRange) {
                scopeSelect.value = 'all_time';
            }
        }
        if (startDateInput) {
            startDateInput.disabled = !supportsDateRange;
        }
        if (endDateInput) {
            endDateInput.disabled = !supportsDateRange;
        }

        if (includeExternalRow) {
            includeExternalRow.style.display = supportsExternalStats ? 'flex' : 'none';
        }
        if (includeExternalCheckbox) {
            includeExternalCheckbox.disabled = !supportsExternalStats;
            if (!supportsExternalStats) {
                includeExternalCheckbox.checked = false;
            }
        }

        this.updateStatsExportScopeVisibility();
    }

    setStatsExportRunningState(isRunning) {
        const startButton = document.getElementById('startStatsExportBtn');
        const formatSelect = document.getElementById('statsExportFormat');
        const scopeSelect = document.getElementById('statsExportScope');
        const startDateInput = document.getElementById('statsExportStartDate');
        const endDateInput = document.getElementById('statsExportEndDate');
        const includeExternalCheckbox = document.getElementById('statsExportIncludeExternal');

        if (startButton) {
            startButton.disabled = isRunning || this.statsExportFormats.length === 0;
            startButton.textContent = isRunning ? 'Exporting...' : 'Start Export';
        }
        if (formatSelect) formatSelect.disabled = isRunning;
        if (scopeSelect) scopeSelect.disabled = isRunning;
        if (startDateInput) startDateInput.disabled = isRunning;
        if (endDateInput) endDateInput.disabled = isRunning;
        if (includeExternalCheckbox) includeExternalCheckbox.disabled = isRunning;

        if (!isRunning) {
            this.updateStatsExportOptionVisibility();
        }
    }

    setStatsExportProgress(progress, message) {
        const progressContainer = document.getElementById('statsExportProgress');
        const progressBar = document.getElementById('statsExportProgressBar');
        const progressText = document.getElementById('statsExportProgressText');

        if (!progressContainer || !progressBar || !progressText) {
            return;
        }

        progressContainer.style.display = 'block';
        progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
        progressText.textContent = `${Math.max(0, Math.min(100, progress))}%`;

        if (message) {
            this.setStatsExportStatus('info', message);
        }
    }

    setStatsExportStatus(type, message) {
        const statusElement = document.getElementById('statsExportStatus');
        if (!statusElement) {
            return;
        }

        if (!message) {
            statusElement.style.display = 'none';
            statusElement.textContent = '';
            statusElement.style.background = '';
            statusElement.style.color = '';
            statusElement.style.borderLeft = '';
            return;
        }

        const palette = {
            info: {
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                border: '4px solid var(--primary-color)'
            },
            success: {
                background: 'rgba(34, 197, 94, 0.12)',
                color: 'var(--success-color)',
                border: '4px solid var(--success-color)'
            },
            error: {
                background: 'rgba(239, 68, 68, 0.12)',
                color: 'var(--danger-color)',
                border: '4px solid var(--danger-color)'
            }
        };

        const selectedPalette = palette[type] || palette.info;
        statusElement.style.display = 'block';
        statusElement.textContent = message;
        statusElement.style.background = selectedPalette.background;
        statusElement.style.color = selectedPalette.color;
        statusElement.style.borderLeft = selectedPalette.border;
    }

    clearStatsExportPollTimer() {
        if (this.statsExportPollTimer) {
            clearTimeout(this.statsExportPollTimer);
            this.statsExportPollTimer = null;
        }
    }

    async startStatsExport() {
        const formatSelect = document.getElementById('statsExportFormat');
        const scopeSelect = document.getElementById('statsExportScope');
        const startDateInput = document.getElementById('statsExportStartDate');
        const endDateInput = document.getElementById('statsExportEndDate');
        const includeExternalCheckbox = document.getElementById('statsExportIncludeExternal');

        if (!formatSelect || !scopeSelect) {
            return;
        }

        const selectedFormat = this.statsExportFormats.find(format => format.id === formatSelect.value);
        const supportsDateRange = selectedFormat ? selectedFormat.supports_date_range !== false : true;
        const supportsExternalStats = selectedFormat ? selectedFormat.supports_external_stats !== false : true;
        const payload = {
            format: formatSelect.value,
            scope: supportsDateRange ? scopeSelect.value : 'all_time',
            include_external_stats: supportsExternalStats && includeExternalCheckbox ? includeExternalCheckbox.checked : false
        };

        if (!payload.format) {
            showDatabaseErrorPopup('Select an export format first.');
            return;
        }

        if (payload.scope === 'custom') {
            payload.start_date = startDateInput ? startDateInput.value : '';
            payload.end_date = endDateInput ? endDateInput.value : '';

            if (!payload.start_date || !payload.end_date) {
                showDatabaseErrorPopup('Choose both a start date and end date for a custom export.');
                return;
            }
        }

        this.clearStatsExportPollTimer();
        this.activeStatsExportJobId = null;
        this.setStatsExportRunningState(true);
        this.setStatsExportProgress(0, 'Queuing export job...');

        try {
            const response = await fetch('/api/stats-export/jobs', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to start export');
            }

            this.activeStatsExportJobId = data.job_id;
            await this.handleStatsExportStatus(data);
        } catch (error) {
            console.error('Error starting stats export:', error);
            this.setStatsExportRunningState(false);
            this.setStatsExportStatus('error', error.message || 'Failed to start export.');
            showDatabaseErrorPopup(error.message || 'Failed to start export.');
        }
    }

    async pollStatsExportStatus(jobId) {
        this.clearStatsExportPollTimer();

        this.statsExportPollTimer = setTimeout(async () => {
            try {
                const response = await fetch(`/api/stats-export/jobs/${encodeURIComponent(jobId)}`);
                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Failed to fetch export status');
                }

                await this.handleStatsExportStatus(data);
            } catch (error) {
                console.error('Error polling stats export status:', error);
                this.setStatsExportRunningState(false);
                this.setStatsExportStatus('error', error.message || 'Failed to fetch export progress.');
            }
        }, 1000);
    }

    async handleStatsExportStatus(data) {
        const progress = Number.isFinite(data.progress) ? data.progress : 0;
        const message = data.error || data.message || 'Export in progress...';
        this.setStatsExportProgress(progress, message);

        if (data.status === 'queued' || data.status === 'running') {
            this.setStatsExportRunningState(true);
            if (data.job_id) {
                await this.pollStatsExportStatus(data.job_id);
            }
            return;
        }

        this.clearStatsExportPollTimer();
        this.setStatsExportRunningState(false);

        if (data.status === 'completed' && data.download_url) {
            const completionMessage = data.message || 'Export complete.';
            this.setStatsExportStatus(
                'success',
                data.row_count
                    ? `${completionMessage} Downloading ${data.row_count.toLocaleString()} rows...`
                    : `${completionMessage} Downloading file...`
            );

            try {
                await this.downloadStatsExportFile(data.download_url, data.filename);
                showDatabaseSuccessPopup('Stats export downloaded successfully.');
            } catch (error) {
                console.error('Error downloading stats export:', error);
                this.setStatsExportStatus('error', error.message || 'Export finished, but the download failed.');
                showDatabaseErrorPopup(error.message || 'Export finished, but the download failed.');
            }
            return;
        }

        const errorMessage = data.error || 'Stats export failed.';
        this.setStatsExportStatus('error', errorMessage);
        showDatabaseErrorPopup(errorMessage);
    }

    extractFilenameFromDisposition(contentDisposition, fallbackName) {
        if (!contentDisposition) {
            return fallbackName || 'gsm_stats_export.csv';
        }

        const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
        if (utf8Match && utf8Match[1]) {
            return decodeURIComponent(utf8Match[1]);
        }

        const plainMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
        if (plainMatch && plainMatch[1]) {
            return plainMatch[1];
        }

        return fallbackName || 'gsm_stats_export.csv';
    }

    async downloadStatsExportFile(downloadUrl, fallbackFilename) {
        const response = await fetch(downloadUrl);
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to download export file.');
        }

        const blob = await response.blob();
        const contentDisposition = response.headers.get('Content-Disposition');
        const filename = this.extractFilenameFromDisposition(contentDisposition, fallbackFilename);
        const url = window.URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.style.display = 'none';
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(anchor);
    }
    
    /**
     * Load dashboard statistics
     */
    async loadDashboardStats() {
        try {
            // Load general stats
            const response = await fetch('/api/games-list');
            const data = await response.json();
            
            if (response.ok && data.games) {
                const totalGames = data.games.length;
                const totalSentences = data.games.reduce((sum, game) => sum + game.sentence_count, 0);
                const totalCharacters = data.games.reduce((sum, game) => sum + game.total_characters, 0);
                
                document.getElementById('totalGamesCount').textContent = totalGames.toLocaleString();
                document.getElementById('totalSentencesCount').textContent = totalSentences.toLocaleString();
                document.getElementById('totalCharactersCount').textContent = totalCharacters.toLocaleString();
            }
            
            // Load game management stats
            await this.loadGameManagementStats();
        } catch (error) {
            console.error('Error loading dashboard stats:', error);
            document.getElementById('totalGamesCount').textContent = 'Error';
            document.getElementById('totalSentencesCount').textContent = 'Error';
        }
    }

    /**
     * Load game management statistics
     */
    async loadGameManagementStats() {
        try {
            const gamesResponse = await fetch('/api/games-management');
            const gamesData = await gamesResponse.json();
            
            if (gamesResponse.ok && gamesData.summary) {
                const linkedElement = document.getElementById('linkedGamesCount');
                const unlinkedElement = document.getElementById('unlinkedGamesCount');
                
                if (linkedElement) {
                    linkedElement.textContent = gamesData.summary.linked_games.toLocaleString();
                }
                if (unlinkedElement) {
                    unlinkedElement.textContent = gamesData.summary.unlinked_games.toLocaleString();
                }
            }
        } catch (error) {
            console.error('Error loading game management stats:', error);
            const linkedElement = document.getElementById('linkedGamesCount');
            const unlinkedElement = document.getElementById('unlinkedGamesCount');
            if (linkedElement) linkedElement.textContent = 'Error';
            if (unlinkedElement) unlinkedElement.textContent = 'Error';
        }
    }
    
    /**
     * Download Yomitan dictionary with proper error handling
     */
    async downloadYomitanDict() {
        try {
            // Get game count from input or localStorage
            const gameCountInput = document.getElementById('yomitanGameCount');
            let gameCount = YOMITAN_GAME_COUNT_DEFAULT;
            
            if (gameCountInput) {
                gameCount = parseInt(gameCountInput.value, 10);
            } else {
                const savedValue = localStorage.getItem(YOMITAN_GAME_COUNT_KEY);
                if (savedValue !== null) {
                    gameCount = parseInt(savedValue, 10);
                }
            }
            
            // Validate and clamp game count
            if (isNaN(gameCount) || gameCount < 1) gameCount = 1;
            if (gameCount > 999) gameCount = 999;
            
            // Get spoiler level from input or localStorage
            const spoilerLevelSelect = document.getElementById('yomitanSpoilerLevel');
            let spoilerLevel = YOMITAN_SPOILER_LEVEL_DEFAULT;
            
            if (spoilerLevelSelect) {
                spoilerLevel = parseInt(spoilerLevelSelect.value, 10);
            } else {
                const savedSpoilerValue = localStorage.getItem(YOMITAN_SPOILER_LEVEL_KEY);
                if (savedSpoilerValue !== null) {
                    spoilerLevel = parseInt(savedSpoilerValue, 10);
                }
            }
            
            // Validate and clamp spoiler level
            if (isNaN(spoilerLevel) || spoilerLevel < 0) spoilerLevel = 0;
            if (spoilerLevel > 2) spoilerLevel = 2;
            
            const response = await fetch(`/api/yomitan-dict?game_count=${gameCount}&spoiler_level=${spoilerLevel}`);
            
            if (!response.ok) {
                // Handle error response
                const errorData = await response.json();
                const errorMessage = errorData.message || errorData.error || 'Failed to generate dictionary';
                const actionHint = errorData.action || '';
                
                showDatabaseErrorPopup(
                    `${errorMessage}${actionHint ? '\n\n' + actionHint : ''}`
                );
                return;
            }
            
            // Success - download the file
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = 'gsm_characters.zip';
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            
            showDatabaseSuccessPopup('Dictionary downloaded successfully! Import it into Yomitan to get started.');
        } catch (error) {
            console.error('Error downloading Yomitan dictionary:', error);
            showDatabaseErrorPopup('Failed to download dictionary. Please check your connection and try again.');
        }
    }

    async checkFreqDictAvailability() {
        try {
            const resp = await fetch('/api/tokenization/status');
            if (resp.ok) {
                const data = await resp.json();
                const warning = document.getElementById('freqDictTokenizationWarning');
                const btn = document.getElementById('downloadFreqDictBtn');
                if (!data.enabled) {
                    if (warning) warning.style.display = 'block';
                    if (btn) btn.disabled = true;
                }
            }
        } catch (e) {
            // Silently ignore — the button will still work and the API will return 404
        }
    }

    async downloadFreqDict() {
        try {
            const response = await fetch('/api/yomitan-freq-dict');
            if (!response.ok) {
                const errorData = await response.json();
                showDatabaseErrorPopup(errorData.error || 'Failed to generate frequency dictionary');
                return;
            }
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = 'gsm_frequency.zip';
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            showDatabaseSuccessPopup('Frequency dictionary downloaded! Import it into Yomitan.');
        } catch (error) {
            console.error('Error downloading frequency dictionary:', error);
            showDatabaseErrorPopup('Failed to download frequency dictionary. Please try again.');
        }
    }
}

// Global database manager instance
let databaseManager;

/**
 * Initialize database management when DOM loads
 */
document.addEventListener('DOMContentLoaded', function() {
    // Ensure all required functions are available
    const requiredFunctions = [
        'showDatabaseSuccessPopup',
        'showDatabaseErrorPopup', 
        'showDatabaseConfirmPopup',
        'formatReleaseDate',
        'switchTab',
        'loadGamesForDataManagement'
    ];
    
    const missingFunctions = requiredFunctions.filter(fn => typeof window[fn] !== 'function');
    if (missingFunctions.length > 0) {
        console.error('Missing required functions:', missingFunctions);
        console.error('Please ensure all database modules are loaded before database.js');
        return;
    }
    
    // Initialize the database manager
    databaseManager = new DatabaseManager();
    
    console.log('Database management system initialized successfully');
});
