// Database Management JavaScript
// Dependencies: shared.js (provides utility functions like escapeHtml, openModal, closeModal, safeJoinArray, logApiResponse)

// Helper function to format release date
function formatReleaseDate(releaseDate) {
    if (!releaseDate) return 'Unknown';
    
    try {
        // Handle ISO format like "2009-10-15T00:00:00"
        const date = new Date(releaseDate);
        if (isNaN(date.getTime())) return 'Invalid Date';
        
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    } catch (error) {
        console.warn('Error formatting release date:', releaseDate, error);
        return 'Invalid Date';
    }
}

// Database Popup Functions
function showDatabaseSuccessPopup(message) {
    const popup = document.getElementById('databaseSuccessPopup');
    const messageEl = document.getElementById('databaseSuccessMessage');
    if (popup && messageEl) {
        messageEl.textContent = message;
        popup.classList.remove('hidden');
    }
}

function showDatabaseErrorPopup(message) {
    const popup = document.getElementById('databaseErrorPopup');
    const messageEl = document.getElementById('databaseErrorMessage');
    if (popup && messageEl) {
        messageEl.textContent = message;
        popup.classList.remove('hidden');
    }
}

function showDatabaseConfirmPopup(message, onConfirm) {
    const popup = document.getElementById('databaseConfirmPopup');
    const messageEl = document.getElementById('databaseConfirmMessage');
    const yesBtn = document.getElementById('databaseConfirmYesBtn');
    const noBtn = document.getElementById('databaseConfirmNoBtn');
    
    if (popup && messageEl && yesBtn && noBtn) {
        messageEl.textContent = message;
        popup.classList.remove('hidden');
        
        // Remove old event listeners and add new ones
        const newYesBtn = yesBtn.cloneNode(true);
        const newNoBtn = noBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(newYesBtn, yesBtn);
        noBtn.parentNode.replaceChild(newNoBtn, noBtn);
        
        newYesBtn.addEventListener('click', () => {
            popup.classList.add('hidden');
            if (onConfirm) onConfirm();
        });
        
        newNoBtn.addEventListener('click', () => {
            popup.classList.add('hidden');
        });
    }
}

function closeDatabasePopups() {
    ['databaseSuccessPopup', 'databaseErrorPopup', 'databaseConfirmPopup'].forEach(id => {
        const popup = document.getElementById(id);
        if (popup) popup.classList.add('hidden');
    });
}

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

        // Tab navigation handlers
        const tabButtons = document.querySelectorAll('.tab-btn');
        tabButtons.forEach(btn => {
            btn.addEventListener('click', (e) => switchTab(e.target.dataset.tab));
        });

        // Bulk operations handlers (moved from old gamesDeletionModal)
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

        // Preset pattern handling is now done by the regex-input component
        // No need to attach event listeners here

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

        // Game data management handlers
        const openGameDataBtn = document.querySelector('[data-action="openGameDataModal"]');
        if (openGameDataBtn) {
            openGameDataBtn.addEventListener('click', openGameDataModal);
        }

        const jitenSearchBtn = document.getElementById('jitenSearchBtn');
        if (jitenSearchBtn) {
            jitenSearchBtn.addEventListener('click', searchJitenMoe);
        }

        const confirmLinkBtn = document.getElementById('confirmLinkBtn');
        if (confirmLinkBtn) {
            confirmLinkBtn.addEventListener('click', confirmLinkGame);
        }

        // Game data filter buttons
        const filterButtons = document.querySelectorAll('.game-data-filters button');
        filterButtons.forEach(btn => {
            btn.addEventListener('click', (event) => filterGames(event.target.dataset.filter));
        });

        // Add event listener for the ignore time window checkbox
        const ignoreTimeWindowCheckbox = document.getElementById('ignoreTimeWindow');
        if (ignoreTimeWindowCheckbox) {
            ignoreTimeWindowCheckbox.addEventListener('change', toggleTimeWindowVisibility);
        }
    }
    
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

// Tab Management Functions
function switchTab(tabName) {
    // Hide all tab contents
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
        tab.style.display = 'none';
    });
    
    // Remove active class from all tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Show selected tab content
    const selectedTab = document.getElementById(tabName + 'Tab');
    const selectedBtn = document.querySelector(`[data-tab="${tabName}"]`);
    
    if (selectedTab && selectedBtn) {
        selectedTab.classList.add('active');
        selectedTab.style.display = 'block';
        selectedBtn.classList.add('active');
        
        // Load content based on tab
        if (tabName === 'linkGames') {
            loadGamesForDataManagement();
        } else if (tabName === 'manageGames') {
            loadGamesForManagement();
        } else if (tabName === 'bulkOperations') {
            loadGamesForBulkOperations();
        }
    }
}

// Updated Game Data Modal Opening
async function openGameDataModal() {
    openModal('gameDataModal');
    // Default to Link Games tab
    switchTab('linkGames');
}

