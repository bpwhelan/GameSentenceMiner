// Database Helper Functions
// Dependencies: shared.js (provides escapeHtml and other utility functions)

/**
 * Format release date for display
 * @param {string} releaseDate - ISO date string or null
 * @returns {string} Formatted date string
 */
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

/**
 * Toggle visibility of time window controls based on checkbox state
 */
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