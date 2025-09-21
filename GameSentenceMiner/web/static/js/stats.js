// Helper function to detect the current theme based on the app's theme system
function getCurrentTheme() {
    const dataTheme = document.documentElement.getAttribute('data-theme');
    if (dataTheme === 'dark' || dataTheme === 'light') {
        return dataTheme;
    }
    
    // Fallback to system preference if no manual theme is set
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
    }
    return 'light';
}

// Helper function to get theme-appropriate text color
function getThemeTextColor() {
    return getCurrentTheme() === 'dark' ? '#fff' : '#222';
}

// Ensure Chart.js uses white font in dark mode and black in light mode for all chart text
if (window.Chart) {
    function setChartFontColor() {
        Chart.defaults.color = getThemeTextColor();
    }
    setChartFontColor();
    
    // Listen for theme changes from both manual toggle and system preference
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setChartFontColor);
    }
    
    // Listen for manual theme changes via MutationObserver on data-theme attribute
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
                setChartFontColor();
            }
        });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// Statistics Page JavaScript
// Dependencies: shared.js (provides utility functions like showElement, hideElement, escapeHtml)

document.addEventListener('DOMContentLoaded', function () {
    // Helper function to create a chart to avoid repeating code
    function createChart(canvasId, datasets, chartTitle) {
        const ctx = document.getElementById(canvasId).getContext('2d');
        new Chart(ctx, {
            type: 'line',
            data: {
                labels: datasets.labels,
                datasets: datasets.datasets
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            color: getThemeTextColor()
                        }
                    },
                    title: {
                        display: true,
                        text: chartTitle,
                        color: getThemeTextColor()
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Cumulative Count',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor()
                        }
                    },
                    x: {
                         title: {
                            display: true,
                            text: 'Date',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor()
                        }
                    }
                }
            }
        });
    }

    // Helper function to get week number of year (GitHub style - week starts on Sunday)
    function getWeekOfYear(date) {
        const yearStart = new Date(date.getFullYear(), 0, 1);
        const dayOfYear = Math.floor((date - yearStart) / (24 * 60 * 60 * 1000)) + 1;
        const dayOfWeek = yearStart.getDay(); // 0 = Sunday
        
        // Calculate week number (1-indexed)
        const weekNum = Math.ceil((dayOfYear + dayOfWeek) / 7);
        return Math.min(53, weekNum); // Cap at 53 weeks
    }
    
    // Helper function to get day of week (0 = Sunday, 6 = Saturday)
    function getDayOfWeek(date) {
        return date.getDay();
    }
    
    // Helper function to get the first Sunday of the year (or before)
    function getFirstSunday(year) {
        const jan1 = new Date(year, 0, 1);
        const dayOfWeek = jan1.getDay();
        const firstSunday = new Date(year, 0, 1 - dayOfWeek);
        return firstSunday;
    }
    
    // Function to calculate heatmap streaks and average daily time
    // This function is used by both the heatmap display and dashboard overview
    function calculateHeatmapStreaks(grid, yearData, allLinesForYear = []) {
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

        // Calculate current streak from today backwards, using streak requirement hours from config
        const date = new Date();
        const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const streakRequirement = window.statsConfig ? window.statsConfig.streakRequirementHours : 1.0;

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
                if (dates[i].activity >= streakRequirement) {
                    currentStreak++;
                } else {
                    break;
                }
            }
        }
        
        // Calculate average daily time for this year
        let avgDailyTime = "-";
        if (allLinesForYear && allLinesForYear.length > 0) {
            // Group timestamps by day for this year
            const dailyTimestamps = {};
            for (const line of allLinesForYear) {
                const ts = parseFloat(line.timestamp);
                if (isNaN(ts)) continue;
                const dateObj = new Date(ts * 1000);
                const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
                if (!dailyTimestamps[dateStr]) {
                    dailyTimestamps[dateStr] = [];
                }
                dailyTimestamps[dateStr].push(parseFloat(line.timestamp));
            }
            
            // Calculate reading time for each day with activity
            let totalHours = 0;
            let activeDays = 0;
            let afkTimerSeconds = window.statsConfig ? window.statsConfig.afkTimerSeconds : 120;
            // Try to get AFK timer from settings modal if available and valid
            const afkTimerInput = document.getElementById('afkTimer');
            if (afkTimerInput && afkTimerInput.value) {
                const parsed = parseInt(afkTimerInput.value, 10);
                if (!isNaN(parsed) && parsed > 0) afkTimerSeconds = parsed;
            }

            for (const [dateStr, timestamps] of Object.entries(dailyTimestamps)) {
                if (timestamps.length >= 2) {
                    timestamps.sort((a, b) => a - b);
                    let dayReadingTime = 0;

                    for (let i = 1; i < timestamps.length; i++) {
                        const gap = timestamps[i] - timestamps[i-1];
                        dayReadingTime += Math.min(gap, afkTimerSeconds);
                    }

                    if (dayReadingTime > 0) {
                        totalHours += dayReadingTime / 3600;
                        activeDays++;
                    }
                } else if (timestamps.length === 1) {
                    // Single timestamp - count as minimal activity (1 second)
                    totalHours += 1 / 3600;
                    activeDays++;
                }
            }
            
            if (activeDays > 0) {
                const avgHours = totalHours / activeDays;
                if (avgHours < 1) {
                    const minutes = Math.round(avgHours * 60);
                    avgDailyTime = `${minutes}m`;
                } else {
                    const hours = Math.floor(avgHours);
                    const minutes = Math.round((avgHours - hours) * 60);
                    avgDailyTime = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
                }
            }
        }
        
        return { longestStreak, currentStreak, avgDailyTime };
    }

    // Global function to calculate current streak for any dataset
    // This ensures consistent streak calculation across heatmap and dashboard
    function calculateCurrentStreak(allLinesData, gameFilter = null) {
        if (!allLinesData || allLinesData.length === 0) {
            return 0;
        }

        // Get streak requirement from config
        const streakRequirement = window.statsConfig ? window.statsConfig.streakRequirementHours : 1.0;
        
        // Filter by game if specified (for current game dashboard)
        let filteredLines = allLinesData;
        if (gameFilter) {
            filteredLines = allLinesData.filter(line => line.game_name === gameFilter);
        }
        
        // Calculate daily reading time using the same logic as the heatmap
        const dailyReadingTime = {};
        
        // Get AFK timer from settings
        const afkTimerSeconds = window.statsConfig ? window.statsConfig.afkTimerSeconds : 120;
        
        for (const line of filteredLines) {
            if (!line.timestamp) continue;
            
            const date = new Date(line.timestamp * 1000);
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            
            if (!dailyReadingTime[dateStr]) {
                dailyReadingTime[dateStr] = [];
            }
            dailyReadingTime[dateStr].push(line.timestamp);
        }
        
        // Calculate actual reading hours per day
        const dailyHours = {};
        for (const [dateStr, timestamps] of Object.entries(dailyReadingTime)) {
            timestamps.sort((a, b) => a - b);
            let totalSeconds = 0;
            
            if (timestamps.length >= 2) {
                for (let i = 1; i < timestamps.length; i++) {
                    const gap = timestamps[i] - timestamps[i-1];
                    totalSeconds += Math.min(gap, afkTimerSeconds);
                }
            } else if (timestamps.length === 1) {
                // Single timestamp - count as minimal activity (1 second)
                totalSeconds = 1;
            }
            
            dailyHours[dateStr] = totalSeconds / 3600;
        }
        
        // Calculate current streak from today backwards
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        
        let currentStreak = 0;
        let checkDate = new Date(today);
        
        // Check back indefinitely until streak breaks
        while (true) {
            const checkDateStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
            const readingHours = dailyHours[checkDateStr] || 0;
            
            if (readingHours >= streakRequirement) {
                currentStreak++;
            } else {
                break;
            }
            
            // Move to previous day
            checkDate.setDate(checkDate.getDate() - 1);
        }
        
        return currentStreak;
    }

    // Function to create GitHub-style heatmap
    function createHeatmap(heatmapData) {
        const container = document.getElementById('heatmapContainer');
        
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
                        
                        cell.title = `${dateStr}: ${activity} characters`;
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
            
            // Calculate and display streaks with average daily time
            const yearLines = window.allLinesData ? window.allLinesData.filter(line => {
                if (!line.timestamp) return false;
                const lineYear = new Date(parseFloat(line.timestamp) * 1000).getFullYear();
                return lineYear === parseInt(year);
            }) : [];
            
            const streaks = calculateHeatmapStreaks(grid, yearData, yearLines);
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
                    <div class="heatmap-streak-number">${streaks.avgDailyTime}</div>
                    <div class="heatmap-streak-label">Avg Daily Time</div>
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

    // Function to generate distinct colors for games
    function generateGameColors(gameCount) {
        const colors = [];
        
        // Predefined set of good colors for the first few games
        const predefinedColors = [
            '#3498db', '#e74c3c', '#2ecc71', '#f1c40f', '#9b59b6',
            '#1abc9c', '#e67e22', '#34495e', '#16a085', '#27ae60',
            '#2980b9', '#8e44ad', '#d35400', '#c0392b', '#7f8c8d'
        ];
        
        // Use predefined colors first
        for (let i = 0; i < Math.min(gameCount, predefinedColors.length); i++) {
            colors.push(predefinedColors[i]);
        }
        
        // Generate additional colors using HSL if needed
        if (gameCount > predefinedColors.length) {
            const remaining = gameCount - predefinedColors.length;
            for (let i = 0; i < remaining; i++) {
                // Distribute hue evenly across the color wheel
                const hue = (i * 360 / remaining) % 360;
                // Use varied saturation and lightness for visual distinction
                const saturation = 65 + (i % 3) * 10; // 65%, 75%, 85%
                const lightness = 45 + (i % 2) * 10;  // 45%, 55%
                
                colors.push(`hsl(${hue.toFixed(0)}, ${saturation}%, ${lightness}%)`);
            }
        }
        
        return colors;
    }

    // Helper function to filter chart data for visible bars
    function getFilteredChartData(originalData, hiddenBars, colors) {
        // Filter data to only include visible bars
        const visibleLabels = [];
        const visibleTotals = [];
        const visibleColors = [];

        originalData.labels.forEach((label, index) => {
            if (!hiddenBars[index]) {
                visibleLabels.push(label);
                visibleTotals.push(originalData.totals[index]);
                visibleColors.push(colors[index]);
            }
        });

        return {
            labels: visibleLabels,
            totals: visibleTotals,
            colors: visibleColors
        };
    }

    // Reusable function to create game bar charts with interactive legend
    function createGameBarChart(canvasId, chartData, chartTitle, yAxisLabel) {
        const ctx = document.getElementById(canvasId).getContext('2d');
        const colors = generateGameColors(chartData.labels.length);
        
        // Track which bars are hidden for toggle functionality
        const hiddenBars = new Array(chartData.labels.length).fill(false);
        
        // Store original data for filtering
        const originalData = {
            labels: [...chartData.labels],
            totals: [...chartData.totals]
        };
        
        function updateChartData() {
            return getFilteredChartData(originalData, hiddenBars, colors);
        }
        
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: chartData.labels, // Each game as a separate label
                datasets: [{
                    label: chartTitle,
                    data: chartData.totals,
                    backgroundColor: colors.map(color => color + '99'), // Semi-transparent
                    borderColor: colors,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                interaction: {
                    intersect: false,
                    mode: 'nearest'
                },
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            color: getThemeTextColor(),
                            generateLabels: function(chart) {
                                // Create custom legend items for each game using original data
                                return originalData.labels.map((gameName, index) => ({
                                    text: gameName,
                                    fillStyle: colors[index],
                                    strokeStyle: colors[index],
                                    lineWidth: 2,
                                    hidden: hiddenBars[index],
                                    index: index,
                                    fontColor: getThemeTextColor()
                                }));
                            }
                        },
                        onClick: function(e, legendItem) {
                            const index = legendItem.index;
                            const chart = this.chart;
                            
                            // Toggle visibility for this specific bar
                            hiddenBars[index] = !hiddenBars[index];
                            
                            // Update chart with filtered data
                            const filteredData = updateChartData();
                            chart.data.labels = filteredData.labels;
                            chart.data.datasets[0].data = filteredData.totals;
                            chart.data.datasets[0].backgroundColor = filteredData.colors.map(color => color + '99');
                            chart.data.datasets[0].borderColor = filteredData.colors;
                            
                            chart.update('resize');
                        }
                    },
                    title: {
                        display: true,
                        text: chartTitle,
                        color: getThemeTextColor()
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                // Show the game name as the main title
                                return context[0].label;
                            },
                            label: function(context) {
                                // Show only this game's data
                                const value = context.parsed.y;
                                return `Characters: ${value.toLocaleString()}`;
                            }
                        },
                        displayColors: true,
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: 'white',
                        bodyColor: 'white',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: yAxisLabel,
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor()
                        }
                    },
                    x: {
                        title: {
                            display: false // Remove unhelpful "Game Titles" label
                        },
                        ticks: {
                            color: getThemeTextColor()
                        }
                    }
                }
            }
        });
    }

    // Specialized function for charts with custom formatting (time/speed)
    function createGameBarChartWithCustomFormat(canvasId, chartData, chartTitle, yAxisLabel, formatFunction) {
        const ctx = document.getElementById(canvasId).getContext('2d');
        const colors = generateGameColors(chartData.labels.length);
        
        // Track which bars are hidden for toggle functionality
        const hiddenBars = new Array(chartData.labels.length).fill(false);
        
        // Store original data for filtering
        const originalData = {
            labels: [...chartData.labels],
            totals: [...chartData.totals]
        };
        
        function updateChartData() {
            return getFilteredChartData(originalData, hiddenBars, colors);
        }
        
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: chartData.labels, // Each game as a separate label
                datasets: [{
                    label: chartTitle,
                    data: chartData.totals,
                    backgroundColor: colors.map(color => color + '99'), // Semi-transparent
                    borderColor: colors,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                interaction: {
                    intersect: false,
                    mode: 'nearest'
                },
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            color: getThemeTextColor(),
                            generateLabels: function(chart) {
                                // Create custom legend items for each game using original data
                                return originalData.labels.map((gameName, index) => ({
                                    text: gameName,
                                    fillStyle: colors[index],
                                    strokeStyle: colors[index],
                                    lineWidth: 2,
                                    hidden: hiddenBars[index],
                                    index: index,
                                    fontColor: getThemeTextColor()
                                }));
                            }
                        },
                        onClick: function(e, legendItem) {
                            const index = legendItem.index;
                            const chart = this.chart;
                            
                            // Toggle visibility for this specific bar
                            hiddenBars[index] = !hiddenBars[index];
                            
                            // Update chart with filtered data
                            const filteredData = updateChartData();
                            chart.data.labels = filteredData.labels;
                            chart.data.datasets[0].data = filteredData.totals;
                            chart.data.datasets[0].backgroundColor = filteredData.colors.map(color => color + '99');
                            chart.data.datasets[0].borderColor = filteredData.colors;
                            
                            chart.update('resize');
                        }
                    },
                    title: {
                        display: true,
                        text: chartTitle,
                        color: getThemeTextColor()
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                // Show the game name as the main title
                                return context[0].label;
                            },
                            label: function(context) {
                                // Use custom format function
                                const value = context.parsed.y;
                                return formatFunction(value);
                            }
                        },
                        displayColors: true,
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: 'white',
                        bodyColor: 'white',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: yAxisLabel,
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor()
                        }
                    },
                    x: {
                        title: {
                            display: false // Remove unhelpful axis labels
                        },
                        ticks: {
                            color: getThemeTextColor()
                        }
                    }
                }
            }
        });
    }

    // Helper functions for formatting
    function formatTime(hours) {
        if (hours < 1) {
            const minutes = (hours * 60).toFixed(0);
            return `Time: ${minutes} minutes`;
        } else {
            return `Time: ${hours.toFixed(2)} hours`;
        }
    }

    function formatSpeed(charsPerHour) {
        return `Speed: ${charsPerHour.toLocaleString()} chars/hour`;
    }

    // Initialize Kanji Grid Renderer (using shared component)
    const kanjiGridRenderer = new KanjiGridRenderer({
        containerSelector: '#kanjiGrid',
        counterSelector: '#kanjiCount',
        colorMode: 'backend',
        emptyMessage: 'No kanji data available'
    });
    
    // Function to create kanji grid (now using shared renderer)
    function createKanjiGrid(kanjiData) {
        kanjiGridRenderer.render(kanjiData);
    }

    // Function to load stats data with optional year filter
    function loadStatsData(filterYear = null) {
        const url = filterYear && filterYear !== 'all' ? `/api/stats?year=${filterYear}` : '/api/stats';
        
        return fetch(url)
            .then(response => response.json())
            .then(data => {
                // Store all lines data globally for heatmap calculations
                if (data.allLinesData && Array.isArray(data.allLinesData)) {
                    window.allLinesData = data.allLinesData;
                } else {
                    // If not provided by API, we'll work without it
                    window.allLinesData = [];
                }
                
                if (!data.labels || data.labels.length === 0) {
                    console.log("No data to display.");
                    return data;
                }

                // Filter datasets for each chart
                const linesData = {
                    labels: data.labels,
                    datasets: data.datasets.filter(d => d.for === "Lines Received")
                };

                const charsData = {
                    labels: data.labels,
                    datasets: data.datasets.filter(d => d.for === 'Characters Read')
                };
                
                // Remove the 'hidden' property so they appear on their own charts
                [...charsData.datasets].forEach(d => delete d.hidden);

                // Create the charts (only on initial load)
                if (!window.chartsInitialized) {
                    createChart('linesChart', linesData, 'Cumulative Lines Received');
                    createChart('charsChart', charsData, 'Cumulative Characters Read');

                    // Create reading chars quantity chart if data exists
                    if (data.totalCharsPerGame) {
                        createGameBarChart('readingCharsChart', data.totalCharsPerGame, 'Reading Chars Quantity', 'Characters Read');
                    }

                    // Create reading time quantity chart if data exists
                    if (data.readingTimePerGame) {
                        createGameBarChartWithCustomFormat('readingTimeChart', data.readingTimePerGame, 'Reading Time Quantity', 'Time (hours)', formatTime);
                    }

                    // Create reading speed per game chart if data exists
                    if (data.readingSpeedPerGame) {
                        createGameBarChartWithCustomFormat('readingSpeedPerGameChart', data.readingSpeedPerGame, 'Reading Speed Improvement', 'Speed (chars/hour)', formatSpeed);
                    }

                    // Create kanji grid if data exists
                    if (data.kanjiGridData) {
                        createKanjiGrid(data.kanjiGridData);
                    }

                    window.chartsInitialized = true;
                }

                // Always update heatmap
                if (data.heatmapData) {
                    const container = document.getElementById('heatmapContainer');
                    container.innerHTML = '';
                    createHeatmap(data.heatmapData);
                }

                // Load dashboard data (only on initial load)
                if (!window.dashboardInitialized) {
                    loadDashboardData(data);
                    window.dashboardInitialized = true;
                }

                // Load goal progress chart (always refresh)
                if (typeof loadGoalProgress === 'function') {
                    // Use the current data instead of making another API call
                    updateGoalProgressWithData(data);
                }

                return data;
            })
            .catch(error => {
                console.error('Error fetching chart data:', error);
                showDashboardError();
                throw error;
            });
    }

    // Goal Progress Chart functionality
    let goalSettings = window.statsConfig || {};
    if (!goalSettings.reading_hours_target) goalSettings.reading_hours_target = 1500;
    if (!goalSettings.character_count_target) goalSettings.character_count_target = 25000000;
    if (!goalSettings.games_target) goalSettings.games_target = 100;

    // Function to load goal settings from API (fallback)
    async function loadGoalSettings() {
        // Use global config if available, otherwise fetch
        if (window.statsConfig) {
            goalSettings.reading_hours_target = window.statsConfig.readingHoursTarget || 1500;
            goalSettings.character_count_target = window.statsConfig.characterCountTarget || 25000000;
            goalSettings.games_target = window.statsConfig.gamesTarget || 100;
            return;
        }
        try {
            const response = await fetch('/api/settings');
            if (response.ok) {
                const settings = await response.json();
                goalSettings = {
                    reading_hours_target: settings.reading_hours_target || 1500,
                    character_count_target: settings.character_count_target || 25000000,
                    games_target: settings.games_target || 100
                };
            }
        } catch (error) {
            console.error('Error loading goal settings:', error);
        }
    }

    // Function to calculate 90-day rolling average for projections
    function calculate90DayAverage(allLinesData, metricType) {
        if (!allLinesData || allLinesData.length === 0) {
            return 0;
        }

        const today = new Date();
        const ninetyDaysAgo = new Date(today.getTime() - (90 * 24 * 60 * 60 * 1000));
        
        // Filter data to last 90 days
        const recentData = allLinesData.filter(line => {
            const lineDate = new Date(line.timestamp * 1000);
            return lineDate >= ninetyDaysAgo && lineDate <= today;
        });

        if (recentData.length === 0) {
            return 0;
        }

        let dailyTotals = {};
        
        if (metricType === 'hours') {
            // Group by day and calculate reading time using AFK timer logic
            const dailyTimestamps = {};
            for (const line of recentData) {
                const ts = parseFloat(line.timestamp);
                if (isNaN(ts)) continue;
                const dateObj = new Date(ts * 1000);
                const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
                if (!dailyTimestamps[dateStr]) {
                    dailyTimestamps[dateStr] = [];
                }
                dailyTimestamps[dateStr].push(ts);
            }
            
            for (const [dateStr, timestamps] of Object.entries(dailyTimestamps)) {
                if (timestamps.length >= 2) {
                    timestamps.sort((a, b) => a - b);
                    let dayHours = 0;
                    let afkTimerSeconds = window.statsConfig ? window.statsConfig.afkTimerSeconds : 120;
                    // Try to get AFK timer from settings modal if available and valid
                    const afkTimerInput = document.getElementById('afkTimer');
                    if (afkTimerInput && afkTimerInput.value) {
                        const parsed = parseInt(afkTimerInput.value, 10);
                        if (!isNaN(parsed) && parsed > 0) afkTimerSeconds = parsed;
                    }

                    for (let i = 1; i < timestamps.length; i++) {
                        const gap = timestamps[i] - timestamps[i-1];
                        dayHours += Math.min(gap, afkTimerSeconds) / 3600;
                    }
                    dailyTotals[dateStr] = dayHours;
                } else if (timestamps.length === 1) {
                    dailyTotals[dateStr] = 1 / 3600; // Minimal activity
                }
            }
        } else if (metricType === 'characters') {
            // Group by day and sum characters
            for (const line of recentData) {
                const ts = parseFloat(line.timestamp);
                if (isNaN(ts)) continue;
                const dateObj = new Date(ts * 1000);
                const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
                dailyTotals[dateStr] = (dailyTotals[dateStr] || 0) + (line.characters || 0);
            }
        } else if (metricType === 'games') {
            // Group by day and count unique games
            const dailyGames = {};
            for (const line of recentData) {
                const ts = parseFloat(line.timestamp);
                if (isNaN(ts)) continue;
                const dateObj = new Date(ts * 1000);
                const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
                if (!dailyGames[dateStr]) {
                    dailyGames[dateStr] = new Set();
                }
                dailyGames[dateStr].add(line.game_name);
            }
            
            for (const [dateStr, gamesSet] of Object.entries(dailyGames)) {
                dailyTotals[dateStr] = gamesSet.size;
            }
        }
        
        const totalDays = Object.keys(dailyTotals).length;
        if (totalDays === 0) {
            return 0;
        }
        
        const totalValue = Object.values(dailyTotals).reduce((sum, value) => sum + value, 0);
        return totalValue / totalDays;
    }

    // Function to format projection text
    function formatProjection(currentValue, targetValue, dailyAverage, metricType) {
        if (currentValue >= targetValue) {
            return 'Goal achieved! 🎉';
        }
        
        if (dailyAverage <= 0) {
            return 'No recent activity';
        }
        
        const remaining = targetValue - currentValue;
        const daysToComplete = Math.ceil(remaining / dailyAverage);
        
        if (daysToComplete <= 0) {
            return 'Goal achieved! 🎉';
        } else if (daysToComplete === 1) {
            return '~1 day remaining';
        } else if (daysToComplete <= 7) {
            return `~${daysToComplete} days remaining`;
        } else if (daysToComplete <= 30) {
            const weeks = Math.ceil(daysToComplete / 7);
            return `~${weeks} week${weeks > 1 ? 's' : ''} remaining`;
        } else if (daysToComplete <= 365) {
            const months = Math.ceil(daysToComplete / 30);
            return `~${months} month${months > 1 ? 's' : ''} remaining`;
        } else {
            const years = Math.ceil(daysToComplete / 365);
            return `~${years} year${years > 1 ? 's' : ''} remaining`;
        }
    }

    // Function to format large numbers
    function formatGoalNumber(num) {
        if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + 'M';
        } else if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        }
        return num.toString();
    }

    // Function to update progress bar color based on percentage
    function updateProgressBarColor(progressElement, percentage) {
        // Remove existing completion classes
        progressElement.classList.remove('completion-0', 'completion-25', 'completion-50', 'completion-75', 'completion-100');
        
        // Add appropriate class based on percentage
        if (percentage >= 100) {
            progressElement.classList.add('completion-100');
        } else if (percentage >= 75) {
            progressElement.classList.add('completion-75');
        } else if (percentage >= 50) {
            progressElement.classList.add('completion-50');
        } else if (percentage >= 25) {
            progressElement.classList.add('completion-25');
        } else {
            progressElement.classList.add('completion-0');
        }
    }

    // Helper function to update goal progress UI with provided data
    function updateGoalProgressUI(allGamesStats, allLinesData) {
        if (!allGamesStats) {
            throw new Error('No stats data available');
        }
        
        // Calculate current progress
        const currentHours = allGamesStats.total_time_hours || 0;
        const currentCharacters = allGamesStats.total_characters || 0;
        const currentGames = allGamesStats.unique_games || 0;
        
        // Calculate 90-day averages for projections
        const dailyHoursAvg = calculate90DayAverage(allLinesData, 'hours');
        const dailyCharsAvg = calculate90DayAverage(allLinesData, 'characters');
        const dailyGamesAvg = calculate90DayAverage(allLinesData, 'games');
        
        // Update Hours Goal
        const hoursPercentage = Math.min(100, (currentHours / goalSettings.reading_hours_target) * 100);
        document.getElementById('goalHoursCurrent').textContent = Math.floor(currentHours).toLocaleString();
        document.getElementById('goalHoursTarget').textContent = goalSettings.reading_hours_target.toLocaleString();
        document.getElementById('goalHoursPercentage').textContent = Math.floor(hoursPercentage) + '%';
        document.getElementById('goalHoursProjection').textContent =
            formatProjection(currentHours, goalSettings.reading_hours_target, dailyHoursAvg, 'hours');
        
        const hoursProgressBar = document.getElementById('goalHoursProgress');
        hoursProgressBar.style.width = hoursPercentage + '%';
        hoursProgressBar.setAttribute('data-percentage', Math.floor(hoursPercentage / 25) * 25);
        updateProgressBarColor(hoursProgressBar, hoursPercentage);
        
        // Update Characters Goal
        const charsPercentage = Math.min(100, (currentCharacters / goalSettings.character_count_target) * 100);
        document.getElementById('goalCharsCurrent').textContent = formatGoalNumber(currentCharacters);
        document.getElementById('goalCharsTarget').textContent = formatGoalNumber(goalSettings.character_count_target);
        document.getElementById('goalCharsPercentage').textContent = Math.floor(charsPercentage) + '%';
        document.getElementById('goalCharsProjection').textContent =
            formatProjection(currentCharacters, goalSettings.character_count_target, dailyCharsAvg, 'characters');
            
        const charsProgressBar = document.getElementById('goalCharsProgress');
        charsProgressBar.style.width = charsPercentage + '%';
        charsProgressBar.setAttribute('data-percentage', Math.floor(charsPercentage / 25) * 25);
        updateProgressBarColor(charsProgressBar, charsPercentage);
        
        // Update Games Goal
        const gamesPercentage = Math.min(100, (currentGames / goalSettings.games_target) * 100);
        document.getElementById('goalGamesCurrent').textContent = currentGames.toLocaleString();
        document.getElementById('goalGamesTarget').textContent = goalSettings.games_target.toLocaleString();
        document.getElementById('goalGamesPercentage').textContent = Math.floor(gamesPercentage) + '%';
        document.getElementById('goalGamesProjection').textContent =
            formatProjection(currentGames, goalSettings.games_target, dailyGamesAvg, 'games');
            
        const gamesProgressBar = document.getElementById('goalGamesProgress');
        gamesProgressBar.style.width = gamesPercentage + '%';
        gamesProgressBar.setAttribute('data-percentage', Math.floor(gamesPercentage / 25) * 25);
        updateProgressBarColor(gamesProgressBar, gamesPercentage);
    }

    // Main function to load and display goal progress
    async function loadGoalProgress() {
        const goalProgressChart = document.getElementById('goalProgressChart');
        const goalProgressLoading = document.getElementById('goalProgressLoading');
        const goalProgressError = document.getElementById('goalProgressError');
        
        if (!goalProgressChart) return;
        
        try {
            // Show loading state
            goalProgressLoading.style.display = 'flex';
            goalProgressError.style.display = 'none';
            
            // Load goal settings and stats data
            await loadGoalSettings();
            const response = await fetch('/api/stats');
            if (!response.ok) throw new Error('Failed to fetch stats data');
            
            const data = await response.json();
            const allGamesStats = data.allGamesStats;
            const allLinesData = data.allLinesData || [];
            
            // Update the UI using the shared helper function
            updateGoalProgressUI(allGamesStats, allLinesData);
            
            // Hide loading state
            goalProgressLoading.style.display = 'none';
            
        } catch (error) {
            console.error('Error loading goal progress:', error);
            goalProgressLoading.style.display = 'none';
            goalProgressError.style.display = 'block';
        }
    }

    // Initial load with saved year preference
    const savedYear = localStorage.getItem('selectedHeatmapYear') || window.statsConfig?.heatmapDisplayYear || 'all';
    loadStatsData(savedYear);

    // Populate settings modal with global config values on load
    if (window.statsConfig) {
        const sessionGapInput = document.getElementById('sessionGap');
        if (sessionGapInput) sessionGapInput.value = window.statsConfig.sessionGapSeconds || 3600;

        const streakReqInput = document.getElementById('streakRequirement');
        if (streakReqInput) streakReqInput.value = window.statsConfig.streakRequirementHours || 1.0;

        const heatmapYearSelect = document.getElementById('heatmapYear');
        if (heatmapYearSelect) heatmapYearSelect.value = window.statsConfig.heatmapDisplayYear || 'all';

        const hoursTargetInput = document.getElementById('readingHoursTarget');
        if (hoursTargetInput) hoursTargetInput.value = window.statsConfig.readingHoursTarget || 1500;

        const charsTargetInput = document.getElementById('characterCountTarget');
        if (charsTargetInput) charsTargetInput.value = window.statsConfig.characterCountTarget || 25000000;

        const gamesTargetInput = document.getElementById('gamesTarget');
        if (gamesTargetInput) gamesTargetInput.value = window.statsConfig.gamesTarget || 100;
    }

    // Function to update goal progress using existing stats data
    async function updateGoalProgressWithData(statsData) {
        const goalProgressChart = document.getElementById('goalProgressChart');
        const goalProgressLoading = document.getElementById('goalProgressLoading');
        const goalProgressError = document.getElementById('goalProgressError');
        
        if (!goalProgressChart) return;
        
        try {
            // Load goal settings if not already loaded
            if (!goalSettings.reading_hours_target) {
                await loadGoalSettings();
            }
            
            const allGamesStats = statsData.allGamesStats;
            const allLinesData = statsData.allLinesData || [];
            
            // Update the UI using the shared helper function
            updateGoalProgressUI(allGamesStats, allLinesData);
            
            // Hide loading and error states
            goalProgressLoading.style.display = 'none';
            goalProgressError.style.display = 'none';
            
        } catch (error) {
            console.error('Error updating goal progress:', error);
            goalProgressLoading.style.display = 'none';
            goalProgressError.style.display = 'block';
        }
    }

    // Load goal progress initially
    setTimeout(() => {
        loadGoalProgress();
    }, 1000);
    
    // Refresh goal progress when settings are updated
    window.addEventListener('settingsUpdated', () => {
        setTimeout(() => {
            loadGoalProgress();
        }, 500);
    });

    // Make functions globally available
    window.createHeatmap = createHeatmap;
    window.loadStatsData = loadStatsData;
    window.loadGoalProgress = loadGoalProgress;

    // Dashboard functionality
    function loadDashboardData(data = null) {
        function updateTodayOverview(allLinesData) {
            // Get today's date string (YYYY-MM-DD)
            // Get today's date string (YYYY-MM-DD), timezone aware (local time)
            const today = new Date();
            const pad = n => n.toString().padStart(2, '0');
            const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
            document.getElementById('todayDate').textContent = todayStr;

            // Filter lines for today
            const todayLines = (allLinesData || []).filter(line => {
                if (!line.timestamp) return false;
                const ts = parseFloat(line.timestamp);
                if (isNaN(ts)) return false;
                const dateObj = new Date(ts * 1000);
                const lineDate = `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
                return lineDate === todayStr;
            });

            // Calculate total characters read today (only valid numbers)
            const totalChars = todayLines.reduce((sum, line) => {
                const chars = Number(line.characters);
                return sum + (isNaN(chars) ? 0 : chars);
            }, 0);

            // Calculate sessions (count gaps > session threshold as new sessions)
            let sessions = 0;
            let sessionGap = window.statsConfig ? window.statsConfig.sessionGapSeconds : 3600;
            // Try to get session gap from settings modal if available and valid
            const sessionGapInput = document.getElementById('sessionGap');
            if (sessionGapInput && sessionGapInput.value) {
                const parsed = parseInt(sessionGapInput.value, 10);
                if (!isNaN(parsed) && parsed > 0) sessionGap = parsed;
            }
            if (todayLines.length > 0 && todayLines[0].session_id !== undefined) {
                const sessionSet = new Set(todayLines.map(l => l.session_id));
                sessions = sessionSet.size;
            } else {
                // Use timestamp gap logic
                const timestamps = todayLines
                    .map(l => parseFloat(l.timestamp))
                    .filter(ts => !isNaN(ts))
                    .sort((a, b) => a - b);
                if (timestamps.length > 0) {
                    sessions = 1;
                    for (let i = 1; i < timestamps.length; i++) {
                        if (timestamps[i] - timestamps[i - 1] > sessionGap) {
                            sessions += 1;
                        }
                    }
                } else {
                    sessions = 0;
                }
            }

            // Calculate total reading time (reuse AFK logic from calculateHeatmapStreaks)
            let totalSeconds = 0;
            const timestamps = todayLines
                .map(l => parseFloat(l.timestamp))
                .filter(ts => !isNaN(ts))
                .sort((a, b) => a - b);
            // Get AFK timer from settings modal if available
            let afkTimerSeconds = window.statsConfig ? window.statsConfig.afkTimerSeconds : 120;
            const afkTimerInput = document.getElementById('afkTimer');
            if (afkTimerInput && afkTimerInput.value) {
                const parsed = parseInt(afkTimerInput.value, 10);
                if (!isNaN(parsed) && parsed > 0) afkTimerSeconds = parsed;
            }
            if (timestamps.length >= 2) {
                for (let i = 1; i < timestamps.length; i++) {
                    const gap = timestamps[i] - timestamps[i-1];
                    totalSeconds += Math.min(gap, afkTimerSeconds);
                }
            } else if (timestamps.length === 1) {
                totalSeconds = 1;
            }
            let totalHours = totalSeconds / 3600;

            // Calculate chars/hour
            let charsPerHour = '-';
            if (totalChars > 0) {
                // Avoid division by zero, set minimum time to 1 minute if activity exists
                if (totalHours <= 0) totalHours = 1/60;
                charsPerHour = Math.round(totalChars / totalHours).toLocaleString();
            }

            // Format hours for display
            let hoursDisplay = '-';
            if (totalHours > 0) {
                const h = Math.floor(totalHours);
                const m = Math.round((totalHours - h) * 60);
                hoursDisplay = h > 0 ? `${h}h${m > 0 ? ' ' + m + 'm' : ''}` : `${m}m`;
            }

            document.getElementById('todayTotalHours').textContent = hoursDisplay;
            document.getElementById('todayTotalChars').textContent = totalChars.toLocaleString();
            document.getElementById('todaySessions').textContent = sessions;
            document.getElementById('todayCharsPerHour').textContent = charsPerHour;
        }

        if (data && data.currentGameStats && data.allGamesStats) {
            // Calculate streaks using global function
            const allGamesStreak = data.allLinesData ? calculateCurrentStreak(data.allLinesData) : 0;
            const currentGameStreak = (data.allLinesData && data.currentGameStats.game_name) ? 
                calculateCurrentStreak(data.allLinesData, data.currentGameStats.game_name) : allGamesStreak;
            
            // Use existing data if available, but override streak with global calculation
            updateCurrentGameDashboard(data.currentGameStats, data.allLinesData, currentGameStreak);
            updateAllGamesDashboard(data.allGamesStats, data.allLinesData, allGamesStreak);
            if (data.allLinesData) updateTodayOverview(data.allLinesData);
            hideDashboardLoading();
        } else {
            // Fetch fresh data
            showDashboardLoading();
            fetch('/api/stats')
                .then(response => response.json())
                .then(data => {
                    if (data.currentGameStats && data.allGamesStats) {
                        // Calculate streaks using global function
                        const allGamesStreak = data.allLinesData ? calculateCurrentStreak(data.allLinesData) : 0;
                        const currentGameStreak = (data.allLinesData && data.currentGameStats.game_name) ? 
                            calculateCurrentStreak(data.allLinesData, data.currentGameStats.game_name) : allGamesStreak;
                        
                        updateCurrentGameDashboard(data.currentGameStats, data.allLinesData, currentGameStreak);
                        updateAllGamesDashboard(data.allGamesStats, data.allLinesData, allGamesStreak);
                        if (data.allLinesData) updateTodayOverview(data.allLinesData);
                    } else {
                        showDashboardError();
                    }
                    hideDashboardLoading();
                })
                .catch(error => {
                    console.error('Error fetching dashboard data:', error);
                    showDashboardError();
                    hideDashboardLoading();
                });
        }
    }

    function updateCurrentGameDashboard(stats, allLinesData = null, globalStreak = null) {
        if (!stats) {
            showNoDashboardData('currentGameCard', 'No current game data available');
            return;
        }

        // Update game name and subtitle
        document.getElementById('currentGameName').textContent = stats.game_name;

        // Update main statistics
        document.getElementById('currentTotalChars').textContent = stats.total_characters_formatted;
        document.getElementById('currentTotalTime').textContent = stats.total_time_formatted;
        document.getElementById('currentReadingSpeed').textContent = stats.reading_speed_formatted;
        document.getElementById('currentSessions').textContent = stats.sessions.toLocaleString();

        // Update progress section
        document.getElementById('currentMonthlyChars').textContent = stats.monthly_characters_formatted;
        document.getElementById('currentFirstDate').textContent = stats.first_date;
        document.getElementById('currentLastDate').textContent = stats.last_date;

        // Update streak indicator using global streak calculation if available
        const streakElement = document.getElementById('currentGameStreak');
        const streakValue = document.getElementById('currentStreakValue');
        
        // Use global streak if provided, otherwise fall back to stats streak
        const streakToUse = globalStreak !== null ? globalStreak : (stats.current_streak || 0);
        
        if (streakToUse > 0) {
            streakValue.textContent = streakToUse;
            streakElement.style.display = 'inline-flex';
        } else {
            streakElement.style.display = 'none';
        }

        // Show the card
        document.getElementById('currentGameCard').style.display = 'block';
    }

    function updateAllGamesDashboard(stats, allLinesData = null, globalStreak = null) {
        if (!stats) {
            showNoDashboardData('allGamesCard', 'No games data available');
            return;
        }

        // Update subtitle
        const gamesText = stats.unique_games === 1 ? '1 game played' : `${stats.unique_games} games played`;
        document.getElementById('totalGamesCount').textContent = gamesText;

        // Update main statistics
        document.getElementById('allTotalChars').textContent = stats.total_characters_formatted;
        document.getElementById('allTotalTime').textContent = stats.total_time_formatted;
        document.getElementById('allReadingSpeed').textContent = stats.reading_speed_formatted;
        document.getElementById('allSessions').textContent = stats.sessions.toLocaleString();

        // Update progress section
        document.getElementById('allMonthlyChars').textContent = stats.monthly_characters_formatted;
        document.getElementById('allUniqueGames').textContent = stats.unique_games.toLocaleString();
        document.getElementById('allTotalSentences').textContent = stats.total_sentences.toLocaleString();

        // Update streak indicator using global streak calculation if available
        const streakElement = document.getElementById('allGamesStreak');
        const streakValue = document.getElementById('allStreakValue');
        
        // Use global streak if provided, otherwise fall back to stats streak
        const streakToUse = globalStreak !== null ? globalStreak : (stats.current_streak || 0);
        
        if (streakToUse > 0) {
            streakValue.textContent = streakToUse;
            streakElement.style.display = 'inline-flex';
        } else {
            streakElement.style.display = 'none';
        }


        // Show the card
        document.getElementById('allGamesCard').style.display = 'block';
    }

    function showDashboardLoading() {
        document.getElementById('dashboardLoading').style.display = 'flex';
        document.getElementById('dashboardError').style.display = 'none';
        document.getElementById('currentGameCard').style.display = 'none';
        document.getElementById('allGamesCard').style.display = 'none';
    }

    function hideDashboardLoading() {
        document.getElementById('dashboardLoading').style.display = 'none';
    }

    function showDashboardError() {
        document.getElementById('dashboardError').style.display = 'block';
        document.getElementById('dashboardLoading').style.display = 'none';
        document.getElementById('currentGameCard').style.display = 'none';
        document.getElementById('allGamesCard').style.display = 'none';
    }

    function showNoDashboardData(cardId, message) {
        const card = document.getElementById(cardId);
        const statsGrid = card.querySelector('.dashboard-stats-grid');
        const progressSection = card.querySelector('.dashboard-progress-section');
        
        // Hide stats and progress sections
        statsGrid.style.display = 'none';
        progressSection.style.display = 'none';
        
        // Add no data message
        let noDataMsg = card.querySelector('.no-data-message');
        if (!noDataMsg) {
            noDataMsg = document.createElement('div');
            noDataMsg.className = 'no-data-message';
            noDataMsg.style.cssText = 'text-align: center; padding: 40px 20px; color: var(--text-tertiary); font-style: italic;';
            card.appendChild(noDataMsg);
        }
        noDataMsg.textContent = message;
        
        card.style.display = 'block';
    }

    // Add click animations for dashboard stat items
    const statItems = document.querySelectorAll('.dashboard-stat-item');
    statItems.forEach(item => {
        item.addEventListener('click', function() {
            // Add click animation
            this.style.transform = 'scale(0.95)';
            setTimeout(() => {
                this.style.transform = '';
            }, 150);
        });
    });

    // Add accessibility improvements
    statItems.forEach(item => {
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'button');
        
        item.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.click();
            }
        });
    });

    // Global function to retry dashboard loading
    window.loadDashboardData = loadDashboardData;

    // Delete Game Entry Functionality
    class GameDeletionManager {
        constructor() {
            this.games = [];
            this.selectedGames = new Set();
            this.isLoading = false;
            
            this.initializeElements();
            this.attachEventListeners();
            this.loadGames();
        }
        
        initializeElements() {
            // Control elements
            this.selectAllBtn = document.getElementById('selectAllBtn');
            this.selectNoneBtn = document.getElementById('selectNoneBtn');
            this.deleteSelectedBtn = document.getElementById('deleteSelectedBtn');
            this.headerCheckbox = document.getElementById('headerCheckbox');
            
            // Table elements
            this.gamesTableBody = document.getElementById('gamesTableBody');
            this.loadingIndicator = document.getElementById('loadingIndicator');
            this.noGamesMessage = document.getElementById('noGamesMessage');
            this.errorMessage = document.getElementById('errorMessage');
            this.retryBtn = document.getElementById('retryBtn');
            
            // Modal elements
            this.confirmationModal = document.getElementById('confirmationModal');
            this.progressModal = document.getElementById('progressModal');
            this.resultModal = document.getElementById('resultModal');
            
            // Modal content elements
            this.selectedGamesList = document.getElementById('selectedGamesList');
            this.totalGamesCount = document.getElementById('totalGamesCount');
            this.totalSentencesCount = document.getElementById('totalSentencesCount');
            this.totalCharactersCount = document.getElementById('totalCharactersCount');
            this.progressText = document.getElementById('progressText');
            this.resultContent = document.getElementById('resultContent');
            this.resultTitle = document.getElementById('resultTitle');
        }
        
        attachEventListeners() {
            // Control buttons
            if (this.selectAllBtn) this.selectAllBtn.addEventListener('click', () => this.selectAll());
            if (this.selectNoneBtn) this.selectNoneBtn.addEventListener('click', () => this.selectNone());
            if (this.deleteSelectedBtn) this.deleteSelectedBtn.addEventListener('click', () => this.showConfirmation());
            if (this.headerCheckbox) this.headerCheckbox.addEventListener('change', (e) => this.toggleAll(e.target.checked));
            
            // Modal controls
            const closeModalBtn = document.getElementById('closeModal');
            if (closeModalBtn) closeModalBtn.addEventListener('click', () => this.hideModal('confirmationModal'));
            const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
            if (cancelDeleteBtn) cancelDeleteBtn.addEventListener('click', () => this.hideModal('confirmationModal'));
            const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
            if (confirmDeleteBtn) confirmDeleteBtn.addEventListener('click', () => this.performDeletion());
            const closeResultModalBtn = document.getElementById('closeResultModal');
            if (closeResultModalBtn) closeResultModalBtn.addEventListener('click', () => this.hideModal('resultModal'));
            const okBtn = document.getElementById('okBtn');
            if (okBtn) okBtn.addEventListener('click', () => this.hideModal('resultModal'));
            
            // Retry button
            if (this.retryBtn) this.retryBtn.addEventListener('click', () => this.loadGames());
            
            // Close modals when clicking outside
            [this.confirmationModal, this.progressModal, this.resultModal].forEach(modal => {
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) {
                        this.hideModal(modal.id);
                    }
                });
            });
        }
        
        async loadGames() {
            this.showLoading(true);
            hideElement(this.errorMessage);
            hideElement(this.noGamesMessage);
            
            try {
                const response = await fetch('/api/games-list');
                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error || 'Failed to fetch games');
                }
                
                this.games = data.games;
                this.selectedGames.clear();
                this.renderGamesTable();
                this.updateDeleteButton();
                
                if (this.games.length === 0) {
                    showElement(this.noGamesMessage);
                }
                
            } catch (error) {
                console.error('Error loading games:', error);
                this.showError(error.message);
            } finally {
                this.showLoading(false);
            }
        }
        
        renderGamesTable() {
            this.gamesTableBody.innerHTML = '';
            
            this.games.forEach(game => {
                const row = document.createElement('tr');
                row.dataset.gameName = game.name;
                
                row.innerHTML = `
                    <td class="checkbox-cell">
                        <input type="checkbox" class="game-checkbox" data-game="${game.name}">
                    </td>
                    <td><strong>${escapeHtml(game.name)}</strong></td>
                    <td>${game.sentence_count.toLocaleString()}</td>
                    <td>${game.total_characters.toLocaleString()}</td>
                    <td>${game.date_range}</td>
                    <td>${game.first_entry_date}</td>
                    <td>${game.last_entry_date}</td>
                `;
                
                // Add checkbox event listener
                const checkbox = row.querySelector('.game-checkbox');
                checkbox.addEventListener('change', (e) => {
                    this.toggleGameSelection(game.name, e.target.checked);
                });
                
                this.gamesTableBody.appendChild(row);
            });
        }
        
        toggleGameSelection(gameName, isSelected) {
            if (isSelected) {
                this.selectedGames.add(gameName);
            } else {
                this.selectedGames.delete(gameName);
            }
            
            this.updateRowSelection(gameName, isSelected);
            this.updateHeaderCheckbox();
            this.updateDeleteButton();
        }
        
        updateRowSelection(gameName, isSelected) {
            const row = document.querySelector(`tr[data-game-name="${gameName}"]`);
            if (row) {
                if (isSelected) {
                    row.classList.add('selected');
                } else {
                    row.classList.remove('selected');
                }
            }
        }
        
        selectAll() {
            this.games.forEach(game => {
                this.selectedGames.add(game.name);
                const checkbox = document.querySelector(`input[data-game="${game.name}"]`);
                if (checkbox) {
                    checkbox.checked = true;
                    this.updateRowSelection(game.name, true);
                }
            });
            this.updateHeaderCheckbox();
            this.updateDeleteButton();
        }
        
        selectNone() {
            this.selectedGames.clear();
            document.querySelectorAll('.game-checkbox').forEach(checkbox => {
                checkbox.checked = false;
            });
            document.querySelectorAll('tr.selected').forEach(row => {
                row.classList.remove('selected');
            });
            this.updateHeaderCheckbox();
            this.updateDeleteButton();
        }
        
        toggleAll(checked) {
            if (checked) {
                this.selectAll();
            } else {
                this.selectNone();
            }
        }
        
        updateHeaderCheckbox() {
            const totalGames = this.games.length;
            const selectedCount = this.selectedGames.size;
            
            if (selectedCount === 0) {
                this.headerCheckbox.checked = false;
                this.headerCheckbox.indeterminate = false;
            } else if (selectedCount === totalGames) {
                this.headerCheckbox.checked = true;
                this.headerCheckbox.indeterminate = false;
            } else {
                this.headerCheckbox.checked = false;
                this.headerCheckbox.indeterminate = true;
            }
        }
        
        updateDeleteButton() {
            this.deleteSelectedBtn.disabled = this.selectedGames.size === 0;
            this.deleteSelectedBtn.textContent = this.selectedGames.size > 0
                ? `Delete Selected Games (${this.selectedGames.size})`
                : 'Delete Selected Games';
        }
        
        showConfirmation() {
            if (this.selectedGames.size === 0) return;
            
            // Populate confirmation modal
            this.populateConfirmationModal();
            this.showModal('confirmationModal');
        }
        
        populateConfirmationModal() {
            const selectedGameData = this.games.filter(game => this.selectedGames.has(game.name));
            
            // Populate games list
            this.selectedGamesList.innerHTML = '';
            selectedGameData.forEach(game => {
                const gameItem = document.createElement('div');
                gameItem.className = 'game-item';
                gameItem.innerHTML = `
                    <div>
                        <div class="game-name">${escapeHtml(game.name)}</div>
                        <div class="game-stats">${game.date_range}</div>
                    </div>
                    <div class="game-stats">
                        ${game.sentence_count} sentences, ${game.total_characters.toLocaleString()} chars
                    </div>
                `;
                this.selectedGamesList.appendChild(gameItem);
            });
            
            // Calculate totals
            const totalGames = selectedGameData.length;
            const totalSentences = selectedGameData.reduce((sum, game) => sum + game.sentence_count, 0);
            const totalCharacters = selectedGameData.reduce((sum, game) => sum + game.total_characters, 0);
            
            this.totalGamesCount.textContent = totalGames;
            this.totalSentencesCount.textContent = totalSentences.toLocaleString();
            this.totalCharactersCount.textContent = totalCharacters.toLocaleString();
        }
        
        async performDeletion() {
            this.hideModal('confirmationModal');
            this.showModal('progressModal');
            
            // Show native confirmation as second stage
            const gameNames = Array.from(this.selectedGames);
            const confirmText = `Are you absolutely sure you want to delete ${gameNames.length} game(s)? This action cannot be undone.`;
            
            if (!confirm(confirmText)) {
                this.hideModal('progressModal');
                return;
            }
            
            try {
                this.progressText.textContent = `Deleting ${gameNames.length} games...`;
                
                const response = await fetch('/api/delete-games', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ game_names: gameNames })
                });
                
                const result = await response.json();
                
                this.hideModal('progressModal');
                this.showResult(result, response.status);
                
            } catch (error) {
                console.error('Error deleting games:', error);
                this.hideModal('progressModal');
                this.showResult({ error: error.message }, 500);
            }
        }
        
        showResult(result, status) {
            let title, content, isSuccess = false;
            
            if (status === 200) {
                // Complete success
                title = 'Deletion Successful';
                isSuccess = true;
                content = `
                    <div class="success-message">
                        <p>✅ Successfully deleted ${result.successful_games.length} games!</p>
                        <p><strong>Total sentences deleted:</strong> ${result.total_sentences_deleted.toLocaleString()}</p>
                    </div>
                `;
            } else if (status === 207) {
                // Partial success
                title = 'Deletion Partially Successful';
                content = `
                    <div class="warning-result">
                        <p>⚠️ ${result.successful_games.length} games deleted successfully</p>
                        <p>${result.failed_games.length} games failed to delete</p>
                        <p><strong>Total sentences deleted:</strong> ${result.total_sentences_deleted.toLocaleString()}</p>
                    </div>
                    <div style="margin-top: 15px;">
                        <strong>Failed games:</strong>
                        <ul style="margin: 10px 0; padding-left: 20px;">
                            ${result.failed_games.map(game => `<li>${escapeHtml(game)}</li>`).join('')}
                        </ul>
                    </div>
                `;
                isSuccess = true; // Still refresh since some succeeded
            } else {
                // Complete failure
                title = 'Deletion Failed';
                content = `
                    <div class="error-result">
                        <p>❌ Failed to delete games</p>
                        <p><strong>Error:</strong> ${escapeHtml(result.error || 'Unknown error occurred')}</p>
                    </div>
                `;
            }
            
            this.resultTitle.textContent = title;
            this.resultContent.innerHTML = content;
            this.showModal('resultModal');
            
            // Auto-refresh if any deletions were successful
            if (isSuccess) {
                setTimeout(() => {
                    this.hideModal('resultModal');
                    window.location.reload();
                }, 3000);
            }
        }
        
        showModal(modalId) {
            const modal = document.getElementById(modalId);
            modal.classList.add('show');
            modal.style.display = 'flex';
        }
        
        hideModal(modalId) {
            const modal = document.getElementById(modalId);
            modal.classList.remove('show');
            modal.style.display = 'none';
        }
        
        showLoading(show) {
            this.isLoading = show;
            if (show) {
                showElement(this.loadingIndicator);
                hideElement(this.gamesTableBody.parentElement);
            } else {
                hideElement(this.loadingIndicator);
                showElement(this.gamesTableBody.parentElement);
            }
        }
        
        showError(message) {
            document.getElementById('errorText').textContent = message;
            showElement(this.errorMessage);
        }
    }
    
    // Initialize the deletion manager
    if (document.getElementById('gamesTableBody')) {
        new GameDeletionManager();
    }
    
    // ExStatic Import Functionality
    const exstaticFileInput = document.getElementById('exstaticFile');
    const importExstaticBtn = document.getElementById('importExstaticBtn');
    const importProgress = document.getElementById('importProgress');
    const importProgressBar = document.getElementById('importProgressBar');
    const importProgressText = document.getElementById('importProgressText');
    const importStatus = document.getElementById('importStatus');
    
    if (exstaticFileInput && importExstaticBtn) {
        // Enable/disable import button based on file selection
        exstaticFileInput.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file && file.type === 'text/csv' && file.name.toLowerCase().endsWith('.csv')) {
                importExstaticBtn.disabled = false;
                importExstaticBtn.style.background = '#2980b9';
                importExstaticBtn.style.cursor = 'pointer';
                showImportStatus('', 'info', false);
            } else {
                importExstaticBtn.disabled = true;
                importExstaticBtn.style.background = '#666';
                importExstaticBtn.style.cursor = 'not-allowed';
                if (file) {
                    showImportStatus('Please select a valid CSV file.', 'error', true);
                }
            }
        });
        
        // Handle import button click
        importExstaticBtn.addEventListener('click', function() {
            const file = exstaticFileInput.files[0];
            if (!file) {
                showImportStatus('Please select a CSV file first.', 'error', true);
                return;
            }
            
            importExstaticData(file);
        });
    }
    
    function showImportStatus(message, type, show) {
        if (!importStatus) return;
        
        if (show && message) {
            importStatus.textContent = message;
            importStatus.style.display = 'block';
            
            // Set appropriate styling based on type
            if (type === 'error') {
                importStatus.style.background = 'var(--danger-color)';
                importStatus.style.color = 'white';
            } else if (type === 'success') {
                importStatus.style.background = 'var(--success-color)';
                importStatus.style.color = 'white';
            } else if (type === 'info') {
                importStatus.style.background = 'var(--primary-color)';
                importStatus.style.color = 'white';
            } else {
                importStatus.style.background = 'var(--bg-tertiary)';
                importStatus.style.color = 'var(--text-primary)';
            }
        } else {
            importStatus.style.display = 'none';
        }
    }
    
    function showImportProgress(show, percentage = 0) {
        if (!importProgress || !importProgressBar || !importProgressText) return;
        
        if (show) {
            importProgress.style.display = 'block';
            importProgressBar.style.width = percentage + '%';
            importProgressText.textContent = Math.round(percentage) + '%';
        } else {
            importProgress.style.display = 'none';
        }
    }
    
    async function importExstaticData(file) {
        try {
            // Disable import button and show progress
            importExstaticBtn.disabled = true;
            showImportProgress(true, 0);
            showImportStatus('Preparing import...', 'info', true);
            
            // Create FormData and append the file
            const formData = new FormData();
            formData.append('file', file);
            
            // Show upload progress
            showImportProgress(true, 25);
            showImportStatus('Uploading file...', 'info', true);
            
            // Send file to backend
            const response = await fetch('/api/import-exstatic', {
                method: 'POST',
                body: formData
            });
            
            showImportProgress(true, 75);
            showImportStatus('Processing data...', 'info', true);
            
            const result = await response.json();
            
            showImportProgress(true, 100);
            
            if (response.ok) {
                // Success
                const message = `Successfully imported ${result.imported_count || 0} lines from ${result.games_count || 0} games.`;
                showImportStatus(message, 'success', true);
                
                // Reset file input and button
                exstaticFileInput.value = '';
                importExstaticBtn.disabled = true;
                
                // Hide progress after a delay
                setTimeout(() => {
                    showImportProgress(false);
                    // Optionally refresh the page to show new data
                    if (result.imported_count > 0) {
                        setTimeout(() => {
                            window.location.reload();
                        }, 2000);
                    }
                }, 1500);
            } else {
                // Error
                showImportStatus(result.error || 'Import failed. Please try again.', 'error', true);
                showImportProgress(false);
            }
        } catch (error) {
            console.error('Import error:', error);
            showImportStatus('Import failed due to network error. Please try again.', 'error', true);
            showImportProgress(false);
        } finally {
            // Re-enable import button only if a file is still selected
            importExstaticBtn.disabled = !(exstaticFileInput && exstaticFileInput.files && exstaticFileInput.files.length > 0);
        }
    }
});