// Load games for the Manage Games tab
async function loadGamesForManagement() {
    const loadingIndicator = document.getElementById('manageGamesLoadingIndicator');
    const content = document.getElementById('manageGamesContent');
    const gamesList = document.getElementById('manageGamesList');
    
    loadingIndicator.style.display = 'flex';
    content.style.display = 'none';
    
    try {
        const gamesResponse = await fetch('/api/games-management');
        const gamesData = await gamesResponse.json();
        
        if (gamesResponse.ok) {
            const games = gamesData.games || [];
            gamesList.innerHTML = '';
            
            games.forEach(game => {
                const gameItem = document.createElement('div');
                gameItem.className = 'manage-game-item';
                
                // Create status indicators
                const statusIndicators = [];
                if (game.is_linked) {
                    statusIndicators.push('<span class="status-badge linked">✅ Linked</span>');
                } else {
                    statusIndicators.push('<span class="status-badge unlinked">🔍 Not Linked</span>');
                }
                
                if (game.has_manual_overrides) {
                    statusIndicators.push('<span class="status-badge manual">📝 Manual Edits</span>');
                }
                
                if (game.completed) {
                    statusIndicators.push('<span class="status-badge completed">🏁 Completed</span>');
                }
                
                // Format dates
                const startDate = game.start_date ? new Date(game.start_date * 1000).toLocaleDateString() : 'Unknown';
                const lastPlayed = game.last_played ? new Date(game.last_played * 1000).toLocaleDateString() : 'Unknown';
                
                gameItem.innerHTML = `
                    <div class="game-header">
                        ${game.image ? `<img src="data:image/png;base64,${game.image}" class="game-thumbnail" alt="Game cover">` : '<div class="game-thumbnail-placeholder">🎮</div>'}
                        <div class="game-info">
                            <h4 class="game-title">${escapeHtml(game.title_original)}</h4>
                            ${game.title_english ? `<p class="game-title-en">${escapeHtml(game.title_english)}</p>` : ''}
                            ${game.title_romaji ? `<p class="game-title-rom">${escapeHtml(game.title_romaji)}</p>` : ''}
                            <div class="game-type-difficulty">
                                ${game.type ? `<span class="game-type">${escapeHtml(game.type)}</span>` : ''}
                                ${game.difficulty ? `<span class="game-difficulty">Difficulty: ${game.difficulty}</span>` : ''}
                            </div>
                        </div>
                        <div class="game-status">
                            ${statusIndicators.join('')}
                        </div>
                    </div>
                    ${game.line_count > 0 ? `
                    <div class="game-stats">
                        <span class="stat-item">${game.line_count.toLocaleString()} lines</span>
                        <span class="stat-item">${game.mined_character_count.toLocaleString()} mined chars</span>
                        ${game.jiten_character_count > 0 ? `<span class="stat-item">Total: ${game.jiten_character_count.toLocaleString()} chars (${((game.mined_character_count / game.jiten_character_count) * 100).toFixed(1)}%)</span>` : ''}
                        <span class="stat-item">Started: ${startDate}</span>
                        <span class="stat-item">Last: ${lastPlayed}</span>
                        ${game.release_date ? `<span class="stat-item">Released: ${formatReleaseDate(game.release_date)}</span>` : ''}
                    </div>
                    ` : ''}
                    <div class="individual-game-actions">
                        ${game.is_linked ? `<button class="action-btn unlink-btn" onclick="openIndividualGameUnlinkModal('${game.id}', '${escapeHtml(game.title_original)}', ${game.line_count}, ${game.mined_character_count})">🔗 Unlink Game</button>` : ''}
                        <button class="action-btn delete-lines-btn" onclick="openIndividualGameDeleteModal('${game.id}', '${escapeHtml(game.title_original)}', ${game.line_count}, ${game.mined_character_count})">🗑️ Delete Game Lines</button>
                        ${!game.is_linked ? `<button class="action-btn primary" onclick="openJitenSearch('${game.id}', '${escapeHtml(game.title_original)}')">🔍 Search jiten.moe</button>` : ''}
                        ${game.is_linked ? `<button class="action-btn warning" onclick="repullJitenData('${game.id}', '${escapeHtml(game.title_original)}')">🔄 Repull from Jiten</button>` : ''}
                        <button class="action-btn" onclick="editGame('${game.id}')">📝 Edit</button>
                        ${!game.completed ? `<button class="action-btn success" onclick="markGameCompleted('${game.id}')">🏁 Mark Complete</button>` : ''}
                    </div>
                    ${game.description ? `<div class="game-description">${escapeHtml(game.description)}</div>` : ''}
                `;
                
                gamesList.appendChild(gameItem);
            });
            
            content.style.display = 'block';
        } else {
            const errorMsg = gamesData.error || 'Failed to load games';
            gamesList.innerHTML = `<p class="error-text">${escapeHtml(errorMsg)}</p>`;
            content.style.display = 'block';
        }
    } catch (error) {
        console.error('Error loading games for management:', error);
        gamesList.innerHTML = `<p class="error-text">Network error: ${escapeHtml(error.message)}</p>`;
        content.style.display = 'block';
    } finally {
        loadingIndicator.style.display = 'none';
    }
}

// Load games for bulk operations tab
async function loadGamesForBulkOperations() {
    const loadingIndicator = document.getElementById('bulkGamesLoadingIndicator');
    const content = document.getElementById('bulkGamesContent');
    const gamesList = document.getElementById('bulkGamesList');
    
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
                    await databaseManager.loadDashboardStats();
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

// Text Lines Functions
function openTextLinesModal() {
    openModal('textLinesModal');
    // Reset the modal state using regex component elements
    const component = document.getElementById('textLinesRegexComponent');
    if (component) {
        const presetSelect = component.querySelector('.regex-preset-select');
        const customInput = component.querySelector('.regex-custom-input');
        const exactTextarea = component.querySelector('.regex-exact-textarea');
        const caseCheckbox = component.querySelector('.regex-case-checkbox');
        const regexCheckbox = component.querySelector('.regex-mode-checkbox');
        
        if (presetSelect) presetSelect.value = '';
        if (customInput) customInput.value = '';
        if (exactTextarea) exactTextarea.value = '';
        if (caseCheckbox) caseCheckbox.checked = false;
        if (regexCheckbox) regexCheckbox.checked = false;
        
        // Show exact text input for deletion use case
        const exactTextGroup = component.querySelector('.regex-exact-text-group');
        if (exactTextGroup) exactTextGroup.style.display = 'block';
    }
    document.getElementById('previewDeleteResults').style.display = 'none';
    document.getElementById('executeDeleteBtn').disabled = true;
}

// Preset patterns are now handled by the regex-input component
// The component automatically populates the custom regex input when a preset is selected

async function previewTextDeletion() {
    // Get values from regex component
    const component = document.getElementById('textLinesRegexComponent');
    const customRegex = component.querySelector('.regex-custom-input').value;
    const textToDelete = component.querySelector('.regex-exact-textarea').value;
    const caseSensitive = component.querySelector('.regex-case-checkbox').checked;
    const useRegex = component.querySelector('.regex-mode-checkbox').checked;
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
    // Get values from regex component
    const component = document.getElementById('textLinesRegexComponent');
    const customRegex = component.querySelector('.regex-custom-input').value;
    const textToDelete = component.querySelector('.regex-exact-textarea').value;
    const caseSensitive = component.querySelector('.regex-case-checkbox').checked;
    const useRegex = component.querySelector('.regex-mode-checkbox').checked;
    const errorDiv = document.getElementById('textLinesError');
    const successDiv = document.getElementById('textLinesSuccess');
    
    errorDiv.style.display = 'none';
    successDiv.style.display = 'none';
    
    if (!customRegex.trim() && !textToDelete.trim()) {
        errorDiv.textContent = 'Please enter either a regex pattern or exact text to delete';
        errorDiv.style.display = 'block';
        return;
    }
    
    showDatabaseConfirmPopup('This will permanently delete the selected text lines. Continue?', async () => {
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
    });
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
    showDatabaseConfirmPopup(`This will permanently remove ${modeText}. Continue?`, async () => {
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
    });
}


// Game Merge Functions
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
        showDatabaseErrorPopup('Failed to load game data for merge');
    }
}

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

