// Overview Page JavaScript
// Dependencies: shared.js (provides utility functions like showElement, hideElement, escapeHtml)

// ============================================================================
// PERFORMANCE OPTIMIZATION: Cache frequently accessed DOM elements
// ============================================================================
const DOM_CACHE = {
    // Dashboard cards
    currentGameCard: null,
    allGamesCard: null,
    todayOverviewCard: null,
    
    // Current game elements
    currentGameName: null,
    currentTotalChars: null,
    currentTotalTime: null,
    currentReadingSpeed: null,
    currentEstimatedTimeLeft: null,
    currentGameStreak: null,
    currentStreakValue: null,
    gameCompletionBtn: null,
    
    // Session elements
    currentSessionTotalHours: null,
    currentSessionTotalChars: null,
    currentSessionStartTime: null,
    currentSessionEndTime: null,
    currentSessionCharsPerHour: null,
    
    // Game metadata elements
    gameContentGrid: null,
    gamePhotoSection: null,
    gamePhoto: null,
    gameTitleOriginal: null,
    gameTitleRomaji: null,
    gameTitleEnglish: null,
    gameTypeBadge: null,
    gameDescription: null,
    descriptionExpandBtn: null,
    gameLinksContainer: null,
    gameLinksPills: null,
    gameProgressContainer: null,
    gameProgressPercentage: null,
    gameProgressFill: null,
    gameStartDate: null,
    gameEstimatedEndDate: null,
    
    // Today's overview elements
    todayDate: null,
    todayTotalHours: null,
    todayTotalChars: null,
    todaySessions: null,
    todayCharsPerHour: null,
    
    // All games elements
    totalGamesCount: null,
    allTotalChars: null,
    allTotalTime: null,
    allReadingSpeed: null,
    allSessions: null,
    allUniqueGames: null,
    allTotalSentences: null,
    allGamesStreak: null,
    allStreakValue: null,
    
    // Loading/error states
    dashboardLoading: null,
    dashboardError: null,
    
    // Heatmap
    heatmapContainer: null,
    
    // Session navigation
    prevSessionBtn: null,
    nextSessionBtn: null,
    deleteSessionBtn: null,
    
    // Initialize all cached references
    init() {
        // Dashboard cards
        this.currentGameCard = document.getElementById('currentGameCard');
        this.allGamesCard = document.getElementById('allGamesCard');
        this.todayOverviewCard = document.getElementById('todayOverviewCard');
        
        // Current game elements
        this.currentGameName = document.getElementById('currentGameName');
        this.currentTotalChars = document.getElementById('currentTotalChars');
        this.currentTotalTime = document.getElementById('currentTotalTime');
        this.currentReadingSpeed = document.getElementById('currentReadingSpeed');
        this.currentEstimatedTimeLeft = document.getElementById('currentEstimatedTimeLeft');
        this.currentGameStreak = document.getElementById('currentGameStreak');
        this.currentStreakValue = document.getElementById('currentStreakValue');
        this.gameCompletionBtn = document.getElementById('gameCompletionBtn');
        
        // Session elements
        this.currentSessionTotalHours = document.getElementById('currentSessionTotalHours');
        this.currentSessionTotalChars = document.getElementById('currentSessionTotalChars');
        this.currentSessionStartTime = document.getElementById('currentSessionStartTime');
        this.currentSessionEndTime = document.getElementById('currentSessionEndTime');
        this.currentSessionCharsPerHour = document.getElementById('currentSessionCharsPerHour');
        
        // Game metadata elements
        this.gameContentGrid = document.getElementById('gameContentGrid');
        this.gamePhotoSection = document.getElementById('gamePhotoSection');
        this.gamePhoto = document.getElementById('gamePhoto');
        this.gameTitleOriginal = document.getElementById('gameTitleOriginal');
        this.gameTitleRomaji = document.getElementById('gameTitleRomaji');
        this.gameTitleEnglish = document.getElementById('gameTitleEnglish');
        this.gameTypeBadge = document.getElementById('gameTypeBadge');
        this.gameDescription = document.getElementById('gameDescription');
        this.descriptionExpandBtn = document.getElementById('descriptionExpandBtn');
        this.gameLinksContainer = document.getElementById('gameLinksContainer');
        this.gameLinksPills = document.getElementById('gameLinksPills');
        this.gameProgressContainer = document.getElementById('gameProgressContainer');
        this.gameProgressPercentage = document.getElementById('gameProgressPercentage');
        this.gameProgressFill = document.getElementById('gameProgressFill');
        this.gameStartDate = document.getElementById('gameStartDate');
        this.gameEstimatedEndDate = document.getElementById('gameEstimatedEndDate');
        
        // Today's overview elements
        this.todayDate = document.getElementById('todayDate');
        this.todayTotalHours = document.getElementById('todayTotalHours');
        this.todayTotalChars = document.getElementById('todayTotalChars');
        this.todaySessions = document.getElementById('todaySessions');
        this.todayCharsPerHour = document.getElementById('todayCharsPerHour');
        
        // All games elements
        this.totalGamesCount = document.getElementById('totalGamesCount');
        this.allTotalChars = document.getElementById('allTotalChars');
        this.allTotalTime = document.getElementById('allTotalTime');
        this.allReadingSpeed = document.getElementById('allReadingSpeed');
        this.allSessions = document.getElementById('allSessions');
        this.allUniqueGames = document.getElementById('allUniqueGames');
        this.allTotalSentences = document.getElementById('allTotalSentences');
        this.allGamesStreak = document.getElementById('allGamesStreak');
        this.allStreakValue = document.getElementById('allStreakValue');
        
        // Loading/error states
        this.dashboardLoading = document.getElementById('dashboardLoading');
        this.dashboardError = document.getElementById('dashboardError');
        
        // Heatmap
        this.heatmapContainer = document.getElementById('heatmapContainer');
        
        // Session navigation
        this.prevSessionBtn = document.querySelector('.prev-session-btn');
        this.nextSessionBtn = document.querySelector('.next-session-btn');
        this.deleteSessionBtn = document.querySelector('.delete-session-btn');
    }
};

