/**
 * Game Detail Page - game-stats.js
 * Fetches game stats, renders game info, handles settings cog management actions.
 */

(function() {
    'use strict';

    const PLACEHOLDER_IMAGE = '/static/favicon-96x96.png';
    const gameId = window.gameConfig ? window.gameConfig.gameId : null;

    if (!gameId) {
        console.error('No gameId found in config');
        return;
    }

    // Current game data (cached for management actions)
    let currentGameData = null;
    let currentStatsData = null;
    let dailySpeedChart = null;

    // Selected games for merge
    let mergeSelectedGames = [];
    let allGamesForMerge = [];

    // ================================================================
    //  DOM References
    // ================================================================
    const gameDetailLoading = document.getElementById('gameDetailLoading');
    const gameDetailError = document.getElementById('gameDetailError');
    const gameDetailErrorMessage = document.getElementById('gameDetailErrorMessage');
    const gameDetailContent = document.getElementById('gameDetailContent');

    // Game info elements
    const gameDetailCard = document.getElementById('gameDetailCard');
    const gameDetailHeaderTitle = document.getElementById('gameDetailHeaderTitle');
    const gamePhoto = document.getElementById('gamePhoto');
    const gamePhotoSection = document.getElementById('gamePhotoSection');
    const gameTitleOriginal = document.getElementById('gameTitleOriginal');
    const gameTitleRomaji = document.getElementById('gameTitleRomaji');
    const gameTitleEnglish = document.getElementById('gameTitleEnglish');
    const gameTypeBadge = document.getElementById('gameTypeBadge');
    const gameDescription = document.getElementById('gameDescription');
    const descriptionExpandBtn = document.getElementById('descriptionExpandBtn');
    const gameLinksContainer = document.getElementById('gameLinksContainer');
    const gameLinksPills = document.getElementById('gameLinksPills');
    const gameGenresContainer = document.getElementById('gameGenresContainer');
    const gameGenresPills = document.getElementById('gameGenresPills');
    const gameTagsContainer = document.getElementById('gameTagsContainer');
    const gameTagsPills = document.getElementById('gameTagsPills');
    const gameProgressContainer = document.getElementById('gameProgressContainer');
    const gameProgressPercentage = document.getElementById('gameProgressPercentage');
    const gameProgressFill = document.getElementById('gameProgressFill');
    const gameStartDate = document.getElementById('gameStartDate');
    const gameEstimatedEndDate = document.getElementById('gameEstimatedEndDate');

    // Stats elements
    const statTotalChars = document.getElementById('statTotalChars');
    const statReadingSpeed = document.getElementById('statReadingSpeed');
    const statTotalTime = document.getElementById('statTotalTime');
    const statEstTimeLeft = document.getElementById('statEstTimeLeft');
    const statTotalSentences = document.getElementById('statTotalSentences');
    const statCardsMined = document.getElementById('statCardsMined');

    // Settings cog
    const settingsCogBtn = document.getElementById('settingsCogBtn');
    const settingsCogDropdown = document.getElementById('settingsCogDropdown');

    // ================================================================
    //  Utilities
    // ================================================================
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatNumber(num) {
        if (!num && num !== 0) return '0';
        return Number(num).toLocaleString();
    }

    function getImageSrc(image) {
        if (!image || image === '') return '';
        if (image.startsWith('data:')) return image;
        return 'data:image/png;base64,' + image;
    }

    function showState(state) {
        gameDetailLoading.style.display = state === 'loading' ? 'flex' : 'none';
        gameDetailError.style.display = state === 'error' ? 'flex' : 'none';
        gameDetailContent.style.display = state === 'loaded' ? '' : 'none';
    }

    function openModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.classList.add('show');
    }

    function closeModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.classList.remove('show');
    }

    function getLinkLabel(url) {
        if (!url) return 'Link';
        try {
            const hostname = new URL(url).hostname.replace('www.', '');
            const knownSites = {
                'vndb.org': 'VNDB',
                'anilist.co': 'AniList',
                'myanimelist.net': 'MAL',
                'jiten.moe': 'Jiten.moe',
                'store.steampowered.com': 'Steam',
                'dlsite.com': 'DLsite',
            };
            return knownSites[hostname] || hostname;
        } catch {
            return 'Link';
        }
    }

    // ================================================================
    //  Render Game Detail
    // ================================================================
    function renderGameInfo(game) {
        // Header title
        gameDetailHeaderTitle.textContent = game.title_original || 'Game Details';

        // Cover image
        const imageSrc = getImageSrc(game.image);
        if (imageSrc) {
            gamePhoto.src = imageSrc;
            gamePhoto.style.display = '';
            gamePhoto.onerror = function() {
                this.style.display = 'none';
                gamePhotoSection.innerHTML = '<div class="game-photo-placeholder"><img src="' + PLACEHOLDER_IMAGE + '" alt="No cover"></div>';
            };
        } else {
            gamePhoto.style.display = 'none';
            gamePhotoSection.innerHTML = '<div class="game-photo-placeholder"><img src="' + PLACEHOLDER_IMAGE + '" alt="No cover"></div>';
        }

        // Titles
        gameTitleOriginal.textContent = game.title_original || '';
        gameTitleRomaji.textContent = game.title_romaji || '';
        gameTitleEnglish.textContent = game.title_english || '';

        // Type badge
        if (game.type) {
            gameTypeBadge.textContent = game.type;
            gameTypeBadge.style.display = '';
        } else {
            gameTypeBadge.style.display = 'none';
        }

        // Description
        if (game.description) {
            gameDescription.textContent = game.description;
            // Check if text overflows
            requestAnimationFrame(function() {
                if (gameDescription.scrollHeight > gameDescription.clientHeight) {
                    descriptionExpandBtn.style.display = '';
                }
            });
        }

        // Links
        const links = game.links || [];
        if (links.length > 0) {
            gameLinksPills.innerHTML = '';
            links.forEach(function(link) {
                const url = typeof link === 'string' ? link : (link.url || '');
                if (!url) return;
                const pill = document.createElement('a');
                pill.className = 'game-link-pill';
                pill.href = url;
                pill.target = '_blank';
                pill.rel = 'noopener noreferrer';
                pill.textContent = getLinkLabel(url);
                gameLinksPills.appendChild(pill);
            });
            gameLinksContainer.style.display = '';
        }

        // Genres
        const genres = game.genres || [];
        if (genres.length > 0) {
            gameGenresPills.innerHTML = '';
            genres.forEach(function(genre) {
                const pill = document.createElement('span');
                pill.className = 'game-genre-pill';
                pill.textContent = genre;
                gameGenresPills.appendChild(pill);
            });
            gameGenresContainer.style.display = '';
        }

        // Tags
        const tags = game.tags || [];
        if (tags.length > 0) {
            gameTagsPills.innerHTML = '';
            tags.forEach(function(tag) {
                const pill = document.createElement('span');
                pill.className = 'game-tag-pill';
                pill.textContent = tag;
                gameTagsPills.appendChild(pill);
            });
            gameTagsContainer.style.display = '';
        }

        // Completed state
        if (game.completed) {
            gameDetailCard.classList.add('completed');
            // Update the mark-complete dropdown item
            const markCompleteItem = document.querySelector('[data-action="markComplete"]');
            if (markCompleteItem) {
                markCompleteItem.innerHTML = '&#9989; Completed';
                markCompleteItem.disabled = true;
                markCompleteItem.style.opacity = '0.5';
                markCompleteItem.style.cursor = 'default';
            }
        }
    }

    function renderStats(stats, game) {
        // Stats
        statTotalChars.textContent = stats.total_characters_formatted || formatNumber(stats.total_characters);
        statReadingSpeed.textContent = stats.reading_speed_formatted || formatNumber(stats.reading_speed);
        statTotalTime.textContent = stats.total_time_formatted || '-';
        statTotalSentences.textContent = formatNumber(stats.total_sentences);
        statCardsMined.textContent = formatNumber(stats.total_cards_mined);

        // Estimate time left
        const characterCount = game.character_count || 0;
        const totalChars = stats.total_characters || 0;
        const readingSpeed = stats.reading_speed || 0;

        if (characterCount > 0 && totalChars > 0 && readingSpeed > 0) {
            const remainingChars = Math.max(0, characterCount - totalChars);
            const remainingHours = remainingChars / readingSpeed;

            if (remainingHours < 1) {
                statEstTimeLeft.textContent = Math.round(remainingHours * 60) + 'm';
            } else {
                statEstTimeLeft.textContent = remainingHours.toFixed(1) + 'h';
            }

            // Progress bar
            const percentage = Math.min(100, Math.round((totalChars / characterCount) * 100));
            gameProgressPercentage.textContent = percentage + '%';
            gameProgressFill.style.width = percentage + '%';
            gameProgressContainer.style.display = '';

            // Dates
            if (stats.first_date) {
                gameStartDate.textContent = stats.first_date;
            }

            // Estimate end date
            if (remainingHours > 0 && stats.total_time_hours > 0 && stats.first_date && stats.last_date) {
                // Calculate average hours per day
                const firstDate = new Date(stats.first_date);
                const lastDate = new Date(stats.last_date);
                const daysDiff = Math.max(1, (lastDate - firstDate) / (1000 * 60 * 60 * 24));
                const hoursPerDay = stats.total_time_hours / daysDiff;
                if (hoursPerDay > 0) {
                    const daysLeft = remainingHours / hoursPerDay;
                    const estEnd = new Date();
                    estEnd.setDate(estEnd.getDate() + Math.round(daysLeft));
                    gameEstimatedEndDate.textContent = '~' + estEnd.toISOString().split('T')[0];
                }
            }
        } else {
            statEstTimeLeft.textContent = '-';
            if (stats.first_date) {
                gameStartDate.textContent = stats.first_date;
                gameProgressContainer.style.display = '';
                gameProgressPercentage.textContent = game.completed ? '100%' : '-';
                gameProgressFill.style.width = game.completed ? '100%' : '0%';
            }
        }
    }

    function renderDailySpeedChart(dailySpeed) {
        if (!dailySpeed || !dailySpeed.labels || dailySpeed.labels.length === 0) return;

        const container = document.getElementById('dailySpeedChartContainer');
        container.style.display = '';

        const ctx = document.getElementById('dailySpeedChart').getContext('2d');

        if (dailySpeedChart) {
            dailySpeedChart.destroy();
        }

        dailySpeedChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: dailySpeed.labels,
                datasets: [
                    {
                        type: 'line',
                        label: 'Reading Speed (chars/hr)',
                        data: dailySpeed.speedData,
                        borderColor: 'rgba(0, 123, 255, 1)',
                        backgroundColor: 'rgba(0, 123, 255, 0.1)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.3,
                        yAxisID: 'y',
                        order: 0,
                    },
                    {
                        type: 'bar',
                        label: 'Characters Read',
                        data: dailySpeed.charsData,
                        backgroundColor: 'rgba(40, 167, 69, 0.5)',
                        borderColor: 'rgba(40, 167, 69, 0.8)',
                        borderWidth: 1,
                        yAxisID: 'y1',
                        order: 1,
                    },
                ],
            },
            options: {
                responsive: true,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: {
                    x: {
                        ticks: { color: 'var(--text-tertiary)', maxRotation: 45 },
                        grid: { display: false },
                    },
                    y: {
                        type: 'linear',
                        position: 'left',
                        title: { display: true, text: 'Chars/Hour', color: 'rgba(0, 123, 255, 1)' },
                        ticks: { color: 'rgba(0, 123, 255, 0.8)' },
                        grid: { color: 'rgba(0, 123, 255, 0.1)' },
                    },
                    y1: {
                        type: 'linear',
                        position: 'right',
                        title: { display: true, text: 'Characters', color: 'rgba(40, 167, 69, 1)' },
                        ticks: { color: 'rgba(40, 167, 69, 0.8)' },
                        grid: { drawOnChartArea: false },
                    },
                },
                plugins: {
                    legend: {
                        labels: { color: 'var(--text-primary)' },
                    },
                },
            },
        });
    }

    // ================================================================
    //  Load Game Data
    // ================================================================
    async function loadGameData() {
        showState('loading');

        try {
            const response = await fetch('/api/game/' + gameId + '/stats');
            if (!response.ok) {
                if (response.status === 404) {
                    gameDetailErrorMessage.textContent = 'Game not found';
                } else {
                    gameDetailErrorMessage.textContent = 'Failed to load game data (HTTP ' + response.status + ')';
                }
                showState('error');
                return;
            }

            const data = await response.json();
            currentGameData = data.game;
            currentStatsData = data.stats;

            renderGameInfo(data.game);
            renderStats(data.stats, data.game);
            renderDailySpeedChart(data.dailySpeed);

            showState('loaded');
        } catch (error) {
            console.error('Error loading game data:', error);
            gameDetailErrorMessage.textContent = error.message || 'Failed to load game data';
            showState('error');
        }
    }

    // ================================================================
    //  Description Expand/Collapse
    // ================================================================
    if (descriptionExpandBtn) {
        descriptionExpandBtn.addEventListener('click', function() {
            const expandText = this.querySelector('.expand-text');
            const collapseText = this.querySelector('.collapse-text');
            const isExpanded = gameDescription.classList.toggle('expanded');

            expandText.style.display = isExpanded ? 'none' : '';
            collapseText.style.display = isExpanded ? '' : 'none';
        });
    }

    // ================================================================
    //  Settings Cog Dropdown
    // ================================================================
    settingsCogBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        settingsCogDropdown.classList.toggle('show');
    });

    document.addEventListener('click', function() {
        settingsCogDropdown.classList.remove('show');
    });

    settingsCogDropdown.addEventListener('click', function(e) {
        e.stopPropagation();
    });

    // Dropdown action routing
    settingsCogDropdown.querySelectorAll('.dropdown-item').forEach(function(item) {
        item.addEventListener('click', function() {
            const action = this.getAttribute('data-action');
            settingsCogDropdown.classList.remove('show');

            switch (action) {
                case 'editGame': openEditModal(); break;
                case 'markComplete': markGameComplete(); break;
                case 'mergeGames': openMergeModal(); break;
                case 'unlinkGame': openUnlinkModal(); break;
                case 'deleteGame': openDeleteModal(); break;
            }
        });
    });

    // ================================================================
    //  Edit Game Modal
    // ================================================================
    function openEditModal() {
        if (!currentGameData) return;

        const g = currentGameData;
        document.getElementById('editTitleOriginal').value = g.title_original || '';
        document.getElementById('editTitleRomaji').value = g.title_romaji || '';
        document.getElementById('editTitleEnglish').value = g.title_english || '';
        document.getElementById('editType').value = g.type || '';
        document.getElementById('editDescription').value = g.description || '';
        document.getElementById('editDifficulty').value = g.difficulty || '';
        document.getElementById('editDeckId').value = g.deck_id || '';
        document.getElementById('editVndbId').value = g.vndb_id || '';
        document.getElementById('editAnilistId').value = g.anilist_id || '';
        document.getElementById('editCharacterCount').value = g.character_count || '';
        document.getElementById('editReleaseDate').value = g.release_date || '';
        document.getElementById('editCharacterSummary').value = g.character_summary || '';
        document.getElementById('editCompleted').checked = g.completed || false;

        // Links
        const links = g.links || [];
        const linkLines = links.map(function(link) {
            return typeof link === 'string' ? link : (link.url || '');
        }).filter(Boolean);
        document.getElementById('editLinksList').value = linkLines.join('\n');

        // Image preview
        const preview = document.getElementById('editImagePreview');
        const previewImg = document.getElementById('editImagePreviewImg');
        const imageSrc = getImageSrc(g.image);
        if (imageSrc) {
            previewImg.src = imageSrc;
            preview.style.display = '';
        } else {
            preview.style.display = 'none';
        }

        document.getElementById('editGameError').style.display = 'none';
        document.getElementById('editGameLoading').style.display = 'none';

        openModal('editGameModal');
    }

    // Image upload handler
    document.getElementById('editImageUpload').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(ev) {
            document.getElementById('editImagePreviewImg').src = ev.target.result;
            document.getElementById('editImagePreview').style.display = '';
        };
        reader.readAsDataURL(file);
    });

    // Save game edits
    document.getElementById('saveGameEditsBtn').addEventListener('click', async function() {
        const errorEl = document.getElementById('editGameError');
        const loadingEl = document.getElementById('editGameLoading');
        errorEl.style.display = 'none';
        loadingEl.style.display = 'flex';

        try {
            // Build links from textarea
            const linkLines = document.getElementById('editLinksList').value.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
            const links = linkLines.map(function(url) {
                return { linkType: 4, url: url };
            });

            // Handle image upload
            let imageValue = undefined;
            const fileInput = document.getElementById('editImageUpload');
            if (fileInput.files && fileInput.files[0]) {
                imageValue = await new Promise(function(resolve) {
                    const reader = new FileReader();
                    reader.onload = function(e) { resolve(e.target.result); };
                    reader.readAsDataURL(fileInput.files[0]);
                });
            }

            const data = {
                title_original: document.getElementById('editTitleOriginal').value,
                title_romaji: document.getElementById('editTitleRomaji').value,
                title_english: document.getElementById('editTitleEnglish').value,
                type: document.getElementById('editType').value,
                description: document.getElementById('editDescription').value,
                difficulty: document.getElementById('editDifficulty').value ? parseInt(document.getElementById('editDifficulty').value) : '',
                deck_id: document.getElementById('editDeckId').value ? parseInt(document.getElementById('editDeckId').value) : '',
                vndb_id: document.getElementById('editVndbId').value,
                anilist_id: document.getElementById('editAnilistId').value,
                character_count: document.getElementById('editCharacterCount').value ? parseInt(document.getElementById('editCharacterCount').value) : '',
                release_date: document.getElementById('editReleaseDate').value,
                character_summary: document.getElementById('editCharacterSummary').value,
                links: links,
                completed: document.getElementById('editCompleted').checked,
            };

            if (imageValue !== undefined) {
                data.image = imageValue;
            }

            const response = await fetch('/api/games/' + gameId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });

            if (!response.ok) {
                const errData = await response.json().catch(function() { return {}; });
                throw new Error(errData.error || 'Failed to save');
            }

            closeModal('editGameModal');
            // Reload page to reflect changes
            loadGameData();
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.style.display = '';
        } finally {
            loadingEl.style.display = 'none';
        }
    });

    // Close edit modal handlers
    document.querySelectorAll('[data-action="closeEditModal"]').forEach(function(btn) {
        btn.addEventListener('click', function() { closeModal('editGameModal'); });
    });

    // ================================================================
    //  Mark as Completed
    // ================================================================
    async function markGameComplete() {
        if (!currentGameData) return;
        if (currentGameData.completed) return;

        try {
            const response = await fetch('/api/games/' + gameId + '/mark-complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (!response.ok) {
                const errData = await response.json().catch(function() { return {}; });
                alert('Failed to mark as completed: ' + (errData.error || 'Unknown error'));
                return;
            }

            // Reload to reflect changes
            loadGameData();
        } catch (error) {
            alert('Failed to mark as completed: ' + error.message);
        }
    }

    // ================================================================
    //  Merge Games Modal
    // ================================================================
    async function openMergeModal() {
        if (!currentGameData) return;

        mergeSelectedGames = [];
        document.getElementById('mergeTargetName').textContent = currentGameData.title_original;
        document.getElementById('mergeSearchInput').value = '';
        document.getElementById('mergeError').style.display = 'none';
        document.getElementById('mergeLoading').style.display = 'none';
        document.getElementById('mergeSelectedContainer').style.display = 'none';
        document.getElementById('confirmMergeBtn').disabled = true;

        openModal('mergeGamesModal');

        // Load all games for the merge picker
        try {
            const response = await fetch('/api/games-management?sort=title');
            if (!response.ok) throw new Error('Failed to load games');
            const data = await response.json();
            allGamesForMerge = (data.games || []).filter(function(g) {
                return g.id !== gameId;
            });
            renderMergeGamesList(allGamesForMerge);
        } catch (error) {
            document.getElementById('mergeError').textContent = error.message;
            document.getElementById('mergeError').style.display = '';
        }
    }

    function renderMergeGamesList(games) {
        const list = document.getElementById('mergeGamesList');
        list.innerHTML = '';

        if (games.length === 0) {
            list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-tertiary);">No games available to merge</div>';
            return;
        }

        games.forEach(function(game) {
            const item = document.createElement('div');
            item.className = 'merge-game-item' + (mergeSelectedGames.some(function(s) { return s.id === game.id; }) ? ' selected' : '');

            const isChecked = mergeSelectedGames.some(function(s) { return s.id === game.id; });

            item.innerHTML = `
                <input type="checkbox" ${isChecked ? 'checked' : ''}>
                <div class="merge-game-info">
                    <div class="merge-game-name">${escapeHtml(game.title_original)}</div>
                    <div class="merge-game-stats">${formatNumber(game.line_count)} lines, ${formatNumber(game.mined_character_count)} chars</div>
                </div>
            `;

            item.addEventListener('click', function() {
                toggleMergeSelection(game);
            });

            list.appendChild(item);
        });
    }

    function toggleMergeSelection(game) {
        const idx = mergeSelectedGames.findIndex(function(s) { return s.id === game.id; });
        if (idx >= 0) {
            mergeSelectedGames.splice(idx, 1);
        } else {
            mergeSelectedGames.push(game);
        }
        updateMergeUI();
    }

    function updateMergeUI() {
        // Re-render the list to update checkboxes
        const query = document.getElementById('mergeSearchInput').value.trim().toLowerCase();
        const filtered = query
            ? allGamesForMerge.filter(function(g) {
                return (g.title_original || '').toLowerCase().includes(query) ||
                       (g.title_romaji || '').toLowerCase().includes(query) ||
                       (g.title_english || '').toLowerCase().includes(query);
            })
            : allGamesForMerge;
        renderMergeGamesList(filtered);

        // Update selected tags
        const container = document.getElementById('mergeSelectedContainer');
        const list = document.getElementById('mergeSelectedList');

        if (mergeSelectedGames.length > 0) {
            container.style.display = '';
            list.innerHTML = '';
            mergeSelectedGames.forEach(function(game) {
                const tag = document.createElement('span');
                tag.className = 'merge-selected-tag';
                tag.innerHTML = escapeHtml(game.title_original) + ' <button class="remove-btn">&times;</button>';
                tag.querySelector('.remove-btn').addEventListener('click', function(e) {
                    e.stopPropagation();
                    toggleMergeSelection(game);
                });
                list.appendChild(tag);
            });
        } else {
            container.style.display = 'none';
        }

        document.getElementById('confirmMergeBtn').disabled = mergeSelectedGames.length === 0;
    }

    // Merge search
    document.getElementById('mergeSearchInput').addEventListener('input', function() {
        const query = this.value.trim().toLowerCase();
        const filtered = query
            ? allGamesForMerge.filter(function(g) {
                return (g.title_original || '').toLowerCase().includes(query) ||
                       (g.title_romaji || '').toLowerCase().includes(query) ||
                       (g.title_english || '').toLowerCase().includes(query);
            })
            : allGamesForMerge;
        renderMergeGamesList(filtered);
    });

    // Confirm merge
    document.getElementById('confirmMergeBtn').addEventListener('click', async function() {
        if (mergeSelectedGames.length === 0 || !currentGameData) return;

        const errorEl = document.getElementById('mergeError');
        const loadingEl = document.getElementById('mergeLoading');
        errorEl.style.display = 'none';
        loadingEl.style.display = 'flex';
        this.disabled = true;

        try {
            const response = await fetch('/api/merge_games', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    target_game: currentGameData.title_original,
                    games_to_merge: mergeSelectedGames.map(function(g) { return g.title_original; }),
                }),
            });

            if (!response.ok) {
                const errData = await response.json().catch(function() { return {}; });
                throw new Error(errData.error || 'Merge failed');
            }

            closeModal('mergeGamesModal');
            loadGameData();
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.style.display = '';
        } finally {
            loadingEl.style.display = 'none';
            this.disabled = mergeSelectedGames.length === 0;
        }
    });

    document.querySelectorAll('[data-action="closeMergeModal"]').forEach(function(btn) {
        btn.addEventListener('click', function() { closeModal('mergeGamesModal'); });
    });

    // ================================================================
    //  Unlink Game Modal
    // ================================================================
    function openUnlinkModal() {
        if (!currentGameData) return;
        document.getElementById('unlinkGameName').textContent = currentGameData.title_original || '-';
        document.getElementById('unlinkError').style.display = 'none';
        document.getElementById('unlinkLoading').style.display = 'none';
        openModal('unlinkGameModal');
    }

    document.getElementById('confirmUnlinkBtn').addEventListener('click', async function() {
        const errorEl = document.getElementById('unlinkError');
        const loadingEl = document.getElementById('unlinkLoading');
        errorEl.style.display = 'none';
        loadingEl.style.display = 'flex';
        this.disabled = true;

        try {
            const response = await fetch('/api/games/' + gameId, {
                method: 'DELETE',
            });

            if (!response.ok) {
                const errData = await response.json().catch(function() { return {}; });
                throw new Error(errData.error || 'Unlink failed');
            }

            // Redirect to games grid
            window.location.href = '/games';
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.style.display = '';
        } finally {
            loadingEl.style.display = 'none';
            this.disabled = false;
        }
    });

    document.querySelectorAll('[data-action="closeUnlinkModal"]').forEach(function(btn) {
        btn.addEventListener('click', function() { closeModal('unlinkGameModal'); });
    });

    // ================================================================
    //  Delete Game Modal
    // ================================================================
    function openDeleteModal() {
        if (!currentGameData) return;
        document.getElementById('deleteGameName').textContent = currentGameData.title_original || '-';
        document.getElementById('deleteGameSentences').textContent = currentStatsData ? formatNumber(currentStatsData.total_sentences) : '-';
        document.getElementById('deleteError').style.display = 'none';
        document.getElementById('deleteLoading').style.display = 'none';
        openModal('deleteGameModal');
    }

    document.getElementById('confirmDeleteBtn').addEventListener('click', async function() {
        const errorEl = document.getElementById('deleteError');
        const loadingEl = document.getElementById('deleteLoading');
        errorEl.style.display = 'none';
        loadingEl.style.display = 'flex';
        this.disabled = true;

        try {
            const response = await fetch('/api/games/' + gameId + '/delete-lines', {
                method: 'DELETE',
            });

            if (!response.ok) {
                const errData = await response.json().catch(function() { return {}; });
                throw new Error(errData.error || 'Delete failed');
            }

            // Redirect to games grid
            window.location.href = '/games';
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.style.display = '';
        } finally {
            loadingEl.style.display = 'none';
            this.disabled = false;
        }
    });

    document.querySelectorAll('[data-action="closeDeleteModal"]').forEach(function(btn) {
        btn.addEventListener('click', function() { closeModal('deleteGameModal'); });
    });

    // ================================================================
    //  Initialize
    // ================================================================
    loadGameData();

})();
