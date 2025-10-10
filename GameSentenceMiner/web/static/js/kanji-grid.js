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
            enableSorting: true, // Enable sorting dropdown
            ...options
        };
        
        // Get DOM elements
        this.container = document.querySelector(this.config.containerSelector);
        this.counter = this.config.counterSelector ? document.querySelector(this.config.counterSelector) : null;
        
        if (!this.container) {
            console.error(`KanjiGridRenderer: Container not found with selector: ${this.config.containerSelector}`);
            return;
        }
        
        // Sorting state
        this.currentKanjiData = null;
        this.sortingConfigs = [];
        this.currentSortMode = 'frequency'; // 'frequency' or config filename
        
        // Initialize sorting if enabled
        if (this.config.enableSorting) {
            this.initializeSorting();
        }
    }
    
    /**
     * Initialize sorting functionality
     */
    async initializeSorting() {
        try {
            // Load saved preference
            this.currentSortMode = this.loadSortPreference();
            
            // Fetch available sorting configs
            await this.loadSortingConfigs();
            
            // Create dropdown UI
            this.createSortDropdown();
        } catch (error) {
            console.error('Failed to initialize sorting:', error);
        }
    }
    
    /**
     * Load available sorting configurations from API
     */
    async loadSortingConfigs() {
        try {
            const response = await fetch('/api/kanji-sorting-configs');
            const data = await response.json();
            this.sortingConfigs = data.configs || [];
        } catch (error) {
            console.error('Failed to load sorting configs:', error);
            this.sortingConfigs = [];
        }
    }
    
    /**
     * Create and insert the sort dropdown UI
     */
    createSortDropdown() {
        // Create dropdown container
        const dropdownContainer = document.createElement('div');
        dropdownContainer.className = 'kanji-sort-dropdown-container';
        
        const label = document.createElement('label');
        label.textContent = 'Sort by: ';
        label.className = 'kanji-sort-label';
        
        const select = document.createElement('select');
        select.className = 'kanji-sort-dropdown';
        select.id = 'kanjiSortDropdown';
        
        // Add "Frequency (default)" option
        const freqOption = document.createElement('option');
        freqOption.value = 'frequency';
        freqOption.textContent = 'Frequency (default)';
        select.appendChild(freqOption);
        
        // Add options from loaded configs
        this.sortingConfigs.forEach(config => {
            const option = document.createElement('option');
            option.value = config.filename;
            option.textContent = config.name;
            select.appendChild(option);
        });
        
        // Set current value
        select.value = this.currentSortMode;
        
        // Add change handler
        select.addEventListener('change', (e) => this.handleSortChange(e.target.value));
        
        dropdownContainer.appendChild(label);
        dropdownContainer.appendChild(select);
        
        // Insert at the top of the container
        this.container.parentElement.insertBefore(dropdownContainer, this.container);
    }
    
    /**
     * Handle sort mode change
     * @param {string} sortMode - Selected sort mode
     */
    async handleSortChange(sortMode) {
        this.currentSortMode = sortMode;
        this.saveSortPreference(sortMode);
        
        // Re-render with current data
        if (this.currentKanjiData) {
            await this.render(this.currentKanjiData);
        }
    }
    
    /**
     * Save sort preference to localStorage
     * @param {string} sortMode - Sort mode to save
     */
    saveSortPreference(sortMode) {
        try {
            localStorage.setItem('kanjiGridSortMode', sortMode);
        } catch (error) {
            console.error('Failed to save sort preference:', error);
        }
    }
    
    /**
     * Load sort preference from localStorage
     * @returns {string} Saved sort mode or 'frequency' as default
     */
    loadSortPreference() {
        try {
            return localStorage.getItem('kanjiGridSortMode') || 'frequency';
        } catch (error) {
            console.error('Failed to load sort preference:', error);
            return 'frequency';
        }
    }
    
    /**
     * Render the kanji grid with provided data
     * @param {Object|Array} kanjiData - Kanji data to render
     */
    async render(kanjiData) {
        if (!kanjiData) {
            this.renderEmpty();
            return;
        }
        
        // Store current data for re-rendering
        this.currentKanjiData = kanjiData;
        
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
        
        // Clear existing grid and reset classes
        this.container.innerHTML = '';
        this.container.classList.remove('flat-mode');
        
        // Render based on current sort mode
        if (this.currentSortMode === 'frequency') {
            this.renderFlat(kanjiList);
        } else {
            await this.renderGrouped(kanjiList, this.currentSortMode);
        }
    }
    
    /**
     * Render kanji in flat/frequency mode
     * @param {Array} kanjiList - List of kanji items
     */
    renderFlat(kanjiList) {
        // Add flat-mode class for CSS Grid layout
        this.container.classList.add('flat-mode');
        
        kanjiList.forEach(item => {
            const cell = this.createKanjiCell(item);
            this.container.appendChild(cell);
        });
    }
    
    /**
     * Render kanji in grouped mode based on JSON configuration
     * @param {Array} kanjiList - List of kanji items
     * @param {string} configFilename - Configuration filename
     */
    async renderGrouped(kanjiList, configFilename) {
        // Remove flat-mode class for block layout
        this.container.classList.remove('flat-mode');
        
        try {
            // Fetch the sorting configuration
            const response = await fetch(`/api/kanji-sorting-config/${configFilename}`);
            if (!response.ok) {
                console.error('Failed to load sorting config, falling back to frequency');
                this.renderFlat(kanjiList);
                return;
            }
            
            const config = await response.json();
            let groups = config.groups || [];
            
            // Create a map for quick kanji lookup
            const kanjiMap = new Map();
            kanjiList.forEach(item => {
                kanjiMap.set(item.kanji, item);
            });
            
            // Handle leftover kanji (add as additional group if exists)
            if (config.leftover_group) {
                const leftoverKanji = Array.from(kanjiMap.values()).filter(item => {
                    return !groups.some(group =>
                        group.characters && group.characters.includes(item.kanji)
                    );
                });
                
                if (leftoverKanji.length > 0) {
                    groups = [...groups, {
                        name: config.leftover_group,
                        characters: leftoverKanji.map(item => item.kanji).join('')
                    }];
                }
            }
            
            // Render each group in stacked layout
            groups.forEach(group => {
                const groupSection = this.createGroupSection(group, kanjiMap);
                this.container.appendChild(groupSection);
            });
            
        } catch (error) {
            console.error('Error rendering grouped kanji:', error);
            this.renderFlat(kanjiList);
        }
    }
    
    /**
     * Create a group section with header and kanji grid
     * @param {Object} group - Group configuration {name, characters}
     * @param {Map} kanjiMap - Map of kanji character to kanji data
     * @returns {HTMLElement} Group section element
     */
    createGroupSection(group, kanjiMap) {
        const section = document.createElement('div');
        section.className = 'kanji-group-section';
        
        const characters = group.characters || '';
        
        // Calculate statistics
        const totalInGroup = characters.length;
        let knownInGroup = 0;
        let foundInGroup = 0;
        
        for (const char of characters) {
            if (kanjiMap.has(char)) {
                foundInGroup++;
                knownInGroup++; // For now, found = known
            }
        }
        
        const foundPercentage = totalInGroup > 0 ? ((foundInGroup / totalInGroup) * 100).toFixed(2) : 0;
        const knownPercentage = totalInGroup > 0 ? ((knownInGroup / totalInGroup) * 100).toFixed(2) : 0;
        
        // Create header
        const header = document.createElement('h3');
        header.className = 'kanji-group-header';
        header.textContent = group.name;
        section.appendChild(header);
        
        // Create stats line
        const stats = document.createElement('div');
        stats.className = 'kanji-group-stats';
        stats.textContent = `${foundInGroup} of ${totalInGroup} Found - ${foundPercentage}%, ${knownInGroup} of ${totalInGroup} Known - ${knownPercentage}%`;
        section.appendChild(stats);
        
        // Create grid for kanji
        const grid = document.createElement('div');
        grid.className = 'kanji-group-grid';
        
        // Render all characters in the group
        for (const char of characters) {
            const kanjiData = kanjiMap.get(char);
            if (kanjiData) {
                const cell = this.createKanjiCell(kanjiData);
                grid.appendChild(cell);
            } else {
                const cell = this.createKanjiCell({
                    kanji: char,
                    frequency: 0,
                    color: '#ebedf0'
                });
                grid.appendChild(cell);
            }
        }
        
        section.appendChild(grid);
        
        return section;
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
        if (frequency > 300) return '#2ee6e0';  // Cyan for very frequent
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