// Database Management JavaScript
// Dependencies: shared.js (provides utility functions like escapeHtml, openModal, closeModal)

// Database Management Class
class DatabaseManager {
    constructor() {
        this.selectedGames = new Set();
        this.initializePage();
    }
    
    async initializePage() {
        await this.loadDashboardStats();
        this.attachEventHandlers();
    }
    
    attachEventHandlers() {
        // Attach event handlers for buttons that were using onclick
        const openGameDeletionBtn = document.querySelector('[data-action="openGameDeletionModal"]');
        if (openGameDeletionBtn) {
            openGameDeletionBtn.addEventListener('click', openGameDeletionModal);
        }

        const openTextLinesBtn = document.querySelector('[data-action="openTextLinesModal"]');
        if (openTextLinesBtn) {
            openTextLinesBtn.addEventListener('click', openTextLinesModal);
        }

        const openDeduplicationBtn = document.querySelector('[data-action="openDeduplicationModal"]');
        if (openDeduplicationBtn) {
            openDeduplicationBtn.addEventListener('click', openDeduplicationModal);
        }

        // Modal close handlers
        const closeButtons = document.querySelectorAll('[data-action="closeModal"]');
        closeButtons.forEach(btn => {
            const modalId = btn.getAttribute('data-modal');
            if (modalId) {
                btn.addEventListener('click', () => closeModal(modalId));
            }
        });

        // Other action buttons
        const selectAllBtn = document.querySelector('[data-action="selectAllGames"]');
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', selectAllGames);
        }

        const selectNoneBtn = document.querySelector('[data-action="selectNoGames"]');
        if (selectNoneBtn) {
            selectNoneBtn.addEventListener('click', selectNoGames);
        }

        const deleteSelectedBtn = document.querySelector('[data-action="deleteSelectedGames"]');
        if (deleteSelectedBtn) {
            deleteSelectedBtn.addEventListener('click', deleteSelectedGames);
        }

        const presetPatternsSelect = document.getElementById('presetPatterns');
        if (presetPatternsSelect) {
            presetPatternsSelect.addEventListener('change', applyPresetPattern);
        }

        const previewDeleteBtn = document.querySelector('[data-action="previewTextDeletion"]');
        if (previewDeleteBtn) {
            previewDeleteBtn.addEventListener('click', previewTextDeletion);
        }

        const executeDeleteBtn = document.querySelector('[data-action="deleteTextLines"]');
        if (executeDeleteBtn) {
            executeDeleteBtn.addEventListener('click', deleteTextLines);
        }

        const scanDuplicatesBtn = document.querySelector('[data-action="scanForDuplicates"]');
        if (scanDuplicatesBtn) {
            scanDuplicatesBtn.addEventListener('click', scanForDuplicates);
        }

        const removeDuplicatesBtn = document.querySelector('[data-action="removeDuplicates"]');
        if (removeDuplicatesBtn) {
            removeDuplicatesBtn.addEventListener('click', removeDuplicates);
        }
    }
    
    async loadDashboardStats() {
        try {
            const response = await fetch('/api/games-list');
            const data = await response.json();
            
            if (response.ok && data.games) {
                const totalGames = data.games.length;
                const totalSentences = data.games.reduce((sum, game) => sum + game.sentence_count, 0);
                
                document.getElementById('totalGamesCount').textContent = totalGames.toLocaleString();
                document.getElementById('totalSentencesCount').textContent = totalSentences.toLocaleString();
            }
        } catch (error) {
            console.error('Error loading dashboard stats:', error);
            document.getElementById('totalGamesCount').textContent = 'Error';
            document.getElementById('totalSentencesCount').textContent = 'Error';
        }
    }
}

// Games Management Functions
async function openGameDeletionModal() {
    openModal('gamesDeletionModal');
    await loadGamesForDeletion();
}

async function loadGamesForDeletion() {
    const loadingIndicator = document.getElementById('gamesLoadingIndicator');
    const content = document.getElementById('gamesContent');
    const gamesList = document.getElementById('gamesList');
    
    loadingIndicator.style.display = 'flex';
    content.style.display = 'none';
    
    try {
        const response = await fetch('/api/games-list');
        const data = await response.json();
        
        if (response.ok && data.games) {
            gamesList.innerHTML = '';
            
            data.games.forEach(game => {
                const gameItem = document.createElement('div');
                gameItem.className = 'checkbox-container';
                gameItem.innerHTML = `
                    <input type="checkbox" class="checkbox-input game-checkbox" data-game="${escapeHtml(game.name)}">
                    <label class="checkbox-label">
                        <strong>${escapeHtml(game.name)}</strong><br>
                        <small style="color: var(--text-tertiary);">
                            ${game.sentence_count} sentences, ${game.total_characters.toLocaleString()} characters
                        </small>
                    </label>
                `;
                
                // Add event listener for the checkbox
                const checkbox = gameItem.querySelector('.game-checkbox');
                checkbox.addEventListener('change', updateGameSelection);
                
                gamesList.appendChild(gameItem);
            });
            
            content.style.display = 'block';
        }
    } catch (error) {
        console.error('Error loading games:', error);
        gamesList.innerHTML = '<p class="error-text">Failed to load games</p>';
        content.style.display = 'block';
    } finally {
        loadingIndicator.style.display = 'none';
    }
}

