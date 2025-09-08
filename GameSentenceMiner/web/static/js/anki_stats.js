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

    async function loadStats() {
        console.log('Loading Anki stats...');
        showLoading(true);
        showError(false);
        try {
            const resp = await fetch('/api/anki_stats');
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

    loadStats();
});