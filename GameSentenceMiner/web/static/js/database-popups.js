// Database Popup Management Functions
// Dependencies: shared.js (provides escapeHtml)

/**
 * Show success popup with message
 * @param {string} message - Success message to display
 */
function showDatabaseSuccessPopup(message) {
    const popup = document.getElementById('databaseSuccessPopup');
    const messageEl = document.getElementById('databaseSuccessMessage');
    if (popup && messageEl) {
        messageEl.textContent = message;
        popup.classList.remove('hidden');
    }
}

/**
 * Show error popup with message
 * @param {string} message - Error message to display
 */
function showDatabaseErrorPopup(message) {
    const popup = document.getElementById('databaseErrorPopup');
    const messageEl = document.getElementById('databaseErrorMessage');
    if (popup && messageEl) {
        messageEl.textContent = message;
        popup.classList.remove('hidden');
    }
}

/**
 * Show confirmation popup with message and callback
 * @param {string} message - Confirmation message to display
 * @param {Function} onConfirm - Callback function to execute on confirmation
 */
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

/**
 * Close all database popups
 */
function closeDatabasePopups() {
    ['databaseSuccessPopup', 'databaseErrorPopup', 'databaseConfirmPopup'].forEach(id => {
        const popup = document.getElementById(id);
        if (popup) popup.classList.add('hidden');
    });
}

/**
 * Initialize database popup close button event listeners
 */
function initializeDatabasePopups() {
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
}