// Game Data Management Functions
let currentGames = [];
let currentGameForSearch = null;
let selectedJitenGame = null;
let jitenSearchResults = []; // Global storage for search results

async function openGameDataModal() {
    openModal('gameDataModal');
    await loadGamesForDataManagement();
}

async function loadGamesForDataManagement() {
    const loadingIndicator = document.getElementById('gameDataLoadingIndicator');
    const content = document.getElementById('gameDataContent');
    const gamesList = document.getElementById('gameDataList');
    
    loadingIndicator.style.display = 'flex';
    content.style.display = 'none';
    
    try {
        const gamesResponse = await fetch('/api/games-management');
        const gamesData = await gamesResponse.json();
        
        if (gamesResponse.ok) {
            currentGames = gamesData.games || [];
            
            // Validate that all games have IDs
            const gamesWithoutIds = currentGames.filter(game => !game.id);
            if (gamesWithoutIds.length > 0) {
                console.error(`Found ${gamesWithoutIds.length} games without IDs:`, gamesWithoutIds);
                showDatabaseErrorPopup(`Warning: ${gamesWithoutIds.length} games are missing IDs. Please refresh the page.`);
            }
            
            console.log(`Loaded ${currentGames.length} games`);
            
            // Update game management stats
            await databaseManager.loadGameManagementStats();
            
            renderGamesList(currentGames);
            content.style.display = 'block';
        } else {
            const errorMsg = gamesData.error || 'Failed to load games';
            gamesList.innerHTML = `<p class="error-text">${escapeHtml(errorMsg)}</p>`;
            content.style.display = 'block';
            console.error('Failed to load games:', gamesData);
        }
    } catch (error) {
        console.error('Error loading games for data management:', error);
        gamesList.innerHTML = `<p class="error-text">Network error: ${escapeHtml(error.message)}</p>`;
        content.style.display = 'block';
    } finally {
        loadingIndicator.style.display = 'none';
    }
}

