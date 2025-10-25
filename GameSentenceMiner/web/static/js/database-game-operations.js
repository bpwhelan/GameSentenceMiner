// Database Individual Game Operations Functions
// Dependencies: shared.js (provides escapeHtml, openModal, closeModal), database-popups.js, database-helpers.js

// Global variables for individual game operations
let currentGameToUnlink = null;
let currentGameToDelete = null;

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
            
            // Refresh the current tab
            const activeTab = document.querySelector('.tab-btn.active');
            if (activeTab) {
                switchTab(activeTab.dataset.tab);
            }
            
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
            
            // Refresh the current tab
            const activeTab = document.querySelector('.tab-btn.active');
            if (activeTab) {
                switchTab(activeTab.dataset.tab);
            }
            
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