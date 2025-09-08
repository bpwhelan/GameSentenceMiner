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

    function getKanjiColor(frequency) {
        // Use the same color scheme as the main stats page
        if (frequency > 500) return '#2ee6e0';  // Cyan for very frequent
        else if (frequency > 100) return '#3be62f';  // Green for frequent
        else if (frequency > 30) return '#e6dc2e';   // Yellow for moderate
        else if (frequency > 10) return '#e6342e';   // Red for occasional
        else return '#ebedf0';  // Gray for rare
    }

    function renderKanjiGrid(kanjiList) {
        console.log('renderKanjiGrid called with', kanjiList.length, 'kanji');
        console.log('missingKanjiGrid element:', missingKanjiGrid);
        
        if (!missingKanjiGrid) {
            console.error('Missing kanji grid element not found!');
            return;
        }
        
        // Clear the grid
        missingKanjiGrid.innerHTML = '';
        console.log('Grid cleared');
        
        // Update counter
        if (missingKanjiCount) {
            missingKanjiCount.textContent = kanjiList.length;
            console.log('Counter updated to:', kanjiList.length);
        }
        
        if (!kanjiList.length) {
            missingKanjiGrid.innerHTML = '<div style="color:var(--text-secondary);padding:16px;text-align:center;">🎉 No missing kanji! You have all frequently used kanji in your Anki collection.</div>';
            return;
        }
        
        // Create individual kanji elements in grid format
        kanjiList.forEach((item, index) => {
            console.log(`Creating kanji element ${index}: ${item.kanji}`);
            const kanjiElement = document.createElement('span');
            kanjiElement.className = 'kanji-cell';
            kanjiElement.textContent = item.kanji;
            kanjiElement.style.backgroundColor = getKanjiColor(item.frequency);
            kanjiElement.title = `${item.kanji} - Seen ${item.frequency} times in GSM`;
            
            // Add click handler for potential future features
            kanjiElement.addEventListener('click', function() {
                console.log(`Clicked kanji: ${item.kanji} (frequency: ${item.frequency})`);
            });
            
            missingKanjiGrid.appendChild(kanjiElement);
        });
        
        console.log('Kanji grid rendered. Grid now has', missingKanjiGrid.children.length, 'children');
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
        if (ankiCoverage) ankiCoverage.textContent = data.coverage_percent + '%';
        renderKanjiGrid(data.missing_kanji);
    }

    async function loadStats() {
        console.log('Loading Anki stats...');
        showLoading(true);
        showError(false);
        try {
            const resp = await fetch('/api/anki-stats');
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