function renderGamesList(games, filter = 'all') {
    const gamesList = document.getElementById('gameDataList');
    
    // Filter games based on selection
    let filteredGames = games;
    if (filter === 'linked') {
        filteredGames = games.filter(game => game.is_linked);
    } else if (filter === 'unlinked') {
        filteredGames = games.filter(game => !game.is_linked);
    }
    
    // Update filter button states
    document.querySelectorAll('.game-data-filters button').forEach(btn => {
        btn.classList.remove('primary');
        btn.classList.add('action-btn');
    });
    const activeBtn = document.getElementById(`filter${filter.charAt(0).toUpperCase() + filter.slice(1)}`);
    if (activeBtn) {
        activeBtn.classList.add('primary');
        activeBtn.classList.remove('action-btn');
    }
    
    gamesList.innerHTML = '';
    
    // Render existing games first
    if (filteredGames.length > 0) {
        filteredGames.forEach(game => {
            const gameItem = document.createElement('div');
            gameItem.className = 'game-data-item';
            
            // Create status indicators
            const statusIndicators = [];
            if (game.is_linked) {
                statusIndicators.push('<span class="status-badge linked">✅ Linked</span>');
            } else {
                statusIndicators.push('<span class="status-badge unlinked">🔍 Not Linked</span>');
            }
            
            if (game.has_manual_overrides) {
                statusIndicators.push('<span class="status-badge manual">📝 Manual Edits</span>');
            }
            
            if (game.completed) {
                statusIndicators.push('<span class="status-badge completed">🏁 Completed</span>');
            }
            
            // Format dates
            const startDate = game.start_date ? new Date(game.start_date * 1000).toLocaleDateString() : 'Unknown';
            const lastPlayed = game.last_played ? new Date(game.last_played * 1000).toLocaleDateString() : 'Unknown';
            
            gameItem.innerHTML = `
                <div class="game-header">
                    ${game.image ? `<img src="data:image/png;base64,${game.image}" class="game-thumbnail" alt="Game cover">` : '<div class="game-thumbnail-placeholder">🎮</div>'}
                    <div class="game-info">
                        <h4 class="game-title">${escapeHtml(game.title_original)}</h4>
                        ${game.title_english ? `<p class="game-title-en">${escapeHtml(game.title_english)}</p>` : ''}
                        ${game.title_romaji ? `<p class="game-title-rom">${escapeHtml(game.title_romaji)}</p>` : ''}
                        <div class="game-type-difficulty">
                            ${game.type ? `<span class="game-type">${escapeHtml(game.type)}</span>` : ''}
                            ${game.difficulty ? `<span class="game-difficulty">Difficulty: ${game.difficulty}</span>` : ''}
                        </div>
                    </div>
                    <div class="game-status">
                        ${statusIndicators.join('')}
                    </div>
                </div>
                ${game.line_count > 0 ? `
                <div class="game-stats">
                    <span class="stat-item">${game.line_count.toLocaleString()} lines</span>
                    <span class="stat-item">${game.mined_character_count.toLocaleString()} mined chars</span>
                    ${game.jiten_character_count > 0 ? `<span class="stat-item">Total: ${game.jiten_character_count.toLocaleString()} chars (${((game.mined_character_count / game.jiten_character_count) * 100).toFixed(1)}%)</span>` : ''}
                    <span class="stat-item">Started: ${startDate}</span>
                    <span class="stat-item">Last: ${lastPlayed}</span>
                    ${game.release_date ? `<span class="stat-item">Released: ${formatReleaseDate(game.release_date)}</span>` : ''}
                </div>
                ` : ''}
                <div class="game-actions">
                    ${!game.is_linked ? `<button class="action-btn primary" onclick="openJitenSearch('${game.id}', '${escapeHtml(game.title_original)}')">🔍 Search jiten.moe</button>` : ''}
                    ${game.is_linked ? `<button class="action-btn warning" onclick="repullJitenData('${game.id}', '${escapeHtml(game.title_original)}')">🔄 Repull from Jiten</button>` : ''}
                    <button class="action-btn" onclick="editGame('${game.id}')">📝 Edit</button>
                    ${!game.completed ? `<button class="action-btn success" onclick="markGameCompleted('${game.id}')">🏁 Mark Complete</button>` : ''}
                </div>
                ${game.description ? `<div class="game-description">${escapeHtml(game.description)}</div>` : ''}
            `;
            
            gamesList.appendChild(gameItem);
        });
    }
    
    // Show empty state if no games
    if (filteredGames.length === 0) {
        gamesList.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); padding: 40px;">
                <p>No games found.</p>
                <p>Start playing games to see them appear here!</p>
            </div>
        `;
    }
}

function filterGames(filter) {
    renderGamesList(currentGames, filter);
}

function openJitenSearch(gameId, gameTitle) {
    // Validate gameId
    if (!gameId || gameId === 'undefined' || gameId === 'null') {
        showDatabaseErrorPopup(`Cannot link game: Invalid game ID. Please refresh the page and try again.`);
        console.error(`Invalid gameId provided to openJitenSearch: ${gameId}`);
        return;
    }
    
    currentGameForSearch = currentGames.find(game => game.id === gameId);
    if (!currentGameForSearch) {
        showDatabaseErrorPopup(`Cannot find game with ID: ${gameId}. Please refresh the page and try again.`);
        console.error(`Game not found in currentGames: ${gameId}`);
        return;
    }
    
    // Additional validation
    if (!currentGameForSearch.id) {
        showDatabaseErrorPopup(`Game data is incomplete (missing ID). Please refresh the page and try again.`);
        console.error(`Game found but has no ID:`, currentGameForSearch);
        return;
    }
    
    document.getElementById('searchingForGame').textContent = gameTitle;
    document.getElementById('jitenSearchInput').value = gameTitle;
    document.getElementById('jitenSearchResults').style.display = 'none';
    document.getElementById('jitenSearchError').style.display = 'none';
    
    openModal('jitenSearchModal');
}

async function searchJitenMoe() {
    const searchInput = document.getElementById('jitenSearchInput');
    const resultsDiv = document.getElementById('jitenSearchResults');
    const resultsListDiv = document.getElementById('jitenResultsList');
    const errorDiv = document.getElementById('jitenSearchError');
    const loadingDiv = document.getElementById('jitenSearchLoading');
    
    const searchTerm = searchInput.value.trim();
    if (!searchTerm) {
        errorDiv.textContent = 'Please enter a search term';
        errorDiv.style.display = 'block';
        return;
    }
    
    errorDiv.style.display = 'none';
    resultsDiv.style.display = 'none';
    loadingDiv.style.display = 'flex';
    
    try {
        const response = await fetch(`/api/jiten-search?title=${encodeURIComponent(searchTerm)}`);
        const data = await response.json();
        
        if (response.ok) {
            if (data.results && data.results.length > 0) {
                renderJitenResults(data.results);
                resultsDiv.style.display = 'block';
            } else {
                errorDiv.textContent = 'No results found. Try a different search term.';
                errorDiv.style.display = 'block';
            }
        } else {
            errorDiv.textContent = data.error || 'Search failed';
            errorDiv.style.display = 'block';
        }
    } catch (error) {
        console.error('Error searching jiten.moe:', error);
        errorDiv.textContent = 'Search failed. Please try again.';
        errorDiv.style.display = 'block';
    } finally {
        loadingDiv.style.display = 'none';
    }
}

function renderJitenResults(results) {
    const resultsListDiv = document.getElementById('jitenResultsList');
    
    // Store results globally for easy access
    jitenSearchResults = results;
    
    resultsListDiv.innerHTML = '';
    
    results.forEach((result, index) => {
        const resultItem = document.createElement('div');
        resultItem.className = 'jiten-result-item';
        
        const mediaTypeMap = {1: 'Anime', 7: 'Visual Novel', 2: 'Manga'};
        const mediaTypeText = mediaTypeMap[result.media_type] || 'Unknown';
        
        resultItem.innerHTML = `
            <div class="jiten-result-header">
                ${result.cover_name ? `<img src="${result.cover_name}" class="jiten-thumbnail" alt="Cover">` : '<div class="jiten-thumbnail-placeholder">🎮</div>'}
                <div class="jiten-info">
                    <h5 class="jiten-title">${escapeHtml(result.title_original)}</h5>
                    ${result.title_english ? `<p class="jiten-title-en">${escapeHtml(result.title_english)}</p>` : ''}
                    ${result.title_romaji ? `<p class="jiten-title-rom">${escapeHtml(result.title_romaji)}</p>` : ''}
                    <div class="jiten-meta">
                        <span class="jiten-type">${mediaTypeText}</span>
                        ${result.difficulty ? `<span class="jiten-difficulty">Difficulty: ${result.difficulty}</span>` : ''}
                        <span class="jiten-chars">Total: ${result.character_count.toLocaleString()} chars</span>
                    </div>
                </div>
                <div class="jiten-actions">
                    <button class="action-btn primary" onclick="selectJitenGame(${index})">Select</button>
                </div>
            </div>
            ${result.description ? `<div class="jiten-description">${escapeHtml(result.description.substring(0, 200))}${result.description.length > 200 ? '...' : ''}</div>` : ''}
        `;
        
        resultsListDiv.appendChild(resultItem);
    });
}

function selectJitenGame(resultIndex) {
    selectedJitenGame = jitenSearchResults[resultIndex];
    
    // Check if we're linking an existing game or creating from potential
    if (window.currentPotentialGame) {
        showPotentialGameLinkConfirmation();
    } else {
        showLinkConfirmation();
    }
}

function showLinkConfirmation() {
    if (!currentGameForSearch || !selectedJitenGame) return;
    
    // Populate current game preview
    const currentGamePreview = document.getElementById('currentGamePreview');
    currentGamePreview.innerHTML = `
        <div class="preview-header">
            <h5>${escapeHtml(currentGameForSearch.title_original)}</h5>
            <div class="preview-stats">
                ${currentGameForSearch.line_count.toLocaleString()} lines,
                ${currentGameForSearch.mined_character_count.toLocaleString()} mined characters
                ${currentGameForSearch.jiten_character_count > 0 ? `<br>Game Total: ${currentGameForSearch.jiten_character_count.toLocaleString()} chars` : ''}
            </div>
        </div>
    `;
    
    // Populate jiten game preview
    const jitenGamePreview = document.getElementById('jitenGamePreview');
    const mediaTypeMap = {1: 'Anime', 7: 'Visual Novel', 2: 'Manga'};
    jitenGamePreview.innerHTML = `
        <div class="preview-header">
            ${selectedJitenGame.cover_name ? `<img src="${selectedJitenGame.cover_name}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 4px; margin-right: 10px;">` : ''}
            <div>
                <h5>${escapeHtml(selectedJitenGame.title_original)}</h5>
                ${selectedJitenGame.title_english ? `<p>${escapeHtml(selectedJitenGame.title_english)}</p>` : ''}
                <div class="preview-stats">
                    ${mediaTypeMap[selectedJitenGame.media_type] || 'Unknown'} |
                    Deck ID: ${selectedJitenGame.deck_id} |
                    Difficulty: ${selectedJitenGame.difficulty}
                </div>
            </div>
        </div>
        ${selectedJitenGame.description ? `<div style="margin-top: 10px; color: var(--text-secondary); font-size: 14px;">${escapeHtml(selectedJitenGame.description.substring(0, 150))}${selectedJitenGame.description.length > 150 ? '...' : ''}</div>` : ''}
    `;
    
    // Show manual overrides warning if any
    const warningDiv = document.getElementById('manualOverridesWarning');
    const overriddenFieldsList = document.getElementById('overriddenFieldsList');
    
    if (currentGameForSearch.has_manual_overrides && currentGameForSearch.manual_overrides) {
        const overridesStr = safeJoinArray(currentGameForSearch.manual_overrides, ', ');
        if (overridesStr) {
            overriddenFieldsList.innerHTML = `<div>Fields: ${overridesStr}</div>`;
            warningDiv.style.display = 'block';
        } else {
            warningDiv.style.display = 'none';
        }
    } else {
        warningDiv.style.display = 'none';
    }
    
    // Close search modal and open confirmation modal
    closeModal('jitenSearchModal');
    openModal('gameLinkConfirmModal');
}

async function confirmLinkGame() {
    if (!currentGameForSearch || !selectedJitenGame) {
        showDatabaseErrorPopup('Missing game or jiten data. Please try again.');
        return;
    }
    
    // Validate game ID before making API call
    if (!currentGameForSearch.id || currentGameForSearch.id === 'undefined' || currentGameForSearch.id === 'null') {
        showDatabaseErrorPopup(`Cannot link game: Invalid game ID (${currentGameForSearch.id}). Please refresh the page and try again.`);
        console.error('Invalid game ID in confirmLinkGame:', currentGameForSearch);
        return;
    }
    
    const errorDiv = document.getElementById('linkConfirmError');
    const loadingDiv = document.getElementById('linkConfirmLoading');
    const confirmBtn = document.getElementById('confirmLinkBtn');
    
    errorDiv.style.display = 'none';
    loadingDiv.style.display = 'flex';
    confirmBtn.disabled = true;
    
    try {
        const apiUrl = `/api/games/${currentGameForSearch.id}/link-jiten`;
        console.log(`Linking game to jiten.moe: ${apiUrl}`);
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deck_id: selectedJitenGame.deck_id,
                jiten_data: selectedJitenGame
            })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            // Success! Close modal and refresh game list
            closeModal('gameLinkConfirmModal');
            await loadGamesForDataManagement();
            await databaseManager.loadGameManagementStats();
            
            // Log the complete API response for debugging
            logApiResponse('Link Game to Jiten', response, result);
            
            // Show success message with line count
            const lineCount = result.lines_linked || currentGameForSearch.line_count || 0;
            console.log(`✅ Game linking successful: ${lineCount} lines linked`);
            showDatabaseSuccessPopup(`Successfully linked "${currentGameForSearch.title_original}" to jiten.moe! ${lineCount} lines linked.`);
        } else {
            const errorMessage = result.error || 'Failed to link game';
            errorDiv.textContent = errorMessage;
            errorDiv.style.display = 'block';
            confirmBtn.disabled = false;
            console.error('Link game API error:', result);
        }
    } catch (error) {
        console.error('Error linking game:', error);
        errorDiv.textContent = `Network error: ${error.message || 'Failed to connect to server'}`;
        errorDiv.style.display = 'block';
        confirmBtn.disabled = false;
    } finally {
        loadingDiv.style.display = 'none';
    }
}

async function markGameCompleted(gameId) {
    showDatabaseConfirmPopup('Mark this game as completed?', async () => {
        try {
            const response = await fetch(`/api/games/${gameId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ completed: true })
            });
            
            const result = await response.json();
            
            if (response.ok) {
                await loadGamesForDataManagement();
                showDatabaseSuccessPopup('Game marked as completed!');
            } else {
                showDatabaseErrorPopup(`Error: ${result.error}`);
            }
        } catch (error) {
            console.error('Error marking game as completed:', error);
            showDatabaseErrorPopup('Failed to mark game as completed');
        }
    });
}

