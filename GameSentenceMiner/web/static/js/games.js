/**
 * Games Grid Page - games.js
 * Fetches games from API and renders a searchable grid with management actions.
 * Dependencies: shared.js, database-helpers.js, database-popups.js,
 *   database-game-data.js, database-bulk-operations.js,
 *   database-game-operations.js, unified-search.js, database-jiten-integration.js
 */

(function () {
    'use strict';

    const PLACEHOLDER_IMAGE = '/static/favicon-96x96.png';
    let allGames = [];
    let bulkMode = false;
    let bulkSelected = new Set();
    // Track the first-selected game for merge target
    let bulkMergeTarget = null;

    // DOM elements
    const gamesGrid = document.getElementById('gamesGrid');
    const gamesLoading = document.getElementById('gamesLoading');
    const gamesError = document.getElementById('gamesError');
    const gamesEmpty = document.getElementById('gamesEmpty');
    const gamesNoResults = document.getElementById('gamesNoResults');
    const gamesSearchInput = document.getElementById('gamesSearchInput');
    const gamesRetryBtn = document.getElementById('gamesRetryBtn');
    const gamesSortSelect = document.getElementById('gamesSortSelect');
    const bulkModeToggle = document.getElementById('bulkModeToggle');
    const bulkBar = document.getElementById('gamesBulkBar');
    const bulkCountLabel = document.getElementById('gamesBulkCount');

    function formatNumber(num) {
        if (!num && num !== 0) return '0';
        return Number(num).toLocaleString();
    }

    function getGameImageSrc(image) {
        if (!image || image === '') return '';
        if (image.startsWith('data:')) return image;
        return 'data:image/png;base64,' + image;
    }

    function getDisplayTitle(game) {
        return game.title_original || game.title_romaji || game.title_english || 'Unknown Game';
    }

    function getSubtitle(game) {
        if (game.title_romaji && game.title_romaji !== game.title_original) return game.title_romaji;
        if (game.title_english) return game.title_english;
        return '';
    }

    function formatLastPlayed(timestamp) {
        if (!timestamp) return 'Never';
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return diffDays + 'd ago';
        if (diffDays < 30) return Math.floor(diffDays / 7) + 'w ago';
        return date.toLocaleDateString(undefined, {
            month: 'short', day: 'numeric',
            year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
        });
    }

    // ── Card creation ──────────────────────────────────────────────────

    function createGameCard(game) {
        const card = document.createElement('div');
        card.className = 'game-card';
        card.setAttribute('data-game-id', game.id);

        const imageSrc = getGameImageSrc(game.image);
        const title = getDisplayTitle(game);
        const subtitle = getSubtitle(game);

        const imageHTML = imageSrc
            ? `<img class="game-card-image" src="${imageSrc}" alt="${escapeHtml(title)}" loading="lazy">`
            : `<div class="game-card-placeholder"><img src="${PLACEHOLDER_IMAGE}" alt="No cover"></div>`;

        const statusClass = game.completed ? 'completed' : 'in-progress';
        const statusLabel = game.completed ? 'Completed' : 'In Progress';

        let subtitleHTML = '';
        if (subtitle) subtitleHTML = `<div class="game-card-subtitle">${escapeHtml(subtitle)}</div>`;

        // Linked badge
        const linkedBadge = game.is_linked
            ? '<span class="game-card-linked-badge">✅ Linked</span>'
            : '';

        card.innerHTML = `
            <div class="game-card-image-container">
                ${imageHTML}
                <div class="game-card-status-badge ${statusClass}">${statusLabel}</div>
                ${linkedBadge}
                <button class="game-card-menu-btn" title="Actions">⋮</button>
                <div class="game-card-menu" style="display:none;">
                    <button data-action="edit">📝 Edit</button>
                    ${!game.is_linked ? '<button data-action="search">🔍 Link to Database</button>' : ''}
                    ${game.is_linked ? '<button data-action="repull">🔄 Repull Data</button>' : ''}
                    ${game.is_linked ? '<button data-action="unlink">🔗 Unlink</button>' : ''}
                    ${!game.completed ? '<button data-action="complete">🏁 Mark Complete</button>' : ''}
                    <button data-action="dedup">🔄 Deduplicate</button>
                    <hr>
                    <button data-action="delete" class="danger-action">🗑️ Delete Lines</button>
                </div>
            </div>
            <div class="game-card-info">
                <div class="game-card-title">${escapeHtml(title)}</div>
                ${subtitleHTML}
                <div class="game-card-stats">
                    <span class="game-card-stat">Last played <span class="game-card-stat-value">${formatLastPlayed(game.last_played)}</span></span>
                    <span class="game-card-stat"><span class="game-card-stat-value">${formatNumber(game.mined_character_count)}</span> chars</span>
                </div>
            </div>
            ${bulkMode ? '<input type="checkbox" class="game-card-bulk-checkbox" aria-label="Select for bulk operation">' : ''}
        `;

        // Wire up the ⋮ menu
        const menuBtn = card.querySelector('.game-card-menu-btn');
        const menu = card.querySelector('.game-card-menu');

        menuBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            // Close any other open menus
            document.querySelectorAll('.game-card-menu').forEach(m => {
                if (m !== menu) m.style.display = 'none';
            });
            menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        });

        menu.addEventListener('click', function (e) {
            e.stopPropagation();
            const action = e.target.closest('button')?.dataset.action;
            if (!action) return;
            menu.style.display = 'none';
            handleCardAction(action, game);
        });

        // Bulk checkbox
        if (bulkMode) {
            const cb = card.querySelector('.game-card-bulk-checkbox');
            cb.checked = bulkSelected.has(game.id);
            cb.addEventListener('click', function (e) { e.stopPropagation(); });
            cb.addEventListener('change', function () {
                if (cb.checked) {
                    bulkSelected.add(game.id);
                    if (!bulkMergeTarget) bulkMergeTarget = game.id;
                } else {
                    bulkSelected.delete(game.id);
                    if (bulkMergeTarget === game.id) {
                        bulkMergeTarget = bulkSelected.size > 0 ? bulkSelected.values().next().value : null;
                    }
                }
                updateBulkUI();
            });
        }

        // Click card to navigate (unless bulk mode or menu click)
        card.addEventListener('click', function (e) {
            if (bulkMode) {
                const cb = card.querySelector('.game-card-bulk-checkbox');
                if (cb && e.target !== cb) {
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                }
                return;
            }
            window.location.href = '/game/' + game.id;
        });

        return card;
    }

    // ── Card action handler ────────────────────────────────────────────

    function handleCardAction(action, game) {
        // Ensure currentGames is populated for the database modules
        if (typeof window.currentGames === 'undefined' || !window.currentGames) {
            window.currentGames = allGames;
        }
        // Also set the module-level currentGames used by database-game-data.js
        currentGames = allGames;

        switch (action) {
            case 'edit':
                editGame(game.id);
                break;
            case 'search':
                openJitenSearch(game.id, game.title_original || '');
                break;
            case 'repull':
                repullJitenData(game.id, game.title_original || '');
                break;
            case 'unlink':
                openIndividualGameUnlinkModal(
                    game.id, game.title_original || '',
                    game.line_count || 0, game.mined_character_count || 0
                );
                break;
            case 'complete':
                markGameCompleted(game.id);
                break;
            case 'dedup':
                openDeduplicationForGame(game);
                break;
            case 'delete':
                openIndividualGameDeleteModal(
                    game.id, game.title_original || '',
                    game.line_count || 0, game.mined_character_count || 0
                );
                break;
        }
    }

    /**
     * Open deduplication modal pre-filled for a specific game.
     */
    function openDeduplicationForGame(game) {
        openModal('deduplicationModal');
        // Load games into the select, then pre-select this game
        loadGamesForDeduplication().then(function () {
            const sel = document.getElementById('gameSelection');
            if (sel) {
                // Deselect all, then select matching game by name
                Array.from(sel.options).forEach(function (opt) {
                    opt.selected = (opt.value === (game.title_original || ''));
                });
            }
        });
        // Reset modal state
        document.getElementById('timeWindow').value = '5';
        document.getElementById('ignoreTimeWindow').checked = false;
        document.getElementById('deduplicationStats').style.display = 'none';
        document.getElementById('removeDuplicatesBtn').disabled = true;
        document.getElementById('deduplicationError').style.display = 'none';
        document.getElementById('deduplicationSuccess').style.display = 'none';
        toggleTimeWindowVisibility();
    }

    // ── Grid rendering ─────────────────────────────────────────────────

    function renderGrid(games) {
        gamesGrid.innerHTML = '';
        games.forEach(function (game) {
            gamesGrid.appendChild(createGameCard(game));
        });
    }

    function sortGames(games) {
        const sortBy = gamesSortSelect.value;
        switch (sortBy) {
            case 'last_played':
                games.sort(function (a, b) { return (b.last_played || 0) - (a.last_played || 0); });
                break;
            case 'character_count':
                games.sort(function (a, b) { return b.mined_character_count - a.mined_character_count; });
                break;
            case 'title':
                games.sort(function (a, b) {
                    return (a.title_original || '').localeCompare(b.title_original || '', 'ja');
                });
                break;
            case 'line_count':
                games.sort(function (a, b) { return b.line_count - a.line_count; });
                break;
            case 'status':
                games.sort(function (a, b) {
                    if (a.completed === b.completed) return (b.last_played || 0) - (a.last_played || 0);
                    return a.completed ? 1 : -1;
                });
                break;
        }
        return games;
    }

    function filterAndRender() {
        const query = gamesSearchInput.value.trim().toLowerCase();
        let gamesToShow = allGames;
        if (query) {
            gamesToShow = allGames.filter(function (game) {
                const original = (game.title_original || '').toLowerCase();
                const romaji = (game.title_romaji || '').toLowerCase();
                const english = (game.title_english || '').toLowerCase();
                return original.includes(query) || romaji.includes(query) || english.includes(query);
            });
        }
        gamesToShow = sortGames(gamesToShow.slice());
        if (gamesToShow.length === 0 && query) {
            gamesGrid.style.display = 'none';
            gamesNoResults.style.display = 'flex';
        } else {
            gamesGrid.style.display = '';
            gamesNoResults.style.display = 'none';
            renderGrid(gamesToShow);
        }
    }

    // ── State management ───────────────────────────────────────────────

    function showState(state) {
        gamesLoading.style.display = state === 'loading' ? 'flex' : 'none';
        gamesError.style.display = state === 'error' ? 'flex' : 'none';
        gamesEmpty.style.display = state === 'empty' ? 'flex' : 'none';
        gamesNoResults.style.display = 'none';
        gamesGrid.style.display = state === 'loaded' ? '' : 'none';
    }

    // ── Data loading ───────────────────────────────────────────────────

    async function loadGames() {
        showState('loading');
        try {
            const response = await fetch('/api/games-management?sort=last_played');
            if (!response.ok) throw new Error('Failed to fetch games: ' + response.status);
            const data = await response.json();
            allGames = data.games || [];

            // Keep the database modules in sync
            if (typeof window !== 'undefined') {
                window.currentGames = allGames;
            }
            currentGames = allGames;

            if (allGames.length === 0) {
                showState('empty');
                return;
            }
            showState('loaded');
            filterAndRender();
        } catch (error) {
            console.error('Error loading games:', error);
            document.getElementById('gamesErrorMessage').textContent = error.message || 'Failed to load games';
            showState('error');
        }
    }

    // ── Bulk mode ──────────────────────────────────────────────────────

    function toggleBulkMode() {
        bulkMode = !bulkMode;
        bulkSelected.clear();
        bulkMergeTarget = null;
        bulkBar.style.display = bulkMode ? 'flex' : 'none';
        bulkModeToggle.classList.toggle('active', bulkMode);
        bulkModeToggle.textContent = bulkMode ? '✖ Cancel' : '☑️ Bulk';
        filterAndRender();
        updateBulkUI();
    }

    function updateBulkUI() {
        const count = bulkSelected.size;
        bulkCountLabel.textContent = count + ' selected';
        document.getElementById('gamesBulkMerge').disabled = count < 2;
        document.getElementById('gamesBulkDelete').disabled = count === 0;
    }

    function bulkSelectAll() {
        const query = gamesSearchInput.value.trim().toLowerCase();
        let visible = allGames;
        if (query) {
            visible = allGames.filter(function (g) {
                return (g.title_original || '').toLowerCase().includes(query)
                    || (g.title_romaji || '').toLowerCase().includes(query)
                    || (g.title_english || '').toLowerCase().includes(query);
            });
        }
        bulkSelected.clear();
        bulkMergeTarget = null;
        visible.forEach(function (g, i) {
            bulkSelected.add(g.id);
            if (i === 0) bulkMergeTarget = g.id;
        });
        filterAndRender();
        updateBulkUI();
    }

    function bulkSelectNone() {
        bulkSelected.clear();
        bulkMergeTarget = null;
        filterAndRender();
        updateBulkUI();
    }

    /**
     * Open merge modal for bulk-selected games.
     * Reuses the shared gameMergeModal and confirmGameMerge from database-bulk-operations.js
     */
    async function bulkMerge() {
        if (bulkSelected.size < 2) return;

        try {
            const response = await fetch('/api/games-list');
            const data = await response.json();
            if (!response.ok || !data.games) return;

            // Map game IDs to names for the merge API
            const idToName = {};
            allGames.forEach(function (g) { idToName[g.id] = g.title_original || ''; });

            const selectedNames = [];
            bulkSelected.forEach(function (id) {
                if (idToName[id]) selectedNames.push(idToName[id]);
            });

            const selectedGames = data.games.filter(function (g) {
                return selectedNames.includes(g.name);
            });

            if (selectedGames.length < 2) {
                showDatabaseErrorPopup('Could not find selected games. Please try again.');
                return;
            }

            // Determine primary game (merge target)
            const targetName = idToName[bulkMergeTarget] || selectedNames[0];
            let primaryGame = selectedGames.find(function (g) { return g.name === targetName; });
            if (!primaryGame) primaryGame = selectedGames[0];

            const secondaryGames = selectedGames.filter(function (g) { return g.name !== primaryGame.name; });
            const totalSentences = selectedGames.reduce(function (s, g) { return s + g.sentence_count; }, 0);
            const totalCharacters = selectedGames.reduce(function (s, g) { return s + g.total_characters; }, 0);

            document.getElementById('primaryGameName').textContent = primaryGame.name;
            document.getElementById('primaryGameStats').textContent =
                primaryGame.sentence_count + ' sentences, ' + primaryGame.total_characters.toLocaleString() + ' characters';

            const secondaryList = document.getElementById('secondaryGamesList');
            secondaryList.innerHTML = '';
            secondaryGames.forEach(function (g) {
                const div = document.createElement('div');
                div.className = 'game-item';
                div.innerHTML = '<div class="game-name">' + escapeHtml(g.name) + '</div>'
                    + '<div class="game-stats">' + g.sentence_count + ' sentences, ' + g.total_characters.toLocaleString() + ' characters</div>';
                secondaryList.appendChild(div);
            });

            document.getElementById('totalSentencesAfterMerge').textContent = totalSentences.toLocaleString();
            document.getElementById('totalCharactersAfterMerge').textContent = totalCharacters.toLocaleString();
            document.getElementById('gamesBeingMerged').textContent = selectedNames.length.toString();

            document.getElementById('mergeError').style.display = 'none';
            document.getElementById('mergeSuccess').style.display = 'none';
            document.getElementById('mergeLoadingIndicator').style.display = 'none';
            document.getElementById('confirmMergeBtn').disabled = false;

            // Store for confirmGameMerge
            window.selectedGamesForMerge = selectedNames;
            // Set merge target for the shared function
            window._gamesBulkMergeTarget = targetName;

            openModal('gameMergeModal');
        } catch (error) {
            console.error('Error preparing merge:', error);
            showDatabaseErrorPopup('Failed to load game data for merge');
        }
    }

    /**
     * Delete lines for all bulk-selected games.
     */
    function bulkDelete() {
        if (bulkSelected.size === 0) return;

        const idToName = {};
        allGames.forEach(function (g) { idToName[g.id] = g.title_original || ''; });

        const gameNames = [];
        bulkSelected.forEach(function (id) {
            if (idToName[id]) gameNames.push(idToName[id]);
        });

        showDatabaseConfirmPopup(
            'Are you sure you want to PERMANENTLY DELETE all lines for ' + gameNames.length + ' game(s)? This cannot be undone.',
            async function () {
                try {
                    const response = await fetch('/api/delete-games', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ game_names: gameNames })
                    });
                    const result = await response.json();
                    if (response.ok) {
                        showDatabaseSuccessPopup('Deleted ' + (result.successful_games || []).length + ' game(s).');
                        bulkSelected.clear();
                        bulkMergeTarget = null;
                        updateBulkUI();
                        await loadGames();
                    } else {
                        showDatabaseErrorPopup('Error: ' + (result.error || 'Unknown error'));
                    }
                } catch (error) {
                    console.error('Error deleting games:', error);
                    showDatabaseErrorPopup('Failed to delete games');
                }
            }
        );
    }

    // ── Close menus on outside click ───────────────────────────────────

    document.addEventListener('click', function () {
        document.querySelectorAll('.game-card-menu').forEach(function (m) {
            m.style.display = 'none';
        });
    });

    // ── Initialize database module integrations ────────────────────────

    function initDatabaseModules() {
        // Initialize popup close buttons
        if (typeof initializeDatabasePopups === 'function') initializeDatabasePopups();

        // Initialize jiten integration (search btn, confirm link btn, image upload)
        if (typeof initializeJitenIntegration === 'function') initializeJitenIntegration();

        // Initialize individual game operations (unlink/delete confirm buttons)
        if (typeof initializeGameOperations === 'function') initializeGameOperations();

        // Initialize text management (dedup scan/remove buttons, time window toggle)
        if (typeof initializeTextManagement === 'function') initializeTextManagement();

        // Wire up modal close buttons
        document.querySelectorAll('[data-action="closeModal"]').forEach(function (btn) {
            const modalId = btn.getAttribute('data-modal');
            if (modalId) {
                btn.addEventListener('click', function () { closeModal(modalId); });
            }
        });

        // Wire up merge confirm button
        var confirmMergeBtn = document.querySelector('[data-action="confirmGameMerge"]');
        if (confirmMergeBtn) {
            confirmMergeBtn.addEventListener('click', function () {
                // Override the merge target for the shared function
                if (window._gamesBulkMergeTarget) {
                    if (typeof databaseManager !== 'undefined') {
                        databaseManager.mergeTargetGame = window._gamesBulkMergeTarget;
                    }
                }
                confirmGameMerge().then(function () {
                    // Refresh games grid after merge
                    setTimeout(function () { loadGames(); }, 2500);
                });
            });
        }
    }

    /**
     * Override refreshAfterLinking to reload the games grid instead of
     * the database page's game list.
     */
    function patchRefreshAfterLinking() {
        window.refreshAfterLinking = async function () {
            console.log('Refreshing games grid after linking...');
            await loadGames();
        };
        // Also patch loadGamesForDataManagement which is called after
        // saveGameEdits and markGameCompleted in database-jiten-integration.js
        window.loadGamesForDataManagement = async function () {
            await loadGames();
        };
    }

    /**
     * Override switchTab to be a no-op on the games page (it's used by
     * database-game-operations.js after unlink/delete to refresh the
     * database page's tabs).
     */
    function patchSwitchTab() {
        if (typeof switchTab === 'undefined') {
            window.switchTab = function () {
                // Reload games grid instead
                loadGames();
            };
        }
    }

    // ── Event listeners ────────────────────────────────────────────────

    gamesSearchInput.addEventListener('input', filterAndRender);
    gamesSortSelect.addEventListener('change', filterAndRender);
    gamesRetryBtn.addEventListener('click', loadGames);
    bulkModeToggle.addEventListener('click', toggleBulkMode);
    document.getElementById('gamesBulkSelectAll').addEventListener('click', bulkSelectAll);
    document.getElementById('gamesBulkSelectNone').addEventListener('click', bulkSelectNone);
    document.getElementById('gamesBulkMerge').addEventListener('click', bulkMerge);
    document.getElementById('gamesBulkDelete').addEventListener('click', bulkDelete);

    // ── Boot ───────────────────────────────────────────────────────────

    patchSwitchTab();
    patchRefreshAfterLinking();
    initDatabaseModules();
    loadGames();

})();
