// Shared game import/link widget used by game stats, overview, and database pages.
// Dependencies: shared.js (escapeHtml/openModal/closeModal), unified-search.js

(function() {
    'use strict';

    const SOURCE_CONFIG = {
        jiten: {
            label: 'Jiten',
            sourceLabel: 'Jiten.moe',
            badgeClass: 'jiten-badge',
            emoji: '🟢',
            warning: '',
        },
        vndb: {
            label: 'VNDB',
            sourceLabel: 'VNDB',
            badgeClass: 'vndb-badge',
            emoji: '🔵',
            warning: '⚠️ Visual Novel data only - character counts and difficulty not available',
        },
        igdb: {
            label: 'IGDB',
            sourceLabel: 'IGDB',
            badgeClass: 'igdb-badge',
            emoji: '🟣',
            warning: '⚠️ Game metadata only - no character data, character counts, or difficulty',
        },
        anilist: {
            label: 'AniList',
            sourceLabel: 'AniList',
            badgeClass: 'anilist-badge',
            emoji: '🟠',
            warning: '⚠️ Anime/Manga data only - character counts and difficulty not available',
        },
    };

    function safeEscapeHtml(value) {
        if (typeof escapeHtml === 'function') {
            return escapeHtml(value || '');
        }

        const div = document.createElement('div');
        div.textContent = value || '';
        return div.innerHTML;
    }

    function formatNumber(value) {
        return Number(value || 0).toLocaleString();
    }

    function normalizeLinksForUpdate(links) {
        if (!Array.isArray(links)) {
            return [];
        }

        return links
            .map(link => {
                if (typeof link === 'string') {
                    return { linkType: 1, url: link };
                }
                return link && link.url ? link : null;
            })
            .filter(Boolean);
    }

    function mergeSourceLinks(existingLinks, newLinks) {
        const merged = [];
        const seen = new Set();

        normalizeLinksForUpdate(existingLinks)
            .concat(normalizeLinksForUpdate(newLinks))
            .forEach(link => {
                const url = String(link.url || '').trim();
                const key = url.toLowerCase();
                if (!url || seen.has(key)) {
                    return;
                }
                seen.add(key);
                merged.push(link);
            });

        return merged;
    }

    function getSourceConfig(source) {
        if (window.UnifiedSearch && UnifiedSearch.sourceConfig && UnifiedSearch.sourceConfig[source]) {
            const unifiedConfig = UnifiedSearch.sourceConfig[source];
            return {
                label: unifiedConfig.label || SOURCE_CONFIG[source]?.label || source,
                sourceLabel: SOURCE_CONFIG[source]?.sourceLabel || unifiedConfig.label || source,
                badgeClass: unifiedConfig.badgeClass || SOURCE_CONFIG[source]?.badgeClass || '',
                emoji: unifiedConfig.emoji || SOURCE_CONFIG[source]?.emoji || '',
                warning: unifiedConfig.warning || SOURCE_CONFIG[source]?.warning || '',
            };
        }

        return SOURCE_CONFIG[source] || {
            label: source || 'Unknown',
            sourceLabel: source || 'Unknown',
            badgeClass: '',
            emoji: '',
            warning: '',
        };
    }

    function getImportedType(result, currentGame) {
        const source = result.source || 'jiten';
        if (source === 'vndb') {
            return 'Visual Novel';
        }
        if (source === 'anilist') {
            const mediaType = String(result.media_type || '').toLowerCase();
            return mediaType === 'manga' ? 'Manga' : 'Anime';
        }
        return currentGame.type || '';
    }

    function buildMatchedPreviewHtml(result) {
        const source = result.source || 'jiten';
        const sourceConfig = getSourceConfig(source);
        const primaryTitle = result.title || result.title_jp || result.title_en || 'Unknown Title';
        const secondaryTitle = result.title_en && result.title_en !== primaryTitle ? result.title_en : '';
        const tertiaryTitle = result.title_jp
            && result.title_jp !== primaryTitle
            && result.title_jp !== secondaryTitle
            ? result.title_jp
            : '';
        const coverUrl = result.cover_url || '';
        const description = result.description
            ? `${safeEscapeHtml(result.description.substring(0, 150))}${result.description.length > 150 ? '...' : ''}`
            : '';

        const metaBits = [];
        if (result.media_type) {
            metaBits.push(result.media_type);
        }

        if (source === 'jiten') {
            if (result.id) {
                metaBits.push(`Deck ID: ${result.id}`);
            }
            if (result.character_count) {
                metaBits.push(`${formatNumber(result.character_count)} chars`);
            }
            if (result.difficulty) {
                metaBits.push(`Difficulty: ${result.difficulty}`);
            }
        } else if (source === 'vndb') {
            if (result.id) {
                metaBits.push(`VNDB ID: ${result.id}`);
            }
            if (result.released) {
                metaBits.push(result.released);
            }
        } else if (source === 'igdb') {
            if (result.year) {
                metaBits.push(result.year);
            }
            if (Array.isArray(result.platforms) && result.platforms.length > 0) {
                metaBits.push(result.platforms.slice(0, 3).join(' • '));
            }
        } else if (source === 'anilist' && result.id) {
            metaBits.push(`AniList ID: ${result.id}`);
        }

        const metaLine = metaBits.length > 0
            ? `<p style="margin: 4px 0 0 0; color: var(--text-tertiary); font-size: 12px;">${safeEscapeHtml(metaBits.join(' | '))}</p>`
            : '';

        return ''
            + '<div style="display: flex; align-items: flex-start; gap: 10px;">'
                + (coverUrl
                    ? `<img src="${safeEscapeHtml(coverUrl)}" style="width: 60px; height: 80px; object-fit: cover; border-radius: 4px; flex-shrink: 0;" onerror="this.style.display='none'">`
                    : '<div style="width: 60px; height: 80px; background: var(--bg-primary); border-radius: 4px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">🎮</div>')
                + '<div style="flex: 1; min-width: 0;">'
                    + `<div style="margin-bottom: 4px;"><span class="source-badge ${sourceConfig.badgeClass}">${sourceConfig.emoji} ${sourceConfig.label}</span></div>`
                    + `<h5 style="margin: 0 0 4px 0;">${safeEscapeHtml(primaryTitle)}</h5>`
                    + (secondaryTitle ? `<p style="margin: 2px 0; color: var(--text-secondary); font-size: 13px;">${safeEscapeHtml(secondaryTitle)}</p>` : '')
                    + (tertiaryTitle ? `<p style="margin: 2px 0; color: var(--text-tertiary); font-size: 12px;">${safeEscapeHtml(tertiaryTitle)}</p>` : '')
                    + metaLine
                + '</div>'
            + '</div>'
            + (sourceConfig.warning ? `<div class="source-warning" style="margin-top: 10px;">${sourceConfig.warning}</div>` : '')
            + (description ? `<div style="margin-top: 10px; color: var(--text-secondary); font-size: 14px;">${description}</div>` : '');
    }

    async function executeLinkRequest(gameId, currentGame, selectedResult, overwriteMetadata) {
        const source = selectedResult.source || 'jiten';
        const sourceConfig = getSourceConfig(source);
        const isJitenSource = source === 'jiten'
            && selectedResult._raw
            && (selectedResult._raw.deck_id || selectedResult.id);

        let response;
        let data;

        if (isJitenSource) {
            const cleanJitenData = Object.assign({}, selectedResult._raw || {});
            response = await fetch(`/api/games/${gameId}/link-jiten`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    deck_id: cleanJitenData.deck_id || selectedResult.id,
                    jiten_data: cleanJitenData,
                    overwrite_metadata: overwriteMetadata,
                }),
            });
            data = await response.json();
        } else if (source === 'igdb') {
            response = await fetch(`/api/games/${gameId}/link-igdb`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    igdb_url: selectedResult.source_url,
                    result_type: selectedResult.result_type || selectedResult.media_type || 'Game',
                    overwrite_metadata: overwriteMetadata,
                }),
            });
            data = await response.json();
        } else {
            const updateData = {
                title_original: selectedResult.title_jp || selectedResult.title || currentGame.title_original,
                title_english: selectedResult.title_en || currentGame.title_english || '',
                title_romaji: selectedResult.title || currentGame.title_romaji || '',
                description: selectedResult.description || currentGame.description || '',
                type: getImportedType(selectedResult, currentGame),
            };

            if (source === 'vndb' && selectedResult.id) {
                updateData.vndb_id = selectedResult.id;
            } else if (source === 'anilist' && selectedResult.id) {
                updateData.anilist_id = selectedResult.id;
            }

            if (selectedResult.source_url) {
                updateData.links = mergeSourceLinks(currentGame.links, [{
                    deckId: 1,
                    linkId: 1,
                    linkType: source === 'vndb' ? 4 : 5,
                    url: selectedResult.source_url,
                }]);
            }

            response = await fetch(`/api/games/${gameId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updateData),
            });
            data = await response.json();
        }

        if (!response.ok) {
            throw new Error((data && data.error) || 'Failed to link game');
        }

        return {
            source,
            sourceConfig,
            sourceLabel: sourceConfig.sourceLabel,
            isJitenSource,
            apiResult: data,
        };
    }

    function GameImportWidget(config) {
        this.config = config || {};
        this.context = null;
        this.selectedResult = null;
        this.elements = {
            searchModal: document.getElementById('linkSearchModal'),
            searchGameName: document.getElementById('linkSearchGameName'),
            searchInput: document.getElementById('linkSearchInput'),
            searchButton: document.getElementById('linkSearchBtn'),
            searchResults: document.getElementById('linkSearchResults'),
            searchResultsList: document.getElementById('linkSearchResultsList'),
            searchError: document.getElementById('linkSearchError'),
            searchLoading: document.getElementById('linkSearchLoading'),
            confirmModal: document.getElementById('linkConfirmModal'),
            confirmTitle: document.getElementById('linkConfirmTitle'),
            confirmCurrentGame: document.getElementById('linkConfirmCurrentGame'),
            confirmMatchedGame: document.getElementById('linkConfirmMatchedGame'),
            confirmManualOverridesWarning: document.getElementById('linkConfirmManualOverridesWarning'),
            confirmOverriddenFieldsList: document.getElementById('linkConfirmOverriddenFieldsList'),
            confirmOverwriteMetadata: document.getElementById('linkConfirmOverwriteMetadata'),
            confirmError: document.getElementById('linkConfirmError'),
            confirmLoading: document.getElementById('linkConfirmLoading'),
            confirmButton: document.getElementById('confirmLinkBtn'),
        };

        this.bindEvents();
    }

    GameImportWidget.prototype.bindEvents = function() {
        if (this.elements.searchButton) {
            this.elements.searchButton.addEventListener('click', this.search.bind(this));
        }

        if (this.elements.searchInput) {
            this.elements.searchInput.addEventListener('keypress', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    this.search();
                }
            });
        }

        if (this.elements.confirmButton) {
            this.elements.confirmButton.addEventListener('click', this.confirm.bind(this));
        }

        document.querySelectorAll('[data-action="closeLinkSearchModal"]').forEach(button => {
            button.addEventListener('click', function() {
                closeModal('linkSearchModal');
            });
        });

        document.querySelectorAll('[data-action="closeLinkConfirmModal"]').forEach(button => {
            button.addEventListener('click', function() {
                closeModal('linkConfirmModal');
            });
        });
    };

    GameImportWidget.prototype.open = function(context) {
        if (!context || !context.gameId || !context.game) {
            throw new Error('Game import context is missing required game data.');
        }

        this.context = context;
        this.selectedResult = null;

        const searchTerm = context.searchTerm || context.displayName || context.game.title_original || '';

        this.elements.searchGameName.textContent = context.displayName || searchTerm;
        this.elements.searchInput.value = searchTerm;
        this.elements.searchResults.style.display = 'none';
        this.elements.searchResultsList.innerHTML = '';
        this.elements.searchError.style.display = 'none';
        this.elements.searchError.textContent = '';
        this.elements.searchLoading.style.display = 'none';

        this.elements.confirmTitle.textContent = 'Confirm Game Link';
        this.elements.confirmCurrentGame.innerHTML = '';
        this.elements.confirmMatchedGame.innerHTML = '';
        this.elements.confirmError.style.display = 'none';
        this.elements.confirmError.textContent = '';
        this.elements.confirmLoading.style.display = 'none';
        this.elements.confirmButton.disabled = false;

        if (this.elements.confirmOverwriteMetadata) {
            this.elements.confirmOverwriteMetadata.checked = false;
        }
        if (this.elements.confirmManualOverridesWarning) {
            this.elements.confirmManualOverridesWarning.style.display = 'none';
        }
        if (this.elements.confirmOverriddenFieldsList) {
            this.elements.confirmOverriddenFieldsList.innerHTML = '';
        }

        openModal('linkSearchModal');
    };

    GameImportWidget.prototype.search = async function() {
        const searchTerm = this.elements.searchInput.value.trim();
        if (!searchTerm) {
            this.elements.searchError.textContent = 'Please enter a search term';
            this.elements.searchError.style.display = 'block';
            return;
        }

        this.elements.searchError.style.display = 'none';
        this.elements.searchResults.style.display = 'none';
        this.elements.searchLoading.style.display = 'flex';

        try {
            if (typeof UnifiedSearch === 'undefined') {
                throw new Error('Search module not loaded. Please refresh the page.');
            }

            const searchResult = await UnifiedSearch.search(searchTerm);
            if (searchResult.error) {
                this.elements.searchError.textContent = searchResult.error;
                this.elements.searchError.style.display = 'block';
            } else if (searchResult.results && searchResult.results.length > 0) {
                UnifiedSearch.renderResults(searchResult.results, this.elements.searchResultsList, result => {
                    this.selectResult(result);
                });
                this.elements.searchResults.style.display = 'block';
            } else {
                this.elements.searchError.textContent = 'No results found. Try a different search term or enable more sources.';
                this.elements.searchError.style.display = 'block';
            }
        } catch (error) {
            console.error('Error searching databases:', error);
            this.elements.searchError.textContent = `Search failed: ${error.message}`;
            this.elements.searchError.style.display = 'block';
        } finally {
            this.elements.searchLoading.style.display = 'none';
        }
    };

    GameImportWidget.prototype.selectResult = function(result) {
        if (!result || !this.context || !this.context.game) {
            return;
        }

        this.selectedResult = result;
        this.elements.confirmCurrentGame.innerHTML = this.config.buildCurrentPreviewHtml(
            this.context,
            {
                escapeHtml: safeEscapeHtml,
                formatNumber,
            }
        );
        this.elements.confirmMatchedGame.innerHTML = buildMatchedPreviewHtml(result);

        const sourceConfig = getSourceConfig(result.source || 'jiten');
        this.elements.confirmTitle.textContent = result.source === 'jiten'
            ? 'Confirm Game Link'
            : `Confirm Game Link (${sourceConfig.label})`;

        if (this.elements.confirmOverwriteMetadata) {
            this.elements.confirmOverwriteMetadata.checked = false;
        }

        const manualOverrides = Array.isArray(this.context.game.manual_overrides)
            ? this.context.game.manual_overrides
            : [];
        if (manualOverrides.length > 0) {
            this.elements.confirmOverriddenFieldsList.innerHTML = `<div>Fields: ${safeEscapeHtml(manualOverrides.join(', '))}</div>`;
            this.elements.confirmManualOverridesWarning.style.display = 'block';
        } else {
            this.elements.confirmOverriddenFieldsList.innerHTML = '';
            this.elements.confirmManualOverridesWarning.style.display = 'none';
        }

        this.elements.confirmError.style.display = 'none';
        this.elements.confirmError.textContent = '';
        this.elements.confirmLoading.style.display = 'none';
        this.elements.confirmButton.disabled = false;

        closeModal('linkSearchModal');
        openModal('linkConfirmModal');
    };

    GameImportWidget.prototype.confirm = async function() {
        if (!this.context || !this.context.game || !this.context.gameId || !this.selectedResult) {
            return;
        }

        if (typeof this.config.isBusy === 'function' && this.config.isBusy()) {
            return;
        }

        this.elements.confirmError.style.display = 'none';
        this.elements.confirmError.textContent = '';
        this.elements.confirmLoading.style.display = 'flex';
        this.elements.confirmButton.disabled = true;

        if (typeof this.config.setBusy === 'function') {
            this.config.setBusy(true);
        }

        try {
            const linkResult = await executeLinkRequest(
                this.context.gameId,
                this.context.game,
                this.selectedResult,
                !!this.elements.confirmOverwriteMetadata?.checked
            );

            closeModal('linkConfirmModal');

            if (typeof this.config.onSuccess === 'function') {
                try {
                    await this.config.onSuccess({
                        context: this.context,
                        selectedResult: this.selectedResult,
                        source: linkResult.source,
                        sourceLabel: linkResult.sourceLabel,
                        isJitenSource: linkResult.isJitenSource,
                        apiResult: linkResult.apiResult,
                    });
                } catch (callbackError) {
                    console.error('Game import success callback failed:', callbackError);
                }
            }
        } catch (error) {
            this.elements.confirmError.textContent = error.message;
            this.elements.confirmError.style.display = 'block';

            if (typeof this.config.onError === 'function') {
                this.config.onError(error, this.context);
            }
        } finally {
            this.elements.confirmLoading.style.display = 'none';
            this.elements.confirmButton.disabled = false;

            if (typeof this.config.setBusy === 'function') {
                this.config.setBusy(false);
            }
        }
    };

    window.GameImportWidget = {
        create(config) {
            return new GameImportWidget(config);
        },
    };
})();
