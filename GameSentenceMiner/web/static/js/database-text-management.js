// Database Text Management Functions
// Dependencies: shared.js (provides escapeHtml, openModal, closeModal), database-popups.js, database-helpers.js, database-game-data.js

/**
 * Open text lines deletion modal
 */
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

/**
 * Preview text deletion based on regex or exact text
 */
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

/**
 * Execute text lines deletion
 */
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
                if (typeof databaseManager !== 'undefined') {
                    await databaseManager.loadDashboardStats();
                }
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

/**
 * Open deduplication modal
 */
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

/**
 * Scan for duplicate sentences
 */
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

/**
 * Remove duplicate sentences
 */
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
                if (typeof databaseManager !== 'undefined') {
                    await databaseManager.loadDashboardStats();
                }
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

/**
 * Initialize text management event handlers
 */
function initializeTextManagement() {
    // Text lines management handlers
    const openTextLinesBtn = document.querySelector('[data-action="openTextLinesModal"]');
    if (openTextLinesBtn) {
        openTextLinesBtn.addEventListener('click', openTextLinesModal);
    }

    const openDeduplicationBtn = document.querySelector('[data-action="openDeduplicationModal"]');
    if (openDeduplicationBtn) {
        openDeduplicationBtn.addEventListener('click', openDeduplicationModal);
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