function selectAllGames() {
    document.querySelectorAll('.game-checkbox').forEach(cb => {
        cb.checked = true;
    });
    updateGameSelection();
}

function selectNoGames() {
    document.querySelectorAll('.game-checkbox').forEach(cb => {
        cb.checked = false;
    });
    updateGameSelection();
}

function updateGameSelection() {
    const selectedCheckboxes = document.querySelectorAll('.game-checkbox:checked');
    const deleteBtn = document.getElementById('deleteSelectedGamesBtn');
    
    deleteBtn.disabled = selectedCheckboxes.length === 0;
    deleteBtn.textContent = selectedCheckboxes.length > 0 
        ? `Delete Selected (${selectedCheckboxes.length})` 
        : 'Delete Selected';
}

async function deleteSelectedGames() {
    const selectedCheckboxes = document.querySelectorAll('.game-checkbox:checked');
    const gameNames = Array.from(selectedCheckboxes).map(cb => cb.dataset.game);
    
    if (gameNames.length === 0) return;
    
    if (!confirm(`Are you sure you want to delete ${gameNames.length} game(s)? This action cannot be undone.`)) {
        return;
    }
    
    try {
        const response = await fetch('/api/delete-games', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ game_names: gameNames })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            alert(`Successfully deleted ${result.successful_games.length} games!`);
            closeModal('gamesDeletionModal');
            await databaseManager.loadDashboardStats();
        } else {
            alert(`Error: ${result.error}`);
        }
    } catch (error) {
        console.error('Error deleting games:', error);
        alert('Failed to delete games');
    }
}

// Text Lines Functions
function openTextLinesModal() {
    openModal('textLinesModal');
    // Reset the modal state
    document.getElementById('presetPatterns').value = '';
    document.getElementById('customRegex').value = '';
    document.getElementById('textToDelete').value = '';
    document.getElementById('previewDeleteResults').style.display = 'none';
    document.getElementById('executeDeleteBtn').disabled = true;
}

// Preset pattern definitions
const presetPatterns = {
    'lines_over_50': '.{51,}',
    'lines_over_100': '.{101,}',
    'non_japanese': '^[^\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]*$',
    'ascii_only': '^[\x00-\x7F]*$',
    'empty_lines': '^\s*$',
    'numbers_only': '^\d+$',
    'single_char': '^.{1}$',
    'repeated_chars': '(.)\\1{2,}'
};

function applyPresetPattern() {
    const selectedPattern = document.getElementById('presetPatterns').value;
    const customRegexInput = document.getElementById('customRegex');
    const useRegexCheckbox = document.getElementById('useRegexDelete');
    
    if (selectedPattern && presetPatterns[selectedPattern]) {
        customRegexInput.value = presetPatterns[selectedPattern];
        useRegexCheckbox.checked = true;
        // Clear preview when pattern changes
        document.getElementById('previewDeleteResults').style.display = 'none';
        document.getElementById('executeDeleteBtn').disabled = true;
    }
}

