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
    
    // Function to show/hide AnkiConnect warning
    function showAnkiConnectWarning(show) {
        if (ankiConnectWarning) {
            ankiConnectWarning.style.display = show ? 'block' : 'none';
        }
    }
    
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
        const gameStatsLoading = document.getElementById('gameStatsLoading');
        const nsfwSfwRetentionLoading = document.getElementById('nsfwSfwRetentionLoading');
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
            loadMiningHeatmap(queryString)
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
            if (gameStatsLoading) gameStatsLoading.style.display = 'none';
            if (nsfwSfwRetentionLoading) nsfwSfwRetentionLoading.style.display = 'none';
            
            // Show tables/grids
            const gameStatsTable = document.getElementById('gameStatsTable');
            const nsfwSfwRetentionStats = document.getElementById('nsfwSfwRetentionStats');
            if (gameStatsTable) gameStatsTable.style.display = 'table';
            if (nsfwSfwRetentionStats) nsfwSfwRetentionStats.style.display = 'grid';
        }
    }
    
    // Individual loading functions for each section
    async function loadKanjiStats(queryString) {
        try {
            const resp = await fetch(`/api/anki_kanji_stats${queryString}`);
            if (!resp.ok) throw new Error('Failed to load kanji stats');
            const data = await resp.json();
            console.log('Received kanji data:', data);
            updateStats(data);
        } catch (e) {
            console.error('Failed to load kanji stats:', e);
            // Show error in kanji section
            const missingKanjiCount = document.getElementById('missingKanjiCount');
            if (missingKanjiCount) missingKanjiCount.textContent = 'Error';
        }
    }
    
    async function loadGameStats(queryString) {
        try {
            const resp = await fetch(`/api/anki_game_stats${queryString}`);
            if (!resp.ok) throw new Error('Failed to load game stats');
            const data = await resp.json();
            console.log('Received game stats data:', data);
            renderGameStatsTable(data);
        } catch (e) {
            console.error('Failed to load game stats:', e);
            const gameStatsEmpty = document.getElementById('gameStatsEmpty');
            if (gameStatsEmpty) {
                gameStatsEmpty.style.display = 'block';
                gameStatsEmpty.textContent = 'Failed to load game statistics. Make sure Anki is running with AnkiConnect.';
            }
        }
    }
    
    async function loadNsfwSfwRetention(queryString) {
        try {
            const resp = await fetch(`/api/anki_nsfw_sfw_retention${queryString}`);
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
        try {
            const resp = await fetch(`/api/anki_mining_heatmap${queryString}`);
            if (!resp.ok) throw new Error('Failed to load mining heatmap');
            const data = await resp.json();
            console.log('Received mining heatmap data:', data);
            
            if (data && Object.keys(data).length > 0) {
                createMiningHeatmap(data);
            } else {
                const container = document.getElementById('miningHeatmapContainer');
                container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 20px;">No mining data available for the selected date range.</p>';
            }
        } catch (e) {
            console.error('Failed to load mining heatmap:', e);
            const container = document.getElementById('miningHeatmapContainer');
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
                const resp = await fetch('/api/anki_earliest_date');
                const data = await resp.json();
                
                // Get first date in ms from API
                const firstDateinMs = data.earliest_date;
                const firstDateObject = new Date(firstDateinMs);
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
            popup.classList.remove("hidden");
            return;
        }

        const { startTimestamp, endTimestamp } = getUnixTimestampsInMilliseconds(fromDateStr, toDateStr);

        // Use unified endpoint instead of multiple calls
        loadAllStats(startTimestamp, endTimestamp);
    }

    fromDateInput.addEventListener("change", handleDateChange);
    toDateInput.addEventListener("change", handleDateChange);

    initializeDates();
    
    function renderGameStatsTable(gameStats) {
        const gameStatsTableBody = document.getElementById('gameStatsTableBody');
        const gameStatsEmpty = document.getElementById('gameStatsEmpty');
        
        if (!gameStats || gameStats.length === 0) {
            gameStatsTableBody.innerHTML = '';
            gameStatsEmpty.style.display = 'block';
            return;
        }
        
        gameStatsEmpty.style.display = 'none';
        
        // Clear existing rows
        gameStatsTableBody.innerHTML = '';
        
        // Populate table with game stats
        gameStats.forEach(game => {
            const row = document.createElement('tr');
            
            // Game name cell
            const nameCell = document.createElement('td');
            nameCell.textContent = game.game_name;
            row.appendChild(nameCell);
            
            // Average time per card cell
            const timeCell = document.createElement('td');
            timeCell.textContent = formatTime(game.avg_time_per_card);
            row.appendChild(timeCell);
            
            // Retention percentage cell
            const retentionCell = document.createElement('td');
            retentionCell.textContent = game.retention_pct + '%';
            retentionCell.style.color = getRetentionColor(game.retention_pct);
            row.appendChild(retentionCell);
            
            gameStatsTableBody.appendChild(row);
        });
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
});