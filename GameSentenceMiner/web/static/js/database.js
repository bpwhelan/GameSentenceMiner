// Database Management JavaScript - Main Entry Point
// Dependencies: All database modules must be loaded before this file

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
        await this.loadDashboardStats();
        this.attachEventHandlers();
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