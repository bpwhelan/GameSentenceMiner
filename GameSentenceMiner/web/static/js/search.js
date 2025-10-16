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
        this.regexCheckbox = document.getElementById('regexCheckbox');
        this.deleteLinesBtn = document.getElementById('deleteLinesBtn');
        this.selectAllBtn = document.getElementById('selectAllBtn');
        this.pageSizeFilter = document.getElementById('pageSizeFilter');
        
        this.currentPage = 1;
        this.pageSize = 20;
        this.searchTimeout = null;
        this.currentQuery = '';
        this.totalResults = 0;
        this.currentUseRegex = false;
        this.initialize();
    }

    async initialize() {
        const urlParams = new URLSearchParams(window.location.search);
        const qParam = urlParams.get('q');
        if (qParam) {
            this.searchInput.value = qParam;
        }

        if (this.pageSizeFilter) {
            this.pageSizeFilter.value = this.pageSize.toString();
        } else {
            console.error('Page size filter element not found!');
        }

        this.initializeEventListeners();
        await this.loadGamesList();

        if (qParam) {
            this.performSearch();
        }
    }
    
    initializeEventListeners() {
        this.searchInput.addEventListener('input', (e) => {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => {
                this.performSearch();
            }, 300);
        });
        
        this.gameFilter.addEventListener('change', () => this.performSearch());
        this.sortFilter.addEventListener('change', () => this.performSearch());
        
        if (this.pageSizeFilter) {
            this.pageSizeFilter.addEventListener('change', () => {
                this.pageSize = parseInt(this.pageSizeFilter.value);
                this.currentPage = 1;
                this.performSearch();
            });
        }
        
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

        if (this.regexCheckbox) {
            this.regexCheckbox.addEventListener('change', () => {
                this.performSearch();
            });
        }

        if (this.deleteLinesBtn) {
            this.deleteLinesBtn.addEventListener('click', () => {
                this.showDeleteConfirmation();
            });
        }

        if (this.selectAllBtn) {
            this.selectAllBtn.addEventListener('click', () => {
                this.toggleSelectAll();
            });
        }
    }
    
    async loadGamesList() {
        try {
            const response = await fetch('/api/games-list');
            const data = await response.json();
            
            if (response.ok && data.games) {
                const gameSelect = this.gameFilter;
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
        const useRegex = this.regexCheckbox && this.regexCheckbox.checked;

        if (query !== this.currentQuery || useRegex !== this.currentUseRegex) {
            this.currentPage = 1;
        }
        this.currentQuery = query;
        this.currentUseRegex = useRegex;

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
            if (useRegex) {
                params.append('use_regex', 'true');
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
        
        const resultText = data.total === 1 ? 'result' : 'results';
        this.searchStats.textContent = `${data.total.toLocaleString()} ${resultText} found`;
        this.searchTime.textContent = `Search completed in ${searchTime}ms`;
        
        if (data.results.length === 0) {
            this.showNoResultsState();
            return;
        }

        this.searchResults.innerHTML = '';
        data.results.forEach(result => {
            const resultElement = this.createResultElement(result);
            this.searchResults.appendChild(resultElement);
        });
        
        this.updatePagination(data);
        this.searchResults.style.display = 'block';
        this.updateDeleteButtonState();
    }
    
    createResultElement(result) {
        const div = document.createElement('div');
        div.className = 'search-result';
        div.style.display = 'flex';
        div.style.alignItems = 'flex-start';
        div.style.gap = '12px';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'line-checkbox';
        checkbox.dataset.lineId = result.id;
        checkbox.checked = false;
        
        checkbox.addEventListener('change', () => {
            this.updateDeleteButtonState();
        });

        if (typeof result.sentence !== 'string') {
            console.warn('Unexpected sentence format:', result.sentence);
            result.sentence = JSON.stringify(result.sentence);
        }
        
        const highlightedText = this.highlightSearchTerms(result.sentence, this.currentQuery);
        
        const date = new Date(result.timestamp * 1000);
        const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${date.toTimeString().split(' ')[0]}`;
        
        const contentDiv = document.createElement('div');
        contentDiv.style.flex = '1';
        contentDiv.innerHTML = `
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
        
        div.appendChild(checkbox);
        div.appendChild(contentDiv);
        
        return div;
    }
    
    highlightSearchTerms(text, query) {
        if (!query) return escapeHtml(text);

        const useRegex = this.regexCheckbox && this.regexCheckbox.checked;
        const escapedText = escapeHtml(text);

        if (useRegex) {
            try {
                const pattern = new RegExp(query, 'gi');
                return escapedText.replace(pattern, '<span class="search-highlight">$&</span>');
            } catch (e) {
                return escapedText;
            }
        } else {
            const searchTerms = query.split(' ').filter(term => term.length > 0);
            let result = escapedText;
            searchTerms.forEach(term => {
                const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
                result = result.replace(regex, '<span class="search-highlight">$1</span>');
            });
            return result;
        }
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
        
        if (this.selectAllBtn) {
            this.selectAllBtn.disabled = true;
            this.selectAllBtn.textContent = 'Select All';
        }
    }

    updateDeleteButtonState() {
        const selectedCount = this.getSelectedCount();
        
        if (this.deleteLinesBtn) {
            this.deleteLinesBtn.disabled = selectedCount === 0;
            this.deleteLinesBtn.textContent = selectedCount > 0
                ? `Delete Selected (${selectedCount})`
                : 'Delete Selected';
        }

        if (this.selectAllBtn) {
            const totalVisible = document.querySelectorAll('.line-checkbox').length;
            
            if (totalVisible === 0) {
                this.selectAllBtn.disabled = true;
                this.selectAllBtn.textContent = 'Select All';
            } else {
                this.selectAllBtn.disabled = false;
                if (this.areAllVisibleSelected()) {
                    this.selectAllBtn.textContent = 'Deselect All';
                } else {
                    this.selectAllBtn.textContent = 'Select All';
                }
            }
        }
    }

    getSelectedLineIds() {
        const selectedIds = [];
        const checkboxes = document.querySelectorAll('.line-checkbox:checked');
        
        checkboxes.forEach(checkbox => {
            const lineId = checkbox.dataset.lineId;
            selectedIds.push(lineId);
        });
        
        return selectedIds;
    }

    getSelectedCount() {
        return document.querySelectorAll('.line-checkbox:checked').length;
    }

    areAllVisibleSelected() {
        const allCheckboxes = document.querySelectorAll('.line-checkbox');
        const selectedCheckboxes = document.querySelectorAll('.line-checkbox:checked');
        return allCheckboxes.length > 0 && allCheckboxes.length === selectedCheckboxes.length;
    }

    toggleSelectAll() {
        const visibleCheckboxes = document.querySelectorAll('.line-checkbox');
        const shouldSelect = !this.areAllVisibleSelected();
        
        visibleCheckboxes.forEach(checkbox => {
            checkbox.checked = shouldSelect;
        });
        
        this.updateDeleteButtonState();
    }

    showDeleteConfirmation() {
        const count = this.getSelectedCount();
        if (count === 0) return;

        const message = `Are you sure you want to delete ${count} selected sentence${count > 1 ? 's' : ''}? This action cannot be undone.`;
        
        document.getElementById('deleteConfirmationMessage').textContent = message;
        openModal('deleteConfirmationModal');
    }

    async deleteSelectedLines() {
        const lineIds = this.getSelectedLineIds();
        
        if (lineIds.length === 0) {
            return;
        }
        
        try {
            this.showLoadingState();
            
            const response = await fetch('/api/delete-sentence-lines', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ line_ids: lineIds })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to delete sentences');
            }

            document.querySelectorAll('.line-checkbox:checked').forEach(cb => cb.checked = false);
            this.updateDeleteButtonState();

            await this.performSearch();

            this.showMessage('Success', `Successfully deleted ${data.deleted_count} sentence${data.deleted_count > 1 ? 's' : ''}`);

        } catch (error) {
            this.showErrorState(`Failed to delete sentences: ${error.message}`);
            console.error('Delete error:', error);
        }
    }

    showMessage(title, message) {
        document.getElementById('messageModalTitle').textContent = title;
        document.getElementById('messageModalText').textContent = message;
        openModal('messageModal');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new SentenceSearchApp();
    
    const closeButtons = document.querySelectorAll('[data-action="closeModal"]');
    closeButtons.forEach(btn => {
        const modalId = btn.getAttribute('data-modal');
        if (modalId) {
            btn.addEventListener('click', () => closeModal(modalId));
        }
    });
    
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', () => {
            closeModal('deleteConfirmationModal');
            app.deleteSelectedLines();
        });
    }
});