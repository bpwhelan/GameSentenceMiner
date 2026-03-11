// anki_stats.js: Loads missing high-frequency kanji stats

document.addEventListener('DOMContentLoaded', function () {
    console.log('Anki Stats JavaScript loaded!');
    
    const loading = document.getElementById('ankiStatsLoading');
    const error = document.getElementById('ankiStatsError');
    const missingKanjiGrid = document.getElementById('missingKanjiGrid');
    const missingKanjiCount = document.getElementById('missingKanjiCount');
    const ankiTotalKanji = document.getElementById('ankiTotalKanji');
    const gsmTotalKanji = document.getElementById('gsmTotalKanji');
    const ankiCoverage = document.getElementById('ankiCoverage');
    const fromDateInput = document.getElementById('fromDate');
    const toDateInput = document.getElementById('toDate');
    const ankiConnectWarning = document.getElementById('ankiConnectWarning');
    const ankiSessionId = window.ANKI_API_SESSION_ID || sessionStorage.getItem('ankiApiSessionId');
    const DEFAULT_ANKI_GAME_TABLE_PAGE_SIZE = 25;

    function getAnkiGameTablePageSize(tableId) {
        const table = document.getElementById(tableId);
        const rawPageSize = Number.parseInt(table?.dataset?.pageSize ?? '', 10);

        if (Number.isFinite(rawPageSize) && rawPageSize > 0) {
            return rawPageSize;
        }

        return DEFAULT_ANKI_GAME_TABLE_PAGE_SIZE;
    }

    const paginatedAnkiTables = {
        cardsPerGame: {
            items: [],
            page: 0,
            pageSize: getAnkiGameTablePageSize('cardsPerGameTable'),
            itemLabel: 'games',
            bodyId: 'cardsPerGameTableBody',
            emptyId: 'cardsPerGameEmpty',
            paginationId: 'cardsPerGamePagination',
            prevId: 'cardsPerGamePrev',
            nextId: 'cardsPerGameNext',
            infoId: 'cardsPerGamePageInfo',
            defaultEmptyText:
                document.getElementById('cardsPerGameEmpty')?.textContent?.trim()
                || 'No card data available for the selected date range.',
            currentEmptyText: '',
            buildRow(game) {
                const row = document.createElement('tr');

                const nameCell = document.createElement('td');
                nameCell.textContent = game.game_name;
                row.appendChild(nameCell);

                const countCell = document.createElement('td');
                countCell.textContent = game.card_count || 0;
                row.appendChild(countCell);

                return row;
            },
        },
        gameStats: {
            items: [],
            page: 0,
            pageSize: getAnkiGameTablePageSize('gameStatsTable'),
            itemLabel: 'games',
            bodyId: 'gameStatsTableBody',
            emptyId: 'gameStatsEmpty',
            paginationId: 'gameStatsPagination',
            prevId: 'gameStatsPrev',
            nextId: 'gameStatsNext',
            infoId: 'gameStatsPageInfo',
            defaultEmptyText:
                document.getElementById('gameStatsEmpty')?.textContent?.trim()
                || 'No game statistics available for the selected date range.',
            currentEmptyText: '',
            buildRow(game) {
                const row = document.createElement('tr');

                const nameCell = document.createElement('td');
                nameCell.textContent = game.game_name;
                row.appendChild(nameCell);

                const timeCell = document.createElement('td');
                timeCell.textContent = formatTime(game.avg_time_per_card);
                row.appendChild(timeCell);

                const retentionCell = document.createElement('td');
                retentionCell.textContent = game.retention_pct + '%';
                retentionCell.style.color = getRetentionColor(game.retention_pct);
                row.appendChild(retentionCell);

                return row;
            },
        },
    };

    Object.values(paginatedAnkiTables).forEach(config => {
        config.currentEmptyText = config.defaultEmptyText;
    });

    function fetchAnkiApi(path) {
        const headers = ankiSessionId ? { 'X-Anki-Session': ankiSessionId } : {};
        return fetch(path, { headers });
    }
    
    // Function to show/hide AnkiConnect warning
    function showAnkiConnectWarning(show) {
        if (ankiConnectWarning) {
            ankiConnectWarning.style.display = show ? 'block' : 'none';
        }
    }

    // Fetch sync status and update UI accordingly
    async function loadSyncStatus() {
        const syncStatusBar = document.getElementById('syncStatusBar');
        const syncStatusText = document.getElementById('syncStatusText');
        try {
            const resp = await fetchAnkiApi('/api/anki_sync_status');
            const data = await resp.json();
            if (data.cache_populated) {
                // Hide the AnkiConnect warning when cache has data
                showAnkiConnectWarning(false);
                if (syncStatusBar && syncStatusText) {
                    let msg = `Cache: ${data.note_count} notes, ${data.card_count} cards`;
                    if (data.last_synced) {
                        const d = new Date(data.last_synced);
                        msg += ` · Last synced: ${d.toLocaleString()}`;
                    }
                    syncStatusText.textContent = msg;
                    syncStatusBar.style.display = 'flex';
                }
            } else {
                if (syncStatusBar) syncStatusBar.style.display = 'none';
            }
        } catch (e) {
            console.warn('Failed to load sync status:', e);
            if (syncStatusBar) syncStatusBar.style.display = 'none';
        }
    }

    // Kick off sync status check immediately
    loadSyncStatus();
    
    // Initialize heatmap renderer with mining-specific configuration
    const miningHeatmapRenderer = new HeatmapRenderer({
        containerId: 'miningHeatmapContainer',
        metricName: 'sentences',
        metricLabel: 'sentences mined'
    });
    
    // Function to create GitHub-style heatmap for mining activity using shared component
    function createMiningHeatmap(heatmapData) {
        miningHeatmapRenderer.render(heatmapData);
    }
    
    
    console.log('Found DOM elements:', {
        loading, error, missingKanjiGrid, missingKanjiCount,
        ankiTotalKanji, gsmTotalKanji, ankiCoverage
    });

    function showLoading(show) {
        loading.style.display = show ? '' : 'none';
    }
    function showError(show) {
        error.style.display = show ? '' : 'none';
    }

    function renderPaginatedAnkiTable(config) {
        const tbody = document.getElementById(config.bodyId);
        const empty = document.getElementById(config.emptyId);
        const pagination = document.getElementById(config.paginationId);
        const prev = document.getElementById(config.prevId);
        const next = document.getElementById(config.nextId);
        const info = document.getElementById(config.infoId);

        if (!tbody || !empty || !pagination || !prev || !next || !info) {
            return;
        }

        if (!config.items.length) {
            tbody.innerHTML = '';
            empty.textContent = config.currentEmptyText;
            empty.style.display = 'block';
            pagination.style.display = 'none';
            info.textContent = '';
            prev.disabled = true;
            next.disabled = true;
            return;
        }

        empty.style.display = 'none';

        const totalPages = Math.ceil(config.items.length / config.pageSize);
        config.page = Math.max(0, Math.min(config.page, totalPages - 1));

        const startIndex = config.page * config.pageSize;
        const endIndex = Math.min(startIndex + config.pageSize, config.items.length);

        tbody.innerHTML = '';
        const fragment = document.createDocumentFragment();
        config.items.slice(startIndex, endIndex).forEach(item => {
            fragment.appendChild(config.buildRow(item));
        });
        tbody.appendChild(fragment);

        pagination.style.display = 'flex';
        prev.disabled = config.page === 0;
        next.disabled = config.page >= totalPages - 1;
        info.textContent = totalPages > 1
            ? `Showing ${startIndex + 1}-${endIndex} of ${config.items.length} ${config.itemLabel} · Page ${config.page + 1} of ${totalPages}`
            : `Showing ${config.items.length} ${config.itemLabel}`;
    }

    function setPaginatedAnkiTableData(config, items, emptyText = config.defaultEmptyText) {
        config.items = items;
        config.page = 0;
        config.currentEmptyText = emptyText;
        renderPaginatedAnkiTable(config);
    }

    function initializePaginatedAnkiTableControls(config) {
        const prev = document.getElementById(config.prevId);
        const next = document.getElementById(config.nextId);

        if (prev) {
            prev.addEventListener('click', () => {
                if (config.page === 0) return;
                config.page -= 1;
                renderPaginatedAnkiTable(config);
            });
        }

        if (next) {
            next.addEventListener('click', () => {
                const totalPages = Math.ceil(config.items.length / config.pageSize);
                if (config.page >= totalPages - 1) return;
                config.page += 1;
                renderPaginatedAnkiTable(config);
            });
        }
    }

    Object.values(paginatedAnkiTables).forEach(initializePaginatedAnkiTableControls);

    // Initialize Kanji Grid Renderer (using shared component)
    const kanjiGridRenderer = new KanjiGridRenderer({
        containerSelector: '#missingKanjiGrid',
        counterSelector: '#missingKanjiCount',
        colorMode: 'frequency',
        emptyMessage: '🎉 No missing kanji! You have all frequently used kanji in your Anki collection.'
    });
    
    // Function to render kanji grid (now using shared renderer)
    function renderKanjiGrid(kanjiList) {
        console.log('renderKanjiGrid called with', kanjiList.length, 'kanji');
        kanjiGridRenderer.render(kanjiList);
        console.log('Kanji grid rendered using shared renderer');
    }

    function updateStats(data) {
        console.log('updateStats called with:', data);
        console.log('DOM elements found:', {
            ankiTotalKanji,
            gsmTotalKanji,
            ankiCoverage,
            missingKanjiGrid,
            missingKanjiCount
        });
        
        // Remove loading skeletons and update values
        if (ankiTotalKanji) {
            ankiTotalKanji.innerHTML = data.anki_kanji_count;
        }
        if (gsmTotalKanji) {
            gsmTotalKanji.innerHTML = data.gsm_kanji_count;
        }
        if (ankiCoverage) {
            const gsmCount = Number(data.gsm_kanji_count);
            const missingCount = Array.isArray(data.missing_kanji) ? data.missing_kanji.length : 0;
            let percent = 0;
            if (gsmCount > 0) {
                percent = ((gsmCount - missingCount) / gsmCount) * 100;
            }
            ankiCoverage.innerHTML = percent.toFixed(1) + '%';
        }
        if (missingKanjiCount) {
            const missingCount = Array.isArray(data.missing_kanji) ? data.missing_kanji.length : 0;
            missingKanjiCount.innerHTML = missingCount;
        }
        renderKanjiGrid(data.missing_kanji);
    }


    function getUnixTimestampsInMilliseconds(startDate, endDate) {
        // Parse the start date and create a Date object at the beginning of the day
        const start = new Date(startDate + 'T00:00:00');
        const startTimestamp = start.getTime(); 

        // Parse the end date and create a Date object at the end of the day
        const end = new Date(endDate + 'T23:59:59.999');
        const endTimestamp = end.getTime();

        return { startTimestamp, endTimestamp };
    }

    // Progressive data loading function - loads each section independently
    async function loadAllStats(start_timestamp = null, end_timestamp = null) {
        console.log('Loading Anki stats with progressive loading...');
        showLoading(true);
        showError(false);
        
        // Show all loading spinners
        const cardsPerGameLoading = document.getElementById('cardsPerGameLoading');
        const gameStatsLoading = document.getElementById('gameStatsLoading');
        const nsfwSfwRetentionLoading = document.getElementById('nsfwSfwRetentionLoading');
        if (cardsPerGameLoading) cardsPerGameLoading.style.display = 'flex';
        if (gameStatsLoading) gameStatsLoading.style.display = 'flex';
        if (nsfwSfwRetentionLoading) nsfwSfwRetentionLoading.style.display = 'flex';
        
        // Build query parameters
        const params = new URLSearchParams();
        if (start_timestamp) params.append('start_timestamp', start_timestamp);
        if (end_timestamp) params.append('end_timestamp', end_timestamp);
        const queryString = params.toString() ? `?${params.toString()}` : '';
        
        // Load sections progressively and concurrently
        const loadPromises = [
            loadKanjiStats(queryString),
            loadGameStats(queryString),
            // loadNsfwSfwRetention(queryString),
        ];
        
        // Wait for all sections to complete
        try {
            await Promise.allSettled(loadPromises);
            showAnkiConnectWarning(false);
        } catch (e) {
            console.error('Some stats failed to load:', e);
            showAnkiConnectWarning(true);
        } finally {
            showLoading(false);
            // Hide loading spinners
            if (cardsPerGameLoading) cardsPerGameLoading.style.display = 'none';
            if (gameStatsLoading) gameStatsLoading.style.display = 'none';
            if (nsfwSfwRetentionLoading) nsfwSfwRetentionLoading.style.display = 'none';


            // Show tables/grids
            const cardsPerGameTable = document.getElementById('cardsPerGameTable');
            const gameStatsTable = document.getElementById('gameStatsTable');
            const nsfwSfwRetentionStats = document.getElementById('nsfwSfwRetentionStats');
            if (cardsPerGameTable) cardsPerGameTable.style.display = 'table';
            if (gameStatsTable) gameStatsTable.style.display = 'table';
            if (nsfwSfwRetentionStats) nsfwSfwRetentionStats.style.display = 'grid';
        }
    }
    
    // Individual loading functions for each section
    async function loadKanjiStats(queryString) {
        try {
            const resp = await fetchAnkiApi(`/api/anki_kanji_stats${queryString}`);
            if (!resp.ok) throw new Error('Failed to load kanji stats');
            const data = await resp.json();
            console.log('Received kanji data:', data);
            updateStats(data);
        } catch (e) {
            console.error('Failed to load kanji stats:', e);
            // Clear all loading skeletons in the kanji section
            if (missingKanjiCount) missingKanjiCount.textContent = 'Error';
            if (ankiTotalKanji) ankiTotalKanji.textContent = '–';
            if (gsmTotalKanji) gsmTotalKanji.textContent = '–';
            if (ankiCoverage) ankiCoverage.textContent = '–';
        }
    }
    
    async function loadGameStats(queryString) {
        try {
            const resp = await fetchAnkiApi(`/api/anki_game_stats${queryString}`);
            if (!resp.ok) throw new Error('Failed to load game stats');
            const data = await resp.json();
            console.log('Received game stats data:', data);
            renderCardsPerGameTable(data);
            renderGameStatsTable(data);
            renderCollectionOverview(data);
        } catch (e) {
            console.error('Failed to load game stats:', e);
            setPaginatedAnkiTableData(
                paginatedAnkiTables.cardsPerGame,
                [],
                'Failed to load card statistics. Make sure Anki is running with AnkiConnect.'
            );
            setPaginatedAnkiTableData(
                paginatedAnkiTables.gameStats,
                [],
                'Failed to load game statistics. Make sure Anki is running with AnkiConnect.'
            );
            renderCollectionOverview(null);
        }
    }
    
    async function loadNsfwSfwRetention(queryString) {
        try {
            const resp = await fetchAnkiApi(`/api/anki_nsfw_sfw_retention${queryString}`);
            if (!resp.ok) throw new Error('Failed to load NSFW/SFW retention');
            const data = await resp.json();
            console.log('Received NSFW/SFW retention data:', data);
            renderNsfwSfwRetention(data);
        } catch (e) {
            console.error('Failed to load NSFW/SFW retention:', e);
            const nsfwSfwRetentionEmpty = document.getElementById('nsfwSfwRetentionEmpty');
            if (nsfwSfwRetentionEmpty) {
                nsfwSfwRetentionEmpty.style.display = 'block';
                nsfwSfwRetentionEmpty.textContent = 'Failed to load retention statistics. Make sure Anki is running with AnkiConnect.';
            }
        }
    }
    
    async function loadMiningHeatmap(queryString) {
        const container = document.getElementById('miningHeatmapContainer');
        if (!container) {
            console.debug('miningHeatmapContainer not found on this page, skipping');
            return;
        }
        try {
            const resp = await fetchAnkiApi(`/api/anki_mining_heatmap${queryString}`);
            if (!resp.ok) throw new Error('Failed to load mining heatmap');
            const data = await resp.json();
            console.log('Received mining heatmap data:', data);
            
            if (data && Object.keys(data).length > 0) {
                createMiningHeatmap(data);
            } else {
                container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 20px;">No mining data available for the selected date range.</p>';
            }
        } catch (e) {
            console.error('Failed to load mining heatmap:', e);
            container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 20px;">Failed to load mining heatmap.</p>';
        }
    }

    document.addEventListener("datesSetAnki", () => {
        const fromDate = sessionStorage.getItem("fromDateAnki");
        const toDate = sessionStorage.getItem("toDateAnki");
        const { startTimestamp, endTimestamp } = getUnixTimestampsInMilliseconds(fromDate, toDate);
        
        // Use unified endpoint instead of multiple calls
        loadAllStats(startTimestamp, endTimestamp);
    });

    async function initializeDates() {
        const fromDateInput = document.getElementById('fromDate');
        const toDateInput = document.getElementById('toDate');

        const fromDate = sessionStorage.getItem("fromDateAnki");
        const toDate = sessionStorage.getItem("toDateAnki");

        if (!(fromDate && toDate)) {
            try {
                // Fetch earliest date from the dedicated endpoint
                const resp = await fetchAnkiApi('/api/anki_earliest_date');
                const data = await resp.json();
                
                // Get first date in ms from API
                const firstDateinMs = data.earliest_date;
                const firstDateObject = new Date(firstDateinMs * 1000);
                const fromDate = firstDateObject.toLocaleDateString('en-CA');
                fromDateInput.value = fromDate;

                // Get today's date
                const today = new Date();
                const toDate = today.toLocaleDateString('en-CA');
                toDateInput.value = toDate;

                // Save in sessionStorage
                sessionStorage.setItem("fromDateAnki", fromDate);
                sessionStorage.setItem("toDateAnki", toDate);

                document.dispatchEvent(new Event("datesSetAnki"));
            } catch (e) {
                console.error('Failed to initialize dates:', e);
                // Fallback to today if API fails
                const today = new Date();
                const todayStr = today.toLocaleDateString('en-CA');
                fromDateInput.value = todayStr;
                toDateInput.value = todayStr;
                sessionStorage.setItem("fromDateAnki", todayStr);
                sessionStorage.setItem("toDateAnki", todayStr);
                document.dispatchEvent(new Event("datesSetAnki"));
            }
        } else {
            // If values already in sessionStorage, set inputs from there
            fromDateInput.value = fromDate;
            toDateInput.value = toDate;
            console.log("already in session storage, dispatching datesSetAnki")
            document.dispatchEvent(new Event("datesSetAnki"));
        }
    }

    function handleDateChange() {
        const fromDateStr = fromDateInput.value;
        const toDateStr = toDateInput.value;

        sessionStorage.setItem("fromDateAnki", fromDateStr);
        sessionStorage.setItem("toDateAnki", toDateStr);

        // Validate date order
        if (fromDateStr && toDateStr && new Date(fromDateStr) > new Date(toDateStr)) {
            const popup = document.getElementById('dateErrorPopup');
            if (popup) popup.classList.remove("hidden");
            return;
        }

        const { startTimestamp, endTimestamp } = getUnixTimestampsInMilliseconds(fromDateStr, toDateStr);

        // Use unified endpoint instead of multiple calls
        loadAllStats(startTimestamp, endTimestamp);
    }

    fromDateInput.addEventListener("change", handleDateChange);
    toDateInput.addEventListener("change", handleDateChange);

    initializeDates();

    function renderCollectionOverview(gameStats) {
        const totalCardsEl = document.getElementById('overviewTotalCards');
        const totalReviewsEl = document.getElementById('overviewTotalReviews');
        const reviewTimeEl = document.getElementById('overviewReviewTime');
        const retentionEl = document.getElementById('overviewRetention');
        const emptyEl = document.getElementById('collectionOverviewEmpty');
        const statsGrid = document.getElementById('collectionOverviewStats');

        if (!gameStats || gameStats.length === 0) {
            if (totalCardsEl) totalCardsEl.innerHTML = '0';
            if (totalReviewsEl) totalReviewsEl.innerHTML = '0';
            if (reviewTimeEl) reviewTimeEl.innerHTML = '0s';
            if (retentionEl) {
                retentionEl.innerHTML = 'N/A';
                retentionEl.style.color = 'var(--text-tertiary)';
            }
            if (emptyEl) emptyEl.style.display = 'block';
            if (statsGrid) statsGrid.style.display = 'none';
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';
        if (statsGrid) statsGrid.style.display = '';

        let totalCards = 0;
        let totalReviews = 0;
        let weightedRetentionSum = 0;
        let totalReviewTimeSec = 0;

        gameStats.forEach(game => {
            totalCards += (game.card_count || 0);
            totalReviews += (game.total_reviews || 0);
            // avg_time_per_card is in seconds, total_reviews is count
            totalReviewTimeSec += (game.avg_time_per_card || 0) * (game.total_reviews || 0);
            // Weight retention by number of reviews for that game
            weightedRetentionSum += (game.retention_pct || 0) * (game.total_reviews || 0);
        });

        const overallRetention = totalReviews > 0 ? (weightedRetentionSum / totalReviews) : 0;

        if (totalCardsEl) totalCardsEl.innerHTML = totalCards.toLocaleString();
        if (totalReviewsEl) totalReviewsEl.innerHTML = totalReviews.toLocaleString();
        if (reviewTimeEl) reviewTimeEl.innerHTML = formatDuration(totalReviewTimeSec);
        if (retentionEl) {
            retentionEl.innerHTML = overallRetention.toFixed(1) + '%';
            retentionEl.style.color = getRetentionColor(overallRetention);
        }
    }

    function formatDuration(totalSeconds) {
        if (totalSeconds < 60) {
            return totalSeconds.toFixed(0) + 's';
        } else if (totalSeconds < 3600) {
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = Math.floor(totalSeconds % 60);
            return `${minutes}m ${seconds}s`;
        } else {
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            return `${hours}h ${minutes}m`;
        }
    }

    function renderCardsPerGameTable(gameStats) {
        const sortedStats = Array.isArray(gameStats)
            ? [...gameStats].sort((a, b) => (b.card_count || 0) - (a.card_count || 0))
            : [];
        setPaginatedAnkiTableData(paginatedAnkiTables.cardsPerGame, sortedStats);
    }

    function renderGameStatsTable(gameStats) {
        const stats = Array.isArray(gameStats) ? [...gameStats] : [];
        setPaginatedAnkiTableData(paginatedAnkiTables.gameStats, stats);
    }
    
    function getRetentionColor(retention) {
        if (retention >= 80) {
            return 'var(--success-color, #2ecc71)';
        } else if (retention >= 70) {
            return 'var(--warning-color, #f39c12)';
        } else {
            return 'var(--danger-color, #e74c3c)';
        }
    }
    
    function formatTime(seconds) {
        if (seconds < 1) {
            return (seconds * 1000).toFixed(0) + 'ms';
        } else if (seconds < 60) {
            return seconds.toFixed(1) + 's';
        } else {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = Math.floor(seconds % 60);
            return `${minutes}m ${remainingSeconds}s`;
    }
    }
    
    // Note: Old individual loading functions (loadGameStats, loadNsfwSfwRetention, loadStats, loadMiningHeatmap)
    // have been replaced by the unified loadAllStats function for better performance
    
    function renderNsfwSfwRetention(data) {
        const nsfwRetentionEl = document.getElementById('nsfwRetention');
        const sfwRetentionEl = document.getElementById('sfwRetention');
        const nsfwReviewsEl = document.getElementById('nsfwReviews');
        const sfwReviewsEl = document.getElementById('sfwReviews');
        const nsfwAvgTimeEl = document.getElementById('nsfwAvgTime');
        const sfwAvgTimeEl = document.getElementById('sfwAvgTime');
        const nsfwSfwRetentionEmpty = document.getElementById('nsfwSfwRetentionEmpty');
        
        // Check if we have any data
        if (data.nsfw_reviews === 0 && data.sfw_reviews === 0) {
            nsfwSfwRetentionEmpty.style.display = 'block';
            document.getElementById('nsfwSfwRetentionStats').style.display = 'none';
            return;
        }
        
        nsfwSfwRetentionEmpty.style.display = 'none';
        
        // Update NSFW retention (remove skeleton and set content)
        if (data.nsfw_reviews > 0) {
            nsfwRetentionEl.innerHTML = data.nsfw_retention + '%';
            nsfwRetentionEl.style.color = getRetentionColor(data.nsfw_retention);
            nsfwReviewsEl.textContent = data.nsfw_reviews + ' reviews';
            nsfwAvgTimeEl.innerHTML = formatTime(data.nsfw_avg_time);
            nsfwAvgTimeEl.style.color = 'var(--text-primary)';
        } else {
            nsfwRetentionEl.innerHTML = 'N/A';
            nsfwRetentionEl.style.color = 'var(--text-tertiary)';
            nsfwReviewsEl.textContent = 'No reviews';
            nsfwAvgTimeEl.innerHTML = 'N/A';
            nsfwAvgTimeEl.style.color = 'var(--text-tertiary)';
        }
        
        // Update SFW retention (remove skeleton and set content)
        if (data.sfw_reviews > 0) {
            sfwRetentionEl.innerHTML = data.sfw_retention + '%';
            sfwRetentionEl.style.color = getRetentionColor(data.sfw_retention);
            sfwReviewsEl.textContent = data.sfw_reviews + ' reviews';
            sfwAvgTimeEl.innerHTML = formatTime(data.sfw_avg_time);
            sfwAvgTimeEl.style.color = 'var(--text-primary)';
        } else {
            sfwRetentionEl.innerHTML = 'N/A';
            sfwRetentionEl.style.color = 'var(--text-tertiary)';
            sfwReviewsEl.textContent = 'No reviews';
            sfwAvgTimeEl.innerHTML = 'N/A';
            sfwAvgTimeEl.style.color = 'var(--text-tertiary)';
        }
    }
    
    // Note: NSFW/SFW retention stats are now loaded via the unified loadAllStats function
    // which is triggered by the "datesSetAnki" event listener above (line 218-225)

    // ================================================================
    // Words Not In Anki — searchable, sortable, paginated table
    // ================================================================
    const WORDS_NOT_IN_ANKI_TIMEOUT_MS = 15000;
    const wordsNotInAnkiDefaultEmptyText = (
        document.getElementById('wordsNotInAnkiEmpty')?.textContent?.trim()
        || 'No words found. Either all words are in Anki or tokenisation is not enabled.'
    );
    const wordsNotInAnki = {
        sort: 'frequency',
        order: 'desc',
        offset: 0,
        limit: 100,
        search: '',
        pos: '',
        vocabOnly: true,
        globalRankBounds: { min: null, max: null },
        globalRankMin: null,
        globalRankMax: null,
        globalRankSource: null,
        total: 0,
        debounceTimer: null,
        rankDebounceTimer: null,
        requestId: 0,
        listRequest: null,
    };
    const wordDetailLinesDefaultEmptyText = (
        document.getElementById('wordDetailLinesEmpty')?.textContent?.trim()
        || 'No tokenised example lines found for this word.'
    );
    const wordDetailGamesDefaultEmptyText = (
        document.getElementById('wordDetailGamesEmpty')?.textContent?.trim()
        || 'No per-game frequency data available for this word.'
    );
    const wordDetail = {
        requestId: 0,
        word: '',
        detailRequest: null,
        searchRequest: null,
    };

    function createTimedRequest(timeoutMs) {
        const controller = new AbortController();
        let timedOut = false;
        const timeoutId = window.setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        return {
            controller,
            cleanup() {
                window.clearTimeout(timeoutId);
            },
            timedOut() {
                return timedOut;
            },
        };
    }

    function abortTimedRequest(requestHandle) {
        if (!requestHandle) return;
        requestHandle.controller.abort();
        requestHandle.cleanup();
    }

    function getWordsNotInAnkiEmptyText() {
        if (areWordsNotInAnkiGlobalRankToolsActive()) {
            return 'No ranked words match the current filters.';
        }
        if (wordsNotInAnki.vocabOnly) {
            return 'No vocabulary words found. Try enabling grammar tokens or adjusting your filters.';
        }
        return wordsNotInAnkiDefaultEmptyText;
    }

    function getWordsNotInAnkiCustomGlobalRankRange() {
        if (!wordsNotInAnki.globalRankSource) {
            return null;
        }

        const bounds = wordsNotInAnki.globalRankBounds;
        if (
            bounds.min == null
            || bounds.max == null
            || wordsNotInAnki.globalRankMin == null
            || wordsNotInAnki.globalRankMax == null
        ) {
            return null;
        }

        if (
            wordsNotInAnki.globalRankMin <= bounds.min
            && wordsNotInAnki.globalRankMax >= bounds.max
        ) {
            return null;
        }

        return {
            min: wordsNotInAnki.globalRankMin,
            max: wordsNotInAnki.globalRankMax,
        };
    }

    function areWordsNotInAnkiGlobalRankToolsActive() {
        return (
            wordsNotInAnki.globalRankSource !== null
            && (
                wordsNotInAnki.sort === 'global_rank'
                || getWordsNotInAnkiCustomGlobalRankRange() !== null
            )
        );
    }

    function formatWordsNotInAnkiGlobalRankSource(source) {
        if (!source || !source.name) return 'Unavailable';
        const version = source.version ? ` (${source.version})` : '';
        return `${source.name}${version}`;
    }

    function setWordsNotInAnkiGlobalRankInputsDisabled(disabled) {
        [
            'wordsNotInAnkiGlobalRankMinInput',
            'wordsNotInAnkiGlobalRankMaxInput',
            'wordsNotInAnkiGlobalRankMinRange',
            'wordsNotInAnkiGlobalRankMaxRange',
            'wordsNotInAnkiGlobalRankReset',
        ].forEach(id => {
            const element = document.getElementById(id);
            if (element) element.disabled = disabled;
        });
    }

    function updateWordsNotInAnkiGlobalRankFill() {
        const fill = document.getElementById('wordsNotInAnkiGlobalRankFill');
        const bounds = wordsNotInAnki.globalRankBounds;
        if (!fill || bounds.min == null || bounds.max == null) {
            if (fill) {
                fill.style.left = '0%';
                fill.style.width = '0%';
            }
            return;
        }

        const total = bounds.max - bounds.min;
        if (total <= 0) {
            fill.style.left = '0%';
            fill.style.width = '100%';
            return;
        }

        const left = ((wordsNotInAnki.globalRankMin - bounds.min) / total) * 100;
        const right = ((wordsNotInAnki.globalRankMax - bounds.min) / total) * 100;
        fill.style.left = `${Math.max(0, left)}%`;
        fill.style.width = `${Math.max(0, right - left)}%`;
    }

    function syncWordsNotInAnkiGlobalRankControls(bounds, source) {
        const card = document.getElementById('wordsNotInAnkiGlobalRankCard');
        const sourceLabel = document.getElementById('wordsNotInAnkiGlobalRankSource');
        const minInput = document.getElementById('wordsNotInAnkiGlobalRankMinInput');
        const maxInput = document.getElementById('wordsNotInAnkiGlobalRankMaxInput');
        const minRange = document.getElementById('wordsNotInAnkiGlobalRankMinRange');
        const maxRange = document.getElementById('wordsNotInAnkiGlobalRankMaxRange');

        wordsNotInAnki.globalRankSource = source || null;
        if (sourceLabel) {
            sourceLabel.textContent = formatWordsNotInAnkiGlobalRankSource(source);
            if (source?.source_url) {
                sourceLabel.title = source.source_url;
            } else {
                sourceLabel.removeAttribute('title');
            }
        }

        if (!card || !source) {
            if (card) card.style.display = 'none';
            wordsNotInAnki.globalRankBounds = { min: null, max: null };
            wordsNotInAnki.globalRankMin = null;
            wordsNotInAnki.globalRankMax = null;
            setWordsNotInAnkiGlobalRankInputsDisabled(true);
            updateWordsNotInAnkiGlobalRankFill();
            return;
        }

        card.style.display = '';

        if (bounds?.min == null || bounds?.max == null) {
            wordsNotInAnki.globalRankBounds = { min: null, max: null };
            wordsNotInAnki.globalRankMin = null;
            wordsNotInAnki.globalRankMax = null;
            if (minInput) minInput.value = '';
            if (maxInput) maxInput.value = '';
            if (minRange) {
                minRange.min = '1';
                minRange.max = '1';
                minRange.value = '1';
            }
            if (maxRange) {
                maxRange.min = '1';
                maxRange.max = '1';
                maxRange.value = '1';
            }
            setWordsNotInAnkiGlobalRankInputsDisabled(true);
            updateWordsNotInAnkiGlobalRankFill();
            return;
        }

        const availableMin = Number(bounds.min);
        const availableMax = Number(bounds.max);
        wordsNotInAnki.globalRankBounds = { min: availableMin, max: availableMax };

        if (wordsNotInAnki.globalRankMin == null) {
            wordsNotInAnki.globalRankMin = availableMin;
        }
        if (wordsNotInAnki.globalRankMax == null) {
            wordsNotInAnki.globalRankMax = availableMax;
        }

        wordsNotInAnki.globalRankMin = Math.max(
            availableMin,
            Math.min(wordsNotInAnki.globalRankMin, availableMax)
        );
        wordsNotInAnki.globalRankMax = Math.max(
            wordsNotInAnki.globalRankMin,
            Math.min(wordsNotInAnki.globalRankMax, availableMax)
        );

        if (minInput) {
            minInput.min = String(availableMin);
            minInput.max = String(availableMax);
            minInput.value = String(wordsNotInAnki.globalRankMin);
        }
        if (maxInput) {
            maxInput.min = String(availableMin);
            maxInput.max = String(availableMax);
            maxInput.value = String(wordsNotInAnki.globalRankMax);
        }
        if (minRange) {
            minRange.min = String(availableMin);
            minRange.max = String(availableMax);
            minRange.value = String(wordsNotInAnki.globalRankMin);
        }
        if (maxRange) {
            maxRange.min = String(availableMin);
            maxRange.max = String(availableMax);
            maxRange.value = String(wordsNotInAnki.globalRankMax);
        }

        setWordsNotInAnkiGlobalRankInputsDisabled(false);
        updateWordsNotInAnkiGlobalRankFill();
    }

    function scheduleWordsNotInAnkiGlobalRankReload() {
        clearTimeout(wordsNotInAnki.rankDebounceTimer);
        wordsNotInAnki.rankDebounceTimer = setTimeout(() => {
            wordsNotInAnki.offset = 0;
            loadWordsNotInAnki();
        }, 150);
    }

    function resetWordsNotInAnkiGlobalRankRange() {
        const bounds = wordsNotInAnki.globalRankBounds;
        if (bounds.min == null || bounds.max == null) return;
        wordsNotInAnki.globalRankMin = bounds.min;
        wordsNotInAnki.globalRankMax = bounds.max;
        syncWordsNotInAnkiGlobalRankControls(bounds, wordsNotInAnki.globalRankSource);
        wordsNotInAnki.offset = 0;
        loadWordsNotInAnki();
    }

    function buildWordSearchHref(word) {
        const params = new URLSearchParams({
            q: word,
            use_tokenised: 'true',
        });
        return `/search?${params.toString()}`;
    }

    function renderGlobalRankCell(globalRank) {
        if (globalRank == null) {
            return '<span class="words-rank-value-empty">—</span>';
        }
        return `<span class="words-rank-value">${globalRank.toLocaleString()}</span>`;
    }

    function setWordDetailSearchHref(word) {
        const openSearchLink = document.getElementById('wordDetailOpenSearch');
        if (openSearchLink) {
            openSearchLink.href = buildWordSearchHref(word);
        }
    }

    function showWordDetailError(message) {
        const errorEl = document.getElementById('wordDetailError');
        if (!errorEl) return;
        if (!message) {
            errorEl.style.display = 'none';
            errorEl.textContent = '';
            return;
        }
        errorEl.textContent = message;
        errorEl.style.display = 'block';
    }

    function setWordDetailLoading(loading) {
        const loadingEl = document.getElementById('wordDetailLoading');
        if (loadingEl) loadingEl.style.display = loading ? 'flex' : 'none';
    }

    function setWordDetailContentVisible(visible) {
        const contentEl = document.getElementById('wordDetailContent');
        if (contentEl) contentEl.style.display = visible ? 'block' : 'none';
    }

    function abortWordDetailRequests() {
        if (wordDetail.detailRequest) {
            abortTimedRequest(wordDetail.detailRequest);
            wordDetail.detailRequest = null;
        }
        if (wordDetail.searchRequest) {
            abortTimedRequest(wordDetail.searchRequest);
            wordDetail.searchRequest = null;
        }
    }

    function resetWordDetailModal(word) {
        const titleEl = document.getElementById('wordDetailModalTitle');
        const subtitleEl = document.getElementById('wordDetailModalSubtitle');
        const gamesEl = document.getElementById('wordDetailGames');
        const linesEl = document.getElementById('wordDetailLines');
        const gamesEmptyEl = document.getElementById('wordDetailGamesEmpty');
        const linesEmptyEl = document.getElementById('wordDetailLinesEmpty');
        const linesMetaEl = document.getElementById('wordDetailLinesMeta');

        if (titleEl) titleEl.textContent = word ? `Word Details: ${word}` : 'Word Details';
        if (subtitleEl) subtitleEl.textContent = 'Tokenised examples and Anki status';
        if (document.getElementById('wordDetailWord')) {
            document.getElementById('wordDetailWord').textContent = word || '—';
        }
        if (document.getElementById('wordDetailReading')) {
            document.getElementById('wordDetailReading').textContent = '—';
        }
        if (document.getElementById('wordDetailPos')) {
            document.getElementById('wordDetailPos').textContent = '—';
        }
        if (document.getElementById('wordDetailAnkiState')) {
            const ankiStateEl = document.getElementById('wordDetailAnkiState');
            ankiStateEl.textContent = 'Not in Anki';
            ankiStateEl.classList.remove('is-known');
        }
        if (document.getElementById('wordDetailTotalOccurrences')) {
            document.getElementById('wordDetailTotalOccurrences').textContent = '0';
        }
        if (document.getElementById('wordDetailDeck')) {
            document.getElementById('wordDetailDeck').textContent = 'Not in Anki';
        }
        if (document.getElementById('wordDetailInterval')) {
            document.getElementById('wordDetailInterval').textContent = '—';
        }
        if (document.getElementById('wordDetailDue')) {
            document.getElementById('wordDetailDue').textContent = '—';
        }

        if (gamesEl) gamesEl.innerHTML = '';
        if (linesEl) linesEl.innerHTML = '';
        if (gamesEmptyEl) {
            gamesEmptyEl.textContent = wordDetailGamesDefaultEmptyText;
            gamesEmptyEl.style.display = 'none';
        }
        if (linesEmptyEl) {
            linesEmptyEl.textContent = wordDetailLinesDefaultEmptyText;
            linesEmptyEl.style.display = 'none';
        }
        if (linesMetaEl) linesMetaEl.textContent = '';

        showWordDetailError('');
        setWordDetailContentVisible(false);
        setWordDetailLoading(true);
        setWordDetailSearchHref(word);
    }

    function closeWordDetailModal() {
        abortWordDetailRequests();
        closeModal('wordDetailModal');
    }

    async function fetchJsonWithTimeout(url, requestHandle) {
        const resp = await fetch(url, { signal: requestHandle.controller.signal });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        return data;
    }

    function formatWordDetailError(error, requestHandle, fallbackMessage) {
        if (!requestHandle) return fallbackMessage;
        if (requestHandle.controller.signal.aborted && !requestHandle.timedOut()) {
            return '';
        }
        if (requestHandle.timedOut()) {
            return `${fallbackMessage} Request timed out.`;
        }
        if (error instanceof Error && error.message) {
            return `${fallbackMessage} ${error.message}`;
        }
        return fallbackMessage;
    }

    function formatWordDetailTimestamp(timestamp) {
        const numeric = Number(timestamp);
        if (!Number.isFinite(numeric) || numeric <= 0) return 'Unknown time';
        const millis = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
        const date = new Date(millis);
        if (Number.isNaN(date.getTime())) return 'Unknown time';
        return date.toLocaleString();
    }

    function renderWordDetailGames(games) {
        const gamesEl = document.getElementById('wordDetailGames');
        const gamesEmptyEl = document.getElementById('wordDetailGamesEmpty');
        if (!gamesEl || !gamesEmptyEl) return;

        gamesEl.innerHTML = '';
        if (!Array.isArray(games) || games.length === 0) {
            gamesEmptyEl.textContent = wordDetailGamesDefaultEmptyText;
            gamesEmptyEl.style.display = 'block';
            return;
        }

        gamesEmptyEl.style.display = 'none';
        const fragment = document.createDocumentFragment();
        games.forEach(game => {
            const row = document.createElement('div');
            row.className = 'word-detail-game-row';

            const name = document.createElement('div');
            name.className = 'word-detail-game-name';
            name.textContent = game.game_name || 'Unknown game';

            const frequency = document.createElement('div');
            frequency.className = 'word-detail-game-frequency';
            frequency.textContent = `${Number(game.frequency || 0).toLocaleString()} seen`;

            row.appendChild(name);
            row.appendChild(frequency);
            fragment.appendChild(row);
        });

        gamesEl.appendChild(fragment);
    }

    function renderWordDetailSummary(detail) {
        const subtitleEl = document.getElementById('wordDetailModalSubtitle');
        const wordEl = document.getElementById('wordDetailWord');
        const readingEl = document.getElementById('wordDetailReading');
        const posEl = document.getElementById('wordDetailPos');
        const ankiStateEl = document.getElementById('wordDetailAnkiState');
        const totalOccurrencesEl = document.getElementById('wordDetailTotalOccurrences');
        const deckEl = document.getElementById('wordDetailDeck');
        const intervalEl = document.getElementById('wordDetailInterval');
        const dueEl = document.getElementById('wordDetailDue');

        const inAnki = Boolean(
            detail.deck_name
            || detail.interval != null
            || detail.due != null
        );

        if (subtitleEl) {
            const gameCount = Array.isArray(detail.games) ? detail.games.length : 0;
            subtitleEl.textContent = `${gameCount.toLocaleString()} game${gameCount === 1 ? '' : 's'} in top frequency breakdown`;
        }
        if (wordEl) wordEl.textContent = detail.word || wordDetail.word || '—';
        if (readingEl) readingEl.textContent = detail.reading || '—';
        if (posEl) posEl.textContent = detail.pos || '—';
        if (ankiStateEl) {
            ankiStateEl.textContent = inAnki ? 'In Anki' : 'Not in Anki';
            ankiStateEl.classList.toggle('is-known', inAnki);
        }
        if (totalOccurrencesEl) {
            totalOccurrencesEl.textContent = Number(detail.total_occurrences || 0).toLocaleString();
        }
        if (deckEl) deckEl.textContent = detail.deck_name || 'Not in Anki';
        if (intervalEl) intervalEl.textContent = detail.interval != null ? `${detail.interval}d` : '—';
        if (dueEl) dueEl.textContent = detail.due != null ? String(detail.due) : '—';

        renderWordDetailGames(detail.games || []);
    }

    function renderWordDetailLines(searchData) {
        const linesEl = document.getElementById('wordDetailLines');
        const linesEmptyEl = document.getElementById('wordDetailLinesEmpty');
        const linesMetaEl = document.getElementById('wordDetailLinesMeta');
        if (!linesEl || !linesEmptyEl || !linesMetaEl) return;

        const lines = Array.isArray(searchData?.lines) ? searchData.lines : [];
        linesEl.innerHTML = '';

        const total = Number(searchData?.total || 0);
        if (total > 0) {
            linesMetaEl.textContent = lines.length < total
                ? `Showing ${lines.length.toLocaleString()} of ${total.toLocaleString()} latest matches`
                : `${total.toLocaleString()} latest match${total === 1 ? '' : 'es'}`;
        } else {
            linesMetaEl.textContent = '';
        }

        if (lines.length === 0) {
            linesEmptyEl.textContent = wordDetailLinesDefaultEmptyText;
            linesEmptyEl.style.display = 'block';
            return;
        }

        linesEmptyEl.style.display = 'none';
        const fragment = document.createDocumentFragment();

        lines.forEach(line => {
            const entry = document.createElement('div');
            entry.className = 'word-detail-line';

            const header = document.createElement('div');
            header.className = 'word-detail-line-header';

            const game = document.createElement('div');
            game.className = 'word-detail-line-game';
            game.textContent = line.game_name || 'Unknown game';

            const time = document.createElement('div');
            time.className = 'word-detail-line-time';
            time.textContent = formatWordDetailTimestamp(line.timestamp);

            const text = document.createElement('div');
            text.className = 'word-detail-line-text';
            text.textContent = line.text || '';

            header.appendChild(game);
            header.appendChild(time);
            entry.appendChild(header);
            entry.appendChild(text);
            fragment.appendChild(entry);
        });

        linesEl.appendChild(fragment);
    }

    async function openWordDetailModal(word) {
        if (!word) return;

        abortWordDetailRequests();

        const requestId = wordDetail.requestId + 1;
        wordDetail.requestId = requestId;
        wordDetail.word = word;

        resetWordDetailModal(word);
        openModal('wordDetailModal');

        const detailHandle = createTimedRequest(WORDS_NOT_IN_ANKI_TIMEOUT_MS);
        const searchHandle = createTimedRequest(WORDS_NOT_IN_ANKI_TIMEOUT_MS);
        wordDetail.detailRequest = detailHandle;
        wordDetail.searchRequest = searchHandle;

        const searchParams = new URLSearchParams({
            q: word,
            limit: '20',
        });

        try {
            const [detailResult, searchResult] = await Promise.allSettled([
                fetchJsonWithTimeout(`/api/tokenisation/word/${encodeURIComponent(word)}`, detailHandle),
                fetchJsonWithTimeout(`/api/tokenisation/search?${searchParams.toString()}`, searchHandle),
            ]);

            if (requestId !== wordDetail.requestId) return;

            const detailLoaded = detailResult.status === 'fulfilled';
            if (detailLoaded) {
                renderWordDetailSummary(detailResult.value);
                setWordDetailContentVisible(true);
            }

            const errorMessages = [];
            if (!detailLoaded) {
                const detailMessage = formatWordDetailError(
                    detailResult.reason,
                    detailHandle,
                    'Could not load word details.'
                );
                if (detailMessage) errorMessages.push(detailMessage);
            }

            if (searchResult.status === 'fulfilled') {
                renderWordDetailLines(searchResult.value);
                if (!detailLoaded && searchResult.value?.word?.word) {
                    const titleEl = document.getElementById('wordDetailModalTitle');
                    if (titleEl) {
                        titleEl.textContent = `Word Details: ${searchResult.value.word.word}`;
                    }
                }
            } else {
                const linesEmptyEl = document.getElementById('wordDetailLinesEmpty');
                if (linesEmptyEl) {
                    linesEmptyEl.textContent = 'Could not load latest example lines.';
                    linesEmptyEl.style.display = 'block';
                }
                const searchMessage = formatWordDetailError(
                    searchResult.reason,
                    searchHandle,
                    'Could not load latest example lines.'
                );
                if (searchMessage) errorMessages.push(searchMessage);
            }

            showWordDetailError(errorMessages.join(' '));
        } finally {
            detailHandle.cleanup();
            searchHandle.cleanup();

            if (wordDetail.detailRequest === detailHandle) {
                wordDetail.detailRequest = null;
            }
            if (wordDetail.searchRequest === searchHandle) {
                wordDetail.searchRequest = null;
            }
            if (requestId === wordDetail.requestId) {
                setWordDetailLoading(false);
            }
        }
    }

    function renderWordCell(word) {
        const href = buildWordSearchHref(word);
        return `<a href="${href}" class="word-link">${escapeHtml(word)}</a>`;
    }

    function renderWordsNotInAnkiRows(words) {
        const tbody = document.getElementById('wordsNotInAnkiTableBody');
        if (!tbody) return;

        tbody.innerHTML = '';
        const wordsFragment = document.createDocumentFragment();
        words.forEach(w => {
            const tr = document.createElement('tr');
            tr.innerHTML =
                `<td>${renderWordCell(w.word)}</td>` +
                `<td>${escapeHtml(w.reading)}</td>` +
                `<td>${escapeHtml(w.pos)}</td>` +
                `<td>${Number(w.frequency || 0).toLocaleString()}</td>` +
                `<td>${renderGlobalRankCell(w.global_rank)}</td>`;

            const detailsCell = document.createElement('td');
            detailsCell.className = 'details-cell';

            const detailsButton = document.createElement('button');
            detailsButton.type = 'button';
            detailsButton.className = 'action-btn primary words-detail-btn';
            detailsButton.dataset.word = w.word;
            detailsButton.textContent = 'Details';

            detailsCell.appendChild(detailsButton);
            tr.appendChild(detailsCell);
            wordsFragment.appendChild(tr);
        });
        tbody.appendChild(wordsFragment);
    }

    async function loadWordsNotInAnki() {
        const loading = document.getElementById('wordsNotInAnkiLoading');
        const empty = document.getElementById('wordsNotInAnkiEmpty');
        const tbody = document.getElementById('wordsNotInAnkiTableBody');
        const totalBadge = document.getElementById('wordsNotInAnkiTotal');
        const totalValue = document.getElementById('wordsNotInAnkiTotalValue');
        const requestId = wordsNotInAnki.requestId + 1;
        wordsNotInAnki.requestId = requestId;

        if (wordsNotInAnki.listRequest) {
            abortTimedRequest(wordsNotInAnki.listRequest);
            wordsNotInAnki.listRequest = null;
        }
        const requestHandle = createTimedRequest(WORDS_NOT_IN_ANKI_TIMEOUT_MS);
        wordsNotInAnki.listRequest = requestHandle;

        if (loading) loading.style.display = 'flex';
        if (empty) {
            empty.style.display = 'none';
            empty.textContent = getWordsNotInAnkiEmptyText();
        }

        const params = new URLSearchParams({
            limit: wordsNotInAnki.limit,
            offset: wordsNotInAnki.offset,
            sort: wordsNotInAnki.sort,
            order: wordsNotInAnki.order,
        });
        if (wordsNotInAnki.search) params.set('search', wordsNotInAnki.search);
        if (wordsNotInAnki.pos) params.set('pos', wordsNotInAnki.pos);
        if (wordsNotInAnki.vocabOnly) params.set('vocab_only', 'true');
        const globalRankRange = getWordsNotInAnkiCustomGlobalRankRange();
        if (globalRankRange) {
            params.set('global_rank_min', String(globalRankRange.min));
            params.set('global_rank_max', String(globalRankRange.max));
        }

        try {
            const resp = await fetch(`/api/tokenisation/words/not-in-anki?${params}`, {
                signal: requestHandle.controller.signal,
            });
            if (!resp.ok) throw new Error('API error');
            const data = await resp.json();
            if (requestId !== wordsNotInAnki.requestId) return;

            wordsNotInAnki.total = data.total;
            syncWordsNotInAnkiGlobalRankControls(
                data.global_rank_bounds || null,
                data.global_rank_source || null
            );

            if (totalBadge) totalBadge.style.display = data.total > 0 ? '' : 'none';
            if (totalValue) totalValue.textContent = data.total.toLocaleString();

            if (!data.words || data.words.length === 0) {
                if (tbody) tbody.innerHTML = '';
                if (empty) {
                    empty.style.display = 'block';
                    empty.textContent = getWordsNotInAnkiEmptyText();
                }
            } else {
                renderWordsNotInAnkiRows(data.words);
            }

            updateWordsNotInAnkiPagination();
        } catch (e) {
            if (requestId !== wordsNotInAnki.requestId) return;
            if (requestHandle.controller.signal.aborted && !requestHandle.timedOut()) return;
            console.error('Failed to load words not in Anki:', e);
            wordsNotInAnki.total = 0;
            if (tbody) tbody.innerHTML = '';
            if (totalBadge) totalBadge.style.display = 'none';
            if (totalValue) totalValue.textContent = '0';
            updateWordsNotInAnkiPagination();
            if (empty) {
                empty.style.display = 'block';
                empty.textContent = requestHandle.timedOut()
                    ? 'Loading words timed out. Please try again.'
                    : 'Failed to load words. Is tokenisation enabled?';
            }
        } finally {
            requestHandle.cleanup();
            if (wordsNotInAnki.listRequest === requestHandle) {
                wordsNotInAnki.listRequest = null;
            }
            if (requestId === wordsNotInAnki.requestId && loading) {
                loading.style.display = 'none';
            }
        }
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    function updateWordsNotInAnkiPagination() {
        const prev = document.getElementById('wordsNotInAnkiPrev');
        const next = document.getElementById('wordsNotInAnkiNext');
        const info = document.getElementById('wordsNotInAnkiPageInfo');

        const page = Math.floor(wordsNotInAnki.offset / wordsNotInAnki.limit) + 1;
        const totalPages = Math.max(1, Math.ceil(wordsNotInAnki.total / wordsNotInAnki.limit));

        if (info) info.textContent = `Page ${page} of ${totalPages} (${wordsNotInAnki.total.toLocaleString()} words)`;
        if (prev) prev.disabled = wordsNotInAnki.offset <= 0;
        if (next) next.disabled = wordsNotInAnki.offset + wordsNotInAnki.limit >= wordsNotInAnki.total;
    }

    // Pagination buttons
    const prevBtn = document.getElementById('wordsNotInAnkiPrev');
    const nextBtn = document.getElementById('wordsNotInAnkiNext');
    if (prevBtn) prevBtn.addEventListener('click', () => {
        wordsNotInAnki.offset = Math.max(0, wordsNotInAnki.offset - wordsNotInAnki.limit);
        loadWordsNotInAnki();
    });
    if (nextBtn) nextBtn.addEventListener('click', () => {
        wordsNotInAnki.offset += wordsNotInAnki.limit;
        loadWordsNotInAnki();
    });

    // Search input with debounce
    const searchInput = document.getElementById('wordsNotInAnkiSearch');
    if (searchInput) searchInput.addEventListener('input', () => {
        clearTimeout(wordsNotInAnki.debounceTimer);
        wordsNotInAnki.debounceTimer = setTimeout(() => {
            wordsNotInAnki.search = searchInput.value.trim();
            wordsNotInAnki.offset = 0;
            loadWordsNotInAnki();
        }, 300);
    });

    // POS filter
    const posSelect = document.getElementById('wordsNotInAnkiPosFilter');
    if (posSelect) posSelect.addEventListener('change', () => {
        wordsNotInAnki.pos = posSelect.value;
        wordsNotInAnki.offset = 0;
        loadWordsNotInAnki();
    });

    const includeGrammarToggle = document.getElementById('wordsNotInAnkiIncludeGrammar');
    if (includeGrammarToggle) includeGrammarToggle.addEventListener('change', () => {
        wordsNotInAnki.vocabOnly = !includeGrammarToggle.checked;
        wordsNotInAnki.offset = 0;
        loadWordsNotInAnki();
    });

    const globalRankMinInput = document.getElementById('wordsNotInAnkiGlobalRankMinInput');
    const globalRankMaxInput = document.getElementById('wordsNotInAnkiGlobalRankMaxInput');
    const globalRankMinRange = document.getElementById('wordsNotInAnkiGlobalRankMinRange');
    const globalRankMaxRange = document.getElementById('wordsNotInAnkiGlobalRankMaxRange');
    const globalRankReset = document.getElementById('wordsNotInAnkiGlobalRankReset');
    const closeWordDetailModalEl = document.getElementById('closeWordDetailModal');
    const closeWordDetailModalBtn = document.getElementById('closeWordDetailModalBtn');
    const wordDetailModalEl = document.getElementById('wordDetailModal');
    const wordsNotInAnkiTableBody = document.getElementById('wordsNotInAnkiTableBody');

    if (globalRankMinInput) globalRankMinInput.addEventListener('change', () => {
        const bounds = wordsNotInAnki.globalRankBounds;
        if (bounds.min == null || bounds.max == null) return;
        const parsed = Number.parseInt(globalRankMinInput.value, 10);
        const nextValue = Number.isFinite(parsed)
            ? parsed
            : bounds.min;
        wordsNotInAnki.globalRankMin = Math.max(
            bounds.min,
            Math.min(nextValue, wordsNotInAnki.globalRankMax ?? bounds.max)
        );
        wordsNotInAnki.globalRankMax = Math.max(
            wordsNotInAnki.globalRankMin,
            wordsNotInAnki.globalRankMax ?? bounds.max
        );
        syncWordsNotInAnkiGlobalRankControls(bounds, wordsNotInAnki.globalRankSource);
        wordsNotInAnki.offset = 0;
        loadWordsNotInAnki();
    });

    if (globalRankMaxInput) globalRankMaxInput.addEventListener('change', () => {
        const bounds = wordsNotInAnki.globalRankBounds;
        if (bounds.min == null || bounds.max == null) return;
        const parsed = Number.parseInt(globalRankMaxInput.value, 10);
        const nextValue = Number.isFinite(parsed)
            ? parsed
            : bounds.max;
        wordsNotInAnki.globalRankMax = Math.min(
            bounds.max,
            Math.max(nextValue, wordsNotInAnki.globalRankMin ?? bounds.min)
        );
        wordsNotInAnki.globalRankMin = Math.min(
            wordsNotInAnki.globalRankMax,
            wordsNotInAnki.globalRankMin ?? bounds.min
        );
        syncWordsNotInAnkiGlobalRankControls(bounds, wordsNotInAnki.globalRankSource);
        wordsNotInAnki.offset = 0;
        loadWordsNotInAnki();
    });

    if (globalRankMinRange) globalRankMinRange.addEventListener('input', () => {
        const bounds = wordsNotInAnki.globalRankBounds;
        if (bounds.min == null || bounds.max == null) return;
        const parsed = Number.parseInt(globalRankMinRange.value, 10);
        wordsNotInAnki.globalRankMin = Math.min(
            parsed,
            wordsNotInAnki.globalRankMax ?? bounds.max
        );
        syncWordsNotInAnkiGlobalRankControls(bounds, wordsNotInAnki.globalRankSource);
        scheduleWordsNotInAnkiGlobalRankReload();
    });

    if (globalRankMaxRange) globalRankMaxRange.addEventListener('input', () => {
        const bounds = wordsNotInAnki.globalRankBounds;
        if (bounds.min == null || bounds.max == null) return;
        const parsed = Number.parseInt(globalRankMaxRange.value, 10);
        wordsNotInAnki.globalRankMax = Math.max(
            parsed,
            wordsNotInAnki.globalRankMin ?? bounds.min
        );
        syncWordsNotInAnkiGlobalRankControls(bounds, wordsNotInAnki.globalRankSource);
        scheduleWordsNotInAnkiGlobalRankReload();
    });

    if (globalRankReset) globalRankReset.addEventListener('click', resetWordsNotInAnkiGlobalRankRange);

    if (closeWordDetailModalEl) {
        closeWordDetailModalEl.addEventListener('click', closeWordDetailModal);
    }
    if (closeWordDetailModalBtn) {
        closeWordDetailModalBtn.addEventListener('click', closeWordDetailModal);
    }

    if (wordsNotInAnkiTableBody) {
        wordsNotInAnkiTableBody.addEventListener('click', event => {
            const button = event.target.closest('.words-detail-btn');
            if (!button) return;
            openWordDetailModal(button.dataset.word || '');
        });
    }

    if (wordDetailModalEl) {
        let backdropMouseDown = false;
        wordDetailModalEl.addEventListener('mousedown', event => {
            backdropMouseDown = event.target === wordDetailModalEl;
        });
        wordDetailModalEl.addEventListener('mouseup', event => {
            if (backdropMouseDown && event.target === wordDetailModalEl) {
                abortWordDetailRequests();
            }
            backdropMouseDown = false;
        });
    }

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && wordDetailModalEl?.classList.contains('show')) {
            abortWordDetailRequests();
        }
    });

    // Sortable column headers
    document.querySelectorAll('#wordsNotInAnkiTable .sortable-header').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (wordsNotInAnki.sort === col) {
                wordsNotInAnki.order = wordsNotInAnki.order === 'desc' ? 'asc' : 'desc';
            } else {
                wordsNotInAnki.sort = col;
                wordsNotInAnki.order = col === 'frequency' ? 'desc' : 'asc';
            }
            wordsNotInAnki.offset = 0;

            // Update header indicators
            document.querySelectorAll('#wordsNotInAnkiTable .sortable-header').forEach(h => {
                h.classList.remove('active-sort');
                const base = h.textContent.replace(/ [▲▼⇅]$/, '');
                h.textContent = base + ' ⇅';
            });
            th.classList.add('active-sort');
            const base = th.textContent.replace(/ [▲▼⇅]$/, '');
            th.textContent = base + (wordsNotInAnki.order === 'desc' ? ' ▼' : ' ▲');

            loadWordsNotInAnki();
        });
    });

    // Initial load (doesn't depend on Anki dates)
    loadWordsNotInAnki();
});
