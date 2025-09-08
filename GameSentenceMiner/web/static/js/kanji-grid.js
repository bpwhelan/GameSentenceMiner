/**
 * Shared Kanji Grid Renderer Component
 * Handles rendering kanji grids with configurable options for different use cases
 */

class KanjiGridRenderer {
    constructor(options = {}) {
        // Default configuration
        this.config = {
            containerSelector: '#kanjiGrid',
            counterSelector: '#kanjiCount',
            colorMode: 'backend', // 'backend' or 'frequency'
            clickHandler: null, // Custom click handler, defaults to search navigation
            emptyMessage: 'No kanji data available',
            showCounter: true,
            showLegend: true,
            ...options
        };
        
        // Get DOM elements
        this.container = document.querySelector(this.config.containerSelector);
        this.counter = this.config.counterSelector ? document.querySelector(this.config.counterSelector) : null;
        
        if (!this.container) {
            console.error(`KanjiGridRenderer: Container not found with selector: ${this.config.containerSelector}`);
            return;
        }
    }
    
    /**
     * Render the kanji grid with provided data
     * @param {Object|Array} kanjiData - Kanji data to render
     */
    render(kanjiData) {
        if (!kanjiData) {
            this.renderEmpty();
            return;
        }
        
        // Handle different data formats
        let kanjiList = [];
        if (Array.isArray(kanjiData)) {
            kanjiList = kanjiData;
        } else if (kanjiData.kanji_data && Array.isArray(kanjiData.kanji_data)) {
            kanjiList = kanjiData.kanji_data;
            // Update counter if available
            if (this.counter && this.config.showCounter) {
                this.counter.textContent = kanjiData.unique_count || kanjiList.length;
            }
        } else {
            this.renderEmpty();
            return;
        }
        
        if (kanjiList.length === 0) {
            this.renderEmpty();
            return;
        }
        
        // Update counter
        if (this.counter && this.config.showCounter) {
            this.counter.textContent = kanjiList.length;
        }
        
        // Clear existing grid
        this.container.innerHTML = '';
        
        // Render kanji cells
        kanjiList.forEach(item => {
            const cell = this.createKanjiCell(item);
            this.container.appendChild(cell);
        });
    }
    
    /**
     * Create individual kanji cell element
     * @param {Object} item - Kanji item with kanji character and frequency
     * @returns {HTMLElement} - Kanji cell element
     */
    createKanjiCell(item) {
        const cell = document.createElement('span');
        cell.className = 'kanji-cell';
        cell.textContent = item.kanji;
        
        // Apply colors based on mode
        if (this.config.colorMode === 'backend' && item.color) {
            // Use backend-provided color
            cell.style.backgroundColor = item.color;
            // Determine text color based on background brightness
            const brightness = this.getColorBrightness(item.color);
            cell.style.color = brightness > 128 ? '#333' : '#fff';
        } else if (this.config.colorMode === 'frequency' && item.frequency) {
            // Calculate color based on frequency
            const color = this.getFrequencyColor(item.frequency);
            cell.style.backgroundColor = color;
            // Determine text color for better contrast
            if (item.frequency > 100) {
                cell.style.color = 'white';
            }
        }
        
        // Add tooltip
        cell.title = `${item.kanji}: ${item.frequency} encounters`;
        
        // Add click handler
        const clickHandler = this.config.clickHandler || this.defaultClickHandler;
        if (clickHandler) {
            cell.style.cursor = 'pointer';
            cell.addEventListener('click', () => clickHandler(item));
        }
        
        return cell;
    }
    
    /**
     * Default click handler - navigate to search page
     * @param {Object} item - Kanji item
     */
    defaultClickHandler(item) {
        window.location.href = `/search?q=${encodeURIComponent(item.kanji)}`;
    }
    
    /**
     * Get color based on frequency (client-side calculation)
     * @param {number} frequency - Kanji frequency
     * @returns {string} - CSS color value
     */
    getFrequencyColor(frequency) {
        if (frequency > 500) return '#2ee6e0';  // Cyan for very frequent
        else if (frequency > 100) return '#3be62f';  // Green for frequent
        else if (frequency > 30) return '#e6dc2e';   // Yellow for moderate
        else if (frequency > 10) return '#e6342e';   // Red for occasional
        else return '#ebedf0';  // Gray for rare
    }
    
    /**
     * Calculate color brightness for text contrast
     * @param {string} hexColor - Hex color value
     * @returns {number} - Brightness value (0-255)
     */
    getColorBrightness(hexColor) {
        // Convert hex to RGB
        const hex = hexColor.replace('#', '');
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        
        // Calculate brightness using standard formula
        return (r * 299 + g * 587 + b * 114) / 1000;
    }
    
    /**
     * Render empty state
     */
    renderEmpty() {
        this.container.innerHTML = `<div style="color:var(--text-secondary);padding:16px;text-align:center;">${this.config.emptyMessage}</div>`;
        
        if (this.counter && this.config.showCounter) {
            this.counter.textContent = '0';
        }
    }
    
    /**
     * Create and render legend (static, always the same)
     * @param {HTMLElement} legendContainer - Container for legend
     */
    renderLegend(legendContainer) {
        if (!legendContainer || !this.config.showLegend) return;
        
        legendContainer.innerHTML = `
            <div class="kanji-legend">
                <span>Rarely Seen</span>
                <div class="kanji-legend-item" style="background-color: #ebedf0;" title="No encounters"></div>
                <div class="kanji-legend-item" style="background-color: #e6342e;" title="Seen once"></div>
                <div class="kanji-legend-item" style="background-color: #e6dc2e;" title="Occasionally seen"></div>
                <div class="kanji-legend-item" style="background-color: #3be62f;" title="Frequently seen"></div>
                <div class="kanji-legend-item" style="background-color: #2ee6e0;" title="Most frequently seen"></div>
                <span>Frequently Seen</span>
            </div>
        `;
    }
    
    /**
     * Update configuration
     * @param {Object} newConfig - New configuration options
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }
    
    /**
     * Clear the grid
     */
    clear() {
        this.container.innerHTML = '';
        if (this.counter && this.config.showCounter) {
            this.counter.textContent = '0';
        }
    }
}

// Export for use in other scripts
window.KanjiGridRenderer = KanjiGridRenderer;