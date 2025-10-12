// Overview Page JavaScript
// Dependencies: shared.js (provides utility functions like showElement, hideElement, escapeHtml)

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

document.addEventListener('DOMContentLoaded', function () {
    
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

    function showNoDataPopup() {
        document.getElementById("noDataPopup").classList.remove("hidden");
    }   

    document.getElementById("closeNoDataPopup").addEventListener("click", () => {
        document.getElementById("noDataPopup").classList.add("hidden");
    });

    // Function to load stats data with optional year filter
    function loadStatsData(start_timestamp = null, end_timestamp = null) {
        let url = '/api/stats';
        const params = new URLSearchParams();

        if (start_timestamp && end_timestamp) {
            // Only filter by timestamps
            params.append('start', start_timestamp);
            params.append('end', end_timestamp);
        }

        const queryString = params.toString();
        if (queryString) {
            url += `?${queryString}`;
        }
        
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
                    showNoDataPopup();
                    return data;
                }

                // Always update heatmap
                if (data.heatmapData) {
                    const container = document.getElementById('heatmapContainer');
                    container.innerHTML = '';
                    createHeatmap(data.heatmapData);
                }

                // Load dashboard data 
                loadDashboardData(data, end_timestamp);

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

    // ================================
    // Utility to convert date strings to Unix timestamps
    // Returns start of day for startDate and end of day for endDate
    // ================================
    function getUnixTimestamps(startDate, endDate) {
        const start = new Date(startDate + 'T00:00:00');
        const startTimestamp = Math.floor(start.getTime() / 1000); // convert ms to s

        const end = new Date(endDate + 'T23:59:59.999');
        const endTimestamp = Math.floor(end.getTime() / 1000); // convert ms to s

        return { startTimestamp, endTimestamp };
    }
    
    // ================================
    // Initialize date inputs with sessionStorage or fetch initial values
    // Dispatches "datesSet" event once dates are set
    // ================================
    function initializeDates() {
        const fromDateInput = document.getElementById('fromDate');
        const toDateInput = document.getElementById('toDate');

        const fromDate = sessionStorage.getItem("fromDate");
        const toDate = sessionStorage.getItem("toDate"); 

        if (!(fromDate && toDate)) {
            fetch('/api/stats')
                .then(response => response.json())
                .then(response_json => {
                    // Get first date from API
                    const firstDate = response_json.allGamesStats.first_date;
                    fromDateInput.value = firstDate;

                    // Get today's date
                    const today = new Date();
                    const toDate = today.toLocaleDateString('en-CA');
                    toDateInput.value = toDate;

                    // Save in sessionStorage
                    sessionStorage.setItem("fromDate", firstDate);
                    sessionStorage.setItem("toDate", toDate);

                    document.dispatchEvent(new Event("datesSet"));
                });
        } else {
            // If values already in sessionStorage, set inputs from there
            fromDateInput.value = fromDate;
            toDateInput.value = toDate;

            document.dispatchEvent(new Event("datesSet"));
        }
    }

    const fromDateInput = document.getElementById('fromDate');
    const toDateInput = document.getElementById('toDate');
    const popup = document.getElementById('dateErrorPopup');
    const closePopupBtn = document.getElementById('closePopupBtn');

    document.addEventListener("datesSet", () => {
        const fromDate = sessionStorage.getItem("fromDate");
        const toDate = sessionStorage.getItem("toDate");
        const { startTimestamp, endTimestamp } = getUnixTimestamps(fromDate, toDate);
        
        loadStatsData(startTimestamp, endTimestamp);
    });

     
    function handleDateChange() {
        const fromDateStr = fromDateInput.value;
        const toDateStr = toDateInput.value;

        sessionStorage.setItem("fromDate", fromDateStr);
        sessionStorage.setItem("toDate", toDateStr);

        // Validate date order
        if (fromDateStr && toDateStr && new Date(fromDateStr) > new Date(toDateStr)) {
            popup.classList.remove("hidden");
            return; 
        }

        const { startTimestamp, endTimestamp } = getUnixTimestamps(fromDateStr, toDateStr);

        loadStatsData(startTimestamp, endTimestamp);
    }

    // Attach listeners to both date inputs
    fromDateInput.addEventListener("change", handleDateChange);
    toDateInput.addEventListener("change", handleDateChange);

    // Session navigation button handlers
    const prevSessionBtn = document.querySelector('.prev-session-btn');
    const nextSessionBtn = document.querySelector('.next-session-btn');

    function updateSessionNavigationButtons() {
        if (!window.todaySessionDetails || window.todaySessionDetails.length === 0) {
            prevSessionBtn.disabled = true;
            nextSessionBtn.disabled = true;
            return;
        }
        prevSessionBtn.disabled = window.currentSessionIndex <= 0;
        nextSessionBtn.disabled = window.currentSessionIndex >= window.todaySessionDetails.length - 1;
    }

    function showSessionAtIndex(index) {
        if (!window.todaySessionDetails || window.todaySessionDetails.length === 0) return;
        if (index < 0 || index >= window.todaySessionDetails.length) return;
        window.currentSessionIndex = index;
        updateCurrentSessionOverview(window.todaySessionDetails, index);
        updateSessionNavigationButtons();
    }

    prevSessionBtn.addEventListener('click', () => {
        if (!window.todaySessionDetails) return;
        let idx = window.currentSessionIndex || 0;
        if (idx > 0) {
            showSessionAtIndex(idx - 1);
        }
    });

    nextSessionBtn.addEventListener('click', () => {
        if (!window.todaySessionDetails) return;
        let idx = window.currentSessionIndex || 0;
        if (idx < window.todaySessionDetails.length - 1) {
            showSessionAtIndex(idx + 1);
        }
    });

    // Update navigation buttons whenever sessions are loaded
    document.addEventListener('datesSet', () => {
        setTimeout(updateSessionNavigationButtons, 1200);
    });

    initializeDates();

    // Popup close button
    closePopupBtn.addEventListener("click", () => {
        popup.classList.add("hidden");
    });

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

    // Make functions globally available
    window.createHeatmap = createHeatmap;
    window.loadStatsData = loadStatsData;
    window.loadGoalProgress = loadGoalProgress;

    function updateCurrentSessionOverview(sessionDetails, index = sessionDetails.length - 1) {
        window.currentSessionIndex = index; // Store globally for potential future use
        console.log('Updating current session overview:', sessionDetails);
        // Get the session at index
        const lastSession = sessionDetails && sessionDetails.length > 0 ? sessionDetails[index] : null;

        if (!lastSession) {
            // No current session
            document.getElementById('currentSessionStatus').textContent = 'No active session';
            document.getElementById('currentSessionTotalHours').textContent = '-';
            document.getElementById('currentSessionTotalChars').textContent = '-';
            document.getElementById('currentSessionStartTime').textContent = '-';
            document.getElementById('currentSessionEndTime').textContent = '-';
            document.getElementById('currentSessionCharsPerHour').textContent = '-';
            return;
        }

        // Update session status (show game name if available)
        const statusText = lastSession.gameName ? `Playing: ${lastSession.gameName}` : 'Active session';
        document.getElementById('currentSessionStatus').textContent = statusText;

        // Format session duration
        let hoursDisplay = '-';
        const sessionHours = lastSession.totalSeconds / 3600;
        if (sessionHours > 0) {
            const h = Math.floor(sessionHours);
            const m = Math.round((sessionHours - h) * 60);
            hoursDisplay = h > 0 ? `${h}h${m > 0 ? ' ' + m + 'm' : ''}` : `${m}m`;
        }

        // Format start time
        const startTimeDisplay = new Date(lastSession.startTime * 1000).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        const endTimeDisplay = new Date(lastSession.endTime * 1000).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        // Update the DOM elements
        document.getElementById('currentSessionTotalHours').textContent = hoursDisplay;
        document.getElementById('currentSessionTotalChars').textContent = lastSession.totalChars.toLocaleString();
        document.getElementById('currentSessionStartTime').textContent = startTimeDisplay;
        if (index === sessionDetails.length - 1) {
            document.getElementById('currentSessionEndTime').textContent = 'Now';
        } else {
            document.getElementById('currentSessionEndTime').textContent = endTimeDisplay;
        }
        document.getElementById('currentSessionCharsPerHour').textContent = lastSession.readSpeed !== '-' ? lastSession.readSpeed.toLocaleString() : '-';
    }

    // Dashboard functionality
    function loadDashboardData(data = null, end_timestamp = null) {
        function updateTodayOverview(allLinesData) {
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
            let minimumSessionLength = 300; // 5 minutes minimum session length
            let sessionDetails = [];
            if (todayLines.length > 0) {
                // Sort lines by timestamp
                const sortedLines = todayLines.slice().sort((a, b) => parseFloat(a.timestamp) - parseFloat(b.timestamp));
                let currentSession = null;
                let lastTimestamp = null;
                let lastGameName = null;

                for (let i = 0; i < sortedLines.length; i++) {
                    const line = sortedLines[i];
                    const ts = parseFloat(line.timestamp);
                    const gameName = line.game_name || '';
                    const chars = Number(line.characters) || 0;

                    // Determine if new session: gap or new game
                    const isNewSession =
                        (lastTimestamp !== null && ts - lastTimestamp > sessionGap) ||
                        (lastGameName !== null && gameName !== lastGameName);

                    if (!currentSession || isNewSession) {
                        // Finish previous session
                        if (currentSession) {
                            // Calculate read speed for session
                            if (currentSession.totalSeconds > 0) {
                                currentSession.readSpeed = Math.round(currentSession.totalChars / (currentSession.totalSeconds / 3600));
                            } else {
                                currentSession.readSpeed = '-';
                            }
                            // Only add session if it meets minimum length requirement
                            if (currentSession.totalSeconds >= minimumSessionLength) {
                                sessionDetails.push(currentSession);
                            }
                        }
                        // Start new session
                        currentSession = {
                            startTime: ts,
                            endTime: ts,
                            gameName: gameName,
                            totalChars: chars,
                            totalSeconds: 0,
                            lines: [line]
                        };
                    } else {
                        // Continue current session
                        currentSession.endTime = ts;
                        currentSession.totalChars += chars;
                        currentSession.lines.push(line);
                        if (lastTimestamp !== null) {
                            let afkTimerSeconds = window.statsConfig ? window.statsConfig.afkTimerSeconds : 120;
                            currentSession.totalSeconds += Math.min(ts - lastTimestamp, afkTimerSeconds);
                        }
                    }

                    lastTimestamp = ts;
                    lastGameName = gameName;
                }

                // Push last session
                if (currentSession) {
                    if (currentSession.totalSeconds > 0) {
                        currentSession.readSpeed = Math.round(currentSession.totalChars / (currentSession.totalSeconds / 3600));
                    } else {
                        currentSession.readSpeed = '-';
                    }
                    sessionDetails.push(currentSession);
                }

                sessions = sessionDetails.length;
            } else {
                sessions = 0;
                sessionDetails = [];
            }

            // Optionally, you can expose sessionDetails for debugging or further UI use:
            console.log(sessionDetails);
            window.todaySessionDetails = sessionDetails;

            // Calculate total reading time (reuse AFK logic from calculateHeatmapStreaks)
            let totalSeconds = 0;
            const timestamps = todayLines
                .map(l => parseFloat(l.timestamp))
                .filter(ts => !isNaN(ts))
                .sort((a, b) => a - b);
            // Get AFK timer from settings modal if available
            let afkTimerSeconds = window.statsConfig ? window.statsConfig.afkTimerSeconds : 120;
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

            // Update current session overview with the last session
            showSessionAtIndex(sessionDetails.length - 1);
        }

        function updateOverviewForEndDay(allLinesData, endTimestamp) {
            if (!endTimestamp) return;

            const pad = n => n.toString().padStart(2, '0');

            // Determine target date string (YYYY-MM-DD) from the end timestamp
            const endDateObj = new Date(endTimestamp * 1000);
            const targetDateStr = `${endDateObj.getFullYear()}-${pad(endDateObj.getMonth() + 1)}-${pad(endDateObj.getDate())}`;
            document.getElementById('todayDate').textContent = targetDateStr;

            // Filter lines that fall on the target date
            const targetLines = (allLinesData || []).filter(line => {
                if (!line.timestamp) return false;
                const ts = parseFloat(line.timestamp);
                if (isNaN(ts)) return false;
                const dateObj = new Date(ts * 1000);
                const lineDate = `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
                return lineDate === targetDateStr;
            });

            // Calculate total characters
            const totalChars = targetLines.reduce((sum, line) => {
                const chars = Number(line.characters);
                return sum + (isNaN(chars) ? 0 : chars);
            }, 0);

            let sessions = 0;
            let sessionGap = window.statsConfig ? window.statsConfig.sessionGapSeconds : 3600;
            let minimumSessionLength = 300; // 5 minutes minimum session length
            let sessionDetails = [];
            if (targetLines.length > 0) {
                // Sort lines by timestamp
                const sortedLines = targetLines.slice().sort((a, b) => parseFloat(a.timestamp) - parseFloat(b.timestamp));
                let currentSession = null;
                let lastTimestamp = null;
                let lastGameName = null;

                for (let i = 0; i < sortedLines.length; i++) {
                    const line = sortedLines[i];
                    const ts = parseFloat(line.timestamp);
                    const gameName = line.game_name || '';
                    const chars = Number(line.characters) || 0;

                    // Determine if new session: gap or new game
                    const isNewSession =
                        (lastTimestamp !== null && ts - lastTimestamp > sessionGap) ||
                        (lastGameName !== null && gameName !== lastGameName);

                    if (!currentSession || isNewSession) {
                        // Finish previous session
                        if (currentSession) {
                            // Calculate read speed for session
                            if (currentSession.totalSeconds > 0) {
                                currentSession.readSpeed = Math.round(currentSession.totalChars / (currentSession.totalSeconds / 3600));
                            } else {
                                currentSession.readSpeed = '-';
                            }
                            // Only add session if it meets minimum length requirement
                            if (currentSession.totalSeconds >= minimumSessionLength) {
                                sessionDetails.push(currentSession);
                            }
                        }
                        // Start new session
                        currentSession = {
                            startTime: ts,
                            endTime: ts,
                            gameName: gameName,
                            totalChars: chars,
                            totalSeconds: 0,
                            lines: [line]
                        };
                    } else {
                        // Continue current session
                        currentSession.endTime = ts;
                        currentSession.totalChars += chars;
                        currentSession.lines.push(line);
                        if (lastTimestamp !== null) {
                            let afkTimerSeconds = window.statsConfig ? window.statsConfig.afkTimerSeconds : 120;
                            currentSession.totalSeconds += Math.min(ts - lastTimestamp, afkTimerSeconds);
                        }
                    }

                    lastTimestamp = ts;
                    lastGameName = gameName;
                }

                // Push last session
                if (currentSession) {
                    if (currentSession.totalSeconds > 0) {
                        currentSession.readSpeed = Math.round(currentSession.totalChars / (currentSession.totalSeconds / 3600));
                    } else {
                        currentSession.readSpeed = '-';
                    }
                    // Only add session if it meets minimum length requirement
                    if (currentSession.totalSeconds >= minimumSessionLength) {
                        sessionDetails.push(currentSession);
                    }
                }

                sessions = sessionDetails.length;
            } else {
                sessions = 0;
                sessionDetails = [];
            }

            // Optionally, you can expose sessionDetails for debugging or further UI use:
            console.log(sessionDetails);
            window.todaySessionDetails = sessionDetails;

            // Calculate total reading time
            let totalSeconds = 0;
            const timestamps = targetLines
                .map(l => parseFloat(l.timestamp))
                .filter(ts => !isNaN(ts))
                .sort((a, b) => a - b);

            let afkTimerSeconds = window.statsConfig?.afkTimerSeconds || 120;

            if (timestamps.length >= 2) {
                for (let i = 1; i < timestamps.length; i++) {
                    const gap = timestamps[i] - timestamps[i - 1];
                    totalSeconds += Math.min(gap, afkTimerSeconds);
                }
            } else if (timestamps.length === 1) {
                totalSeconds = 1;
            }

            let totalHours = totalSeconds / 3600;

            // Calculate chars/hour
            let charsPerHour = '-';
            if (totalChars > 0) {
                if (totalHours <= 0) totalHours = 1/60; // Minimum 1 minute
                charsPerHour = Math.round(totalChars / totalHours).toLocaleString();
            }

            // Format hours for display
            let hoursDisplay = '-';
            if (totalHours > 0) {
                const h = Math.floor(totalHours);
                const m = Math.round((totalHours - h) * 60);
                hoursDisplay = h > 0 ? `${h}h${m > 0 ? ' ' + m + 'm' : ''}` : `${m}m`;
            }

            // Update DOM
            document.getElementById('todayTotalHours').textContent = hoursDisplay;
            document.getElementById('todayTotalChars').textContent = totalChars.toLocaleString();
            document.getElementById('todaySessions').textContent = sessions;
            document.getElementById('todayCharsPerHour').textContent = charsPerHour;

            showSessionAtIndex(sessionDetails.length - 1);
        }

        if (data && data.currentGameStats && data.allGamesStats) {
            // Use existing data if available
            updateCurrentGameDashboard(data.currentGameStats);
            updateAllGamesDashboard(data.allGamesStats);
            
            if (data.allLinesData) {
                end_timestamp == null ? updateTodayOverview(data.allLinesData) : updateOverviewForEndDay(data.allLinesData, end_timestamp)
            }

            hideDashboardLoading();
        } else {
            // Fetch fresh data
            showDashboardLoading();
            fetch('/api/stats')
                .then(response => response.json())
                .then(data => {
                    if (data.currentGameStats && data.allGamesStats) {
                        updateCurrentGameDashboard(data.currentGameStats);
                        updateAllGamesDashboard(data.allGamesStats);
                        if (data.allLinesData) {
                            end_timestamp == null ? updateTodayOverview(data.allLinesData) : updateOverviewForEndDay(data.allLinesData, end_timestamp)
                        }
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

    function updateCurrentGameDashboard(stats) {
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

        // Update streak indicator
        const streakElement = document.getElementById('currentGameStreak');
        const streakValue = document.getElementById('currentStreakValue');
        if (stats.current_streak > 0) {
            streakValue.textContent = stats.current_streak;
            streakElement.style.display = 'inline-flex';
        } else {
            streakElement.style.display = 'none';
        }

        // Show the card
        document.getElementById('currentGameCard').style.display = 'block';
    }

    function updateAllGamesDashboard(stats) {
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

        // Update streak indicator
        const streakElement = document.getElementById('allGamesStreak');
        const streakValue = document.getElementById('allStreakValue');
        if (stats.current_streak > 0) {
            streakValue.textContent = stats.current_streak;
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
});