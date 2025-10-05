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
});