// ============================================================================
// PERFORMANCE OPTIMIZATION: Cache API responses to avoid redundant fetches
// ============================================================================
const API_CACHE = {
    statsData: null,
    statsDataTimestamp: null,
    CACHE_DURATION: 5000, // 5 seconds cache
    
    setStatsData(data) {
        this.statsData = data;
        this.statsDataTimestamp = Date.now();
    },
    
    getStatsData() {
        if (!this.statsData || !this.statsDataTimestamp) {
            return null;
        }
        // Check if cache is still valid
        if (Date.now() - this.statsDataTimestamp > this.CACHE_DURATION) {
            this.statsData = null;
            this.statsDataTimestamp = null;
            return null;
        }
        return this.statsData;
    },
    
    clearStatsData() {
        this.statsData = null;
        this.statsDataTimestamp = null;
    }
};

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
    // Initialize DOM cache
    DOM_CACHE.init();
    
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
        
        // Helper function to format average time
        const formatAvgTime = (avgHours) => {
            if (avgHours < 1) {
                const minutes = Math.round(avgHours * 60);
                return `${minutes}m`;
            } else {
                const hours = Math.floor(avgHours);
                const minutes = Math.round((avgHours - hours) * 60);
                return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
            }
        };

        // Calculate average daily time for this year, last 30 days, and last 7 days
        let avgDailyTime = "-";
        let avgDaily30 = "-";
        let avgDaily7 = "-";
        
        if (allLinesForYear && allLinesForYear.length > 0) {
            // Check if we have pre-calculated reading time from rollup data
            const hasReadingTimeData = allLinesForYear.some(line => line.reading_time_seconds !== undefined);
            
            // Get date ranges
            const now = new Date();
            const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
            const sevenDaysAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
            
            if (hasReadingTimeData) {
                // Use pre-calculated reading time from rollup data (FAST!)
                let totalHours = 0;
                let activeDays = 0;
                let totalHours30 = 0;
                let activeDays30 = 0;
                let totalHours7 = 0;
                let activeDays7 = 0;
                
                for (const line of allLinesForYear) {
                    if (line.reading_time_seconds !== undefined && line.reading_time_seconds > 0) {
                        const hours = line.reading_time_seconds / 3600;
                        
                        // All year
                        totalHours += hours;
                        activeDays++;
                        
                        // Parse the date from the line (assuming line has a date field)
                        // If not, we'll need to use timestamp
                        let lineDate;
                        if (line.date) {
                            lineDate = new Date(line.date);
                        } else if (line.timestamp) {
                            lineDate = new Date(parseFloat(line.timestamp) * 1000);
                        }
                        
                        if (lineDate) {
                            // Last 30 days
                            if (lineDate >= thirtyDaysAgo) {
                                totalHours30 += hours;
                                activeDays30++;
                            }
                            
                            // Last 7 days
                            if (lineDate >= sevenDaysAgo) {
                                totalHours7 += hours;
                                activeDays7++;
                            }
                        }
                    }
                }
                
                if (activeDays > 0) {
                    avgDailyTime = formatAvgTime(totalHours / activeDays);
                }
                if (activeDays30 > 0) {
                    avgDaily30 = formatAvgTime(totalHours30 / activeDays30);
                }
                if (activeDays7 > 0) {
                    avgDaily7 = formatAvgTime(totalHours7 / activeDays7);
                }
            } else {
                // Fallback: Calculate from individual timestamps (for today's data)
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
                let totalHours30 = 0;
                let activeDays30 = 0;
                let totalHours7 = 0;
                let activeDays7 = 0;
                let afkTimerSeconds = window.statsConfig ? window.statsConfig.afkTimerSeconds : 120;

                for (const [dateStr, timestamps] of Object.entries(dailyTimestamps)) {
                    let dayReadingTime = 0;
                    
                    if (timestamps.length >= 2) {
                        timestamps.sort((a, b) => a - b);

                        for (let i = 1; i < timestamps.length; i++) {
                            const gap = timestamps[i] - timestamps[i-1];
                            dayReadingTime += Math.min(gap, afkTimerSeconds);
                        }
                    } else if (timestamps.length === 1) {
                        // Single timestamp - count as minimal activity (1 second)
                        dayReadingTime = 1;
                    }

                    if (dayReadingTime > 0) {
                        const dayHours = dayReadingTime / 3600;
                        const dayDate = new Date(dateStr);
                        
                        // All year
                        totalHours += dayHours;
                        activeDays++;
                        
                        // Last 30 days
                        if (dayDate >= thirtyDaysAgo) {
                            totalHours30 += dayHours;
                            activeDays30++;
                        }
                        
                        // Last 7 days
                        if (dayDate >= sevenDaysAgo) {
                            totalHours7 += dayHours;
                            activeDays7++;
                        }
                    }
                }
                
                if (activeDays > 0) {
                    avgDailyTime = formatAvgTime(totalHours / activeDays);
                }
                if (activeDays30 > 0) {
                    avgDaily30 = formatAvgTime(totalHours30 / activeDays30);
                }
                if (activeDays7 > 0) {
                    avgDaily7 = formatAvgTime(totalHours7 / activeDays7);
                }
            }
        }
        console.log({ longestStreak, currentStreak, avgDaily: avgDailyTime, avgDaily30, avgDaily7 })
        
        return { longestStreak, currentStreak, avgDaily: avgDailyTime, avgDaily30, avgDaily7 };
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
    function loadStatsData() {
        let url = '/api/stats';
        
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
                loadDashboardData(data);

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
        const currentGames = allGamesStats.completed_games || 0;
        
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

    // Session navigation button handlers
    const prevSessionBtn = document.querySelector('.prev-session-btn');
    const nextSessionBtn = document.querySelector('.next-session-btn');
    const deleteSessionBtn = document.querySelector('.delete-session-btn');

    function updateSessionNavigationButtons() {
        if (!window.todaySessionDetails || window.todaySessionDetails.length === 0) {
            // Keep buttons visible but disabled when no sessions
            prevSessionBtn.disabled = true;
            nextSessionBtn.disabled = true;
            deleteSessionBtn.disabled = true;
            return;
        }
        // Enable/disable based on navigation state
        prevSessionBtn.disabled = window.currentSessionIndex <= 0;
        nextSessionBtn.disabled = window.currentSessionIndex >= window.todaySessionDetails.length - 1;
        deleteSessionBtn.disabled = false;
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

        // Confirm deletion with clear warning
        const confirmMsg = `All session data will be deleted.\n\nSession: ${new Date(sessionToDelete.startTime * 1000).toLocaleString()}\nLines: ${sessionToDelete.lines.length}\n\nThis action cannot be undone. Continue?`;
        if (!confirm(confirmMsg)) return;

        // Call the delete function
        deleteSession(sessionToDelete);
    });

    loadStatsData();

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
        const estimatedTimeLeftBox = estimatedTimeLeftEl.closest('.dashboard-stat-item');
        
        if (!stats.game_character_count || stats.game_character_count <= 0 ||
            !stats.total_characters || stats.total_characters <= 0 ||
            !stats.reading_speed || stats.reading_speed <= 0) {
            // Hide the entire stat box when we can't calculate estimated time
            if (estimatedTimeLeftBox) {
                estimatedTimeLeftBox.style.display = 'none';
            }
            return;
        }
        
        // Show the stat box if it was hidden
        if (estimatedTimeLeftBox) {
            estimatedTimeLeftBox.style.display = '';
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
            // No current session - clear session stats
            const sessionHoursEl = document.getElementById('currentSessionTotalHours');
            const sessionCharsEl = document.getElementById('currentSessionTotalChars');
            const sessionStartEl = document.getElementById('currentSessionStartTime');
            const sessionEndEl = document.getElementById('currentSessionEndTime');
            const sessionSpeedEl = document.getElementById('currentSessionCharsPerHour');
            
            if (sessionHoursEl) sessionHoursEl.textContent = '-';
            if (sessionCharsEl) sessionCharsEl.textContent = '-';
            if (sessionStartEl) sessionStartEl.textContent = '-';
            if (sessionEndEl) sessionEndEl.textContent = '-';
            if (sessionSpeedEl) sessionSpeedEl.textContent = '-';
            return;
        }

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
        
        // Update Session Chars with native tooltip
        const sessionCharsEl = document.getElementById('currentSessionTotalChars');
        const sessionCharsBox = sessionCharsEl.closest('.dashboard-stat-item');
        sessionCharsEl.textContent = Math.round(lastSession.totalChars).toLocaleString();
        if (sessionCharsBox) {
            sessionCharsBox.setAttribute('title', `${lastSession.totalChars.toLocaleString(undefined, {maximumFractionDigits: 2})} characters`);
        }
        
        document.getElementById('currentSessionStartTime').textContent = startTimeDisplay;
        document.getElementById('currentSessionEndTime').textContent = endTimeDisplay;
        
        // Update Session Chars/Hour with native tooltip
        const sessionSpeedEl = document.getElementById('currentSessionCharsPerHour');
        const sessionSpeedBox = sessionSpeedEl.closest('.dashboard-stat-item');
        sessionSpeedEl.textContent = lastSession.charsPerHour > 0 ? Math.round(lastSession.charsPerHour).toLocaleString() : '-';
        if (sessionSpeedBox && lastSession.charsPerHour > 0) {
            sessionSpeedBox.setAttribute('title', `${lastSession.charsPerHour.toLocaleString(undefined, {maximumFractionDigits: 2})} chars/hour`);
        }

        // Render game metadata if available
        renderSessionGameMetadata(lastSession);
    }

    function renderSessionGameMetadata(session) {
        const gameContentGrid = document.getElementById('gameContentGrid');
        const noGameDataMessage = document.getElementById('noGameDataMessage');
        const noGameDataTitle = document.getElementById('noGameDataTitle');
        const gameMetadata = session.gameMetadata;
        
        // Check if we have meaningful game data (image or description)
        const hasImage = gameMetadata && gameMetadata.image && gameMetadata.image.trim();
        const hasDescription = gameMetadata && gameMetadata.description && gameMetadata.description.trim();
        const hasManualOverrides = !!(gameMetadata && gameMetadata.manual_overrides && gameMetadata.manual_overrides.length > 0);
        
        // Show message if: no metadata OR (no image AND no description AND no manual overrides)
        if (!gameMetadata || (!hasImage && !hasDescription && !hasManualOverrides)) {
            if (gameContentGrid) {
                gameContentGrid.style.display = 'none';
            }
            if (noGameDataMessage) {
                // Set the game title in the message
                if (noGameDataTitle && session.gameName) {
                    noGameDataTitle.textContent = session.gameName;
                }
                noGameDataMessage.style.display = 'block';
            }
            return;
        }

        // Hide the message and show the game content grid
        if (noGameDataMessage) {
            noGameDataMessage.style.display = 'none';
        }
        if (gameContentGrid) {
            gameContentGrid.style.display = 'flex';
        }

        // Clear existing content
        const gamePhotoSection = document.getElementById('gamePhotoSection');
        const gamePhoto = document.getElementById('gamePhoto');
        const gameTitleOriginal = document.getElementById('gameTitleOriginal');
        const gameTitleRomaji = document.getElementById('gameTitleRomaji');
        const gameTitleEnglish = document.getElementById('gameTitleEnglish');
        const gameTypeBadge = document.getElementById('gameTypeBadge');
        const gameDescription = document.getElementById('gameDescription');
        const descriptionExpandBtn = document.getElementById('descriptionExpandBtn');
        const gameLinksContainer = document.getElementById('gameLinksContainer');
        const gameLinksPills = document.getElementById('gameLinksPills');

        // Update photo - all images are now stored as PNG base64
        if (gameMetadata.image && gameMetadata.image.trim()) {
            let imageSrc = gameMetadata.image.trim();
            
            // Handle different image formats
            if (imageSrc.startsWith('data:image')) {
                // Already has data URI prefix
                gamePhoto.src = imageSrc;
            } else if (imageSrc.startsWith('http')) {
                // External URL
                gamePhoto.src = imageSrc;
            } else {
                // Raw base64 data - add PNG data URI prefix (all uploads are converted to PNG)
                gamePhoto.src = `data:image/png;base64,${imageSrc}`;
            }
            
            gamePhotoSection.style.display = 'block';
            gamePhoto.style.display = 'block';
        } else {
            gamePhotoSection.style.display = 'none';
        }

        // Update titles
        if (gameMetadata.title_original) {
            gameTitleOriginal.textContent = gameMetadata.title_original;
            gameTitleOriginal.style.display = 'block';
        } else {
            gameTitleOriginal.style.display = 'none';
        }
        
        if (gameMetadata.title_romaji) {
            gameTitleRomaji.textContent = gameMetadata.title_romaji;
            gameTitleRomaji.style.display = 'block';
        } else {
            gameTitleRomaji.style.display = 'none';
        }
        
        if (gameMetadata.title_english) {
            gameTitleEnglish.textContent = gameMetadata.title_english;
            gameTitleEnglish.style.display = 'block';
        } else {
            gameTitleEnglish.style.display = 'none';
        }

        // Update type badge
        if (gameMetadata.type) {
            gameTypeBadge.textContent = gameMetadata.type;
            gameTypeBadge.style.display = 'inline-block';
        } else {
            gameTypeBadge.style.display = 'none';
        }

        // Update description
        if (gameMetadata.description) {
            gameDescription.textContent = gameMetadata.description;
            gameDescription.classList.remove('expanded');
            
            // Show/hide expand button based on description length
            if (gameMetadata.description.length > 150) {
                descriptionExpandBtn.style.display = 'block';
                const expandText = descriptionExpandBtn.querySelector('.expand-text');
                const collapseText = descriptionExpandBtn.querySelector('.collapse-text');
                if (expandText) expandText.style.display = 'inline';
                if (collapseText) collapseText.style.display = 'none';
            } else {
                descriptionExpandBtn.style.display = 'none';
            }
        } else {
            gameDescription.textContent = '';
            descriptionExpandBtn.style.display = 'none';
        }

        // Update links
        if (gameMetadata.links && gameMetadata.links.length > 0) {
            gameLinksPills.innerHTML = '';
            
            gameMetadata.links.forEach(link => {
                if (link.url) {
                    const pill = document.createElement('a');
                    pill.href = link.url;
                    pill.target = '_blank';
                    pill.rel = 'noopener noreferrer';
                    pill.className = 'game-link-pill';
                    pill.textContent = extractDomainName(link.url);
                    gameLinksPills.appendChild(pill);
                }
            });
            
            gameLinksContainer.style.display = 'flex';
        } else {
            gameLinksContainer.style.display = 'none';
        }
    }

    // Function to load today's stats from new API endpoint
    function loadTodayStats() {
        fetch('/api/today-stats')
            .then(response => response.json())
            .then(data => {
                // Update today's total hours
                const totalHours = data.todayTotalHours || 0;
                let hoursDisplay = '-';
                if (totalHours > 0) {
                    const h = Math.floor(totalHours);
                    const m = Math.round((totalHours - h) * 60);
                    hoursDisplay = h > 0 ? `${h}h${m > 0 ? ' ' + m + 'm' : ''}` : `${m}m`;
                }
                document.getElementById('todayTotalHours').textContent = hoursDisplay;
                
                // Update today's total characters with native tooltip
                const todayCharsEl = document.getElementById('todayTotalChars');
                const todayCharsBox = todayCharsEl.closest('.dashboard-stat-item');
                todayCharsEl.textContent = data.todayTotalChars.toLocaleString();
                if (todayCharsBox) {
                    todayCharsBox.setAttribute('title', `${data.todayTotalChars.toLocaleString(undefined, {maximumFractionDigits: 2})} characters`);
                }
                
                // Update today's sessions count
                document.getElementById('todaySessions').textContent = data.todaySessions || 0;
                
                // Update today's chars/hour with native tooltip
                const todaySpeedEl = document.getElementById('todayCharsPerHour');
                const todaySpeedBox = todaySpeedEl.closest('.dashboard-stat-item');
                todaySpeedEl.textContent = data.todayCharsPerHour > 0 ? data.todayCharsPerHour.toLocaleString() : '-';
                if (todaySpeedBox && data.todayCharsPerHour > 0) {
                    todaySpeedBox.setAttribute('title', `${data.todayCharsPerHour.toLocaleString(undefined, {maximumFractionDigits: 2})} chars/hour`);
                }
                
                // Store sessions globally for navigation
                window.todaySessionDetails = data.sessions || [];
                
                // Show the latest session (most recent)
                if (window.todaySessionDetails.length > 0) {
                    showSessionAtIndex(window.todaySessionDetails.length - 1);
                } else {
                    // No sessions - clear session displays
                    document.getElementById('currentSessionTotalChars').textContent = '0';
                    document.getElementById('currentSessionCharsPerHour').textContent = '-';
                }
                
                // Update session navigation buttons
                updateSessionNavigationButtons();
            })
            .catch(error => {
                console.error('Error fetching today\'s stats:', error);
                // Set default values on error
                document.getElementById('todayTotalHours').textContent = '-';
                document.getElementById('todayTotalChars').textContent = '0';
                document.getElementById('todaySessions').textContent = '0';
                document.getElementById('todayCharsPerHour').textContent = '-';
                document.getElementById('currentSessionTotalChars').textContent = '0';
                document.getElementById('currentSessionCharsPerHour').textContent = '-';
            });
    }

    // Dashboard functionality
    function loadDashboardData(data = null) {
        function updateOverviewForEndDay(allLinesData) {
            const pad = n => n.toString().padStart(2, '0');

            // Determine target date string (YYYY-MM-DD) from the end timestamp
            const endDateObj = new Date();
            const targetDateStr = `${endDateObj.getFullYear()}-${pad(endDateObj.getMonth() + 1)}-${pad(endDateObj.getDate())}`;
            const afkTimerSeconds = window.statsConfig ? window.statsConfig.afkTimerSeconds : 120;
            document.getElementById('todayDate').textContent = targetDateStr;
            
            // Load today's stats from new API
            loadTodayStats();
            return; // Skip old calculation logic below

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
            updateOverviewForEndDay(data.allLinesData);
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
                        
                        // Always fetch today's data live (don't use rollup data for today)
  
                    if (data.allLinesData) {
                        updateOverviewForEndDay(data.allLinesData);
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
                'store.steampowered.com': 'Steam',
                "Itch.io": "Itch.io",
                'gog.com': 'GOG',
                'epicgames.com': 'Epic Games',
                'nintendo.com': 'Nintendo',
                'playstation.com': 'PlayStation',
                'xbox.com': 'Xbox',
                'crunchyroll.com': 'Crunchyroll',
                'hidive.com': 'HIDIVE',
                'funimation.com': 'Funimation',
                'animenewsnetwork.com': 'ANN',
                'tvdb.com': 'TheTVDB',
                'themoviedb.org': 'TMDB',
                'imdb.com': 'IMDb',
                'letterboxd.com': 'Letterboxd',
                'goodreads.com': 'Goodreads',
                'bookwalker.jp': 'BookWalker',
                'dlsite.com': 'DLsite',
                'jlist.com': 'J-List',
                'getchu.com': 'Getchu',
                'erogamescape.dyndns.org': 'ErogameScape',
                'itch.io': 'Itch.io',
                'gamejolt.com': 'Game Jolt',
                'mobygames.com': 'MobyGames',
                'giantbomb.com': 'GiantBomb',
                'howlongtobeat.com': 'HowLongToBeat',
                'backloggd.com': 'Backloggd',
                'vndb.org': 'VNDB',
                'mangadex.org': 'MangaDex',
                'animeuknews.net': 'Anime UK News',
                'mydramalist.com': 'MyDramaList',
                'metacritic.com': 'Metacritic',
                'opencritic.com': 'OpenCritic',
                'itch.io': 'Itch.io',
                'indiedb.com': 'IndieDB',
                'moddb.com': 'ModDB',
                'romhacking.net': 'Romhacking',
                'nexusmods.com': 'Nexus Mods',
                'archiveofourown.org': 'AO3',
                'fanfiction.net': 'FanFiction.net',
                'tumblr.com': 'Tumblr',
                'pixiv.net': 'Pixiv',
                'deviantart.com': 'DeviantArt',
                'booth.pm': 'BOOTH',
                'patreon.com': 'Patreon',
                'kickstarter.com': 'Kickstarter'
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

        // Update subtitle with game name only if title_original is not set
        // (If title_original exists, it will be shown in the game content grid instead)
        const currentGameNameEl = document.getElementById('currentGameName');
        if (stats.title_original && stats.title_original.trim()) {
            // Hide subtitle when we have a proper title in the game content grid
            currentGameNameEl.style.display = 'none';
        } else {
            // Show game name in subtitle when no title_original is available
            const gameName = stats.game_name || 'Unknown Game';
            currentGameNameEl.textContent = gameName;
            currentGameNameEl.style.display = 'block';
        }
        
        // Handle completion button visibility and state
        const completionBtn = document.getElementById('gameCompletionBtn');
        const currentGameCard = document.getElementById('currentGameCard');
        
        if (completionBtn) {
            const completion = stats.progress_percentage || 0;
            const isCompleted = stats.completed || false;
            const hasCharacterCount = stats.game_character_count && stats.game_character_count > 0;
            
            if (isCompleted) {
                // Game is already completed - show completed state
                completionBtn.textContent = 'Completed ✓';
                completionBtn.disabled = true;
                completionBtn.classList.add('completed');
                completionBtn.style.display = 'inline-block';
                currentGameCard.classList.add('completed');
            } else if (!hasCharacterCount || completion >= 90) {
                // Show button if: no character count set OR game is ≥90% complete
                completionBtn.textContent = 'Mark as completed?';
                completionBtn.disabled = false;
                completionBtn.classList.remove('completed');
                completionBtn.style.display = 'inline-block';
                currentGameCard.classList.remove('completed');
            } else {
                // Game has character count and is <90% complete - hide button
                completionBtn.style.display = 'none';
                currentGameCard.classList.remove('completed');
            }
        }

        // Check if we have meaningful game data
        const gameContentGrid = document.getElementById('gameContentGrid');
        const noGameDataMessage = document.getElementById('noGameDataMessage');
        const gamePhotoSection = document.getElementById('gamePhotoSection');
        const gamePhoto = document.getElementById('gamePhoto');
        
        // Check if we have meaningful game data (image or description)
        const hasImage = stats.image && stats.image.trim();
        const hasDescription = stats.description && stats.description.trim();
        const hasManualOverrides = !!(stats.manual_overrides && stats.manual_overrides.length > 0);
        
        // Show message if: no image AND no description AND no manual overrides
        // (If user has manually edited ANY field, don't show the message)
        if (!hasImage && !hasDescription && !hasManualOverrides) {
            if (gameContentGrid) {
                gameContentGrid.style.display = 'none';
            }
            if (noGameDataMessage) {
                // Set the game title in the message
                const noGameDataTitle = document.getElementById('noGameDataTitle');
                if (noGameDataTitle) {
                    const gameTitle = stats.title_original || stats.game_name || 'Game';
                    noGameDataTitle.textContent = gameTitle;
                }
                noGameDataMessage.style.display = 'block';
            }
        } else {
            // Hide the message and display the content grid
            if (noGameDataMessage) {
                noGameDataMessage.style.display = 'none';
            }
            gameContentGrid.style.display = 'flex';
        }
        
        // Update game photo - all images are now stored as PNG base64
        if (stats.image && stats.image.trim()) {
            let imageSrc = stats.image.trim();
            
            // Handle different image formats
            if (imageSrc.startsWith('data:image')) {
                // Already has data URI prefix
                gamePhoto.src = imageSrc;
            } else if (imageSrc.startsWith('http')) {
                // External URL
                gamePhoto.src = imageSrc;
            } else {
                // Raw base64 data - add PNG data URI prefix (all uploads are converted to PNG)
                gamePhoto.src = `data:image/png;base64,${imageSrc}`;
            }
            
            gamePhotoSection.style.display = 'block';
            gamePhoto.style.display = 'block';
        } else {
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

        // Update main statistics with native tooltips
        const currentTotalCharsEl = document.getElementById('currentTotalChars');
        const currentTotalCharsBox = currentTotalCharsEl.closest('.dashboard-stat-item');
        currentTotalCharsEl.textContent = stats.total_characters_formatted;
        if (currentTotalCharsBox && stats.total_characters) {
            currentTotalCharsBox.setAttribute('title', `${stats.total_characters.toLocaleString(undefined, {maximumFractionDigits: 2})} characters`);
        }
        
        document.getElementById('currentTotalTime').textContent = stats.total_time_formatted;
        
        const currentReadingSpeedEl = document.getElementById('currentReadingSpeed');
        const currentReadingSpeedBox = currentReadingSpeedEl.closest('.dashboard-stat-item');
        currentReadingSpeedEl.textContent = stats.reading_speed_formatted;
        if (currentReadingSpeedBox && stats.reading_speed) {
            currentReadingSpeedBox.setAttribute('title', `${stats.reading_speed.toLocaleString(undefined, {maximumFractionDigits: 2})} chars/hour`);
        }

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
        const gamesText = stats.completed_games === 1 ? '1 game completed' : `${stats.completed_games} games completed`;
        document.getElementById('totalGamesCount').textContent = gamesText;

        // Update main statistics with native tooltips
        const allTotalCharsEl = document.getElementById('allTotalChars');
        const allTotalCharsBox = allTotalCharsEl.closest('.dashboard-stat-item');
        allTotalCharsEl.textContent = stats.total_characters_formatted;
        if (allTotalCharsBox && stats.total_characters) {
            allTotalCharsBox.setAttribute('title', `${stats.total_characters.toLocaleString(undefined, {maximumFractionDigits: 2})} characters`);
        }
        
        document.getElementById('allTotalTime').textContent = stats.total_time_formatted;
        
        const allReadingSpeedEl = document.getElementById('allReadingSpeed');
        const allReadingSpeedBox = allReadingSpeedEl.closest('.dashboard-stat-item');
        allReadingSpeedEl.textContent = stats.reading_speed_formatted;
        if (allReadingSpeedBox && stats.reading_speed) {
            allReadingSpeedBox.setAttribute('title', `${stats.reading_speed.toLocaleString(undefined, {maximumFractionDigits: 2})} chars/hour`);
        }
        
        document.getElementById('allSessions').textContent = stats.sessions.toLocaleString();

        // Update progress section (removed monthly characters)
        document.getElementById('allUniqueGames').textContent = stats.completed_games.toLocaleString();
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
    
    // Game completion button handler
    const gameCompletionBtn = document.getElementById('gameCompletionBtn');
    if (gameCompletionBtn) {
        gameCompletionBtn.addEventListener('click', async function() {
            // Don't do anything if already completed
            if (this.disabled) return;
            
            // Get the current game ID from the stats
            // We need to fetch current stats to get the game_id
            try {
                const response = await fetch('/api/stats');
                if (!response.ok) throw new Error('Failed to fetch stats');
                
                const data = await response.json();
                const currentGameStats = data.currentGameStats;
                
                if (!currentGameStats || !currentGameStats.game_name) {
                    console.error('No current game found');
                    return;
                }
                
                // Find the game_id by looking up the game
                // We need to get the game_id from the games management API
                const gamesResponse = await fetch('/api/games-management');
                if (!gamesResponse.ok) throw new Error('Failed to fetch games');
                
                const gamesData = await gamesResponse.json();
                const currentGame = gamesData.games.find(g =>
                    g.title_original === currentGameStats.game_name ||
                    g.title_original === currentGameStats.title_original
                );
                
                if (!currentGame) {
                    console.error('Could not find game ID for current game');
                    return;
                }
                
                // Confirm with user
                const confirmMsg = `Mark "${currentGame.title_original}" as completed?`;
                if (!confirm(confirmMsg)) return;
                
                // Call the API to mark as complete
                const markCompleteResponse = await fetch(`/api/games/${currentGame.id}/mark-complete`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                if (!markCompleteResponse.ok) {
                    const errorData = await markCompleteResponse.json();
                    throw new Error(errorData.error || 'Failed to mark game as complete');
                }
                
                const result = await markCompleteResponse.json();
                console.log('Game marked as complete:', result);
                
                // Trigger confetti celebration!
                if (typeof confetti !== 'undefined') {
                    // Fire confetti from multiple angles for a nice effect
                    const duration = 3000; // 3 seconds
                    const animationEnd = Date.now() + duration;
                    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 9999 };

                    function randomInRange(min, max) {
                        return Math.random() * (max - min) + min;
                    }

                    const interval = setInterval(function() {
                        const timeLeft = animationEnd - Date.now();

                        if (timeLeft <= 0) {
                            return clearInterval(interval);
                        }

                        const particleCount = 50 * (timeLeft / duration);
                        
                        // Fire confetti from left side
                        confetti({
                            ...defaults,
                            particleCount,
                            origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 }
                        });
                        
                        // Fire confetti from right side
                        confetti({
                            ...defaults,
                            particleCount,
                            origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 }
                        });
                    }, 250);
                }
                
                // Update button to completed state
                this.textContent = 'Completed ✓';
                this.disabled = true;
                this.classList.add('completed');
                
                // Add completed class to card
                const currentGameCard = document.getElementById('currentGameCard');
                if (currentGameCard) {
                    currentGameCard.classList.add('completed');
                }
                
                // Optionally refresh the dashboard to reflect changes
                setTimeout(() => {
                    loadDashboardData();
                }, 500);
                
            } catch (error) {
                console.error('Error marking game as complete:', error);
                alert(`Failed to mark game as complete: ${error.message}`);
            }
        });
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
            // Enable button whenever any file is selected
            if (file) {
                importExstaticBtn.disabled = false;
                importExstaticBtn.style.background = '#2980b9';
                importExstaticBtn.style.cursor = 'pointer';
                showImportStatus('', 'info', false);
            } else {
                importExstaticBtn.disabled = true;
                importExstaticBtn.style.background = '#666';
                importExstaticBtn.style.cursor = 'not-allowed';
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