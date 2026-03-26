// Database Jiten.moe Integration Functions
// Dependencies: shared.js (provides escapeHtml, openModal, closeModal, safeJoinArray, logApiResponse), database-popups.js, database-helpers.js

// Global flag to prevent concurrent link operations
let isLinkingInProgress = false;

let databaseGameImportWidget = null;

function getDatabaseGameImportWidget() {
    if (!databaseGameImportWidget) {
        if (!window.GameImportWidget || typeof window.GameImportWidget.create !== 'function') {
            throw new Error('Game import widget is not loaded. Please refresh the page.');
        }

        databaseGameImportWidget = window.GameImportWidget.create({
            isBusy() {
                return isLinkingInProgress;
            },
            setBusy(isBusy) {
                isLinkingInProgress = isBusy;
            },
            buildCurrentPreviewHtml(context, helpers) {
                return `
                    <div class="preview-header">
                        <h5>${helpers.escapeHtml(context.game.title_original || context.displayName || '')}</h5>
                        <div class="preview-stats">
                            ${helpers.formatNumber(context.game.line_count)} lines,
                            ${helpers.formatNumber(context.game.mined_character_count)} mined characters
                            ${context.game.jiten_character_count > 0 ? `<br>Game Total: ${helpers.formatNumber(context.game.jiten_character_count)} chars` : ''}
                        </div>
                    </div>
                `;
            },
            async onSuccess(payload) {
                const gameTitle = payload.context.game.title_original || payload.context.displayName || 'Game';
                const linkedLineCount = payload.apiResult.lines_linked || payload.context.game.line_count || 0;

                if (payload.isJitenSource) {
                    console.log(`✅ Game linking to ${payload.sourceLabel} successful: ${linkedLineCount} lines linked`);
                    showDatabaseSuccessPopup(`Successfully linked "${gameTitle}" to ${payload.sourceLabel}! ${linkedLineCount} lines linked.`);
                } else if (payload.source === 'igdb') {
                    console.log(`✅ Game metadata updated from ${payload.sourceLabel}`);
                    showDatabaseSuccessPopup(
                        `Successfully updated "${gameTitle}" with ${payload.sourceLabel} metadata! Note: IGDB does not include character data.`
                    );
                } else {
                    console.log(`✅ Game metadata updated from ${payload.sourceLabel}`);
                    showDatabaseSuccessPopup(
                        `Successfully updated "${gameTitle}" with ${payload.sourceLabel} metadata! Note: Character counts and difficulty are only available from Jiten.`
                    );
                }

                await refreshAfterLinking();
            },
            onError(error) {
                console.error('Error linking game:', error);
            },
        });
    }

    return databaseGameImportWidget;
}

function openJitenSearch(gameId, gameTitle) {
    if (!gameId || gameId === 'undefined' || gameId === 'null') {
        showDatabaseErrorPopup('Cannot link game: Invalid game ID. Please refresh the page and try again.');
        console.error(`Invalid gameId provided to openJitenSearch: ${gameId}`);
        return;
    }

    currentGameForSearch = currentGames.find(game => game.id === gameId);
    if (!currentGameForSearch) {
        showDatabaseErrorPopup(`Cannot find game with ID: ${gameId}. Please refresh the page and try again.`);
        console.error(`Game not found in currentGames: ${gameId}`);
        return;
    }

    if (!currentGameForSearch.id) {
        showDatabaseErrorPopup('Game data is incomplete (missing ID). Please refresh the page and try again.');
        console.error('Game found but has no ID:', currentGameForSearch);
        return;
    }

    try {
        getDatabaseGameImportWidget().open({
            gameId: currentGameForSearch.id,
            game: currentGameForSearch,
            displayName: gameTitle || currentGameForSearch.title_original || '',
            searchTerm: gameTitle || currentGameForSearch.title_original || '',
        });
    } catch (error) {
        showDatabaseErrorPopup(error.message);
        console.error('Failed to open shared game import widget:', error);
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
    document.getElementById('editVndbId').value = game.vndb_id || '';
    document.getElementById('editAnilistId').value = game.anilist_id || '';
    document.getElementById('editCharacterCount').value = game.jiten_character_count || '';
    document.getElementById('editCompleted').checked = !!game.completed;
    document.getElementById('editCharacterSummary').value = game.character_summary || '';
    
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
        const characterSummary = document.getElementById('editCharacterSummary').value.trim();
        const updateData = {
            title_original: titleOriginal,
            title_romaji: document.getElementById('editTitleRomaji').value.trim(),
            title_english: document.getElementById('editTitleEnglish').value.trim(),
            type: document.getElementById('editType').value,
            description: document.getElementById('editDescription').value.trim(),
            completed: document.getElementById('editCompleted').checked,
            character_summary: characterSummary || null
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
        
        const vndbId = document.getElementById('editVndbId').value.trim();
        if (vndbId) {
            updateData.vndb_id = vndbId;
        }
        
        const anilistId = document.getElementById('editAnilistId').value.trim();
        if (anilistId) {
            updateData.anilist_id = anilistId;
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
 * Repull data from the associated data source for a game
 * Supports Jiten.moe, VNDB, AniList, and IGDB - will automatically detect the source
 * @param {string} gameId - Game ID to repull data for
 * @param {string} gameName - Game name for display
 */
async function repullJitenData(gameId, gameName) {
    console.log(`🔄 Starting repull operation for game: ${gameName} (ID: ${gameId})`);
    
    showDatabaseConfirmPopup(
        `Repull data for "${gameName}"? This will update all non-manually edited fields with fresh data from the linked source (Jiten, VNDB, AniList, or IGDB).`,
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
                logApiResponse('Repull Game Data', response, result);
                
                if (response.ok) {
                    console.log(`✅ Repull operation successful for ${gameName}`);
                    
                    let message = result.message || 'Repull completed successfully';
                    
                    // Show which sources were used
                    if (result.sources_used) {
                        const sourcesStr = safeJoinArray(result.sources_used, ', ');
                        if (sourcesStr) {
                            message += ` Sources: ${sourcesStr}.`;
                            console.log(`📦 Sources used: ${sourcesStr}`);
                        }
                    }
                    
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
                showDatabaseErrorPopup('Failed to repull game data');
            }
        }
    );
}

/**
 * Initialize jiten integration event handlers
 */
function initializeJitenIntegration() {
    if (document.getElementById('linkSearchModal')) {
        try {
            getDatabaseGameImportWidget();
        } catch (error) {
            console.error('Failed to initialize shared game import widget:', error);
        }
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
