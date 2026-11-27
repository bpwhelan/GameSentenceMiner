// Database Bulk Operations Functions
// Dependencies: shared.js (provides escapeHtml, openModal, closeModal), database-popups.js, database-game-data.js

/**
 * Select all games in the bulk operations list
 */
function selectAllGames() {
    // Clear current merge target
    if (typeof databaseManager !== 'undefined') {
        databaseManager.mergeTargetGame = null;
    }
    document.querySelectorAll('.checkbox-container').forEach(container => {
        container.classList.remove('merge-target');
    });
    
    const checkboxes = document.querySelectorAll('.game-checkbox');
    checkboxes.forEach((cb, index) => {
        cb.checked = true;
        // Mark the first checkbox as merge target
        if (index === 0 && typeof databaseManager !== 'undefined') {
            databaseManager.mergeTargetGame = cb.dataset.game;
            cb.closest('.checkbox-container').classList.add('merge-target');
        }
    });
    updateGameSelection();
}

/**
 * Deselect all games in the bulk operations list
 */
function selectNoGames() {
    // Clear merge target
    if (typeof databaseManager !== 'undefined') {
        databaseManager.mergeTargetGame = null;
    }
    document.querySelectorAll('.checkbox-container').forEach(container => {
        container.classList.remove('merge-target');
    });
    
    document.querySelectorAll('.game-checkbox').forEach(cb => {
        cb.checked = false;
    });
    updateGameSelection();
}

/**
 * Handle game selection change events
 * @param {Event} event - Change event from checkbox
 */
function handleGameSelectionChange(event) {
    const checkbox = event.target;
    const gameName = checkbox.dataset.game;
    const isChecked = checkbox.checked;
    
    // Get current selection count before updating
    const currentSelectedCount = document.querySelectorAll('.game-checkbox:checked').length - (isChecked ? 1 : 0);
    
    if (isChecked) {
        // Game is being selected
        if (currentSelectedCount === 0 && typeof databaseManager !== 'undefined') {
            // This is the first game being selected, mark it as merge target
            databaseManager.mergeTargetGame = gameName;
            // Add visual indicator
            checkbox.closest('.checkbox-container').classList.add('merge-target');
        }
    } else {
        // Game is being deselected
        if (typeof databaseManager !== 'undefined' && gameName === databaseManager.mergeTargetGame) {
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

/**
 * Update the state of bulk operation buttons based on selection
 */
function updateGameSelection() {
    const selectedCheckboxes = document.querySelectorAll('.game-checkbox:checked');
    const deleteBtn = document.getElementById('deleteSelectedGamesBtn');
    const mergeBtn = document.getElementById('mergeSelectedGamesBtn');
    
    if (deleteBtn) {
        // Update delete button
        deleteBtn.disabled = selectedCheckboxes.length === 0;
        deleteBtn.textContent = selectedCheckboxes.length > 0 ? `Delete Selected (${selectedCheckboxes.length})` : 'Delete Selected';
    }
    
    if (mergeBtn) {
        // Update merge button - only enable when 2 or more games are selected
        mergeBtn.disabled = selectedCheckboxes.length < 2;
        mergeBtn.textContent = selectedCheckboxes.length >= 2 ? `Merge Selected (${selectedCheckboxes.length})` : 'Merge Selected Games';
    }
}

/**
 * Delete selected games after confirmation
 */
async function deleteSelectedGames() {
    const selectedCheckboxes = document.querySelectorAll('.game-checkbox:checked');
    const gameNames = Array.from(selectedCheckboxes).map(cb => cb.dataset.game);
    
    if (gameNames.length === 0) return;
    
    showDatabaseConfirmPopup(
        `Are you sure you want to delete ${gameNames.length} game(s)? This action cannot be undone.`,
        async () => {
            try {
                const response = await fetch('/api/delete-games', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ game_names: gameNames })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    showDatabaseSuccessPopup(`Successfully deleted ${result.successful_games.length} games!`);
                    closeModal('gamesDeletionModal');
                    if (typeof databaseManager !== 'undefined') {
                        await databaseManager.loadDashboardStats();
                    }
                } else {
                    showDatabaseErrorPopup(`Error: ${result.error}`);
                }
            } catch (error) {
                console.error('Error deleting games:', error);
                showDatabaseErrorPopup('Failed to delete games');
            }
        }
    );
}

/**
 * Open game merge modal with selected games
 */
async function openGameMergeModal() {
    const selectedCheckboxes = document.querySelectorAll('.game-checkbox:checked');
    const gameNames = Array.from(selectedCheckboxes).map(cb => cb.dataset.game);
    
    if (gameNames.length < 2) {
        showDatabaseErrorPopup('Please select at least 2 games to merge.');
        return;
    }
    
    try {
        // Get detailed game information
        const response = await fetch('/api/games-list');
        const data = await response.json();
        
        if (response.ok && data.games) {
            const selectedGames = data.games.filter(game => gameNames.includes(game.name));
            
            // Use the tracked merge target as primary game, or fall back to first selected
            let primaryGame = selectedGames.find(game => 
                typeof databaseManager !== 'undefined' && game.name === databaseManager.mergeTargetGame
            );
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
        showDatabaseErrorPopup('Failed to load game data for merge');
    }
}

/**
 * Confirm and execute game merge operation
 */
async function confirmGameMerge() {
    const gameNames = window.selectedGamesForMerge;
    
    if (!gameNames || gameNames.length < 2) {
        showDatabaseErrorPopup('Invalid game selection for merge');
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
        const target_game = (typeof databaseManager !== 'undefined' && databaseManager.mergeTargetGame) || gameNames[0];
        const response = await fetch('/api/merge_games', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                target_game: target_game,
                games_to_merge: gameNames.filter(name => name !== target_game)
            })
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
                if (typeof databaseManager !== 'undefined') {
                    await databaseManager.loadDashboardStats();
                }
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

/**
 * Initialize bulk operations event handlers
 */
function initializeBulkOperations() {
    // Bulk operations handlers
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
}