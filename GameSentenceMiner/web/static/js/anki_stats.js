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
        
        if (ankiTotalKanji) ankiTotalKanji.textContent = data.anki_kanji_count;
        if (gsmTotalKanji) gsmTotalKanji.textContent = data.gsm_kanji_count;
        if (ankiCoverage) {
            const gsmCount = Number(data.gsm_kanji_count);
            const missingCount = Array.isArray(data.missing_kanji) ? data.missing_kanji.length : 0;
            let percent = 0;
            if (gsmCount > 0) {
                percent = ((gsmCount - missingCount) / gsmCount) * 100;
            }
            ankiCoverage.textContent = percent.toFixed(1) + '%';
        }
        renderKanjiGrid(data.missing_kanji);
    }

    async function loadStats(start_timestamp = null, end_timestamp = null) {
        console.log('Loading Anki stats...');
        showLoading(true);
        showError(false);
        try {
            // Build URL with optional query params
            const params = new URLSearchParams();
            if (start_timestamp) params.append('start_timestamp', start_timestamp);
            if (end_timestamp) params.append('end_timestamp', end_timestamp);
            const url = '/api/anki_stats' + (params.toString() ? `?${params.toString()}` : '');

            const resp = await fetch(url);
            if (!resp.ok) throw new Error('Failed to load');
            const data = await resp.json();
            console.log('Received data:', data);
            updateStats(data);
        } catch (e) {
            console.error('Failed to load Anki stats:', e);
            showError(true);
        } finally {
            showLoading(false);
        }
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

    document.addEventListener("datesSetAnki", () => {
        const fromDate = sessionStorage.getItem("fromDateAnki");
        const toDate = sessionStorage.getItem("toDateAnki");
        const { startTimestamp, endTimestamp } = getUnixTimestampsInMilliseconds(fromDate, toDate);
        
        loadStats(startTimestamp, endTimestamp);
    });

    function initializeDates() {
        const fromDateInput = document.getElementById('fromDate');
        const toDateInput = document.getElementById('toDate');

        const fromDate = sessionStorage.getItem("fromDateAnki");
        const toDate = sessionStorage.getItem("toDateAnki"); 

        if (!(fromDate && toDate)) {
            fetch('/api/anki_earliest_date')
                .then(response => response.json())
                .then(response_json => {
                    // Get first date in ms from API
                    const firstDateinMs = response_json.earliest_card;
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
                });
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

        loadStats(startTimestamp, endTimestamp)
    }

    fromDateInput.addEventListener("change", handleDateChange);
    toDateInput.addEventListener("change", handleDateChange);

    initializeDates();
    
    // Game Stats functionality
    async function loadGameStats(start_timestamp = null, end_timestamp = null) {
        console.log('[GAME STATS] Loading game stats with timestamps:', start_timestamp, end_timestamp);
        const gameStatsTable = document.getElementById('gameStatsTableBody');
        const gameStatsEmpty = document.getElementById('gameStatsEmpty');
        
        try {
            // Build URL with optional query params
            const params = new URLSearchParams();
            if (start_timestamp) params.append('start_timestamp', start_timestamp);
            if (end_timestamp) params.append('end_timestamp', end_timestamp);
            const url = '/api/anki_game_stats' + (params.toString() ? `?${params.toString()}` : '');

            console.log('[GAME STATS] Fetching from:', url);
            const resp = await fetch(url);
            console.log('[GAME STATS] Response status:', resp.status, resp.statusText);
            if (!resp.ok) {
                const errorText = await resp.text();
                console.error('[GAME STATS] Response error:', errorText);
                throw new Error('Failed to load game stats: ' + resp.statusText);
            }
            const data = await resp.json();
            console.log('[GAME STATS] Received game stats data:', data);
            renderGameStatsTable(data);
        } catch (e) {
            console.error('[GAME STATS] Error loading game stats:', e);
            gameStatsTable.innerHTML = '';
            gameStatsEmpty.style.display = 'block';
            gameStatsEmpty.textContent = 'Failed to load game statistics. Make sure Anki is running with AnkiConnect.';
        }
    }
    
    function renderGameStatsTable(gameStats) {
        const gameStatsTable = document.getElementById('gameStatsTableBody');
        const gameStatsEmpty = document.getElementById('gameStatsEmpty');
        
        if (!gameStats || gameStats.length === 0) {
            gameStatsTable.innerHTML = '';
            gameStatsEmpty.style.display = 'block';
            return;
        }
        
        gameStatsEmpty.style.display = 'none';
        
        // Clear existing rows
        gameStatsTable.innerHTML = '';
        
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
            // Add color coding for retention
            if (game.retention_pct >= 90) {
                retentionCell.style.color = 'var(--success-color, #2ecc71)';
            } else if (game.retention_pct >= 80) {
                retentionCell.style.color = 'var(--warning-color, #f39c12)';
            } else {
                retentionCell.style.color = 'var(--danger-color, #e74c3c)';
            }
            row.appendChild(retentionCell);
            
            gameStatsTable.appendChild(row);
        });
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
    
    // Load game stats when dates are set
    console.log('[GAME STATS] Setting up datesSetAnki event listener');
    document.addEventListener("datesSetAnki", () => {
        console.log('[GAME STATS] datesSetAnki event fired!');
        const fromDate = sessionStorage.getItem("fromDateAnki");
        const toDate = sessionStorage.getItem("toDateAnki");
        console.log('[GAME STATS] Date range:', fromDate, 'to', toDate);
        const { startTimestamp, endTimestamp } = getUnixTimestampsInMilliseconds(fromDate, toDate);
        console.log('[GAME STATS] Calling loadGameStats with timestamps:', startTimestamp, endTimestamp);
        
        loadGameStats(startTimestamp, endTimestamp);
    });
    
    // Load game stats immediately if dates already exist in sessionStorage
    const fromDate = sessionStorage.getItem("fromDateAnki");
    const toDate = sessionStorage.getItem("toDateAnki");
    if (fromDate && toDate) {
        console.log('[GAME STATS] Dates found in sessionStorage, loading game stats immediately');
        const { startTimestamp, endTimestamp } = getUnixTimestampsInMilliseconds(fromDate, toDate);
        loadGameStats(startTimestamp, endTimestamp);
    } else {
        console.log('[GAME STATS] No dates in sessionStorage yet, will wait for datesSetAnki event');
    }
    
    console.log('[GAME STATS] JavaScript initialization complete');
});