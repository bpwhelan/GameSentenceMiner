// Database Jiten.moe Integration Functions
// Dependencies: shared.js (provides escapeHtml, openModal, closeModal, safeJoinArray, logApiResponse), database-popups.js, database-helpers.js

// Global flag to prevent concurrent link operations
let isLinkingInProgress = false;

/**
 * Open jiten.moe search modal for a specific game
 * @param {string} gameId - Game ID to search for
 * @param {string} gameTitle - Game title to search for
 */
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

/**
 * Search jiten.moe database
 */
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
    
    // Remove all punctuation from the search term before sending to API
    const searchTermNoPunctuation = searchTerm.replace(/[^\p{L}\p{N}\s]/gu, '');
    
    errorDiv.style.display = 'none';
    resultsDiv.style.display = 'none';
    loadingDiv.style.display = 'flex';
    
    try {
        const response = await fetch(`/api/jiten-search?title=${encodeURIComponent(searchTermNoPunctuation)}`);
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

/**
 * Render jiten.moe search results
 * @param {Array} results - Search results from jiten.moe
 */
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

/**
 * Select a jiten.moe game result
 * @param {number} resultIndex - Index of the selected result
 */
function selectJitenGame(resultIndex) {
    selectedJitenGame = jitenSearchResults[resultIndex];
    
    // Check if we're linking an existing game or creating from potential
    if (window.currentPotentialGame) {
        if (typeof showPotentialGameLinkConfirmation === 'function') {
            showPotentialGameLinkConfirmation();
        } else {
            showLinkConfirmation();
        }
    } else {
        showLinkConfirmation();
    }
}

/**
 * Show link confirmation modal
 */
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

/**
 * Confirm and execute game linking to jiten.moe
 */
async function confirmLinkGame() {
    if (!currentGameForSearch || !selectedJitenGame) {
        showDatabaseErrorPopup('Missing game or jiten data. Please try again.');
        return;
    }
    
    // Prevent concurrent link operations
    if (isLinkingInProgress) {
        console.log('Link operation already in progress, ignoring request');
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
    
    // Set global lock
    isLinkingInProgress = true;
    
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
            // Success! Close modal
            closeModal('gameLinkConfirmModal');
            
            // Log the complete API response for debugging
            logApiResponse('Link Game to Jiten', response, result);
            
            // Show success message with line count
            const lineCount = result.lines_linked || currentGameForSearch.line_count || 0;
            console.log(`✅ Game linking successful: ${lineCount} lines linked`);
            showDatabaseSuccessPopup(`Successfully linked "${currentGameForSearch.title_original}" to jiten.moe! ${lineCount} lines linked.`);
            
            // Refresh data without page reload
            await refreshAfterLinking();
            
            // Reset state for next operation
            confirmBtn.disabled = false;
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
        // Release global lock
        isLinkingInProgress = false;
    }
}

/**
 * Refresh data after successful game linking without page reload
 */
async function refreshAfterLinking() {
    console.log('🔄 Refreshing data after game linking...');
    
    try {
        // Fetch updated game data from API
        const gamesResponse = await fetch('/api/games-management');
        const gamesData = await gamesResponse.json();
        
        if (gamesResponse.ok && gamesData.games) {
            // Update the currentGames array with fresh data
            currentGames = gamesData.games;
            console.log(`✅ Updated currentGames array with ${currentGames.length} games`);
            
            // Get the current filter state
            const activeFilterBtn = document.querySelector('.game-data-filters button.primary');
            const currentFilter = activeFilterBtn ? activeFilterBtn.dataset.filter : 'all';
            
            // Re-render the games list with the current filter (this is smooth, no loading indicator)
            renderGamesList(currentGames, currentFilter);
            
            // Silently update dashboard stats in the background
            if (typeof databaseManager !== 'undefined' && databaseManager.loadGameManagementStats) {
                await databaseManager.loadGameManagementStats();
            }
        }
        
        console.log('✅ Data refresh completed successfully');
    } catch (error) {
        console.error('Error refreshing data after linking:', error);
        // Don't show error to user since the link operation itself succeeded
    }
}

/**
 * Mark a game as completed
 * @param {string} gameId - Game ID to mark as completed
 */
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

/**
 * Edit a game's information
 * @param {string} gameId - Game ID to edit
 */
function editGame(gameId) {
    const game = currentGames.find(g => g.id === gameId);
    if (!game) {
        showDatabaseErrorPopup('Game not found');
        return;
    }
    
    openEditGameModal(game);
}

/**
 * Open edit game modal with game data
 * @param {Object} game - Game object to edit
 */
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
    document.getElementById('editCharacterCount').value = game.jiten_character_count || '';
    document.getElementById('editCompleted').checked = !!game.completed;
    
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
    
    // Handle links JSON - keep the hidden field updated for compatibility
    if (game.links && game.links.length > 0) {
        document.getElementById('editLinks').value = JSON.stringify(game.links, null, 2);
        
        // Extract URLs from links array and populate the list textarea
        // Handle both array of objects and array of strings
        const urls = game.links.map(link => {
            if (typeof link === 'string') {
                return link;
            } else if (link && link.url) {
                return link.url;
            }
            return null;
        }).filter(url => url);
        
        document.getElementById('editLinksList').value = urls.join('\n');
    } else {
        document.getElementById('editLinks').value = '';
        document.getElementById('editLinksList').value = '';
    }
    
    // Handle image preview
    const imagePreview = document.getElementById('editImagePreview');
    const imagePreviewImg = document.getElementById('editImagePreviewImg');
    if (game.image) {
        imagePreviewImg.src = game.image.startsWith('data:') ? game.image : `data:image/png;base64,${game.image}`;
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

/**
 * Convert any image file to PNG format using Canvas API
 * @param {File} file - The image file to convert
 * @returns {Promise<string>} Base64 PNG data (without data URI prefix)
 */
async function convertImageToPNG(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const reader = new FileReader();
        
        reader.onload = (e) => {
            img.onload = () => {
                try {
                    // Create canvas and draw image
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    
                    // Convert to PNG base64 (remove data:image/png;base64, prefix)
                    const pngDataUrl = canvas.toDataURL('image/png');
                    const pngBase64 = pngDataUrl.split(',')[1];
                    resolve(pngBase64);
                } catch (error) {
                    reject(new Error(`Failed to convert image to PNG: ${error.message}`));
                }
            };
            img.onerror = () => reject(new Error('Failed to load image for conversion'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Failed to read image file'));
        reader.readAsDataURL(file);
    });
}

/**
 * Save game edits
 */
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
    
    // Convert links list to JSON array
    const linksListText = document.getElementById('editLinksList').value.trim();
    let linksArray = [];
    if (linksListText) {
        // Split by newlines and filter out empty lines
        const urls = linksListText.split('\n')
            .map(url => url.trim())
            .filter(url => url.length > 0);
        
        // Convert each URL to the required JSON format
        linksArray = urls.map(url => ({
            deckId: 1,
            linkId: 1,
            linkType: 2,
            url: url
        }));
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
        
        // Handle image upload - convert to PNG format
        const imageFile = document.getElementById('editImageUpload').files[0];
        if (imageFile) {
            try {
                const pngBase64 = await convertImageToPNG(imageFile);
                updateData.image = pngBase64;
            } catch (error) {
                console.error('Error converting image:', error);
                errorDiv.textContent = `Failed to process image: ${error.message}`;
                errorDiv.style.display = 'block';
                saveBtn.disabled = false;
                loadingDiv.style.display = 'none';
                return;
            }
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

/**
 * Repull data from jiten.moe for a game
 * @param {string} gameId - Game ID to repull data for
 * @param {string} gameName - Game name for display
 */
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
                    
                    // Safe handling of skipped_fields
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
                    if (typeof databaseManager !== 'undefined') {
                        await databaseManager.loadDashboardStats();
                    }
                    
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

/**
 * Initialize jiten integration event handlers
 */
function initializeJitenIntegration() {
    const jitenSearchBtn = document.getElementById('jitenSearchBtn');
    if (jitenSearchBtn) {
        jitenSearchBtn.addEventListener('click', searchJitenMoe);
    }

    // Add Enter key support for jiten search input
    const jitenSearchInput = document.getElementById('jitenSearchInput');
    if (jitenSearchInput) {
        jitenSearchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchJitenMoe();
            }
        });
    }

    const confirmLinkBtn = document.getElementById('confirmLinkBtn');
    if (confirmLinkBtn) {
        confirmLinkBtn.addEventListener('click', confirmLinkGame);
    }

    // Handle image upload preview - convert to PNG for preview
    const imageUpload = document.getElementById('editImageUpload');
    if (imageUpload) {
        imageUpload.addEventListener('change', async function(e) {
            const file = e.target.files[0];
            if (file) {
                try {
                    const pngBase64 = await convertImageToPNG(file);
                    const imagePreview = document.getElementById('editImagePreview');
                    const imagePreviewImg = document.getElementById('editImagePreviewImg');
                    imagePreviewImg.src = `data:image/png;base64,${pngBase64}`;
                    imagePreview.style.display = 'block';
                } catch (error) {
                    console.error('Error previewing image:', error);
                    alert(`Failed to preview image: ${error.message}`);
                }
            }
        });
    }
}