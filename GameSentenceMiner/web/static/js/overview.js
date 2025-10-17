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
    
    // Custom streak calculation function for activity heatmap (includes average daily time)
    function calculateActivityStreaks(grid, yearData, allLinesForYear = []) {
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
        
        return { longestStreak, currentStreak, avgDaily: avgDailyTime };
    }
    
    // Initialize heatmap renderer with custom configuration for activity tracking
    const activityHeatmapRenderer = new HeatmapRenderer({
        containerId: 'heatmapContainer',
        metricName: 'characters',
        metricLabel: 'characters',
        calculateStreaks: calculateActivityStreaks
    });
    
    // Function to create GitHub-style heatmap using shared component
    function createHeatmap(heatmapData) {
        activityHeatmapRenderer.render(heatmapData, window.allLinesData || []);
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
    const deleteSessionBtn = document.querySelector('.delete-session-btn');

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

    function deleteSession(session) {
        const line_ids = session.lines.map(line => line.id);
        fetch('/api/delete-sentence-lines', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ line_ids })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                // Remove the session from the list
                window.todaySessionDetails = window.todaySessionDetails.filter(s => s !== session);
                // Update the UI
                updateCurrentSessionOverview(window.todaySessionDetails, window.currentSessionIndex);
                updateSessionNavigationButtons();
            } else {
                console.error('Failed to delete session:', data.error);
            }
        })
        .catch(error => {
            console.error('Error deleting session:', error);
        });
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

    deleteSessionBtn.addEventListener('click', () => {
        if (!window.todaySessionDetails || window.todaySessionDetails.length === 0) return;
        const idx = window.currentSessionIndex || 0;
        const sessionToDelete = window.todaySessionDetails[idx];
        if (!sessionToDelete) return;

        // Confirm deletion
        const confirm1 = confirm(`Are you sure you want to delete the session starting at ${new Date(sessionToDelete.startTime * 1000).toLocaleString()}? This will delete ${sessionToDelete.lines.length} lines. This action cannot be undone.`);
        if (!confirm1) return;
        const confirm2 = confirm("Are you REALLY sure? This cannot be undone.");
        if (!confirm2) return;
        const confirm3 = confirm("Final warning: Delete this session permanently?");
        if (!confirm3) return;

        // Call the delete function
        deleteSession(sessionToDelete);
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

    // Function to update progress timeline with start and estimated end dates
    function updateProgressTimeline(stats) {
        const startDateEl = document.getElementById('gameStartDate');
        const endDateEl = document.getElementById('gameEstimatedEndDate');
        
        // Set start date
        if (stats.first_date) {
            startDateEl.textContent = stats.first_date;
        } else {
            startDateEl.textContent = '-';
        }
        
        // Calculate and set estimated end date
        if (!stats.game_character_count || stats.game_character_count <= 0 ||
            !stats.total_characters || stats.total_characters <= 0 ||
            !stats.reading_speed || stats.reading_speed <= 0) {
            endDateEl.textContent = '-';
            return;
        }
        
        const charsRead = stats.total_characters;
        const totalChars = stats.game_character_count;
        const charsRemaining = Math.max(0, totalChars - charsRead);
        
        if (charsRemaining === 0) {
            endDateEl.textContent = 'Completed! 🎉';
            return;
        }
        
        // Calculate daily character progress
        let dailyCharProgress = 0;
        if (stats.daily_activity && Object.keys(stats.daily_activity).length > 0) {
            const activityDays = Object.values(stats.daily_activity).filter(chars => chars > 0);
            if (activityDays.length > 0) {
                dailyCharProgress = activityDays.reduce((sum, chars) => sum + chars, 0) / activityDays.length;
            }
        }
        
        if (dailyCharProgress === 0) {
            dailyCharProgress = stats.reading_speed; // Fallback: assume 1 hour per day
        }
        
        const daysUntilCompletion = Math.ceil(charsRemaining / dailyCharProgress);
        const today = new Date();
        const completionDate = new Date(today);
        completionDate.setDate(completionDate.getDate() + daysUntilCompletion);
        
        // Format as YYYY-MM-DD (estimated)
        const year = completionDate.getFullYear();
        const month = String(completionDate.getMonth() + 1).padStart(2, '0');
        const day = String(completionDate.getDate()).padStart(2, '0');
        endDateEl.textContent = `${year}-${month}-${day} (estimated)`;
    }
    
    // Function to update estimated time left stat
    function updateEstimatedTimeLeft(stats) {
        const estimatedTimeLeftEl = document.getElementById('currentEstimatedTimeLeft');
        
        if (!stats.game_character_count || stats.game_character_count <= 0 ||
            !stats.total_characters || stats.total_characters <= 0 ||
            !stats.reading_speed || stats.reading_speed <= 0) {
            estimatedTimeLeftEl.textContent = '-';
            return;
        }
        
        const charsRead = stats.total_characters;
        const totalChars = stats.game_character_count;
        const charsRemaining = Math.max(0, totalChars - charsRead);
        
        if (charsRemaining === 0) {
            estimatedTimeLeftEl.textContent = '0h';
            return;
        }
        
        const readingSpeed = stats.reading_speed;
        const hoursRemaining = charsRemaining / readingSpeed;
        
        // Format hours remaining
        let hoursText;
        if (hoursRemaining < 1) {
            const minutes = Math.round(hoursRemaining * 60);
            hoursText = `${minutes}m`;
        } else if (hoursRemaining < 24) {
            const hours = Math.floor(hoursRemaining);
            const minutes = Math.round((hoursRemaining - hours) * 60);
            hoursText = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
        } else if (hoursRemaining < 168) {
            const days = Math.floor(hoursRemaining / 24);
            const hours = Math.round(hoursRemaining % 24);
            hoursText = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
        } else {
            const days = Math.floor(hoursRemaining / 24);
            hoursText = `${days}d`;
        }
        
        estimatedTimeLeftEl.textContent = hoursText;
    }

    // Make functions globally available
    window.createHeatmap = createHeatmap;
    window.loadStatsData = loadStatsData;
    window.loadGoalProgress = loadGoalProgress;
    window.updateProgressTimeline = updateProgressTimeline;
    window.updateEstimatedTimeLeft = updateEstimatedTimeLeft;

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
        document.getElementById('currentSessionEndTime').textContent = endTimeDisplay;
        document.getElementById('currentSessionCharsPerHour').textContent = lastSession.readSpeed !== '-' ? lastSession.readSpeed.toLocaleString() : '-';
    }

    // Dashboard functionality
    function loadDashboardData(data = null, end_timestamp = null) {
        function updateTodayOverview(allLinesData) {
            // Get today's date string (YYYY-MM-DD), timezone aware (local time)
            const today = new Date();
            const pad = n => n.toString().padStart(2, '0');
            const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
            const afkTimerSeconds = window.statsConfig ? window.statsConfig.afkTimerSeconds : 120;
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
                        currentSession.endTime = ts + afkTimerSeconds;
                        currentSession.totalChars += chars;
                        currentSession.lines.push(line);
                        if (lastTimestamp !== null) {
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
            // console.log(sessionDetails);
            window.todaySessionDetails = sessionDetails;

            // Calculate total reading time (reuse AFK logic from calculateHeatmapStreaks)
            let totalSeconds = 0;
            const timestamps = todayLines
                .map(l => parseFloat(l.timestamp))
                .filter(ts => !isNaN(ts))
                .sort((a, b) => a - b);
            // Get AFK timer from settings modal if available
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
            const afkTimerSeconds = window.statsConfig ? window.statsConfig.afkTimerSeconds : 120;
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
                        currentSession.endTime = ts + afkTimerSeconds;
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

    // Helper function to extract and format domain names from URLs
    function extractDomainName(url) {
        if (!url) return 'Link';
        
        try {
            // Parse the URL
            const urlObj = new URL(url);
            let domain = urlObj.hostname;
            
            // Remove 'www.' prefix if present
            domain = domain.replace(/^www\./, '');
            
            // Map common domains to friendly names
            const domainMap = {
                'vndb.org': 'VNDB',
                'myanimelist.net': 'MAL',
                'anilist.co': 'AniList',
                'anime-planet.com': 'Anime-Planet',
                'kitsu.io': 'Kitsu',
                'anidb.net': 'AniDB',
                'mangaupdates.com': 'MangaUpdates',
                'novelupdates.com': 'NovelUpdates',
                'wikipedia.org': 'Wikipedia',
                'fandom.com': 'Fandom',
                'steam.com': 'Steam',
                'steampowered.com': 'Steam',
                'gog.com': 'GOG',
                'epicgames.com': 'Epic Games',
                'nintendo.com': 'Nintendo',
                'playstation.com': 'PlayStation',
                'xbox.com': 'Xbox'
            };
            
            // Check if we have a friendly name for this domain
            if (domainMap[domain]) {
                return domainMap[domain];
            }
            
            // Otherwise, capitalize the main domain name
            const parts = domain.split('.');
            if (parts.length >= 2) {
                // Get the second-to-last part (e.g., 'example' from 'example.com')
                const mainPart = parts[parts.length - 2];
                return mainPart.charAt(0).toUpperCase() + mainPart.slice(1);
            }
            
            return domain;
        } catch (e) {
            // If URL parsing fails, return a generic label
            return 'Link';
        }
    }

    function updateCurrentGameDashboard(stats) {
        if (!stats) {
            showNoDashboardData('currentGameCard', 'No current game data available');
            return;
        }

        // Update subtitle only (remove game name display)
        document.getElementById('currentGameName').textContent = '';

        // Always show game metadata section
        const gameContentGrid = document.getElementById('gameContentGrid');
        const gamePhotoSection = document.getElementById('gamePhotoSection');
        const gamePhoto = document.getElementById('gamePhoto');
        
        // Always display the content grid
        gameContentGrid.style.display = 'flex';
        
        // Update game photo with proper error handling
        console.log('[DEBUG] Game photo data:', {
            hasImage: !!stats.image,
            imageLength: stats.image ? stats.image.length : 0,
            imagePrefix: stats.image ? stats.image.substring(0, 50) : 'none',
            imageTrimmed: stats.image ? stats.image.trim().substring(0, 50) : 'none'
        });
        
        if (stats.image && stats.image.trim()) {
            let imageSrc = stats.image.trim();
            
            // Check if it's a base64 image or URL
            if (imageSrc.startsWith('data:image')) {
                console.log('[DEBUG] Setting base64 image with data URI');
                gamePhoto.src = imageSrc;
                gamePhotoSection.style.display = 'block';
                gamePhoto.style.display = 'block';
            } else if (imageSrc.startsWith('http')) {
                console.log('[DEBUG] Setting URL image:', imageSrc);
                gamePhoto.src = imageSrc;
                gamePhotoSection.style.display = 'block';
                gamePhoto.style.display = 'block';
            } else if (imageSrc.startsWith('/9j/') || imageSrc.startsWith('iVBOR')) {
                // Raw base64 data without data URI prefix - add it
                // /9j/ is JPEG, iVBOR is PNG
                const mimeType = imageSrc.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
                imageSrc = `data:${mimeType};base64,${imageSrc}`;
                console.log('[DEBUG] Added data URI prefix to raw base64 data');
                gamePhoto.src = imageSrc;
                gamePhotoSection.style.display = 'block';
                gamePhoto.style.display = 'block';
            } else {
                // Invalid image format, hide photo section
                console.log('[DEBUG] Invalid image format, hiding photo section');
                gamePhotoSection.style.display = 'none';
            }
        } else {
            console.log('[DEBUG] No image data, hiding photo section');
            gamePhotoSection.style.display = 'none';
        }
            
            // Update game titles
            const titleOriginal = document.getElementById('gameTitleOriginal');
            const titleRomaji = document.getElementById('gameTitleRomaji');
            const titleEnglish = document.getElementById('gameTitleEnglish');
            
            if (stats.title_original) {
                titleOriginal.textContent = stats.title_original;
                titleOriginal.style.display = 'block';
            } else {
                titleOriginal.style.display = 'none';
            }
            
            if (stats.title_romaji) {
                titleRomaji.textContent = stats.title_romaji;
                titleRomaji.style.display = 'block';
            } else {
                titleRomaji.style.display = 'none';
            }
            
            if (stats.title_english) {
                titleEnglish.textContent = stats.title_english;
                titleEnglish.style.display = 'block';
            } else {
                titleEnglish.style.display = 'none';
            }
            
            // Update game type badge
            const typeBadge = document.getElementById('gameTypeBadge');
            if (stats.type) {
                typeBadge.textContent = stats.type;
                typeBadge.style.display = 'inline-block';
            } else {
                typeBadge.style.display = 'none';
            }
            
            // Update game description
            const description = document.getElementById('gameDescription');
            const expandBtn = document.getElementById('descriptionExpandBtn');
            if (stats.description) {
                description.textContent = stats.description;
                // Show expand button if description is long (more than ~150 characters)
                if (stats.description.length > 150) {
                    expandBtn.style.display = 'block';
                } else {
                    expandBtn.style.display = 'none';
                }
            } else {
                description.textContent = '';
                expandBtn.style.display = 'none';
            }
            
            // Update game links
            const linksContainer = document.getElementById('gameLinksContainer');
            const linksPills = document.getElementById('gameLinksPills');
            if (stats.links && stats.links.length > 0) {
                // Clear existing pills
                linksPills.innerHTML = '';
                
                // Create a pill for each link
                stats.links.forEach(link => {
                    if (link.url) {
                        const pill = document.createElement('a');
                        pill.href = link.url;
                        pill.target = '_blank';
                        pill.rel = 'noopener noreferrer';
                        pill.className = 'game-link-pill';
                        pill.textContent = extractDomainName(link.url);
                        linksPills.appendChild(pill);
                    }
                });
                
                // Show the links container
                linksContainer.style.display = 'flex';
            } else {
                // Hide the links container if no links
                linksContainer.style.display = 'none';
            }
            
            // Update progress bar and timeline
            const progressContainer = document.getElementById('gameProgressContainer');
            if (stats.game_character_count > 0) {
                const percentage = stats.progress_percentage || 0;
                document.getElementById('gameProgressPercentage').textContent = Math.floor(percentage) + '%';
                document.getElementById('gameProgressFill').style.width = percentage + '%';
                
                // Update timeline dates
                updateProgressTimeline(stats);
                
                progressContainer.style.display = 'block';
            } else {
                progressContainer.style.display = 'none';
            }
            
            // Update estimated time left stat
            updateEstimatedTimeLeft(stats);

        // Update main statistics
        document.getElementById('currentTotalChars').textContent = stats.total_characters_formatted;
        document.getElementById('currentTotalTime').textContent = stats.total_time_formatted;
        document.getElementById('currentReadingSpeed').textContent = stats.reading_speed_formatted;

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
    
    // Description expand/collapse functionality
    const descriptionExpandBtn = document.getElementById('descriptionExpandBtn');
    if (descriptionExpandBtn) {
        descriptionExpandBtn.addEventListener('click', function() {
            const description = document.getElementById('gameDescription');
            const expandText = this.querySelector('.expand-text');
            const collapseText = this.querySelector('.collapse-text');
            
            if (description.classList.contains('expanded')) {
                // Collapse
                description.classList.remove('expanded');
                expandText.style.display = 'inline';
                collapseText.style.display = 'none';
            } else {
                // Expand
                description.classList.add('expanded');
                expandText.style.display = 'none';
                collapseText.style.display = 'inline';
            }
        });
    }
});