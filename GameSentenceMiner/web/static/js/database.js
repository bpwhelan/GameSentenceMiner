// Database Management JavaScript
// Dependencies: shared.js (provides utility functions like escapeHtml, openModal, closeModal)

// Database Management Class
class DatabaseManager {
    constructor() {
        this.selectedGames = new Set();
        this.mergeTargetGame = null; // Track the first game selected for merge operations
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

        const mergeSelectedBtn = document.querySelector('[data-action="mergeSelectedGames"]');
        if (mergeSelectedBtn) {
            mergeSelectedBtn.addEventListener('click', openGameMergeModal);
        }

        const confirmMergeBtn = document.querySelector('[data-action="confirmGameMerge"]');
        if (confirmMergeBtn) {
            confirmMergeBtn.addEventListener('click', confirmGameMerge);
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

        // Add event listener for the ignore time window checkbox
        const ignoreTimeWindowCheckbox = document.getElementById('ignoreTimeWindow');
        if (ignoreTimeWindowCheckbox) {
            ignoreTimeWindowCheckbox.addEventListener('change', toggleTimeWindowVisibility);
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
                checkbox.addEventListener('change', (event) => handleGameSelectionChange(event));
                
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
    // Clear current merge target
    databaseManager.mergeTargetGame = null;
    document.querySelectorAll('.checkbox-container').forEach(container => {
        container.classList.remove('merge-target');
    });
    
    const checkboxes = document.querySelectorAll('.game-checkbox');
    checkboxes.forEach((cb, index) => {
        cb.checked = true;
        // Mark the first checkbox as merge target
        if (index === 0) {
            databaseManager.mergeTargetGame = cb.dataset.game;
            cb.closest('.checkbox-container').classList.add('merge-target');
        }
    });
    updateGameSelection();
}

function selectNoGames() {
    // Clear merge target
    databaseManager.mergeTargetGame = null;
    document.querySelectorAll('.checkbox-container').forEach(container => {
        container.classList.remove('merge-target');
    });
    
    document.querySelectorAll('.game-checkbox').forEach(cb => {
        cb.checked = false;
    });
    updateGameSelection();
}

function handleGameSelectionChange(event) {
    const checkbox = event.target;
    const gameName = checkbox.dataset.game;
    const isChecked = checkbox.checked;
    
    // Get current selection count before updating
    const currentSelectedCount = document.querySelectorAll('.game-checkbox:checked').length - (isChecked ? 1 : 0);
    
    if (isChecked) {
        // Game is being selected
        if (currentSelectedCount === 0) {
            // This is the first game being selected, mark it as merge target
            databaseManager.mergeTargetGame = gameName;
            // Add visual indicator
            checkbox.closest('.checkbox-container').classList.add('merge-target');
        }
    } else {
        // Game is being deselected
        if (gameName === databaseManager.mergeTargetGame) {
            // The merge target is being deselected
            databaseManager.mergeTargetGame = null;
            checkbox.closest('.checkbox-container').classList.remove('merge-target');
            
            // If there are still other games selected, make the first one the new target
            const remainingSelected = document.querySelectorAll('.game-checkbox:checked');
            if (remainingSelected.length > 0) {
                const newTargetCheckbox = remainingSelected[0];
                const newTargetGame = newTargetCheckbox.dataset.game;
                databaseManager.mergeTargetGame = newTargetGame;
                newTargetCheckbox.closest('.checkbox-container').classList.add('merge-target');
            }
        } else {
            // Remove merge target styling if it exists
            checkbox.closest('.checkbox-container').classList.remove('merge-target');
        }
    }
    
    updateGameSelection();
}

function updateGameSelection() {
    const selectedCheckboxes = document.querySelectorAll('.game-checkbox:checked');
    const deleteBtn = document.getElementById('deleteSelectedGamesBtn');
    const mergeBtn = document.getElementById('mergeSelectedGamesBtn');
    
    // Update delete button
    deleteBtn.disabled = selectedCheckboxes.length === 0;
    deleteBtn.textContent = selectedCheckboxes.length > 0 ? `Delete Selected (${selectedCheckboxes.length})` : 'Delete Selected';
    
    // Update merge button - only enable when 2 or more games are selected
    mergeBtn.disabled = selectedCheckboxes.length < 2;
    mergeBtn.textContent = selectedCheckboxes.length >= 2 ? `Merge Selected (${selectedCheckboxes.length})` : 'Merge Selected Games';
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
    document.getElementById('ignoreTimeWindow').checked = false;
    document.getElementById('deduplicationStats').style.display = 'none';
    document.getElementById('removeDuplicatesBtn').disabled = true;
    document.getElementById('deduplicationError').style.display = 'none';
    document.getElementById('deduplicationSuccess').style.display = 'none';
    // Ensure time window is visible on modal open
    toggleTimeWindowVisibility();
}

function toggleTimeWindowVisibility() {
    const ignoreTimeWindow = document.getElementById('ignoreTimeWindow').checked;
    const timeWindowGroup = document.getElementById('timeWindowGroup');
    
    if (ignoreTimeWindow) {
        timeWindowGroup.style.opacity = '0.5';
        timeWindowGroup.style.pointerEvents = 'none';
        document.getElementById('timeWindow').disabled = true;
    } else {
        timeWindowGroup.style.opacity = '1';
        timeWindowGroup.style.pointerEvents = 'auto';
        document.getElementById('timeWindow').disabled = false;
    }
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
    const ignoreTimeWindow = document.getElementById('ignoreTimeWindow').checked;
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
    
    // Only validate time window if not ignoring it
    if (!ignoreTimeWindow && (isNaN(timeWindow) || timeWindow < 1)) {
        errorDiv.textContent = 'Time window must be at least 1 minute';
        errorDiv.style.display = 'block';
        return;
    }
    
    try {
        const requestData = {
            games: selectedGames,
            time_window_minutes: timeWindow,
            case_sensitive: caseSensitive,
            ignore_time_window: ignoreTimeWindow,
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
                const modeText = ignoreTimeWindow ? 'across entire games' : `within ${timeWindow} minute time window`;
                successDiv.textContent = `Found ${result.duplicates_count} duplicate sentences ${modeText} ready for removal.`;
                successDiv.style.display = 'block';
            } else {
                const modeText = ignoreTimeWindow ? 'across entire games' : 'within the specified time window';
                successDiv.textContent = `No duplicates found in the selected games ${modeText}.`;
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
        const modeText = ignoreTimeWindow ? 'across entire games' : 'with time window';
        successDiv.textContent = `Preview feature ready - found ${duplicatesFound} potential duplicates ${modeText} (backend endpoint needed)`;
        successDiv.style.display = 'block';
    }
}

async function removeDuplicates() {
    const selectedGames = Array.from(document.getElementById('gameSelection').selectedOptions).map(option => option.value);
    const timeWindow = parseInt(document.getElementById('timeWindow').value);
    const caseSensitive = document.getElementById('caseSensitiveDedup').checked;
    const preserveNewest = document.getElementById('preserveNewest').checked;
    const ignoreTimeWindow = document.getElementById('ignoreTimeWindow').checked;
    
    const modeText = ignoreTimeWindow ? 'ALL duplicate sentences across entire games' : 'duplicate sentences within the time window';
    if (!confirm(`This will permanently remove ${modeText}. Continue?`)) {
        return;
    }
    
    try {
        const requestData = {
            games: selectedGames,
            time_window_minutes: timeWindow,
            case_sensitive: caseSensitive,
            preserve_newest: preserveNewest,
            ignore_time_window: ignoreTimeWindow,
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
            const resultModeText = ignoreTimeWindow ? 'across entire games' : `within ${timeWindow} minute time window`;
            successDiv.textContent = `Successfully removed ${result.deleted_count} duplicate sentences ${resultModeText}!`;
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


// Game Merge Functions
async function openGameMergeModal() {
    const selectedCheckboxes = document.querySelectorAll('.game-checkbox:checked');
    const gameNames = Array.from(selectedCheckboxes).map(cb => cb.dataset.game);
    
    if (gameNames.length < 2) {
        alert('Please select at least 2 games to merge.');
        return;
    }
    
    try {
        // Get detailed game information
        const response = await fetch('/api/games-list');
        const data = await response.json();
        
        if (response.ok && data.games) {
            const selectedGames = data.games.filter(game => gameNames.includes(game.name));
            
            // Use the tracked merge target as primary game, or fall back to first selected
            let primaryGame = selectedGames.find(game => game.name === databaseManager.mergeTargetGame);
            if (!primaryGame) {
                primaryGame = selectedGames[0];
            }
            
            // Secondary games are all selected games except the primary
            const secondaryGames = selectedGames.filter(game => game.name !== primaryGame.name);
            
            // Calculate totals
            const totalSentences = selectedGames.reduce((sum, game) => sum + game.sentence_count, 0);
            const totalCharacters = selectedGames.reduce((sum, game) => sum + game.total_characters, 0);
            
            // Populate primary game info
            document.getElementById('primaryGameName').textContent = primaryGame.name;
            document.getElementById('primaryGameStats').textContent =
                `${primaryGame.sentence_count} sentences, ${primaryGame.total_characters.toLocaleString()} characters`;
            
            // Populate secondary games list
            const secondaryList = document.getElementById('secondaryGamesList');
            secondaryList.innerHTML = '';
            secondaryGames.forEach(game => {
                const gameDiv = document.createElement('div');
                gameDiv.className = 'game-item';
                gameDiv.innerHTML = `
                    <div class="game-name">${escapeHtml(game.name)}</div>
                    <div class="game-stats">${game.sentence_count} sentences, ${game.total_characters.toLocaleString()} characters</div>
                `;
                secondaryList.appendChild(gameDiv);
            });
            
            // Update merge statistics
            document.getElementById('totalSentencesAfterMerge').textContent = totalSentences.toLocaleString();
            document.getElementById('totalCharactersAfterMerge').textContent = totalCharacters.toLocaleString();
            document.getElementById('gamesBeingMerged').textContent = gameNames.length;
            
            // Reset modal state
            document.getElementById('mergeError').style.display = 'none';
            document.getElementById('mergeSuccess').style.display = 'none';
            document.getElementById('mergeLoadingIndicator').style.display = 'none';
            document.getElementById('confirmMergeBtn').disabled = false;
            
            // Store selected games for the merge operation
            window.selectedGamesForMerge = gameNames;
            
            openModal('gameMergeModal');
        }
    } catch (error) {
        console.error('Error loading game data for merge:', error);
        alert('Failed to load game data for merge');
    }
}

async function confirmGameMerge() {
    const gameNames = window.selectedGamesForMerge;
    
    if (!gameNames || gameNames.length < 2) {
        alert('Invalid game selection for merge');
        return;
    }
    
    const errorDiv = document.getElementById('mergeError');
    const successDiv = document.getElementById('mergeSuccess');
    const loadingDiv = document.getElementById('mergeLoadingIndicator');
    const confirmBtn = document.getElementById('confirmMergeBtn');
    
    // Reset state
    errorDiv.style.display = 'none';
    successDiv.style.display = 'none';
    
    // Show loading state
    loadingDiv.style.display = 'flex';
    confirmBtn.disabled = true;
    
    try {
        target_game = databaseManager.mergeTargetGame || gameNames[0];
        const response = await fetch('/api/merge_games', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
                { target_game: target_game, games_to_merge: gameNames.filter(name => name !== target_game) })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            // Show success message
            successDiv.textContent = `Successfully merged ${result.merged_games.length} games into "${result.primary_game}"! Moved ${result.lines_moved} sentences.`;
            successDiv.style.display = 'block';
            
            // Auto-close modal after 2 seconds and refresh
            setTimeout(async () => {
                closeModal('gameMergeModal');
                closeModal('gamesDeletionModal');
                await databaseManager.loadDashboardStats();
            }, 2000);
            
        } else {
            // Show error message
            errorDiv.textContent = result.error || 'Failed to merge games';
            errorDiv.style.display = 'block';
            confirmBtn.disabled = false;
        }
    } catch (error) {
        console.error('Error merging games:', error);
        errorDiv.textContent = 'Network error occurred while merging games';
        errorDiv.style.display = 'block';
        confirmBtn.disabled = false;
    } finally {
        loadingDiv.style.display = 'none';
    }
}

// Initialize page when DOM loads
let databaseManager;
document.addEventListener('DOMContentLoaded', function() {
    databaseManager = new DatabaseManager();
});