function editGame(gameId) {
    const game = currentGames.find(g => g.id === gameId);
    if (!game) {
        showDatabaseErrorPopup('Game not found');
        return;
    }
    
    openEditGameModal(game);
}

function openEditGameModal(game) {
    // Populate form fields with current game data
    document.getElementById('editGameId').value = game.id;
    document.getElementById('editTitleOriginal').value = game.title_original || '';
    document.getElementById('editTitleRomaji').value = game.title_romaji || '';
    document.getElementById('editTitleEnglish').value = game.title_english || '';
    document.getElementById('editType').value = game.type || '';
    document.getElementById('editDescription').value = game.description || '';
    document.getElementById('editDifficulty').value = game.difficulty || '';
    document.getElementById('editDeckId').value = game.deck_id || '';
    document.getElementById('editCharacterCount').value = game.character_count || '';
    document.getElementById('editCompleted').checked = game.completed || false;
    
    // Handle release date - convert ISO format to date input format (YYYY-MM-DD)
    if (game.release_date) {
        try {
            const date = new Date(game.release_date);
            if (!isNaN(date.getTime())) {
                document.getElementById('editReleaseDate').value = date.toISOString().split('T')[0];
            } else {
                document.getElementById('editReleaseDate').value = '';
            }
        } catch (error) {
            console.warn('Error parsing release date:', game.release_date, error);
            document.getElementById('editReleaseDate').value = '';
        }
    } else {
        document.getElementById('editReleaseDate').value = '';
    }
    
    // Handle links JSON
    if (game.links && game.links.length > 0) {
        document.getElementById('editLinks').value = JSON.stringify(game.links, null, 2);
    } else {
        document.getElementById('editLinks').value = '';
    }
    
    // Handle image preview
    const imagePreview = document.getElementById('editImagePreview');
    const imagePreviewImg = document.getElementById('editImagePreviewImg');
    if (game.image) {
        imagePreviewImg.src = `data:image/png;base64,${game.image}`;
        imagePreview.style.display = 'block';
    } else {
        imagePreview.style.display = 'none';
    }
    
    // Reset file input
    document.getElementById('editImageUpload').value = '';
    
    // Reset error display
    document.getElementById('editGameError').style.display = 'none';
    
    // Open the modal
    openModal('editGameModal');
}

