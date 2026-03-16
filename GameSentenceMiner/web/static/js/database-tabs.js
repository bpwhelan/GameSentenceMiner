// Database Tab Management Functions
// Dependencies: shared.js (provides openModal, closeModal)

/**
 * Switch between tabs in the game data modal
 * @param {string} tabName - Name of the tab to switch to
 */
function switchTab(tabName) {
    // Hide all tab contents within the game data modal only
    const modal = document.getElementById('gameDataModal');
    if (!modal) return;
    modal.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
        tab.style.display = 'none';
    });
    
    // Remove active class from tab buttons within the game data modal only
    modal.querySelectorAll('.tab-btn').forEach(btn => {
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
        } else if (tabName === 'tasks' && typeof loadCronTasks === 'function') {
            loadCronTasks();
        }
    }
}

function getActiveGameDataTabButton() {
    const modal = document.getElementById('gameDataModal');
    if (!modal) return null;
    return modal.querySelector('.tab-btn[data-tab].active');
}

function getActiveGameDataTabName() {
    const activeTab = getActiveGameDataTabButton();
    return activeTab ? activeTab.dataset.tab : null;
}

/**
 * Open the game data modal and switch to Link Games tab by default
 */
async function openGameDataModal() {
    openModal('gameDataModal');
    // Default to Link Games tab
    switchTab('linkGames');
}

/**
 * Initialize tab navigation event handlers
 */
function initializeTabHandlers() {
    // Tab navigation handlers — only for the game data modal's [data-tab] buttons
    const gameDataModal = document.getElementById('gameDataModal');
    if (gameDataModal) {
        gameDataModal.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
            btn.addEventListener('click', (e) => switchTab(e.target.dataset.tab));
        });
    }

    // Game data management handlers
    const openGameDataBtn = document.querySelector('[data-action="openGameDataModal"]');
    if (openGameDataBtn) {
        openGameDataBtn.addEventListener('click', openGameDataModal);
    }
}
