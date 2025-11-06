// Database Game Data Management Functions
// Dependencies: shared.js (provides escapeHtml, openModal, closeModal), database-helpers.js (provides formatReleaseDate), database-popups.js

// Global variables for game data management
let currentGames = [];
let currentGameForSearch = null;
let selectedJitenGame = null;
let jitenSearchResults = []; // Global storage for search results

/**
 * Load games for the Link Games tab (data management)
 */
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

/**
 * Render games list with filtering
 * @param {Array} games - Array of game objects
 * @param {string} filter - Filter type ('all', 'linked', 'unlinked')
 */
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
                    ${game.image ? `<img src="${game.image.startsWith('data:') ? game.image : 'data:image/png;base64,' + game.image}" class="game-thumbnail" alt="Game cover">` : '<div class="game-thumbnail-placeholder">🎮</div>'}
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
                    <span class="stat-item">${game.mined_character_count.toLocaleString()} read</span>
                    ${game.jiten_character_count > 0 ? `<span class="stat-item">Total: ${game.jiten_character_count.toLocaleString()} chars (${((game.mined_character_count / game.jiten_character_count) * 100).toFixed(1)}%)</span>` : ''}
                    <span class="stat-item">Started: ${startDate}</span>
                    <span class="stat-item">Last: ${lastPlayed}</span>
                    ${game.release_date ? `<span class="stat-item">Released: ${formatReleaseDate(game.release_date)}</span>` : ''}
                </div>
                ` : ''}
                <div class="game-actions">
                    ${!game.is_linked ? `<button class="action-btn primary jiten-search-btn" data-game-id="${game.id}" data-title="${escapeHtml(game.title_original)}">🔍 Search jiten.moe</button>` : ''}
                    ${game.is_linked ? `<button class="action-btn warning repull-jiten-btn" data-game-id="${game.id}" data-title="${escapeHtml(game.title_original)}">🔄 Repull from Jiten</button>` : ''}
                    <button class="action-btn edit-game-btn" data-game-id="${game.id}">📝 Edit</button>
                    ${!game.completed ? `<button class="action-btn success mark-complete-btn" data-game-id="${game.id}">🏁 Mark Complete</button>` : ''}
                </div>
                ${game.description ? `<div class="game-description">${escapeHtml(game.description)}</div>` : ''}
            `;
            
            gamesList.appendChild(gameItem);
        });

        // Attach event listeners to action buttons
        gamesList.querySelectorAll('.jiten-search-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                openJitenSearch(btn.getAttribute('data-game-id'), btn.getAttribute('data-title'));
            });
        });
        gamesList.querySelectorAll('.repull-jiten-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                repullJitenData(btn.getAttribute('data-game-id'), btn.getAttribute('data-title'));
            });
        });
        gamesList.querySelectorAll('.edit-game-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                editGame(btn.getAttribute('data-game-id'));
            });
        });
        gamesList.querySelectorAll('.mark-complete-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                markGameCompleted(btn.getAttribute('data-game-id'));
            });
        });
    } else {
        // Show empty state if no games
        gamesList.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); padding: 40px;">
                <p>No games found.</p>
                <p>Start playing games to see them appear here!</p>
            </div>
        `;
    }
}

/**
 * Filter games by type
 * @param {string} filter - Filter type ('all', 'linked', 'unlinked')
 */
function filterGames(filter) {
    renderGamesList(currentGames, filter);
}

/**
 * Load games for the Manage Games tab
 */
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
            
            // Sort games alphabetically by title_original
            games.sort((a, b) => {
                const titleA = (a.title_original || '').toLowerCase();
                const titleB = (b.title_original || '').toLowerCase();
                return titleA.localeCompare(titleB);
            });
            
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
                        ${game.image ? `<img src="${game.image.startsWith('data:') ? game.image : 'data:image/png;base64,' + game.image}" class="game-thumbnail" alt="Game cover">` : '<div class="game-thumbnail-placeholder">🎮</div>'}
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
                        <span class="stat-item">${game.mined_character_count.toLocaleString()} read</span>
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

/**
 * Load games for bulk operations tab
 */
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
            // Sort games alphabetically by name
            data.games.sort((a, b) => {
                const nameA = (a.name || '').toLowerCase();
                const nameB = (b.name || '').toLowerCase();
                return nameA.localeCompare(nameB);
            });
            
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

/**
 * Load games for deduplication
 */
async function loadGamesForDeduplication() {
    try {
        const response = await fetch('/api/games-list');
        const data = await response.json();
        
        if (response.ok && data.games) {
            // Sort games alphabetically by name
            data.games.sort((a, b) => {
                const nameA = (a.name || '').toLowerCase();
                const nameB = (b.name || '').toLowerCase();
                return nameA.localeCompare(nameB);
            });
            
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

/**
 * Initialize game data filter buttons
 */
function initializeGameDataFilters() {
    // Game data filter buttons
    const filterButtons = document.querySelectorAll('.game-data-filters button');
    filterButtons.forEach(btn => {
        btn.addEventListener('click', (event) => filterGames(event.target.dataset.filter));
    });
}