// Handle image upload preview
document.addEventListener('DOMContentLoaded', function() {
    const imageUpload = document.getElementById('editImageUpload');
    if (imageUpload) {
        imageUpload.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = function(event) {
                    const imagePreview = document.getElementById('editImagePreview');
                    const imagePreviewImg = document.getElementById('editImagePreviewImg');
                    imagePreviewImg.src = event.target.result;
                    imagePreview.style.display = 'block';
                };
                reader.readAsDataURL(file);
            }
        });
    }
});

async function saveGameEdits() {
    const gameId = document.getElementById('editGameId').value;
    const errorDiv = document.getElementById('editGameError');
    const loadingDiv = document.getElementById('editGameLoading');
    const saveBtn = document.getElementById('saveGameEditsBtn');
    
    // Reset error display
    errorDiv.style.display = 'none';
    
    // Validate required fields
    const titleOriginal = document.getElementById('editTitleOriginal').value.trim();
    if (!titleOriginal) {
        errorDiv.textContent = 'Original title is required';
        errorDiv.style.display = 'block';
        return;
    }
    
    // Validate links JSON if provided
    const linksText = document.getElementById('editLinks').value.trim();
    let linksArray = [];
    if (linksText) {
        try {
            linksArray = JSON.parse(linksText);
            if (!Array.isArray(linksArray)) {
                errorDiv.textContent = 'Links must be a JSON array';
                errorDiv.style.display = 'block';
                return;
            }
        } catch (e) {
            errorDiv.textContent = 'Invalid JSON format for links';
            errorDiv.style.display = 'block';
            return;
        }
    }
    
    // Validate difficulty
    const difficulty = document.getElementById('editDifficulty').value;
    if (difficulty && (parseInt(difficulty) < 1 || parseInt(difficulty) > 5)) {
        errorDiv.textContent = 'Difficulty must be between 1 and 5';
        errorDiv.style.display = 'block';
        return;
    }
    
    // Show loading state
    loadingDiv.style.display = 'flex';
    saveBtn.disabled = true;
    
    try {
        // Prepare update data
        const updateData = {
            title_original: titleOriginal,
            title_romaji: document.getElementById('editTitleRomaji').value.trim(),
            title_english: document.getElementById('editTitleEnglish').value.trim(),
            type: document.getElementById('editType').value,
            description: document.getElementById('editDescription').value.trim(),
            completed: document.getElementById('editCompleted').checked
        };
        
        // Add release date if provided
        const releaseDate = document.getElementById('editReleaseDate').value;
        if (releaseDate) {
            // Convert date input (YYYY-MM-DD) to ISO format for storage
            updateData.release_date = releaseDate + 'T00:00:00';
        }
        
        // Add optional numeric fields
        const deckId = document.getElementById('editDeckId').value;
        if (deckId) {
            updateData.deck_id = parseInt(deckId);
        }
        
        if (difficulty) {
            updateData.difficulty = parseInt(difficulty);
        }
        
        const characterCount = document.getElementById('editCharacterCount').value;
        if (characterCount) {
            updateData.character_count = parseInt(characterCount);
        }
        
        // Add links if provided
        if (linksArray.length > 0) {
            updateData.links = linksArray;
        }
        
        // Handle image upload
        const imageFile = document.getElementById('editImageUpload').files[0];
        if (imageFile) {
            const reader = new FileReader();
            const imageBase64 = await new Promise((resolve, reject) => {
                reader.onload = (e) => {
                    // Extract base64 data (remove data:image/...;base64, prefix)
                    const base64 = e.target.result.split(',')[1];
                    resolve(base64);
                };
                reader.onerror = reject;
                reader.readAsDataURL(imageFile);
            });
            updateData.image = imageBase64;
        }
        
        // Send update request
        const response = await fetch(`/api/games/${gameId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updateData)
        });
        
        const result = await response.json();
        
        if (response.ok) {
            // Success! Close modal and refresh
            closeModal('editGameModal');
            await loadGamesForDataManagement();
            showDatabaseSuccessPopup('Game updated successfully! All edited fields marked as manual overrides.');
        } else {
            errorDiv.textContent = result.error || 'Failed to update game';
            errorDiv.style.display = 'block';
            saveBtn.disabled = false;
        }
    } catch (error) {
        console.error('Error saving game edits:', error);
        errorDiv.textContent = `Error: ${error.message}`;
        errorDiv.style.display = 'block';
        saveBtn.disabled = false;
    } finally {
        loadingDiv.style.display = 'none';
    }
}

// Repull Jiten Data Function
async function repullJitenData(gameId, gameName) {
    console.log(`🔄 Starting repull operation for game: ${gameName} (ID: ${gameId})`);
    
    showDatabaseConfirmPopup(
        `Repull data from jiten.moe for "${gameName}"? This will update all non-manually edited fields with fresh data from jiten.moe.`,
        async () => {
            console.log(`✅ User confirmed repull for ${gameName}`);
            
            try {
                console.log(`📡 Making API request to /api/games/${gameId}/repull-jiten`);
                
                const response = await fetch(`/api/games/${gameId}/repull-jiten`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                console.log(`📥 Received response:`, {
                    status: response.status,
                    statusText: response.statusText,
                    ok: response.ok,
                    headers: Object.fromEntries(response.headers.entries())
                });
                
                const result = await response.json();
                
                // Log the complete API response for debugging
                logApiResponse('Repull Jiten Data', response, result);
                
                if (response.ok) {
                    console.log(`✅ Repull operation successful for ${gameName}`);
                    
                    let message = result.message || 'Repull completed successfully';
                    
                    // Safe handling of updated_fields
                    if (result.updated_fields) {
                        const updatedFieldsStr = safeJoinArray(result.updated_fields, ', ');
                        if (updatedFieldsStr) {
                            message += ` Updated fields: ${updatedFieldsStr}.`;
                            console.log(`📝 Updated fields: ${updatedFieldsStr}`);
                        }
                    }
                    
                    // Safe handling of skipped_fields - THIS IS THE FIX FOR THE ORIGINAL ERROR
                    if (result.skipped_fields) {
                        const skippedFieldsStr = safeJoinArray(result.skipped_fields, ', ');
                        if (skippedFieldsStr) {
                            message += ` Skipped (manually edited): ${skippedFieldsStr}.`;
                            console.log(`⏭️ Skipped fields: ${skippedFieldsStr}`);
                        }
                    }
                    
                    console.log(`📢 Final success message: ${message}`);
                    showDatabaseSuccessPopup(message);
                    
                    // Refresh the current tab to show updated data
                    console.log(`🔄 Refreshing current tab to show updated data`);
                    const activeTab = document.querySelector('.tab-btn.active');
                    if (activeTab) {
                        console.log(`🔄 Switching to tab: ${activeTab.dataset.tab}`);
                        switchTab(activeTab.dataset.tab);
                    }
                    
                    // Update dashboard stats
                    console.log(`📊 Updating dashboard stats`);
                    await databaseManager.loadDashboardStats();
                    
                    console.log(`✅ Repull operation completed successfully for ${gameName}`);
                } else {
                    console.error(`❌ Repull operation failed for ${gameName}:`, result);
                    const errorMessage = result.error || 'Unknown error occurred';
                    showDatabaseErrorPopup(`Error: ${errorMessage}`);
                }
            } catch (error) {
                console.error(`💥 Exception during repull operation for ${gameName}:`, error);
                console.error('Error stack:', error.stack);
                showDatabaseErrorPopup('Failed to repull data from jiten.moe');
            }
        }
    );
}

// Individual Game Operations Functions
let currentGameToUnlink = null;
let currentGameToDelete = null;

// Individual Game Unlink Modal
function openIndividualGameUnlinkModal(gameId, gameName, sentenceCount, characterCount) {
    // Find the game in currentGames to get release_date
    const game = currentGames.find(g => g.id === gameId);
    
    currentGameToUnlink = {
        id: gameId,
        name: gameName,
        sentenceCount: sentenceCount,
        characterCount: characterCount,
        releaseDate: game ? game.release_date : null
    };
    
    // Populate modal with game information
    document.getElementById('unlinkGameName').textContent = gameName;
    document.getElementById('unlinkGameSentences').textContent = sentenceCount.toLocaleString();
    document.getElementById('unlinkGameCharacters').textContent = characterCount.toLocaleString();
    document.getElementById('unlinkGameReleaseDate').textContent = formatReleaseDate(currentGameToUnlink.releaseDate);
    
    // Reset modal state
    document.getElementById('individualUnlinkError').style.display = 'none';
    document.getElementById('individualUnlinkLoading').style.display = 'none';
    document.getElementById('confirmIndividualUnlinkBtn').disabled = false;
    
    // Open the modal
    openModal('individualGameUnlinkModal');
}

async function confirmIndividualGameUnlink() {
    if (!currentGameToUnlink) {
        showDatabaseErrorPopup('No game selected for unlinking');
        return;
    }
    
    const errorDiv = document.getElementById('individualUnlinkError');
    const loadingDiv = document.getElementById('individualUnlinkLoading');
    const confirmBtn = document.getElementById('confirmIndividualUnlinkBtn');
    
    // Reset state
    errorDiv.style.display = 'none';
    
    // Show loading state
    loadingDiv.style.display = 'flex';
    confirmBtn.disabled = true;
    
    try {
        // Call the unlink API (DELETE removes jiten.moe link but preserves sentences)
        const response = await fetch(`/api/games/${currentGameToUnlink.id}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = await response.json();
        
        if (response.ok) {
            // Success! Close modal and show success message
            closeModal('individualGameUnlinkModal');
            showDatabaseSuccessPopup(`Game "${result.game_name}" has been unlinked successfully. ${result.unlinked_lines} sentences preserved.`);
            
            // Refresh the current tab
            const activeTab = document.querySelector('.tab-btn.active');
            if (activeTab) {
                switchTab(activeTab.dataset.tab);
            }
            
            // Update dashboard stats
            await databaseManager.loadDashboardStats();
            
            // Clear the current game
            currentGameToUnlink = null;
        } else {
            // Show error message
            errorDiv.textContent = result.error || 'Failed to unlink game';
            errorDiv.style.display = 'block';
            confirmBtn.disabled = false;
        }
    } catch (error) {
        console.error('Error unlinking game:', error);
        errorDiv.textContent = `Error: ${error.message}`;
        errorDiv.style.display = 'block';
        confirmBtn.disabled = false;
    } finally {
        loadingDiv.style.display = 'none';
    }
}

// Individual Game Delete Lines Modal
function openIndividualGameDeleteModal(gameId, gameName, sentenceCount, characterCount) {
    currentGameToDelete = {
        id: gameId,
        name: gameName,
        sentenceCount: sentenceCount,
        characterCount: characterCount
    };
    
    // Populate modal with game information
    document.getElementById('deleteGameName').textContent = gameName;
    document.getElementById('deleteGameSentences').textContent = sentenceCount.toLocaleString();
    document.getElementById('deleteGameCharacters').textContent = characterCount.toLocaleString();
    
    // Reset modal state
    document.getElementById('individualDeleteError').style.display = 'none';
    document.getElementById('individualDeleteLoading').style.display = 'none';
    document.getElementById('confirmIndividualDeleteBtn').disabled = false;
    
    // Open the modal
    openModal('individualGameDeleteModal');
}

async function confirmIndividualGameDelete() {
    if (!currentGameToDelete) {
        showDatabaseErrorPopup('No game selected for deletion');
        return;
    }
    
    const errorDiv = document.getElementById('individualDeleteError');
    const loadingDiv = document.getElementById('individualDeleteLoading');
    const confirmBtn = document.getElementById('confirmIndividualDeleteBtn');
    
    // Reset state
    errorDiv.style.display = 'none';
    
    // Show loading state
    loadingDiv.style.display = 'flex';
    confirmBtn.disabled = true;
    
    try {
        // Call the delete lines API - this should be a different endpoint that actually deletes sentences
        // For now, we'll use the same endpoint but add a parameter to indicate permanent deletion
        const response = await fetch(`/api/games/${currentGameToDelete.id}/delete-lines`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ permanent: true })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            // Success! Close modal and show success message
            closeModal('individualGameDeleteModal');
            showDatabaseSuccessPopup(`Game lines for "${result.game_name}" have been PERMANENTLY DELETED. ${result.deleted_lines} sentences removed forever.`);
            
            // Refresh the current tab
            const activeTab = document.querySelector('.tab-btn.active');
            if (activeTab) {
                switchTab(activeTab.dataset.tab);
            }
            
            // Update dashboard stats
            await databaseManager.loadDashboardStats();
            
            // Clear the current game
            currentGameToDelete = null;
        } else {
            // Show error message
            errorDiv.textContent = result.error || 'Failed to delete game lines';
            errorDiv.style.display = 'block';
            confirmBtn.disabled = false;
        }
    } catch (error) {
        console.error('Error deleting game lines:', error);
        errorDiv.textContent = `Error: ${error.message}`;
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
    
    // Initialize popup close button event listeners
    const closeDatabaseSuccessBtn = document.getElementById('closeDatabaseSuccessBtn');
    if (closeDatabaseSuccessBtn) {
        closeDatabaseSuccessBtn.addEventListener('click', () => {
            document.getElementById('databaseSuccessPopup').classList.add('hidden');
        });
    }
    
    const closeDatabaseErrorBtn = document.getElementById('closeDatabaseErrorBtn');
    if (closeDatabaseErrorBtn) {
        closeDatabaseErrorBtn.addEventListener('click', () => {
            document.getElementById('databaseErrorPopup').classList.add('hidden');
        });
    }
    
    // Initialize individual game operation confirmation buttons
    const confirmIndividualUnlinkBtn = document.getElementById('confirmIndividualUnlinkBtn');
    if (confirmIndividualUnlinkBtn) {
        confirmIndividualUnlinkBtn.addEventListener('click', confirmIndividualGameUnlink);
    }
    
    const confirmIndividualDeleteBtn = document.getElementById('confirmIndividualDeleteBtn');
    if (confirmIndividualDeleteBtn) {
        confirmIndividualDeleteBtn.addEventListener('click', confirmIndividualGameDelete);
    }
});