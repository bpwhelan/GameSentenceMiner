// Unified Search JavaScript Module
// Provides search functionality across Jiten.moe, VNDB, and AniList
// Dependencies: shared.js (provides escapeHtml)

const UnifiedSearch = {
    // Default enabled sources
    enabledSources: ['jiten', 'vndb', 'anilist'],
    
    // Debounce timer
    debounceTimer: null,
    debounceDelay: 300,
    
    // Current search results
    currentResults: {
        jiten: [],
        vndb: [],
        anilist: []
    },
    
    // Source configuration
    sourceConfig: {
        jiten: {
            label: 'Jiten',
            emoji: '🟢',
            badgeClass: 'jiten-badge',
            color: '#10b981',
            isPrimary: true,
            description: 'Primary source - full stats support'
        },
        vndb: {
            label: 'VNDB',
            emoji: '🔵',
            badgeClass: 'vndb-badge',
            color: '#3b82f6',
            isPrimary: false,
            description: 'Visual Novel database - limited stats',
            warning: '⚠️ Visual Novel data only - limited stats'
        },
        anilist: {
            label: 'AniList',
            emoji: '🟠',
            badgeClass: 'anilist-badge',
            color: '#f97316',
            isPrimary: false,
            description: 'Anime/Manga database - limited stats',
            warning: '⚠️ Anime/Manga data only - limited stats'
        }
    },
    
    /**
     * Initialize the unified search module
     * Sets up event listeners for source toggles
     */
    initialize() {
        this.setupSourceToggles();
        console.log('UnifiedSearch module initialized');
    },
    
    /**
     * Setup source toggle checkbox event listeners
     */
    setupSourceToggles() {
        const sources = ['jiten', 'vndb', 'anilist'];
        sources.forEach(source => {
            const toggle = document.getElementById(`toggle-${source}`);
            if (toggle) {
                toggle.addEventListener('change', (e) => {
                    this.toggleSource(source, e.target.checked);
                });
            }
        });
    },
    
    /**
     * Toggle a source on/off
     * @param {string} source - Source identifier ('jiten', 'vndb', 'anilist')
     * @param {boolean} enabled - Whether the source should be enabled
     */
    toggleSource(source, enabled) {
        if (enabled && !this.enabledSources.includes(source)) {
            this.enabledSources.push(source);
        } else if (!enabled) {
            this.enabledSources = this.enabledSources.filter(s => s !== source);
        }
        console.log(`Source ${source} ${enabled ? 'enabled' : 'disabled'}. Active sources:`, this.enabledSources);
    },
    
    /**
     * Debounced search function
     * @param {string} query - Search query
     * @param {Function} callback - Callback function to handle results
     */
    debouncedSearch(query, callback) {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        
        this.debounceTimer = setTimeout(async () => {
            const results = await this.search(query);
            if (callback) callback(results);
        }, this.debounceDelay);
    },
    
    /**
     * Search the unified API
     * @param {string} query - Search query
     * @returns {Promise<Object>} Search results grouped by source
     */
    async search(query) {
        if (!query || query.trim() === '') {
            return { results: [], bySource: {} };
        }
        
        // Ensure at least one source is enabled
        if (this.enabledSources.length === 0) {
            console.warn('No sources enabled for search');
            return { results: [], bySource: {}, error: 'No sources enabled' };
        }
        
        const sources = this.enabledSources.join(',');
        
        try {
            const response = await fetch(`/api/search/unified?q=${encodeURIComponent(query)}&sources=${sources}`);
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || 'Search failed');
            }
            
            // Store results for reference
            this.currentResults = data.by_source || {};
            
            return {
                results: data.results || [],
                bySource: data.by_source || {},
                query: data.query,
                sources_searched: data.sources_searched
            };
        } catch (error) {
            console.error('Unified search error:', error);
            return { results: [], bySource: {}, error: error.message };
        }
    },
    
    /**
     * Get badge HTML for a source
     * @param {string} source - Source identifier
     * @returns {string} HTML string for the badge
     */
    getSourceBadge(source) {
        const config = this.sourceConfig[source];
        if (!config) return '';
        
        return `<span class="source-badge ${config.badgeClass}">${config.emoji} ${config.label}</span>`;
    },
    
    /**
     * Get warning message for non-primary sources
     * @param {string} source - Source identifier
     * @returns {string} HTML string for the warning or empty string for primary source
     */
    getSourceWarning(source) {
        const config = this.sourceConfig[source];
        if (!config || config.isPrimary) return '';
        
        return config.warning ? `<div class="source-warning">${config.warning}</div>` : '';
    },
    
    /**
     * Render search results to a container element
     * @param {Array} results - Array of search results
     * @param {HTMLElement} containerElement - Container to render results into
     * @param {Function} onSelectCallback - Callback when a result is selected
     */
    renderResults(results, containerElement, onSelectCallback) {
        if (!containerElement) {
            console.error('Container element not provided for renderResults');
            return;
        }
        
        containerElement.innerHTML = '';
        
        if (!results || results.length === 0) {
            containerElement.innerHTML = `
                <div class="unified-search-empty">
                    <p>No results found. Try a different search term or enable more sources.</p>
                </div>
            `;
            return;
        }
        
        // Group results by source for better organization
        const grouped = this.groupResultsBySource(results);
        
        // Render Jiten results first (primary source)
        if (grouped.jiten && grouped.jiten.length > 0) {
            this.renderSourceSection('jiten', grouped.jiten, containerElement, onSelectCallback);
        }
        
        // Then VNDB
        if (grouped.vndb && grouped.vndb.length > 0) {
            this.renderSourceSection('vndb', grouped.vndb, containerElement, onSelectCallback);
        }
        
        // Then AniList
        if (grouped.anilist && grouped.anilist.length > 0) {
            this.renderSourceSection('anilist', grouped.anilist, containerElement, onSelectCallback);
        }
    },
    
    /**
     * Group results by source
     * @param {Array} results - Array of search results
     * @returns {Object} Results grouped by source
     */
    groupResultsBySource(results) {
        const grouped = {
            jiten: [],
            vndb: [],
            anilist: []
        };
        
        results.forEach(result => {
            const source = result.source;
            if (grouped[source]) {
                grouped[source].push(result);
            }
        });
        
        return grouped;
    },
    
    /**
     * Render a section of results for a specific source
     * @param {string} source - Source identifier
     * @param {Array} results - Results for this source
     * @param {HTMLElement} container - Container element
     * @param {Function} onSelectCallback - Callback when a result is selected
     */
    renderSourceSection(source, results, container, onSelectCallback) {
        const config = this.sourceConfig[source];
        const sectionDiv = document.createElement('div');
        sectionDiv.className = `unified-search-section unified-search-section-${source}`;
        
        // Section header with source badge
        const header = document.createElement('div');
        header.className = 'unified-search-section-header';
        header.innerHTML = `
            ${this.getSourceBadge(source)}
            <span class="unified-search-section-count">${results.length} result${results.length !== 1 ? 's' : ''}</span>
            ${this.getSourceWarning(source)}
        `;
        sectionDiv.appendChild(header);
        
        // Results grid
        const grid = document.createElement('div');
        grid.className = 'unified-search-results';
        
        results.forEach((result, index) => {
            const card = this.createResultCard(result, index, onSelectCallback);
            grid.appendChild(card);
        });
        
        sectionDiv.appendChild(grid);
        container.appendChild(sectionDiv);
    },
    
    /**
     * Create a result card element
     * @param {Object} result - Search result object
     * @param {number} index - Index in results array
     * @param {Function} onSelectCallback - Callback when selected
     * @returns {HTMLElement} Card element
     */
    createResultCard(result, index, onSelectCallback) {
        const card = document.createElement('div');
        card.className = 'search-result-card';
        card.dataset.source = result.source;
        card.dataset.index = index;
        
        // Safe escape function
        const escape = typeof escapeHtml === 'function' ? escapeHtml : (str) => {
            const div = document.createElement('div');
            div.textContent = str || '';
            return div.innerHTML;
        };
        
        // Determine display titles
        const primaryTitle = result.title || result.title_jp || result.title_en || 'Unknown Title';
        const secondaryTitle = result.title_en && result.title_en !== primaryTitle ? result.title_en : '';
        const tertiaryTitle = result.title_jp && result.title_jp !== primaryTitle && result.title_jp !== secondaryTitle ? result.title_jp : '';
        
        // Cover image or placeholder
        const coverHtml = result.cover_url 
            ? `<img src="${escape(result.cover_url)}" class="search-result-cover" alt="Cover" onerror="this.onerror=null;this.src='';this.style.display='none';this.parentElement.innerHTML='<div class=\\'search-result-cover-placeholder\\'>🎮</div>';">`
            : '<div class="search-result-cover-placeholder">🎮</div>';
        
        // Description (truncated)
        const description = result.description 
            ? escape(result.description.substring(0, 150)) + (result.description.length > 150 ? '...' : '')
            : '';
        
        // Build card HTML
        card.innerHTML = `
            <div class="search-result-header">
                ${coverHtml}
                <div class="search-result-info">
                    <h5 class="search-result-title">${escape(primaryTitle)}</h5>
                    ${secondaryTitle ? `<p class="search-result-title-secondary">${escape(secondaryTitle)}</p>` : ''}
                    ${tertiaryTitle ? `<p class="search-result-title-tertiary">${escape(tertiaryTitle)}</p>` : ''}
                    <div class="search-result-meta">
                        ${this.getSourceBadge(result.source)}
                    </div>
                </div>
            </div>
            ${description ? `<div class="search-result-description">${description}</div>` : ''}
            <div class="search-result-actions">
                <button class="action-btn primary unified-search-select-btn">🔗 Link</button>
                ${result.source_url ? `<a href="${escape(result.source_url)}" target="_blank" rel="noopener noreferrer" class="action-btn">🔗 View Source</a>` : ''}
            </div>
        `;
        
        // Attach click handler for select button
        const selectBtn = card.querySelector('.unified-search-select-btn');
        if (selectBtn && onSelectCallback) {
            selectBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelectCallback(result, index);
            });
        }
        
        return card;
    },
    
    /**
     * Render source toggle checkboxes
     * @param {HTMLElement} containerElement - Container to render toggles into
     */
    renderSourceToggles(containerElement) {
        if (!containerElement) return;
        
        containerElement.innerHTML = '';
        
        Object.keys(this.sourceConfig).forEach(source => {
            const config = this.sourceConfig[source];
            const isEnabled = this.enabledSources.includes(source);
            
            const label = document.createElement('label');
            label.className = 'source-toggle-label';
            label.innerHTML = `
                <input type="checkbox" id="toggle-${source}" class="source-toggle-checkbox" ${isEnabled ? 'checked' : ''}>
                <span class="source-toggle-text">${config.emoji} ${config.label}</span>
            `;
            
            containerElement.appendChild(label);
        });
        
        // Re-setup event listeners
        this.setupSourceToggles();
    },
    
    /**
     * Create and show loading indicator
     * @param {HTMLElement} containerElement - Container to show loading in
     */
    showLoading(containerElement) {
        if (!containerElement) return;
        
        containerElement.innerHTML = `
            <div class="unified-search-loading">
                <div class="spinner"></div>
                <span>Searching across ${this.enabledSources.length} source${this.enabledSources.length !== 1 ? 's' : ''}...</span>
            </div>
        `;
    },
    
    /**
     * Show error message
     * @param {HTMLElement} containerElement - Container to show error in
     * @param {string} message - Error message
     */
    showError(containerElement, message) {
        if (!containerElement) return;
        
        containerElement.innerHTML = `
            <div class="unified-search-error">
                <div class="error-icon">❌</div>
                <div class="error-message">${message || 'An error occurred during search'}</div>
            </div>
        `;
    },
    
    /**
     * Get selected result data formatted for game linking
     * @param {Object} result - The selected search result
     * @returns {Object} Formatted data for linking
     */
    formatForLinking(result) {
        // Base linking data
        const linkData = {
            source: result.source,
            source_id: result.id,
            title_original: result.title_jp || result.title || '',
            title_english: result.title_en || '',
            title_romaji: result.title || '',
            description: result.description || '',
            cover_url: result.cover_url || '',
            source_url: result.source_url || ''
        };
        
        // Add source-specific IDs
        if (result.source === 'jiten') {
            // For Jiten, the raw data should contain deck_id
            if (result._raw) {
                linkData.deck_id = result._raw.deck_id;
                linkData.jiten_data = result._raw;
            }
        } else if (result.source === 'vndb') {
            linkData.vndb_id = result.id;
        } else if (result.source === 'anilist') {
            linkData.anilist_id = result.id;
        }
        
        return linkData;
    },
    
    /**
     * Check if a result is from the primary source (Jiten)
     * @param {Object} result - Search result
     * @returns {boolean} True if from primary source
     */
    isPrimarySource(result) {
        return result && result.source === 'jiten';
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    UnifiedSearch.initialize();
});

// Export for use in other modules
if (typeof window !== 'undefined') {
    window.UnifiedSearch = UnifiedSearch;
}
