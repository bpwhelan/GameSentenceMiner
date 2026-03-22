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
 * Format a Unix timestamp for display in the local timezone.
 * @param {number|null|undefined} timestamp - Unix timestamp in seconds
 * @param {string} fallback - Fallback label when no timestamp is available
 * @returns {string} Formatted timestamp string
 */
function formatUnixTimestamp(timestamp, fallback = 'Never') {
    if (timestamp === null || timestamp === undefined || timestamp === '') {
        return fallback;
    }

    const numericTimestamp = Number(timestamp);
    if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) {
        return fallback;
    }

    const date = new Date(numericTimestamp * 1000);
    if (Number.isNaN(date.getTime())) {
        return fallback;
    }

    return date.toLocaleString();
}

/**
 * Format a game difficulty bucket for display.
 * @param {Object|null|undefined} game - Game object with difficulty metadata
 * @returns {string} Difficulty label or empty string when unavailable
 */
function formatGameDifficultyLabel(game) {
    const difficultyLabels = ['Beginner', 'Easy', 'Average', 'Hard', 'Expert', 'Insane'];

    if (!game) {
        return '';
    }

    if (game.difficulty_label) {
        return game.difficulty_label;
    }

    if (game.difficulty === null || game.difficulty === undefined || game.difficulty === '') {
        return '';
    }

    const difficultyValue = Number(game.difficulty);
    if (Number.isNaN(difficultyValue)) {
        return '';
    }

    const bucket = Math.min(
        Math.max(Math.floor(difficultyValue), 0),
        difficultyLabels.length - 1
    );

    return difficultyLabels[bucket];
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