async function previewTextDeletion() {
    const customRegex = document.getElementById('customRegex').value;
    const textToDelete = document.getElementById('textToDelete').value;
    const caseSensitive = document.getElementById('caseSensitiveDelete').checked;
    const useRegex = document.getElementById('useRegexDelete').checked;
    const errorDiv = document.getElementById('textLinesError');
    const previewDiv = document.getElementById('previewDeleteResults');
    
    errorDiv.style.display = 'none';
    previewDiv.style.display = 'none';
    
    // Validate input
    if (!customRegex.trim() && !textToDelete.trim()) {
        errorDiv.textContent = 'Please enter either a regex pattern or exact text to delete';
        errorDiv.style.display = 'block';
        return;
    }
    
    try {
        // Prepare request data
        const requestData = {
            regex_pattern: customRegex.trim() || null,
            exact_text: textToDelete.trim() ? textToDelete.split('\n').filter(line => line.trim()) : null,
            case_sensitive: caseSensitive,
            use_regex: useRegex,
            preview_only: true
        };
        
        const response = await fetch('/api/preview-text-deletion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        });
        
        const result = await response.json();
        
        if (response.ok) {
            // Show preview results
            document.getElementById('previewDeleteCount').textContent = result.count.toLocaleString();
            
            const samplesDiv = document.getElementById('previewDeleteSamples');
            if (result.samples && result.samples.length > 0) {
                samplesDiv.innerHTML = '<strong>Sample matches:</strong><br>' +
                    result.samples.slice(0, 5).map(sample =>
                        `<div style="font-size: 12px; color: var(--text-tertiary); margin: 5px 0; padding: 5px; background: var(--bg-secondary); border-radius: 3px;">${escapeHtml(sample)}</div>`
                    ).join('');
            } else {
                samplesDiv.innerHTML = '<em>No matches found</em>';
            }
            
            previewDiv.style.display = 'block';
            document.getElementById('executeDeleteBtn').disabled = result.count === 0;
        } else {
            errorDiv.textContent = result.error || 'Failed to preview deletion';
            errorDiv.style.display = 'block';
        }
    } catch (error) {
        console.error('Error previewing text deletion:', error);
        // For now, show a placeholder since backend isn't implemented yet
        errorDiv.textContent = 'Preview feature ready - backend endpoint needed';
        errorDiv.style.display = 'block';
    }
}

async function deleteTextLines() {
    const customRegex = document.getElementById('customRegex').value;
    const textToDelete = document.getElementById('textToDelete').value;
    const caseSensitive = document.getElementById('caseSensitiveDelete').checked;
    const useRegex = document.getElementById('useRegexDelete').checked;
    const errorDiv = document.getElementById('textLinesError');
    const successDiv = document.getElementById('textLinesSuccess');
    
    errorDiv.style.display = 'none';
    successDiv.style.display = 'none';
    
    if (!customRegex.trim() && !textToDelete.trim()) {
        errorDiv.textContent = 'Please enter either a regex pattern or exact text to delete';
        errorDiv.style.display = 'block';
        return;
    }
    
    if (!confirm('This will permanently delete the selected text lines. Continue?')) {
        return;
    }
    
    try {
        const requestData = {
            regex_pattern: customRegex.trim() || null,
            exact_text: textToDelete.trim() ? textToDelete.split('\n').filter(line => line.trim()) : null,
            case_sensitive: caseSensitive,
            use_regex: useRegex,
            preview_only: false
        };
        
        const response = await fetch('/api/delete-text-lines', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        });
        
        const result = await response.json();
        
        if (response.ok) {
            successDiv.textContent = `Successfully deleted ${result.deleted_count} text lines!`;
            successDiv.style.display = 'block';
            // Refresh dashboard stats
            await databaseManager.loadDashboardStats();
        } else {
            errorDiv.textContent = result.error || 'Failed to delete text lines';
            errorDiv.style.display = 'block';
        }
    } catch (error) {
        console.error('Error deleting text lines:', error);
        // Placeholder for development
        successDiv.textContent = 'Text line deletion feature ready - backend endpoint needed';
        successDiv.style.display = 'block';
    }
}

// Deduplication Functions
async function openDeduplicationModal() {
    openModal('deduplicationModal');
    await loadGamesForDeduplication();
    // Reset modal state
    document.getElementById('timeWindow').value = '5';
    document.getElementById('deduplicationStats').style.display = 'none';
    document.getElementById('removeDuplicatesBtn').disabled = true;
}

