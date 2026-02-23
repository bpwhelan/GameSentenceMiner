/**
 * Games Grid Page - games.js
 * Fetches games from API and renders a searchable grid.
 */

(function() {
    'use strict';

    const PLACEHOLDER_IMAGE = '/static/favicon-96x96.png';
    let allGames = [];

    // DOM elements
    const gamesGrid = document.getElementById('gamesGrid');
    const gamesLoading = document.getElementById('gamesLoading');
    const gamesError = document.getElementById('gamesError');
    const gamesEmpty = document.getElementById('gamesEmpty');
    const gamesNoResults = document.getElementById('gamesNoResults');
    const gamesSearchInput = document.getElementById('gamesSearchInput');
    const gamesRetryBtn = document.getElementById('gamesRetryBtn');

    /**
     * Format a number with comma separators.
     */
    function formatNumber(num) {
        if (!num && num !== 0) return '0';
        return Number(num).toLocaleString();
    }

    /**
     * Get the display image source for a game.
     */
    function getGameImageSrc(image) {
        if (!image || image === '') return '';
        if (image.startsWith('data:')) return image;
        return 'data:image/png;base64,' + image;
    }

    /**
     * Get the best display title for a game.
     */
    function getDisplayTitle(game) {
        return game.title_original || game.title_romaji || game.title_english || 'Unknown Game';
    }

    /**
     * Get the subtitle (romaji or english) for a game.
     */
    function getSubtitle(game) {
        if (game.title_romaji && game.title_romaji !== game.title_original) {
            return game.title_romaji;
        }
        if (game.title_english) {
            return game.title_english;
        }
        return '';
    }

    /**
     * Create a game card element.
     */
    function createGameCard(game) {
        const card = document.createElement('div');
        card.className = 'game-card';
        card.setAttribute('data-game-id', game.id);

        const imageSrc = getGameImageSrc(game.image);
        const title = getDisplayTitle(game);
        const subtitle = getSubtitle(game);

        let imageHTML;
        if (imageSrc) {
            imageHTML = `<img class="game-card-image" src="${imageSrc}" alt="${title}" loading="lazy">`;
        } else {
            imageHTML = `<div class="game-card-placeholder"><img src="${PLACEHOLDER_IMAGE}" alt="No cover"></div>`;
        }

        let completedBadge = '';
        if (game.completed) {
            completedBadge = '<div class="game-card-completed-badge">Completed</div>';
        }

        let subtitleHTML = '';
        if (subtitle) {
            subtitleHTML = `<div class="game-card-subtitle">${escapeHtml(subtitle)}</div>`;
        }

        card.innerHTML = `
            <div class="game-card-image-container">
                ${imageHTML}
                ${completedBadge}
            </div>
            <div class="game-card-info">
                <div class="game-card-title">${escapeHtml(title)}</div>
                ${subtitleHTML}
                <div class="game-card-stats">
                    <span class="game-card-stat"><span class="game-card-stat-value">${formatNumber(game.line_count)}</span> lines</span>
                    <span class="game-card-stat"><span class="game-card-stat-value">${formatNumber(game.mined_character_count)}</span> chars</span>
                </div>
            </div>
        `;

        card.addEventListener('click', function() {
            window.location.href = `/game/${game.id}`;
        });

        return card;
    }

    /**
     * Escape HTML special characters.
     */
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Render the games grid with the given list of games.
     */
    function renderGrid(games) {
        gamesGrid.innerHTML = '';
        games.forEach(function(game) {
            gamesGrid.appendChild(createGameCard(game));
        });
    }

    /**
     * Filter games by the search input.
     */
    function filterGames() {
        const query = gamesSearchInput.value.trim().toLowerCase();

        if (!query) {
            renderGrid(allGames);
            gamesGrid.style.display = '';
            gamesNoResults.style.display = 'none';
            return;
        }

        const filtered = allGames.filter(function(game) {
            const original = (game.title_original || '').toLowerCase();
            const romaji = (game.title_romaji || '').toLowerCase();
            const english = (game.title_english || '').toLowerCase();
            return original.includes(query) || romaji.includes(query) || english.includes(query);
        });

        if (filtered.length === 0) {
            gamesGrid.style.display = 'none';
            gamesNoResults.style.display = 'flex';
        } else {
            gamesGrid.style.display = '';
            gamesNoResults.style.display = 'none';
            renderGrid(filtered);
        }
    }

    /**
     * Show a specific state and hide others.
     */
    function showState(state) {
        gamesLoading.style.display = state === 'loading' ? 'flex' : 'none';
        gamesError.style.display = state === 'error' ? 'flex' : 'none';
        gamesEmpty.style.display = state === 'empty' ? 'flex' : 'none';
        gamesNoResults.style.display = 'none';
        gamesGrid.style.display = state === 'loaded' ? '' : 'none';
    }

    /**
     * Fetch games from the API and render the grid.
     */
    async function loadGames() {
        showState('loading');

        try {
            const response = await fetch('/api/games-management?sort=last_played');
            if (!response.ok) {
                throw new Error('Failed to fetch games: ' + response.status);
            }

            const data = await response.json();
            allGames = data.games || [];

            if (allGames.length === 0) {
                showState('empty');
                return;
            }

            showState('loaded');
            renderGrid(allGames);
        } catch (error) {
            console.error('Error loading games:', error);
            document.getElementById('gamesErrorMessage').textContent = error.message || 'Failed to load games';
            showState('error');
        }
    }

    // Event listeners
    gamesSearchInput.addEventListener('input', filterGames);
    gamesRetryBtn.addEventListener('click', loadGames);

    // Initial load
    loadGames();
})();
