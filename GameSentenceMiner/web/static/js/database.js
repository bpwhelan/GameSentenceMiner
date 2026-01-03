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