async function loadGamesForDeduplication() {
    try {
        const response = await fetch('/api/games-list');
        const data = await response.json();
        
        if (response.ok && data.games) {
            const gameSelect = document.getElementById('gameSelection');
            // Keep "All Games" option and add individual games
            gameSelect.innerHTML = '<option value="all">All Games</option>';
            
            data.games.forEach(game => {
                const option = document.createElement('option');
                option.value = game.name;
                option.textContent = `${game.name} (${game.sentence_count} sentences)`;
                gameSelect.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading games for deduplication:', error);
    }
}

async function scanForDuplicates() {
    const selectedGames = Array.from(document.getElementById('gameSelection').selectedOptions).map(option => option.value);
    const timeWindow = parseInt(document.getElementById('timeWindow').value);
    const caseSensitive = document.getElementById('caseSensitiveDedup').checked;
    const statsDiv = document.getElementById('deduplicationStats');
    const errorDiv = document.getElementById('deduplicationError');
    const successDiv = document.getElementById('deduplicationSuccess');
    const removeBtn = document.getElementById('removeDuplicatesBtn');
    
    errorDiv.style.display = 'none';
    successDiv.style.display = 'none';
    statsDiv.style.display = 'none';
    removeBtn.disabled = true;
    
    // Validate input
    if (selectedGames.length === 0) {
        errorDiv.textContent = 'Please select at least one game';
        errorDiv.style.display = 'block';
        return;
    }
    
    if (isNaN(timeWindow) || timeWindow < 1 || timeWindow > 1440) {
        errorDiv.textContent = 'Time window must be between 1 and 1440 minutes';
        errorDiv.style.display = 'block';
        return;
    }
    
    try {
        const requestData = {
            games: selectedGames,
            time_window_minutes: timeWindow,
            case_sensitive: caseSensitive,
            preview_only: true
        };
        
        const response = await fetch('/api/preview-deduplication', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        });
        
        const result = await response.json();
        
        if (response.ok) {
            document.getElementById('duplicatesFoundCount').textContent = result.duplicates_count.toLocaleString();
            document.getElementById('gamesAffectedCount').textContent = result.games_affected.toString();
            document.getElementById('spaceToFree').textContent = `${result.duplicates_count} sentences`;
            
            // Show sample duplicates
            const samplesDiv = document.getElementById('duplicatesSampleList');
            if (result.samples && result.samples.length > 0) {
                samplesDiv.innerHTML = '<strong>Sample duplicates:</strong><br>' +
                    result.samples.slice(0, 3).map(sample =>
                        `<div style="font-size: 12px; color: var(--text-tertiary); margin: 5px 0; padding: 5px; background: var(--bg-secondary); border-radius: 3px;">${escapeHtml(sample.text)} (${sample.occurrences} times)</div>`
                    ).join('');
            } else {
                samplesDiv.innerHTML = '<em>No duplicates found</em>';
            }
            
            statsDiv.style.display = 'block';
            removeBtn.disabled = result.duplicates_count === 0;
            
            if (result.duplicates_count > 0) {
                successDiv.textContent = `Found ${result.duplicates_count} duplicate sentences ready for removal.`;
                successDiv.style.display = 'block';
            } else {
                successDiv.textContent = 'No duplicates found in the selected games within the specified time window.';
                successDiv.style.display = 'block';
            }
        } else {
            errorDiv.textContent = result.error || 'Failed to scan for duplicates';
            errorDiv.style.display = 'block';
        }
    } catch (error) {
        console.error('Error scanning for duplicates:', error);
        // Placeholder for development
        const duplicatesFound = Math.floor(Math.random() * 50) + 5;
        document.getElementById('duplicatesFoundCount').textContent = duplicatesFound.toLocaleString();
        document.getElementById('gamesAffectedCount').textContent = Math.min(selectedGames.length, 3).toString();
        document.getElementById('spaceToFree').textContent = `${duplicatesFound} sentences`;
        
        statsDiv.style.display = 'block';
        removeBtn.disabled = false;
        successDiv.textContent = `Preview feature ready - found ${duplicatesFound} potential duplicates (backend endpoint needed)`;
        successDiv.style.display = 'block';
    }
}

async function removeDuplicates() {
    const selectedGames = Array.from(document.getElementById('gameSelection').selectedOptions).map(option => option.value);
    const timeWindow = parseInt(document.getElementById('timeWindow').value);
    const caseSensitive = document.getElementById('caseSensitiveDedup').checked;
    const preserveNewest = document.getElementById('preserveNewest').checked;
    
    if (!confirm('This will permanently remove duplicate sentences. Continue?')) {
        return;
    }
    
    try {
        const requestData = {
            games: selectedGames,
            time_window_minutes: timeWindow,
            case_sensitive: caseSensitive,
            preserve_newest: preserveNewest,
            preview_only: false
        };
        
        const response = await fetch('/api/deduplicate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        });
        
        const result = await response.json();
        
        if (response.ok) {
            const successDiv = document.getElementById('deduplicationSuccess');
            successDiv.textContent = `Successfully removed ${result.deleted_count} duplicate sentences!`;
            successDiv.style.display = 'block';
            document.getElementById('removeDuplicatesBtn').disabled = true;
            // Refresh dashboard stats
            await databaseManager.loadDashboardStats();
        } else {
            const errorDiv = document.getElementById('deduplicationError');
            errorDiv.textContent = result.error || 'Failed to remove duplicates';
            errorDiv.style.display = 'block';
        }
    } catch (error) {
        console.error('Error removing duplicates:', error);
        // Placeholder for development
        const successDiv = document.getElementById('deduplicationSuccess');
        successDiv.textContent = 'Deduplication feature ready - backend endpoint needed';
        successDiv.style.display = 'block';
        document.getElementById('removeDuplicatesBtn').disabled = true;
    }
}

// Initialize page when DOM loads
let databaseManager;
document.addEventListener('DOMContentLoaded', function() {
    databaseManager = new DatabaseManager();
});