class SentenceSearchApp {
    constructor() {
        this.searchInput = document.getElementById('searchInput');
        this.gameFilter = document.getElementById('gameFilter');
        this.sortFilter = document.getElementById('sortFilter');
        this.fromDateFilter = document.getElementById('searchFromDate');
        this.toDateFilter = document.getElementById('searchToDate');
        this.searchResults = document.getElementById('searchResults');
        this.loadingIndicator = document.getElementById('loadingIndicator');
        this.noResults = document.getElementById('noResults');
        this.emptyState = document.getElementById('emptyState');
        this.errorMessage = document.getElementById('errorMessage');
        this.searchStats = document.getElementById('searchStats');
        this.searchTime = document.getElementById('searchTime');
        
        // Regex component elements
        this.regexPresetSelect = document.querySelector('.regex-preset-select');
        this.regexCustomInput = document.querySelector('.regex-custom-input');
        this.regexCaseCheckbox = document.querySelector('.regex-case-checkbox');
        this.regexModeCheckbox = document.querySelector('.regex-mode-checkbox');
        
        // Duplicate detection elements
        this.toggleDuplicateBtn = document.getElementById('toggleDuplicateDetection');
        this.duplicateSection = document.getElementById('duplicateDetectionSection');
        this.duplicateTimeWindow = document.getElementById('duplicateTimeWindow');
        this.duplicateIgnoreTimeWindow = document.getElementById('duplicateIgnoreTimeWindow');
        this.duplicateCaseSensitive = document.getElementById('duplicateCaseSensitive');
        this.searchDuplicatesBtn = document.getElementById('searchDuplicatesBtn');
        this.duplicateTimeWindowGroup = document.getElementById('duplicateTimeWindowGroup');
        
        this.deleteLinesBtn = document.getElementById('deleteLinesBtn');
        this.selectAllBtn = document.getElementById('selectAllBtn');
        this.pageSizeFilter = document.getElementById('pageSizeFilter');
        this.toggleAdvancedBtn = document.getElementById('toggleAdvancedSearch');
        this.advancedSearchSection = document.getElementById('advancedSearchSection');
        
        this.currentPage = 1;
        this.pageSize = 20;
        this.searchTimeout = null;
        this.currentQuery = '';
        this.totalResults = 0;
        this.currentUseRegex = false;
        this.isDuplicateSearch = false;
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
        
        // Date range filters do NOT auto-trigger search - user must click Search button
        
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

        // Regex component event listeners
        if (this.regexCustomInput) {
            this.regexCustomInput.addEventListener('input', () => {
                clearTimeout(this.searchTimeout);
                this.searchTimeout = setTimeout(() => {
                    this.performSearch();
                }, 300);
            });
        }
        
        if (this.regexModeCheckbox) {
            this.regexModeCheckbox.addEventListener('change', () => {
                this.performSearch();
            });
        }
        
        if (this.regexCaseCheckbox) {
            this.regexCaseCheckbox.addEventListener('change', () => {
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

        if (this.toggleAdvancedBtn) {
            this.toggleAdvancedBtn.addEventListener('click', () => {
                this.toggleAdvancedSearch();
            });
        }
        
        // Duplicate detection event listeners
        if (this.toggleDuplicateBtn) {
            this.toggleDuplicateBtn.addEventListener('click', () => {
                this.toggleDuplicateDetection();
            });
        }
        
        if (this.duplicateIgnoreTimeWindow) {
            this.duplicateIgnoreTimeWindow.addEventListener('change', () => {
                this.toggleDuplicateTimeWindow();
            });
        }
        
        if (this.searchDuplicatesBtn) {
            this.searchDuplicatesBtn.addEventListener('click', () => {
                this.searchForDuplicates();
            });
        }
        
        // Manual search button for date filtering
        const manualSearchBtn = document.getElementById('manualSearchBtn');
        if (manualSearchBtn) {
            manualSearchBtn.addEventListener('click', () => {
                this.performSearch();
            });
        }
    }

    toggleAdvancedSearch() {
        if (!this.advancedSearchSection || !this.toggleAdvancedBtn) return;
        
        const isHidden = this.advancedSearchSection.style.display === 'none';
        
        if (isHidden) {
            this.advancedSearchSection.style.display = 'block';
            this.toggleAdvancedBtn.innerHTML = '<span id="toggleIcon">▲</span> Hide Advanced Search';
        } else {
            this.advancedSearchSection.style.display = 'none';
            this.toggleAdvancedBtn.innerHTML = '<span id="toggleIcon">▼</span> Show Advanced Search';
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
        const fromDate = this.fromDateFilter ? this.fromDateFilter.value : '';
        const toDate = this.toDateFilter ? this.toDateFilter.value : '';
        
        // Get regex settings from component
        const customRegex = this.regexCustomInput ? this.regexCustomInput.value.trim() : '';
        const useRegex = this.regexModeCheckbox ? this.regexModeCheckbox.checked : false;
        const caseSensitive = this.regexCaseCheckbox ? this.regexCaseCheckbox.checked : false;
        
        // Use custom regex if provided and regex mode is enabled, otherwise use search query
        // If search is empty, default to .* regex pattern
        let searchPattern = (useRegex && customRegex) ? customRegex : query;
        let effectiveUseRegex = useRegex;
        
        if (!searchPattern && !query) {
            searchPattern = '.*';
            effectiveUseRegex = true;  // Force regex mode for .* pattern
        }

        if (searchPattern !== this.currentQuery || effectiveUseRegex !== this.currentUseRegex) {
            this.currentPage = 1;
        }
        this.currentQuery = searchPattern;
        this.currentUseRegex = effectiveUseRegex;

        this.showLoadingState();
        const startTime = Date.now();

        try {
            const params = new URLSearchParams({
                q: searchPattern,
                page: this.currentPage,
                page_size: this.pageSize,
                sort: sortBy
            });

            if (gameFilter) {
                params.append('game', gameFilter);
            }
            if (fromDate) {
                params.append('from_date', fromDate);
            }
            if (toDate) {
                params.append('to_date', toDate);
            }
            if (effectiveUseRegex) {
                params.append('use_regex', 'true');
            }
            if (caseSensitive) {
                params.append('case_sensitive', 'true');
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

        const useRegex = this.regexModeCheckbox ? this.regexModeCheckbox.checked : false;
        const customRegex = this.regexCustomInput ? this.regexCustomInput.value.trim() : '';
        const caseSensitive = this.regexCaseCheckbox ? this.regexCaseCheckbox.checked : false;
        const escapedText = escapeHtml(text);

        if (useRegex && customRegex) {
            try {
                const flags = caseSensitive ? 'g' : 'gi';
                const pattern = new RegExp(customRegex, flags);
                return escapedText.replace(pattern, '<span class="search-highlight">$&</span>');
            } catch (e) {
                return escapedText;
            }
        } else {
            const searchTerms = query.split(' ').filter(term => term.length > 0);
            let result = escapedText;
            searchTerms.forEach(term => {
                const flags = caseSensitive ? 'g' : 'gi';
                const regex = new RegExp(`(${escapeRegex(term)})`, flags);
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

    toggleDuplicateDetection() {
        if (!this.duplicateSection || !this.toggleDuplicateBtn) return;
        
        const isHidden = this.duplicateSection.style.display === 'none';
        const icon = document.getElementById('duplicateToggleIcon');
        
        if (isHidden) {
            this.duplicateSection.style.display = 'block';
            if (icon) icon.textContent = '▲';
        } else {
            this.duplicateSection.style.display = 'none';
            if (icon) icon.textContent = '▼';
        }
    }
    
    toggleDuplicateTimeWindow() {
        if (!this.duplicateIgnoreTimeWindow || !this.duplicateTimeWindowGroup) return;
        
        const isIgnored = this.duplicateIgnoreTimeWindow.checked;
        
        if (isIgnored) {
            this.duplicateTimeWindowGroup.style.opacity = '0.5';
            this.duplicateTimeWindowGroup.style.pointerEvents = 'none';
            if (this.duplicateTimeWindow) {
                this.duplicateTimeWindow.disabled = true;
            }
        } else {
            this.duplicateTimeWindowGroup.style.opacity = '1';
            this.duplicateTimeWindowGroup.style.pointerEvents = 'auto';
            if (this.duplicateTimeWindow) {
                this.duplicateTimeWindow.disabled = false;
            }
        }
    }
    
    async searchForDuplicates() {
        const gameFilter = this.gameFilter.value;
        const timeWindow = parseInt(this.duplicateTimeWindow.value);
        const ignoreTimeWindow = this.duplicateIgnoreTimeWindow.checked;
        const caseSensitive = this.duplicateCaseSensitive.checked;
        
        // Validate input
        if (!ignoreTimeWindow && (isNaN(timeWindow) || timeWindow < 1)) {
            this.showErrorState('Time window must be at least 1 minute');
            return;
        }
        
        this.showLoadingState();
        this.isDuplicateSearch = true;
        const startTime = Date.now();
        
        try {
            const requestData = {
                game: gameFilter,
                time_window_minutes: timeWindow,
                ignore_time_window: ignoreTimeWindow,
                case_sensitive: caseSensitive
            };
            
            const response = await fetch('/api/search-duplicates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestData)
            });
            
            const data = await response.json();
            const searchTime = Date.now() - startTime;
            
            if (!response.ok) {
                throw new Error(data.error || 'Duplicate search failed');
            }
            
            // Display results using existing display method
            this.displayResults(data, searchTime);
            
            // Update stats text to indicate duplicate search
            if (data.total > 0) {
                const modeText = ignoreTimeWindow ? 'across entire game' : `within ${timeWindow} minute window`;
                const gameText = gameFilter ? ` in ${gameFilter}` : '';
                this.searchStats.textContent = `Found ${data.total.toLocaleString()} duplicate sentences ${modeText}${gameText}`;
            }
            
        } catch (error) {
            this.showErrorState(error.message);
            this.isDuplicateSearch = false;
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