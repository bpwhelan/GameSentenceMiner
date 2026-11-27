// Database Individual Game Operations Functions
// Dependencies: shared.js (provides escapeHtml, openModal, closeModal), database-popups.js, database-helpers.js

// Global variables for individual game operations
let currentGameToUnlink = null;
let currentGameToDelete = null;
let archiveRequestRunning = false;

async function runDatabaseMaintenanceJob(url, body, onProgress) {
    const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Unable to start database maintenance');
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const poll = await fetch(`/api/database/maintenance/jobs/${encodeURIComponent(job.id)}`);
        const progress = await poll.json();
        if (!poll.ok || progress.status === 'failed') throw new Error(progress.error || 'Database maintenance failed');
        if (onProgress) onProgress(progress);
        if (progress.status === 'completed') return progress.result;
    }
}

async function archiveGames(gameIds, options = {}) {
    if (archiveRequestRunning || !gameIds.length) return;
    archiveRequestRunning = true;
    const notify = options.onStatus || showDatabaseSuccessPopup;
    try {
        notify('Checking selected games…');
        const response = await fetch('/api/games/archive/preview', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({game_ids: gameIds})
        });
        const preview = await response.json();
        if (!response.ok) throw new Error(preview.error || 'Unable to preview archive');
        if (!preview.raw_lines) {
            notify('The selected games have no original sentences left to archive. Their saved statistics remain available.');
            return;
        }
        if (!window.confirm(`Archive ${preview.raw_lines.toLocaleString()} original sentences across ${preview.game_count.toLocaleString()} selected games?\n\nReading statistics, mined-card totals, kanji frequencies, and available word frequencies will be preserved. Original sentences and translations will be saved in a compressed file per game, then removed from the database. You can restore them from Tools while you keep the files.\n\nArchive these games?`)) {
            notify('Archive cancelled.');
            return;
        }
        notify(`Archiving ${preview.game_count.toLocaleString()} selected games…`);
        const result = await runDatabaseMaintenanceJob('/api/games/archive', {game_ids: gameIds, confirm: true}, progress => {
            if (progress.status === 'running' && progress.total_games) {
                notify(`Archiving games: ${progress.completed_games} of ${progress.total_games} processed.` +
                    (progress.current_game ? ` Currently archiving ${progress.current_game}.` : ''));
            }
        });
        let message = `Archived ${result.archived_lines.toLocaleString()} sentences across ${result.archived_games.toLocaleString()} games. Statistics are preserved and original sentences are saved in ZIP files. Manage saved files or use Vacuum now in Tools to reclaim unused database space.`;
        if (result.skipped_games) message += ` ${result.skipped_games} games had no original sentences to archive.`;
        if (result.failed_games.length) {
            message += ` Could not archive ${result.failed_games.length} games: ` +
                result.failed_games.map(game => `${game.game_name}: ${game.error}`).join('; ');
        }
        notify(message);
        await refreshGameManagementView();
        if (typeof loadDatabaseMaintenance === 'function') await loadDatabaseMaintenance();
        if (typeof loadArchiveFiles === 'function') await loadArchiveFiles();
        if (typeof databaseManager !== 'undefined') await databaseManager.loadDashboardStats();
        return result;
    } catch (error) {
        if (options.onStatus) options.onStatus(error.message);
        else showDatabaseErrorPopup(error.message);
    } finally { archiveRequestRunning = false; }
}

async function archiveGame(gameId, options = {}) {
    if (archiveRequestRunning) return;
    archiveRequestRunning = true;
    const notify = options.onStatus || showDatabaseSuccessPopup;
    try {
        const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/archive`);
        const preview = await response.json();
        if (!response.ok) throw new Error(preview.error || 'Unable to preview archive');
        if (!preview.raw_lines) {
            notify('This game has no original sentences left to archive. Its saved statistics remain available.');
            return;
        }
        if (!window.confirm(`Archive ${preview.raw_lines.toLocaleString()} original sentences?\n\nReading statistics, mined-card totals, kanji frequencies, and available word frequencies will be preserved. Original sentences and translations will be saved in a compressed file for this game, then removed from the database. You can restore them from Tools while you keep the file.\n\nArchive this game?`)) return;
        notify('Archiving game… This can take a while for large games.');
        const result = await runDatabaseMaintenanceJob(`/api/games/${encodeURIComponent(gameId)}/archive`, {confirm: true});
        notify(`Archived ${result.archived_lines.toLocaleString()} sentences. Statistics are preserved and original sentences are saved in a ZIP file. Manage saved files or use Vacuum now in Tools to reclaim unused database space.`);
        await refreshGameManagementView();
        if (typeof loadDatabaseMaintenance === 'function') await loadDatabaseMaintenance();
        if (typeof loadArchiveFiles === 'function') await loadArchiveFiles();
        if (typeof databaseManager !== 'undefined') await databaseManager.loadDashboardStats();
        return true;
    } catch (error) {
        if (options.onStatus) options.onStatus(error.message);
        else showDatabaseErrorPopup(error.message);
    }
    finally { archiveRequestRunning = false; }
}

/**
 * Refresh whichever game-management view is hosting these shared operations.
 */
async function refreshGameManagementView() {
    const activeTab = document.querySelector('.tab-btn.active');
    if (activeTab) {
        await switchTab(activeTab.dataset.tab);
    } else if (typeof loadGamesForDataManagement === 'function') {
        // Standalone Games page replaces this loader with its card-grid refresh.
        await loadGamesForDataManagement();
    }
}

/**
 * Open individual game unlink confirmation modal
 * @param {string} gameId - Game ID to unlink
 * @param {string} gameName - Game name for display
 * @param {number} sentenceCount - Number of sentences
 * @param {number} characterCount - Number of characters
 */
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

/**
 * Confirm and execute individual game unlink operation
 */
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
            
            await refreshGameManagementView();
            
            // Update dashboard stats
            if (typeof databaseManager !== 'undefined') {
                await databaseManager.loadDashboardStats();
            }
            
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

/**
 * Open individual game delete lines confirmation modal
 * @param {string} gameId - Game ID to delete lines for
 * @param {string} gameName - Game name for display
 * @param {number} sentenceCount - Number of sentences
 * @param {number} characterCount - Number of characters
 */
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

/**
 * Confirm and execute individual game delete lines operation
 */
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
            
            await refreshGameManagementView();
            
            // Update dashboard stats
            if (typeof databaseManager !== 'undefined') {
                await databaseManager.loadDashboardStats();
            }
            
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

/**
 * Initialize individual game operations event handlers
 */
function initializeGameOperations() {
    // Individual game operation confirmation buttons
    const confirmIndividualUnlinkBtn = document.getElementById('confirmIndividualUnlinkBtn');
    if (confirmIndividualUnlinkBtn) {
        confirmIndividualUnlinkBtn.addEventListener('click', confirmIndividualGameUnlink);
    }
    
    const confirmIndividualDeleteBtn = document.getElementById('confirmIndividualDeleteBtn');
    if (confirmIndividualDeleteBtn) {
        confirmIndividualDeleteBtn.addEventListener('click', confirmIndividualGameDelete);
    }
}
