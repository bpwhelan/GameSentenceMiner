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
    
    // Helper function to get week number of year (GitHub style - week starts on Sunday)
    function getWeekOfYear(date) {
        const yearStart = new Date(date.getFullYear(), 0, 1);
        const dayOfYear = Math.floor((date - yearStart) / (24 * 60 * 60 * 1000)) + 1;
        const dayOfWeek = yearStart.getDay(); // 0 = Sunday
        
        // Calculate week number (1-indexed)
        const weekNum = Math.ceil((dayOfYear + dayOfWeek) / 7);
        return Math.min(53, weekNum); // Cap at 53 weeks
    }
    
    // Helper function to get the first Sunday of the year (or before)
    function getFirstSunday(year) {
        const jan1 = new Date(year, 0, 1);
        const dayOfWeek = jan1.getDay();
        const firstSunday = new Date(year, 0, 1 - dayOfWeek);
        return firstSunday;
    }
    
    // Function to calculate heatmap streaks for mining activity
    function calculateMiningStreaks(grid, yearData) {
        const dates = [];
        
        // Collect all dates in chronological order
        for (let week = 0; week < 53; week++) {
            for (let day = 0; day < 7; day++) {
                const date = grid[day][week];
                if (date) {
                    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                    const activity = yearData[dateStr] || 0;
                    dates.push({ date: dateStr, activity: activity });
                }
            }
        }
        
        // Sort dates chronologically
        dates.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        let longestStreak = 0;
        let currentStreak = 0;
        let tempStreak = 0;
        
        // Calculate longest streak
        for (let i = 0; i < dates.length; i++) {
            if (dates[i].activity > 0) {
                tempStreak++;
                longestStreak = Math.max(longestStreak, tempStreak);
            } else {
                tempStreak = 0;
            }
        }
        
        // Calculate current streak from today backwards
        const date = new Date();
        const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        
        // Find today's index or the most recent date before today
        let todayIndex = -1;
        for (let i = dates.length - 1; i >= 0; i--) {
            if (dates[i].date <= today) {
                todayIndex = i;
                break;
            }
        }
        
        // Count backwards from today (or most recent date)
        if (todayIndex >= 0) {
            for (let i = todayIndex; i >= 0; i--) {
                if (dates[i].activity > 0) {
                    currentStreak++;
                } else {
                    break;
                }
            }
        }
        
        // Calculate average daily mining (sentences mined per active day)
        let totalMined = 0;
        let activeDays = 0;
        for (let i = 0; i < dates.length; i++) {
            if (dates[i].activity > 0) {
                totalMined += dates[i].activity;
                activeDays++;
            }
        }
        const avgDaily = activeDays > 0 ? Math.round(totalMined / activeDays) : 0;
        
        return { longestStreak, currentStreak, avgDaily };
    }
    
    // Function to create GitHub-style heatmap for mining activity
    function createMiningHeatmap(heatmapData) {
        const container = document.getElementById('miningHeatmapContainer');
        container.innerHTML = ''; // Clear existing content
        
        Object.keys(heatmapData).sort().forEach(year => {
            const yearData = heatmapData[year];
            const yearDiv = document.createElement('div');
            yearDiv.className = 'heatmap-year';
            
            const yearTitle = document.createElement('h3');
            yearTitle.textContent = year;
            yearDiv.appendChild(yearTitle);
            
            // Find maximum activity value for this year to scale colors
            const maxActivity = Math.max(...Object.values(yearData));
            
            // Create main wrapper to center everything
            const mainWrapper = document.createElement('div');
            mainWrapper.className = 'heatmap-wrapper';
            
            // Create container wrapper for labels and grid
            const containerWrapper = document.createElement('div');
            containerWrapper.className = 'heatmap-container-wrapper';
            
            // Create day labels (S, M, T, W, T, F, S)
            const dayLabels = document.createElement('div');
            dayLabels.className = 'heatmap-day-labels';
            const dayNames = ['S', '', 'M', '', 'W', '', 'F']; // Only show some labels for space
            dayNames.forEach(dayName => {
                const dayLabel = document.createElement('div');
                dayLabel.className = 'heatmap-day-label';
                dayLabel.textContent = dayName;
                dayLabels.appendChild(dayLabel);
            });
            
            // Create grid container
            const gridContainer = document.createElement('div');
            
            // Create month labels
            const monthLabels = document.createElement('div');
            monthLabels.className = 'heatmap-month-labels';
            
            // Create the main grid
            const gridDiv = document.createElement('div');
            gridDiv.className = 'heatmap-grid';
            
            // Initialize 7x53 grid with empty cells
            const grid = Array(7).fill(null).map(() => Array(53).fill(null));
            
            // Get the first Sunday of the year (start of week 1)
            const firstSunday = getFirstSunday(parseInt(year));
            
            // Populate grid with dates for the entire year
            for (let week = 0; week < 53; week++) {
                for (let day = 0; day < 7; day++) {
                    const currentDate = new Date(firstSunday);
                    currentDate.setDate(firstSunday.getDate() + (week * 7) + day);
                    
                    // Only include dates that belong to the current year
                    if (currentDate.getFullYear() === parseInt(year)) {
                        grid[day][week] = currentDate;
                    }
                }
            }
            
            // Create month labels based on grid positions
            const monthTracker = new Set();
            for (let week = 0; week < 53; week++) {
                const dateInWeek = grid[0][week] || grid[1][week] || grid[2][week] ||
                                 grid[3][week] || grid[4][week] || grid[5][week] || grid[6][week];
                
                if (dateInWeek) {
                    const month = dateInWeek.getMonth();
                    const monthName = dateInWeek.toLocaleDateString('en', { month: 'short' });
                    
                    // Add month label if it's the first week of the month
                    if (!monthTracker.has(month) && dateInWeek.getDate() <= 7) {
                        const monthLabel = document.createElement('div');
                        monthLabel.className = 'heatmap-month-label';
                        monthLabel.style.gridColumn = `${week + 1}`;
                        monthLabel.textContent = monthName;
                        monthLabels.appendChild(monthLabel);
                        monthTracker.add(month);
                    }
                }
            }
            
            // Create cells for the grid
            for (let day = 0; day < 7; day++) {
                for (let week = 0; week < 53; week++) {
                    const cell = document.createElement('div');
                    cell.className = 'heatmap-cell';
                    
                    const date = grid[day][week];
                    if (date) {
                        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                        const activity = yearData[dateStr] || 0;
                        
                        if (activity > 0 && maxActivity > 0) {
                            // Calculate percentage of maximum activity
                            const percentage = (activity / maxActivity) * 100;
                            
                            // Assign discrete color levels based on percentage thresholds
                            let colorLevel;
                            if (percentage <= 25) {
                                colorLevel = 1; // Light green
                            } else if (percentage <= 50) {
                                colorLevel = 2; // Medium green
                            } else if (percentage <= 75) {
                                colorLevel = 3; // Dark green
                            } else {
                                colorLevel = 4; // Darkest green
                            }
                            
                            // Define discrete colors for each level
                            const colors = {
                                1: '#c6e48b', // Light green (1-25%)
                                2: '#7bc96f', // Medium green (26-50%)
                                3: '#239a3b', // Dark green (51-75%)
                                4: '#196127'  // Darkest green (76-100%)
                            };
                            
                            cell.style.backgroundColor = colors[colorLevel];
                        }
                        
                        cell.title = `${dateStr}: ${activity} sentence${activity !== 1 ? 's' : ''} mined`;
                    } else {
                        // Empty cell for dates outside the year
                        cell.style.backgroundColor = 'transparent';
                        cell.style.cursor = 'default';
                    }
                    
                    gridDiv.appendChild(cell);
                }
            }
            
            gridContainer.appendChild(monthLabels);
            gridContainer.appendChild(gridDiv);
            containerWrapper.appendChild(dayLabels);
            containerWrapper.appendChild(gridContainer);
            mainWrapper.appendChild(containerWrapper);
            
            // Calculate and display streaks
            const streaks = calculateMiningStreaks(grid, yearData);
            const streaksDiv = document.createElement('div');
            streaksDiv.className = 'heatmap-streaks';
            streaksDiv.innerHTML = `
                <div class="heatmap-streak-item">
                    <div class="heatmap-streak-number">${streaks.longestStreak}</div>
                    <div class="heatmap-streak-label">Longest Streak</div>
                </div>
                <div class="heatmap-streak-item">
                    <div class="heatmap-streak-number">${streaks.currentStreak}</div>
                    <div class="heatmap-streak-label">Current Streak</div>
                </div>
                <div class="heatmap-streak-item">
                    <div class="heatmap-streak-number">${streaks.avgDaily}</div>
                    <div class="heatmap-streak-label">Avg Daily Mining</div>
                </div>
            `;
            mainWrapper.appendChild(streaksDiv);
            yearDiv.appendChild(mainWrapper);
            
            // Add legend with discrete colors
            const legend = document.createElement('div');
            legend.className = 'heatmap-legend';
            legend.innerHTML = `
                <span>Less</span>
                <div class="heatmap-legend-item" style="background-color: #ebedf0;" title="No activity"></div>
                <div class="heatmap-legend-item" style="background-color: #c6e48b;" title="1-25% of max activity"></div>
                <div class="heatmap-legend-item" style="background-color: #7bc96f;" title="26-50% of max activity"></div>
                <div class="heatmap-legend-item" style="background-color: #239a3b;" title="51-75% of max activity"></div>
                <div class="heatmap-legend-item" style="background-color: #196127;" title="76-100% of max activity"></div>
                <span>More</span>
            `;
            yearDiv.appendChild(legend);
            
            container.appendChild(yearDiv);
        });
    }
    
    // Function to load mining heatmap data
    async function loadMiningHeatmap(start_timestamp = null, end_timestamp = null) {
        try {
            const params = new URLSearchParams();
            if (start_timestamp) params.append('start', start_timestamp);
            if (end_timestamp) params.append('end', end_timestamp);
            const url = '/api/mining_heatmap' + (params.toString() ? `?${params.toString()}` : '');
            
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('Failed to load mining heatmap');
            const data = await resp.json();
            
            if (Object.keys(data).length > 0) {
                createMiningHeatmap(data);
            } else {
                const container = document.getElementById('miningHeatmapContainer');
                container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 20px;">No mining data available for the selected date range.</p>';
            }
        } catch (e) {
            console.error('Failed to load mining heatmap:', e);
            const container = document.getElementById('miningHeatmapContainer');
            container.innerHTML = '<p style="text-align: center; color: var(--danger-color); padding: 20px;">Failed to load mining heatmap.</p>';
        }
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
        loadMiningHeatmap(startTimestamp / 1000, endTimestamp / 1000); // Convert from ms to seconds
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

        loadStats(startTimestamp, endTimestamp);
        loadMiningHeatmap(startTimestamp / 1000, endTimestamp / 1000); // Convert from ms to seconds
    }

    fromDateInput.addEventListener("change", handleDateChange);
    toDateInput.addEventListener("change", handleDateChange);

    initializeDates();
});