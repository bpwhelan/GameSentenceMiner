// Search Page JavaScript
// Dependencies: shared.js (provides utility functions like escapeHtml, escapeRegex)

class SentenceSearchApp {
    constructor() {
        this.searchInput = document.getElementById('searchInput');
        this.gameFilter = document.getElementById('gameFilter');
        this.sortFilter = document.getElementById('sortFilter');
        this.searchResults = document.getElementById('searchResults');
        this.loadingIndicator = document.getElementById('loadingIndicator');
        this.noResults = document.getElementById('noResults');
        this.emptyState = document.getElementById('emptyState');
        this.errorMessage = document.getElementById('errorMessage');
        this.searchStats = document.getElementById('searchStats');
        this.searchTime = document.getElementById('searchTime');
        
        this.currentPage = 1;
        this.pageSize = 20;
        this.searchTimeout = null;
        this.currentQuery = '';
        this.totalResults = 0;

        // Move initialization logic to async method
        this.initialize();
    }

    async initialize() {
        // Check for ?q= parameter and pre-fill input
        const urlParams = new URLSearchParams(window.location.search);
        const qParam = urlParams.get('q');
        if (qParam) {
            this.searchInput.value = qParam;
        }

        this.initializeEventListeners();
        await this.loadGamesList();

        // Trigger search after games list loads if q param is present
        if (qParam) {
            this.performSearch();
        }
    }
    
    initializeEventListeners() {
        // Debounced search input
        this.searchInput.addEventListener('input', (e) => {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => {
                this.performSearch();
            }, 300);
        });
        
        // Filter changes
        this.gameFilter.addEventListener('change', () => this.performSearch());
        this.sortFilter.addEventListener('change', () => this.performSearch());
        
        // Pagination
        document.getElementById('prevPage').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.performSearch();
            }
        });
        
        document.getElementById('nextPage').addEventListener('click', () => {
            this.currentPage++;
            this.performSearch();
        });
    }
    
    async loadGamesList() {
        try {
            const response = await fetch('/api/games-list');
            const data = await response.json();
            
            if (response.ok && data.games) {
                const gameSelect = this.gameFilter;
                // Clear existing options except "All Games"
                gameSelect.innerHTML = '<option value="">All Games</option>';
                
                data.games.forEach(game => {
                    const option = document.createElement('option');
                    option.value = game.name;
                    option.textContent = game.name;
                    gameSelect.appendChild(option);
                });
            }
        } catch (error) {
            console.error('Failed to load games list:', error);
        }
    }
    
    async performSearch() {
        const query = this.searchInput.value.trim();
        const gameFilter = this.gameFilter.value;
        const sortBy = this.sortFilter.value;
        
        // Reset to first page for new searches
        if (query !== this.currentQuery) {
            this.currentPage = 1;
        }
        this.currentQuery = query;
        
        // Show appropriate state
        if (!query) {
            this.showEmptyState();
            return;
        }
        
        this.showLoadingState();
        const startTime = Date.now();
        
        try {
            const params = new URLSearchParams({
                q: query,
                page: this.currentPage,
                page_size: this.pageSize,
                sort: sortBy
            });
            
            if (gameFilter) {
                params.append('game', gameFilter);
            }
            
            const response = await fetch(`/api/search-sentences?${params}`);
            const data = await response.json();
            
            const searchTime = Date.now() - startTime;
            
            if (!response.ok) {
                throw new Error(data.error || 'Search failed');
            }
            
            this.displayResults(data, searchTime);
            
        } catch (error) {
            this.showErrorState(error.message);
        }
    }
    
    displayResults(data, searchTime) {
        this.hideAllStates();
        this.totalResults = data.total;
        
        // Update stats
        const resultText = data.total === 1 ? 'result' : 'results';
        this.searchStats.textContent = `${data.total.toLocaleString()} ${resultText} found`;
        this.searchTime.textContent = `Search completed in ${searchTime}ms`;
        
        if (data.results.length === 0) {
            this.showNoResultsState();
            return;
        }
        
        // Render results
        this.searchResults.innerHTML = '';
        data.results.forEach(result => {
            const resultElement = this.createResultElement(result);
            this.searchResults.appendChild(resultElement);
        });
        
        this.updatePagination(data);
        this.searchResults.style.display = 'block';
    }
    
    createResultElement(result) {
        const div = document.createElement('div');
        div.className = 'search-result';
        
        // Highlight search terms
        const highlightedText = this.highlightSearchTerms(result.sentence, this.currentQuery);
        
        // Format timestamp to ISO format
        const date = new Date(result.timestamp * 1000);
        const formattedDate = date.toISOString().split('T')[0] + ' ' + date.toTimeString().split(' ')[0];
        
        div.innerHTML = `
            <div class="result-sentence">${highlightedText}</div>
            <div class="result-metadata">
                <div class="metadata-item">
                    <span class="game-tag">${escapeHtml(result.game_name)}</span>
                </div>
                <div class="metadata-item">
                    <span class="metadata-label">📅</span>
                    <span class="metadata-value">${formattedDate}</span>
                </div>
                ${result.translation ? `
                    <div class="metadata-item">
                        <span class="metadata-label">💬</span>
                        <span class="metadata-value">Translation available</span>
                    </div>
                ` : ''}
            </div>
        `;
        
        return div;
    }
    
    highlightSearchTerms(text, query) {
        if (!query) return escapeHtml(text);
        
        const escapedText = escapeHtml(text);
        const searchTerms = query.split(' ').filter(term => term.length > 0);
        
        let result = escapedText;
        searchTerms.forEach(term => {
            const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
            result = result.replace(regex, '<span class="search-highlight">$1</span>');
        });
        
        return result;
    }
    
    updatePagination(data) {
        const pagination = document.getElementById('pagination');
        const prevBtn = document.getElementById('prevPage');
        const nextBtn = document.getElementById('nextPage');
        const pageInfo = document.getElementById('pageInfo');
        
        const totalPages = Math.ceil(data.total / this.pageSize);
        
        if (totalPages <= 1) {
            pagination.style.display = 'none';
            return;
        }
        
        pagination.style.display = 'flex';
        prevBtn.disabled = this.currentPage <= 1;
        nextBtn.disabled = this.currentPage >= totalPages;
        
        const startResult = (this.currentPage - 1) * this.pageSize + 1;
        const endResult = Math.min(this.currentPage * this.pageSize, data.total);
        
        pageInfo.textContent = `Page ${this.currentPage} of ${totalPages} (${startResult}-${endResult} of ${data.total})`;
    }
    
    showLoadingState() {
        this.hideAllStates();
        this.loadingIndicator.style.display = 'flex';
    }
    
    showEmptyState() {
        this.hideAllStates();
        this.emptyState.style.display = 'block';
        this.searchStats.textContent = 'Ready to search';
        this.searchTime.textContent = '';
    }
    
    showNoResultsState() {
        this.hideAllStates();
        this.noResults.style.display = 'block';
    }
    
    showErrorState(message) {
        this.hideAllStates();
        this.errorMessage.style.display = 'block';
        document.getElementById('errorText').textContent = message;
    }
    
    hideAllStates() {
        this.loadingIndicator.style.display = 'none';
        this.emptyState.style.display = 'none';
        this.noResults.style.display = 'none';
        this.errorMessage.style.display = 'none';
        this.searchResults.style.display = 'none';
        document.getElementById('pagination').style.display = 'none';
    }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SentenceSearchApp();
});