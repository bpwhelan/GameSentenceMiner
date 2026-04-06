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

    // Learning history chart
    learningHistoryChart: null,
    learningHistoryChartWrap: null,
    learningHistorySummary: null,
    learningHistoryNoData: null,
    learningHistoryMatureWordsBtn: null,
    learningHistoryUniqueKanjiBtn: null,
    
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

        // Learning history chart
        this.learningHistoryChart = document.getElementById('learningHistoryChart');
        this.learningHistoryChartWrap = document.getElementById('learningHistoryChartWrap');
        this.learningHistorySummary = document.getElementById('learningHistorySummary');
        this.learningHistoryNoData = document.getElementById('learningHistoryNoData');
        this.learningHistoryMatureWordsBtn = document.getElementById('learningHistoryMatureWordsBtn');
        this.learningHistoryUniqueKanjiBtn = document.getElementById('learningHistoryUniqueKanjiBtn');
        
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

function getChartColor(varName, alpha) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (!raw) {
        return alpha !== undefined && alpha < 1 ? `rgba(128, 128, 128, ${alpha})` : '#888';
    }

    if (alpha !== undefined && alpha < 1) {
        if (raw.startsWith('#')) {
            let hex = raw.replace('#', '');
            if (hex.length === 3) {
                hex = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
            }
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        if (raw.startsWith('rgb(')) {
            return raw.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
        }
        if (raw.startsWith('rgba(')) {
            return raw.replace(/,[^,]*\)$/, `, ${alpha})`);
        }
    }

    return raw;
}

document.addEventListener('DOMContentLoaded', function () {

    // Cache for time-display refresh
    let _cachedCurrentGameStats = null;
    let _cachedAllGamesStats = null;
    let _cachedTodayHours = null;
    let _cachedSessionHours = null;

    // Track which game_id is currently displayed in "Overall Game Statistics"
    // so we only re-fetch when navigating to a session for a different game
    let _currentlyDisplayedGameId = null;
    let _hydratedOverviewGameId = null;
    let _currentManagedGameData = null;
    let _currentManagedGameStats = null;
    let _currentManagedSessionSignature = null;
    let overviewMergeSelectedGames = [];
    let overviewAllGamesForMerge = [];

    DOM_CACHE.init();

    let learningHistoryChartInstance = null;
    let learningHistoryData = null;
    let activeLearningHistoryMetric = 'mature_words';

    const LEARNING_HISTORY_METRICS = {
        mature_words: {
            label: 'Mature Words',
            singular: 'mature word',
            plural: 'mature words',
            colorVar: '--chart-success',
            emptyMessage: 'No mature word history yet.',
        },
        unique_kanji: {
            label: 'Unique Kanji',
            singular: 'unique kanji',
            plural: 'unique kanji',
            colorVar: '--chart-info',
            emptyMessage: 'No unique kanji history yet.',
        },
    };

    function setLearningHistoryToggleState(metricKey) {
        if (DOM_CACHE.learningHistoryMatureWordsBtn) {
            DOM_CACHE.learningHistoryMatureWordsBtn.classList.toggle(
                'active',
                metricKey === 'mature_words'
            );
        }
        if (DOM_CACHE.learningHistoryUniqueKanjiBtn) {
            DOM_CACHE.learningHistoryUniqueKanjiBtn.classList.toggle(
                'active',
                metricKey === 'unique_kanji'
            );
        }
    }

    function destroyLearningHistoryChart() {
        if (learningHistoryChartInstance) {
            learningHistoryChartInstance.destroy();
            learningHistoryChartInstance = null;
        }
    }

    function showLearningHistoryNoData(message) {
        destroyLearningHistoryChart();
        if (DOM_CACHE.learningHistoryChartWrap) {
            DOM_CACHE.learningHistoryChartWrap.style.display = 'none';
        }
        if (DOM_CACHE.learningHistoryNoData) {
            DOM_CACHE.learningHistoryNoData.textContent = message;
            DOM_CACHE.learningHistoryNoData.style.display = 'block';
        }
    }

    function showLearningHistoryChart() {
        if (DOM_CACHE.learningHistoryChartWrap) {
            DOM_CACHE.learningHistoryChartWrap.style.display = 'block';
        }
        if (DOM_CACHE.learningHistoryNoData) {
            DOM_CACHE.learningHistoryNoData.style.display = 'none';
        }
    }

    function formatLearningHistorySummary(series, metricConfig) {
        const total = Number(series && series.total) || 0;
        const noun = total === 1 ? metricConfig.singular : metricConfig.plural;
        return `${total.toLocaleString()} ${noun} learnt so far`;
    }

    function renderLearningHistoryChart() {
        setLearningHistoryToggleState(activeLearningHistoryMetric);

        if (!DOM_CACHE.learningHistoryChart || !learningHistoryData || !window.Chart) {
            return;
        }

        const metricConfig =
            LEARNING_HISTORY_METRICS[activeLearningHistoryMetric] ||
            LEARNING_HISTORY_METRICS.mature_words;
        const labels = Array.isArray(learningHistoryData.labels)
            ? learningHistoryData.labels
            : [];
        const series = learningHistoryData.series
            ? learningHistoryData.series[activeLearningHistoryMetric]
            : null;

        if (DOM_CACHE.learningHistorySummary) {
            DOM_CACHE.learningHistorySummary.textContent = formatLearningHistorySummary(
                series,
                metricConfig
            );
        }

        if (
            !series ||
            !Array.isArray(series.cumulative) ||
            !Array.isArray(series.daily_new) ||
            labels.length === 0 ||
            Number(series.total) === 0
        ) {
            showLearningHistoryNoData(metricConfig.emptyMessage);
            return;
        }

        showLearningHistoryChart();

        const chartContext = DOM_CACHE.learningHistoryChart.getContext('2d');
        destroyLearningHistoryChart();

        learningHistoryChartInstance = new Chart(chartContext, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: series.label || metricConfig.label,
                        data: series.cumulative,
                        borderColor: getChartColor(metricConfig.colorVar, 0.95),
                        backgroundColor: getChartColor(metricConfig.colorVar, 0.15),
                        borderWidth: 3,
                        fill: true,
                        tension: 0.25,
                        pointRadius: 2,
                        pointHoverRadius: 5,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: {
                    x: {
                        ticks: {
                            color: getChartColor('--chart-text'),
                            maxRotation: 45,
                            autoSkip: true,
                            maxTicksLimit: 12,
                        },
                        grid: {
                            display: false,
                        },
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: getChartColor('--chart-text'),
                            precision: 0,
                        },
                        title: {
                            display: true,
                            text: metricConfig.label,
                            color: getChartColor('--chart-text'),
                        },
                        grid: {
                            color: getChartColor('--chart-grid'),
                        },
                    },
                },
                plugins: {
                    legend: {
                        display: false,
                    },
                    tooltip: {
                        callbacks: {
                            label(context) {
                                return `Cumulative: ${context.parsed.y.toLocaleString()}`;
                            },
                            afterLabel(context) {
                                const dailyValue = series.daily_new[context.dataIndex] || 0;
                                return `New that day: ${dailyValue.toLocaleString()}`;
                            },
                        },
                    },
                },
            },
        });
    }

    function handleLearningHistoryResponse(result) {
        if (!result) {
            learningHistoryData = null;
            if (DOM_CACHE.learningHistorySummary) {
                DOM_CACHE.learningHistorySummary.textContent = 'Learning history unavailable.';
            }
            showLearningHistoryNoData('Failed to load learning history.');
            return;
        }

        if (result.status === 404) {
            learningHistoryData = null;
            if (DOM_CACHE.learningHistorySummary) {
                DOM_CACHE.learningHistorySummary.textContent =
                    'Learning history is unavailable while tokenization is disabled.';
            }
            showLearningHistoryNoData(
                'Enable tokenization to see mature word and kanji history.'
            );
            return;
        }

        if (result.status !== 200 || !result.data) {
            learningHistoryData = null;
            if (DOM_CACHE.learningHistorySummary) {
                DOM_CACHE.learningHistorySummary.textContent = 'Learning history unavailable.';
            }
            showLearningHistoryNoData('Failed to load learning history.');
            return;
        }

        learningHistoryData = result.data;
        renderLearningHistoryChart();
    }

    function fetchLearningHistoryData() {
        return fetch('/api/tokenization/maturity-history')
            .then(async response => {
                if (response.status === 404) {
                    return { status: 404, data: null };
                }
                if (!response.ok) {
                    throw new Error(`Failed to load learning history (${response.status})`);
                }
                return {
                    status: 200,
                    data: await response.json(),
                };
            })
            .catch(error => {
                console.error('Failed to load learning history:', error);
                return { status: 0, data: null };
            });
    }

    if (DOM_CACHE.learningHistoryMatureWordsBtn) {
        DOM_CACHE.learningHistoryMatureWordsBtn.addEventListener('click', function() {
            activeLearningHistoryMetric = 'mature_words';
            renderLearningHistoryChart();
        });
    }

    if (DOM_CACHE.learningHistoryUniqueKanjiBtn) {
        DOM_CACHE.learningHistoryUniqueKanjiBtn.addEventListener('click', function() {
            activeLearningHistoryMetric = 'unique_kanji';
            renderLearningHistoryChart();
        });
    }
    
    // Custom streak calculation function for activity heatmap (includes average daily time)
    function calculateActivityStreaks(grid, yearData, allLinesForYear = []) {
        const streakRequirement = window.statsConfig ? window.statsConfig.streakRequirementHours : 1.0;
        
        // Build a map of all dates with activity from ALL years
        const activityMap = new Map();
        
        // Access the parent renderer's heatmapData to get all years
        if (this.heatmapData) {
            Object.keys(this.heatmapData).sort().forEach(year => {
                const data = this.heatmapData[year];
                Object.keys(data).forEach(dateStr => {
                    activityMap.set(dateStr, data[dateStr] || 0);
                });
            });
        }
        
        // Get all dates sorted chronologically
        const allDates = Array.from(activityMap.keys()).sort();
        
        // Calculate longest streak - consecutive calendar days with activity
        let longestStreak = 0;
        let tempStreak = 0;
        let prevDate = null;
        
        for (const dateStr of allDates) {
            const activity = activityMap.get(dateStr);
            
            if (activity >= streakRequirement) {
                // Check if this is consecutive with previous date
                if (prevDate === null) {
                    tempStreak = 1;
                } else {
                    const prev = new Date(prevDate);
                    const curr = new Date(dateStr);
                    const dayDiff = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
                    
                    if (dayDiff === 1) {
                        tempStreak++;
                    } else {
                        tempStreak = 1;
                    }
                }
                longestStreak = Math.max(longestStreak, tempStreak);
                prevDate = dateStr;
            } else {
                tempStreak = 0;
                prevDate = null;
            }
        }

        // Calculate current streak from today backwards (consecutive days)
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let currentStreak = 0;
        let checkDate = new Date(today);
        let daysChecked = 0;
        const maxDaysToCheck = 1000; // Safety limit
        
        while (daysChecked < maxDaysToCheck) {
            const dateStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
            const activity = activityMap.get(dateStr) || 0;
            
            if (activity >= streakRequirement) {
                currentStreak++;
            } else {
                // Stop at first day without activity
                break;
            }
            
            checkDate.setDate(checkDate.getDate() - 1); // Move to previous day
            daysChecked++;
        }
        
        // Helper function to format average time - delegates to shared time format utility
        const formatAvgTime = (avgHours) => window.formatTime(avgHours);

        // Helper function to format average characters
        const formatAvgChars = (avgChars) => {
            if (avgChars >= 1000000) {
                return `${(avgChars / 1000000).toFixed(1)}M`;
            } else if (avgChars >= 1000) {
                return `${(avgChars / 1000).toFixed(1)}K`;
            }
            return Math.round(avgChars).toString();
        };

        // Calculate average daily time for this year, last 30 days, and last 7 days
        let avgDailyTime = "-";
        let avgDailyChars = "-";
        let avgDailyChars30 = "-";
        let avgDailyChars7 = "-";
        let avgDaily30 = "-";
        let avgDaily7 = "-";
        
        if (allLinesForYear && allLinesForYear.length > 0) {
            // Get date ranges
            const now = new Date();
            const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
            const sevenDaysAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));

            let totalHours = 0;
            let totalChars = 0;
            let activeDays = 0;
            let totalHours30 = 0;
            let totalChars30 = 0;
            let activeDays30 = 0;
            let totalHours7 = 0;
            let totalChars7 = 0;
            let activeDays7 = 0;

            for (const line of allLinesForYear) {
                if (line.reading_time_seconds === undefined || line.reading_time_seconds <= 0) {
                    continue;
                }

                const hours = line.reading_time_seconds / 3600;
                const chars = line.characters || 0;
                let lineDate;

                if (line.date) {
                    lineDate = new Date(line.date);
                } else if (line.timestamp) {
                    lineDate = new Date(parseFloat(line.timestamp) * 1000);
                }

                totalHours += hours;
                totalChars += chars;
                activeDays++;

                if (lineDate) {
                    if (lineDate >= thirtyDaysAgo) {
                        totalHours30 += hours;
                        totalChars30 += chars;
                        activeDays30++;
                    }

                    if (lineDate >= sevenDaysAgo) {
                        totalHours7 += hours;
                        totalChars7 += chars;
                        activeDays7++;
                    }
                }
            }

            if (activeDays > 0) {
                avgDailyTime = formatAvgTime(totalHours / activeDays);
                avgDailyChars = formatAvgChars(totalChars / activeDays);
            }
            if (activeDays30 > 0) {
                avgDaily30 = formatAvgTime(totalHours30 / activeDays30);
                avgDailyChars30 = formatAvgChars(totalChars30 / activeDays30);
            }
            if (activeDays7 > 0) {
                avgDaily7 = formatAvgTime(totalHours7 / activeDays7);
                avgDailyChars7 = formatAvgChars(totalChars7 / activeDays7);
            }
        }
        console.log({ longestStreak, currentStreak, avgDaily: avgDailyTime, avgDaily30, avgDaily7, avgDailyChars, avgDailyChars30, avgDailyChars7 })
        
        return { longestStreak, currentStreak, avgDaily: avgDailyTime, avgDaily30, avgDaily7, avgDailyChars, avgDailyChars30, avgDailyChars7 };
    }
    
    // Initialize heatmap renderer with custom configuration for activity tracking
    const activityHeatmapRenderer = new HeatmapRenderer({
        containerId: 'heatmapContainer',
        metricName: 'characters',
        metricLabel: 'characters',
        calculateStreaks: calculateActivityStreaks
    });
    // Expose for time-format refresh
    window.activityHeatmapRenderer = activityHeatmapRenderer;
    
    // Function to create GitHub-style heatmap using shared component
    function createHeatmap(heatmapData) {
        activityHeatmapRenderer.render(heatmapData, window.allLinesData || []);
    }

    function showNoDataPopup() {
        const popup = document.getElementById("noDataPopup");
        if (popup) popup.classList.remove("hidden");
    }   

    const closeNoDataPopup = document.getElementById("closeNoDataPopup");
    if (closeNoDataPopup) {
        closeNoDataPopup.addEventListener("click", () => {
            const popup = document.getElementById("noDataPopup");
            if (popup) popup.classList.add("hidden");
        });
    }

    // Function to load stats data with optional year filter
    function loadStatsData() {
        let url = '/api/stats';
        
        // Start learning history in parallel, but don't block the main overview render on it.
        fetchLearningHistoryData().then(handleLearningHistoryResponse);

        // Fetch main stats and allLinesData in parallel.
        const statsPromise = fetch(url).then(response => response.json());
        const allLinesPromise = fetch('/api/stats/all-lines-data')
            .then(response => response.json())
            .then(lines => {
                window.allLinesData = Array.isArray(lines) ? lines : [];
                return window.allLinesData;
            })
            .catch(err => {
                console.error('Failed to load all-lines-data:', err);
                window.allLinesData = [];
                return [];
            });

        return Promise.all([statsPromise, allLinesPromise])
            .then(([data, allLinesData]) => {
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
                    updateGoalProgressWithData(data, allLinesData);
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
            const dailyReadingTimes = {};
            for (const line of recentData) {
                if (line.reading_time_seconds === undefined || line.reading_time_seconds <= 0) {
                    continue;
                }
                const ts = parseFloat(line.timestamp);
                if (isNaN(ts)) continue;
                const dateObj = new Date(ts * 1000);
                const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
                dailyReadingTimes[dateStr] = (dailyReadingTimes[dateStr] || 0) + line.reading_time_seconds;
            }

            for (const [dateStr, readingTimeSeconds] of Object.entries(dailyReadingTimes)) {
                if (readingTimeSeconds > 0) {
                    dailyTotals[dateStr] = readingTimeSeconds / 3600;
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
        
        // Update Hours Goal (with null checks - elements may not exist on all pages)
        const hoursPercentage = Math.min(100, (currentHours / goalSettings.reading_hours_target) * 100);
        const goalHoursCurrentEl = document.getElementById('goalHoursCurrent');
        if (goalHoursCurrentEl) goalHoursCurrentEl.textContent = Math.floor(currentHours).toLocaleString();
        const goalHoursTargetEl = document.getElementById('goalHoursTarget');
        if (goalHoursTargetEl) goalHoursTargetEl.textContent = goalSettings.reading_hours_target.toLocaleString();
        const goalHoursPercentageEl = document.getElementById('goalHoursPercentage');
        if (goalHoursPercentageEl) goalHoursPercentageEl.textContent = Math.floor(hoursPercentage) + '%';
        const goalHoursProjectionEl = document.getElementById('goalHoursProjection');
        if (goalHoursProjectionEl) goalHoursProjectionEl.textContent =
            formatProjection(currentHours, goalSettings.reading_hours_target, dailyHoursAvg, 'hours');
        
        const hoursProgressBar = document.getElementById('goalHoursProgress');
        if (hoursProgressBar) {
            hoursProgressBar.style.width = hoursPercentage + '%';
            hoursProgressBar.setAttribute('data-percentage', Math.floor(hoursPercentage / 25) * 25);
            updateProgressBarColor(hoursProgressBar, hoursPercentage);
        }
        
        // Update Characters Goal
        const charsPercentage = Math.min(100, (currentCharacters / goalSettings.character_count_target) * 100);
        const goalCharsCurrentEl = document.getElementById('goalCharsCurrent');
        if (goalCharsCurrentEl) goalCharsCurrentEl.textContent = formatGoalNumber(currentCharacters);
        const goalCharsTargetEl = document.getElementById('goalCharsTarget');
        if (goalCharsTargetEl) goalCharsTargetEl.textContent = formatGoalNumber(goalSettings.character_count_target);
        const goalCharsPercentageEl = document.getElementById('goalCharsPercentage');
        if (goalCharsPercentageEl) goalCharsPercentageEl.textContent = Math.floor(charsPercentage) + '%';
        const goalCharsProjectionEl = document.getElementById('goalCharsProjection');
        if (goalCharsProjectionEl) goalCharsProjectionEl.textContent =
            formatProjection(currentCharacters, goalSettings.character_count_target, dailyCharsAvg, 'characters');
            
        const charsProgressBar = document.getElementById('goalCharsProgress');
        if (charsProgressBar) {
            charsProgressBar.style.width = charsPercentage + '%';
            charsProgressBar.setAttribute('data-percentage', Math.floor(charsPercentage / 25) * 25);
            updateProgressBarColor(charsProgressBar, charsPercentage);
        }
        
        // Update Games Goal
        const gamesPercentage = Math.min(100, (currentGames / goalSettings.games_target) * 100);
        const goalGamesCurrentEl = document.getElementById('goalGamesCurrent');
        if (goalGamesCurrentEl) goalGamesCurrentEl.textContent = currentGames.toLocaleString();
        const goalGamesTargetEl = document.getElementById('goalGamesTarget');
        if (goalGamesTargetEl) goalGamesTargetEl.textContent = goalSettings.games_target.toLocaleString();
        const goalGamesPercentageEl = document.getElementById('goalGamesPercentage');
        if (goalGamesPercentageEl) goalGamesPercentageEl.textContent = Math.floor(gamesPercentage) + '%';
        const goalGamesProjectionEl = document.getElementById('goalGamesProjection');
        if (goalGamesProjectionEl) goalGamesProjectionEl.textContent =
            formatProjection(currentGames, goalSettings.games_target, dailyGamesAvg, 'games');
            
        const gamesProgressBar = document.getElementById('goalGamesProgress');
        if (gamesProgressBar) {
            gamesProgressBar.style.width = gamesPercentage + '%';
            gamesProgressBar.setAttribute('data-percentage', Math.floor(gamesPercentage / 25) * 25);
            updateProgressBarColor(gamesProgressBar, gamesPercentage);
        }
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
            
            // Load goal settings, stats, and allLinesData in parallel
            await loadGoalSettings();
            const [statsResponse, allLinesData] = await Promise.all([
                fetch('/api/stats').then(r => r.json()),
                fetch('/api/stats/all-lines-data')
                    .then(r => r.json())
                    .catch(() => [])
            ]);
            
            const allGamesStats = statsResponse.allGamesStats;
            
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
        const line_ids = session.lines
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
                // Clamp currentSessionIndex to valid range after removal
                if (window.todaySessionDetails.length === 0) {
                    window.currentSessionIndex = 0;
                } else {
                    window.currentSessionIndex = Math.min(window.currentSessionIndex, window.todaySessionDetails.length - 1);
                }
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
    async function updateGoalProgressWithData(statsData, allLinesData) {
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
            const linesData = allLinesData || window.allLinesData || [];
            
            // Update the UI using the shared helper function
            updateGoalProgressUI(allGamesStats, linesData);
            
            // Hide loading and error states
            goalProgressLoading.style.display = 'none';
            goalProgressError.style.display = 'none';
            
        } catch (error) {
            console.error('Error updating goal progress:', error);
            goalProgressLoading.style.display = 'none';
            goalProgressError.style.display = 'block';
        }
    }

    window.addEventListener('settingsUpdated', function() {
        loadGoalSettings()
            .then(function() {
                return loadStatsData();
            })
            .catch(function(error) {
                console.error('Failed to refresh overview after settings update:', error);
            });
    });

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

        estimatedTimeLeftEl.textContent = window.formatTime(hoursRemaining);
    }

    // Make functions globally available
    window.createHeatmap = createHeatmap;
    window.loadStatsData = loadStatsData;
    window.loadGoalProgress = loadGoalProgress;
    window.updateProgressTimeline = updateProgressTimeline;
    window.updateEstimatedTimeLeft = updateEstimatedTimeLeft;

    // Refresh all time displays when time format toggle changes
    window.refreshTimeDisplays = function() {
        if (_cachedCurrentGameStats) {
            updateCurrentGameDashboard(_cachedCurrentGameStats);
        }
        if (_cachedAllGamesStats) {
            updateAllGamesDashboard(_cachedAllGamesStats);
        }
        // Refresh today's hours display
        if (_cachedTodayHours !== null) {
            const hoursDisplay = _cachedTodayHours > 0 ? window.formatTime(_cachedTodayHours) : '-';
            const el = document.getElementById('todayTotalHours');
            if (el) el.textContent = hoursDisplay;
        }
        // Refresh current session hours display
        if (window.todaySessionDetails && window.todaySessionDetails.length > 0) {
            const idx = window.currentSessionIndex || 0;
            const session = window.todaySessionDetails[idx];
            if (session) {
                const sessionHours = session.totalSeconds / 3600;
                const el = document.getElementById('currentSessionTotalHours');
                if (el) el.textContent = sessionHours > 0 ? window.formatTime(sessionHours) : '-';
            }
        }
        // Re-render heatmap to update avg daily time display
        if (window.activityHeatmapRenderer && window.activityHeatmapRenderer.heatmapData) {
            window.activityHeatmapRenderer.render(
                window.activityHeatmapRenderer.heatmapData,
                window.activityHeatmapRenderer.allLinesData || []
            );
        }
    };

    const currentSessionManagementContainer = document.getElementById('currentSessionManagementContainer');
    const currentSessionSettingsCogBtn = document.getElementById('currentSessionSettingsCogBtn');
    const currentSessionSettingsCogDropdown = document.getElementById('currentSessionSettingsCogDropdown');
    const currentSessionMarkCompleteItem = currentSessionSettingsCogDropdown
        ? currentSessionSettingsCogDropdown.querySelector('[data-action="markComplete"]')
        : null;

    function closeCurrentSessionSettingsDropdown() {
        if (currentSessionSettingsCogDropdown) {
            currentSessionSettingsCogDropdown.classList.remove('show');
        }
    }

    function updateCurrentSessionManagementVisibility(gameId) {
        if (!currentSessionManagementContainer) {
            return;
        }

        currentSessionManagementContainer.style.display = gameId ? 'block' : 'none';
        if (!gameId) {
            closeCurrentSessionSettingsDropdown();
        }
    }

    function updateCurrentSessionManagedCompletedState(isCompleted) {
        if (!currentSessionMarkCompleteItem) {
            return;
        }

        currentSessionMarkCompleteItem.innerHTML = isCompleted
            ? '&#9989; Completed'
            : '&#9989; Mark as Completed';
        currentSessionMarkCompleteItem.disabled = !!isCompleted;
        currentSessionMarkCompleteItem.style.opacity = isCompleted ? '0.5' : '';
        currentSessionMarkCompleteItem.style.cursor = isCompleted ? 'default' : '';
    }

    function setCurrentManagedGameContext(gameStats, options = {}) {
        if (!gameStats || !gameStats.game_id) {
            _currentManagedGameData = null;
            _currentManagedGameStats = null;
            _currentManagedSessionSignature = options.sessionSignature || null;
            updateCurrentSessionManagementVisibility('');
            updateCurrentSessionManagedCompletedState(false);
            return;
        }

        _currentManagedGameData = gameStats;
        _currentManagedGameStats = gameStats;
        _currentManagedSessionSignature = options.sessionSignature || null;
        updateCurrentSessionManagementVisibility(gameStats.game_id);
        updateCurrentSessionManagedCompletedState(gameStats.completed);
    }

    function getCurrentManagedGameId() {
        return (_currentManagedGameData && _currentManagedGameData.game_id)
            || (_currentManagedGameStats && _currentManagedGameStats.game_id)
            || '';
    }

    function getCurrentManagedGameName() {
        const game = _currentManagedGameData || _currentManagedGameStats;
        return (game && (game.title_original || game.title_romaji || game.title_english || game.game_name)) || 'this game';
    }

    function getCurrentManagedGameSceneName() {
        const game = _currentManagedGameData || _currentManagedGameStats;
        return (game && (game.obs_scene_name || game.title_original || game.title_romaji || game.title_english)) || '';
    }

    function getCurrentSessionSignature(session) {
        if (!session) {
            return null;
        }

        return {
            startTime: Number(session.startTime || 0),
            endTime: Number(session.endTime || 0),
            totalChars: Number(session.totalChars || 0),
            gameId: session.gameMetadata && session.gameMetadata.game_id ? session.gameMetadata.game_id : '',
            gameName: session.gameName || '',
            lineCount: Array.isArray(session.lines) ? session.lines.length : 0,
        };
    }

    function findSessionIndexBySignature(sessions, signature) {
        if (!Array.isArray(sessions) || sessions.length === 0 || !signature) {
            return -1;
        }

        return sessions.findIndex(session => {
            const sessionSignature = getCurrentSessionSignature(session);
            return sessionSignature
                && sessionSignature.startTime === signature.startTime
                && sessionSignature.endTime === signature.endTime
                && sessionSignature.totalChars === signature.totalChars
                && sessionSignature.gameId === signature.gameId
                && sessionSignature.gameName === signature.gameName
                && sessionSignature.lineCount === signature.lineCount;
        });
    }

    function getSelectedSessionSignature() {
        if (!window.todaySessionDetails || window.todaySessionDetails.length === 0) {
            return null;
        }

        const index = Number.isInteger(window.currentSessionIndex)
            ? window.currentSessionIndex
            : window.todaySessionDetails.length - 1;
        return getCurrentSessionSignature(window.todaySessionDetails[index]);
    }

    // Maps /api/game/<game_id>/stats response to the format updateCurrentGameDashboard expects
    function mapGameApiResponseToCurrentGameStats(data) {
        const game = data.game;
        const stats = data.stats;

        const totalChars = stats.total_characters || 0;
        const charCount = game.character_count || 0;
        const progressPercentage = charCount > 0 ? Math.min(100, (totalChars / charCount) * 100) : 0;

        // Build daily_activity from dailySpeed data for progress timeline estimation
        const dailyActivity = {};
        if (data.dailySpeed && data.dailySpeed.labels) {
            for (let i = 0; i < data.dailySpeed.labels.length; i++) {
                dailyActivity[data.dailySpeed.labels[i]] = data.dailySpeed.charsData[i] || 0;
            }
        }

        return {
            game_name: game.title_original || '',
            game_id: game.id || '',
            deck_id: game.deck_id || '',
            title_original: game.title_original || '',
            title_romaji: game.title_romaji || '',
            title_english: game.title_english || '',
            obs_scene_name: game.obs_scene_name || '',
            type: game.type || '',
            description: game.description || '',
            image: game.image || '',
            game_character_count: charCount,
            character_count: charCount,
            difficulty: game.difficulty || '',
            links: game.links || [],
            completed: game.completed || false,
            release_date: game.release_date || '',
            manual_overrides: game.manual_overrides || [],
            genres: game.genres || [],
            tags: game.tags || [],
            character_summary: game.character_summary || '',
            vndb_id: game.vndb_id || '',
            anilist_id: game.anilist_id || '',
            total_characters: totalChars,
            total_characters_formatted: stats.total_characters_formatted || '0',
            total_sentences: stats.total_sentences || 0,
            total_time_hours: stats.total_time_hours || 0,
            total_time_formatted: stats.total_time_formatted || '0m',
            reading_speed: stats.reading_speed || 0,
            reading_speed_formatted: stats.reading_speed_formatted || '0',
            first_date: stats.first_date || '',
            last_date: stats.last_date || '',
            progress_percentage: Math.round(progressPercentage * 10) / 10,
            daily_activity: dailyActivity,
            current_streak: 0, // Not available from per-game endpoint
            sessions: 0,
            monthly_characters: 0,
            monthly_characters_formatted: '0',
        };
    }

    // Fetch stats for a specific game and update the "Overall Game Statistics" + progress bar
    function fetchAndUpdateGameStatsForSession(session) {
        const gameId = session.gameMetadata && session.gameMetadata.game_id;
        const sessionSignature = getCurrentSessionSignature(session);

        // If no game_id, we can't fetch per-game stats - clear the overall section
        if (!gameId) {
            _currentlyDisplayedGameId = null;
            _hydratedOverviewGameId = null;
            setCurrentManagedGameContext(null, { sessionSignature });
            // Show the game name from the session at least
            const currentGameNameEl = document.getElementById('currentGameName');
            if (currentGameNameEl) {
                currentGameNameEl.textContent = session.gameName || 'Unknown Game';
                currentGameNameEl.style.display = 'block';
            }
            // Hide progress bar since we have no game data
            const progressContainer = document.getElementById('gameProgressContainer');
            if (progressContainer) progressContainer.style.display = 'none';
            // Reset overall stats to show dashes
            document.getElementById('currentTotalChars').textContent = '-';
            document.getElementById('currentReadingSpeed').textContent = '-';
            document.getElementById('currentTotalTime').textContent = '-';
            const estBox = document.getElementById('currentEstimatedTimeLeft');
            if (estBox) {
                estBox.textContent = '-';
                const statItem = estBox.closest('.dashboard-stat-item');
                if (statItem) statItem.style.display = 'none';
            }
            // Hide streak and completion btn
            document.getElementById('currentGameStreak').style.display = 'none';
            document.getElementById('gameCompletionBtn').style.display = 'none';
            return;
        }

        // Skip fetch if we're already showing a hydrated view for this exact game/session.
        if (gameId === _currentlyDisplayedGameId && gameId === _hydratedOverviewGameId) {
            setCurrentManagedGameContext(_currentManagedGameData, { sessionSignature });
            return;
        }

        _currentlyDisplayedGameId = gameId;

        fetch(`/api/game/${gameId}/stats`)
            .then(response => {
                if (!response.ok) throw new Error('Failed to fetch game stats');
                return response.json();
            })
            .then(data => {
                // Verify we're still showing the same game (user might have navigated again)
                if (_currentlyDisplayedGameId !== gameId) return;

                const mappedStats = mapGameApiResponseToCurrentGameStats(data);
                _hydratedOverviewGameId = gameId;
                setCurrentManagedGameContext(mappedStats, { sessionSignature });
                updateCurrentGameDashboard(mappedStats);
            })
            .catch(error => {
                console.error(`Error fetching stats for game ${gameId}:`, error);
                if (_currentlyDisplayedGameId === gameId) {
                    _hydratedOverviewGameId = null;
                    setCurrentManagedGameContext(null, { sessionSignature });
                }
            });
    }

    function updateCurrentSessionOverview(sessionDetails, index = sessionDetails.length - 1) {
        window.currentSessionIndex = index; // Store globally for potential future use
        console.log('Updating current session overview:', sessionDetails);
        // Get the session at index
        const lastSession = sessionDetails && sessionDetails.length > 0 ? sessionDetails[index] : null;

        if (!lastSession) {
            _currentlyDisplayedGameId = null;
            _hydratedOverviewGameId = null;
            setCurrentManagedGameContext(null);
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
            hoursDisplay = window.formatTime(sessionHours);
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

        // Update "Overall Game Statistics" + progress bar for this session's game
        fetchAndUpdateGameStatsForSession(lastSession);
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

        // Update genres (limit to 5)
        const gameGenresContainer = document.getElementById('gameGenresContainer');
        const gameGenresPills = document.getElementById('gameGenresPills');
        if (gameMetadata.genres && gameMetadata.genres.length > 0) {
            gameGenresPills.innerHTML = '';
            
            const genresToShow = gameMetadata.genres.slice(0, 5);
            genresToShow.forEach(genre => {
                const pill = document.createElement('span');
                pill.className = 'game-genre-pill';
                pill.textContent = genre;
                gameGenresPills.appendChild(pill);
            });
            
            gameGenresContainer.style.display = 'flex';
        } else {
            gameGenresContainer.style.display = 'none';
        }

        // Update tags (limit to 5)
        const gameTagsContainer = document.getElementById('gameTagsContainer');
        const gameTagsPills = document.getElementById('gameTagsPills');
        if (gameMetadata.tags && gameMetadata.tags.length > 0) {
            gameTagsPills.innerHTML = '';
            
            const tagsToShow = gameMetadata.tags.slice(0, 5);
            tagsToShow.forEach(tag => {
                const pill = document.createElement('span');
                pill.className = 'game-tag-pill';
                pill.textContent = tag;
                gameTagsPills.appendChild(pill);
            });
            
            gameTagsContainer.style.display = 'flex';
        } else {
            gameTagsContainer.style.display = 'none';
        }
    }

    // Function to load today's stats from new API endpoint
    function loadTodayStats(options = {}) {
        fetch('/api/today-stats')
            .then(response => response.json())
            .then(data => {
                // Update today's total hours
                const totalHours = data.todayTotalHours || 0;
                _cachedTodayHours = totalHours;
                let hoursDisplay = '-';
                if (totalHours > 0) {
                    hoursDisplay = window.formatTime(totalHours);
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
                
                let targetSessionIndex = window.todaySessionDetails.length - 1;
                const preferredSessionSignature =
                    options.preferredSessionSignature || getSelectedSessionSignature();
                const matchingSessionIndex = findSessionIndexBySignature(
                    window.todaySessionDetails,
                    preferredSessionSignature
                );
                if (matchingSessionIndex >= 0) {
                    targetSessionIndex = matchingSessionIndex;
                }

                // Show the latest session (most recent) unless a matching session was requested
                if (window.todaySessionDetails.length > 0) {
                    showSessionAtIndex(targetSessionIndex);
                } else {
                    // No sessions - clear session displays
                    document.getElementById('currentSessionTotalChars').textContent = '0';
                    document.getElementById('currentSessionCharsPerHour').textContent = '-';
                    setCurrentManagedGameContext(null);
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
                setCurrentManagedGameContext(null);
            });
    }

    // Dashboard functionality
    function loadDashboardData(data = null, options = {}) {
        function updateOverviewForEndDay() {
            const pad = n => n.toString().padStart(2, '0');

            // Determine target date string (YYYY-MM-DD) from the end timestamp
            const endDateObj = new Date();
            const targetDateStr = `${endDateObj.getFullYear()}-${pad(endDateObj.getMonth() + 1)}-${pad(endDateObj.getDate())}`;
            document.getElementById('todayDate').textContent = targetDateStr;
            
            // Load today's stats from new API
            loadTodayStats(options.todayStats || {});
        }

        if (data && data.currentGameStats && data.allGamesStats) {
            // Use existing data if available
            updateCurrentGameDashboard(data.currentGameStats);
            updateAllGamesDashboard(data.allGamesStats);
            updateOverviewForEndDay();
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
                        updateOverviewForEndDay();
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
                'itch.io': 'Itch.io',
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
                'gamejolt.com': 'Game Jolt',
                'mobygames.com': 'MobyGames',
                'giantbomb.com': 'GiantBomb',
                'howlongtobeat.com': 'HowLongToBeat',
                'igdb.com': 'IGDB',
                'mangadex.org': 'MangaDex',
                'animeuknews.net': 'Anime UK News',
                'mydramalist.com': 'MyDramaList',
                'metacritic.com': 'Metacritic',
                'opencritic.com': 'OpenCritic',
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

    function getImageSrc(image) {
        if (!image || image === '') {
            return '';
        }
        if (image.startsWith('data:') || image.startsWith('http')) {
            return image;
        }
        return `data:image/png;base64,${image}`;
    }

    function normalizeLinksForUpdate(links) {
        if (!Array.isArray(links)) {
            return [];
        }

        return links
            .map(link => {
                if (typeof link === 'string') {
                    return { linkType: 1, url: link };
                }
                return link && link.url ? link : null;
            })
            .filter(Boolean);
    }

    function mergeSourceLinks(existingLinks, newLinks) {
        const merged = [];
        const seen = new Set();

        normalizeLinksForUpdate(existingLinks)
            .concat(normalizeLinksForUpdate(newLinks))
            .forEach(link => {
                const url = String(link.url || '').trim();
                const key = url.toLowerCase();
                if (!url || seen.has(key)) {
                    return;
                }
                seen.add(key);
                merged.push(link);
            });

        return merged;
    }

    function refreshOverviewAfterGameManagement(options = {}) {
        API_CACHE.clearStatsData();
        _currentlyDisplayedGameId = null;
        _hydratedOverviewGameId = null;

        const preferredSessionSignature =
            options.preserveCurrentSelection === false
                ? null
                : (_currentManagedSessionSignature || getSelectedSessionSignature());

        loadDashboardData(null, {
            todayStats: {
                preferredSessionSignature,
            },
        });
    }

    function openEditModal() {
        if (!_currentManagedGameData) {
            return;
        }

        const game = _currentManagedGameData;
        document.getElementById('editTitleOriginal').value = game.title_original || '';
        document.getElementById('editTitleRomaji').value = game.title_romaji || '';
        document.getElementById('editTitleEnglish').value = game.title_english || '';
        document.getElementById('editType').value = game.type || '';
        document.getElementById('editDescription').value = game.description || '';
        document.getElementById('editDifficulty').value = game.difficulty || '';
        document.getElementById('editDeckId').value = game.deck_id || '';
        document.getElementById('editVndbId').value = game.vndb_id || '';
        document.getElementById('editAnilistId').value = game.anilist_id || '';
        document.getElementById('editCharacterCount').value = game.character_count || game.game_character_count || '';
        document.getElementById('editReleaseDate').value = game.release_date || '';
        document.getElementById('editCharacterSummary').value = game.character_summary || '';
        document.getElementById('editCompleted').checked = game.completed || false;
        document.getElementById('editImageUpload').value = '';

        const links = normalizeLinksForUpdate(game.links);
        document.getElementById('editLinksList').value = links.map(link => link.url).join('\n');

        const preview = document.getElementById('editImagePreview');
        const previewImg = document.getElementById('editImagePreviewImg');
        const imageSrc = getImageSrc(game.image);
        if (imageSrc) {
            previewImg.src = imageSrc;
            preview.style.display = '';
        } else {
            preview.style.display = 'none';
        }

        document.getElementById('editGameError').style.display = 'none';
        document.getElementById('editGameLoading').style.display = 'none';
        openModal('editGameModal');
    }

    async function saveCurrentManagedGameEdits() {
        const gameId = getCurrentManagedGameId();
        if (!gameId) {
            return;
        }

        const errorEl = document.getElementById('editGameError');
        const loadingEl = document.getElementById('editGameLoading');
        errorEl.style.display = 'none';
        loadingEl.style.display = 'flex';

        try {
            const linkLines = document.getElementById('editLinksList').value
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean);
            const links = linkLines.map(url => ({ linkType: 4, url }));

            let imageValue;
            const fileInput = document.getElementById('editImageUpload');
            if (fileInput.files && fileInput.files[0]) {
                imageValue = await new Promise(resolve => {
                    const reader = new FileReader();
                    reader.onload = event => resolve(event.target.result);
                    reader.readAsDataURL(fileInput.files[0]);
                });
            }

            const data = {
                title_original: document.getElementById('editTitleOriginal').value,
                title_romaji: document.getElementById('editTitleRomaji').value,
                title_english: document.getElementById('editTitleEnglish').value,
                type: document.getElementById('editType').value,
                description: document.getElementById('editDescription').value,
                difficulty: document.getElementById('editDifficulty').value
                    ? parseInt(document.getElementById('editDifficulty').value, 10)
                    : '',
                deck_id: document.getElementById('editDeckId').value
                    ? parseInt(document.getElementById('editDeckId').value, 10)
                    : '',
                vndb_id: document.getElementById('editVndbId').value,
                anilist_id: document.getElementById('editAnilistId').value,
                character_count: document.getElementById('editCharacterCount').value
                    ? parseInt(document.getElementById('editCharacterCount').value, 10)
                    : '',
                release_date: document.getElementById('editReleaseDate').value,
                character_summary: document.getElementById('editCharacterSummary').value,
                links,
                completed: document.getElementById('editCompleted').checked,
            };

            if (imageValue !== undefined) {
                data.image = imageValue;
            }

            const response = await fetch(`/api/games/${gameId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || 'Failed to save');
            }

            closeModal('editGameModal');
            refreshOverviewAfterGameManagement();
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.style.display = '';
        } finally {
            loadingEl.style.display = 'none';
        }
    }

    async function markCurrentManagedGameComplete(options = {}) {
        const gameId = getCurrentManagedGameId();
        if (!gameId || (_currentManagedGameData && _currentManagedGameData.completed)) {
            return;
        }

        try {
            const response = await fetch(`/api/games/${gameId}/mark-complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || 'Failed to mark as completed');
            }

            if (options.celebrate && typeof confetti !== 'undefined') {
                const duration = 3000;
                const animationEnd = Date.now() + duration;
                const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 9999 };

                function randomInRange(min, max) {
                    return Math.random() * (max - min) + min;
                }

                const interval = setInterval(() => {
                    const timeLeft = animationEnd - Date.now();
                    if (timeLeft <= 0) {
                        clearInterval(interval);
                        return;
                    }

                    const particleCount = 50 * (timeLeft / duration);
                    confetti({
                        ...defaults,
                        particleCount,
                        origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 },
                    });
                    confetti({
                        ...defaults,
                        particleCount,
                        origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 },
                    });
                }, 250);
            }

            refreshOverviewAfterGameManagement();
        } catch (error) {
            alert(`Failed to mark as completed: ${error.message}`);
        }
    }

    async function openMergeModal() {
        const gameId = getCurrentManagedGameId();
        if (!gameId || !_currentManagedGameData) {
            return;
        }

        overviewMergeSelectedGames = [];
        document.getElementById('mergeTargetName').textContent = getCurrentManagedGameName();
        document.getElementById('mergeSearchInput').value = '';
        document.getElementById('mergeError').style.display = 'none';
        document.getElementById('mergeLoading').style.display = 'none';
        document.getElementById('mergeSelectedContainer').style.display = 'none';
        document.getElementById('confirmMergeBtn').disabled = true;
        openModal('mergeGamesModal');

        try {
            const response = await fetch('/api/games-management?sort=title');
            if (!response.ok) {
                throw new Error('Failed to load games');
            }
            const data = await response.json();
            overviewAllGamesForMerge = (data.games || []).filter(game => game.id !== gameId);
            renderMergeGamesList(overviewAllGamesForMerge);
        } catch (error) {
            document.getElementById('mergeError').textContent = error.message;
            document.getElementById('mergeError').style.display = '';
        }
    }

    function renderMergeGamesList(games) {
        const list = document.getElementById('mergeGamesList');
        list.innerHTML = '';

        if (games.length === 0) {
            list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-tertiary);">No games available to merge</div>';
            return;
        }

        games.forEach(game => {
            const item = document.createElement('div');
            item.className = 'merge-game-item'
                + (overviewMergeSelectedGames.some(selected => selected.id === game.id) ? ' selected' : '');

            const isChecked = overviewMergeSelectedGames.some(selected => selected.id === game.id);
            item.innerHTML = `
                <input type="checkbox" ${isChecked ? 'checked' : ''}>
                <div class="merge-game-info">
                    <div class="merge-game-name">${escapeHtml(game.title_original)}</div>
                    <div class="merge-game-stats">${Number(game.line_count || 0).toLocaleString()} lines, ${Number(game.mined_character_count || 0).toLocaleString()} chars</div>
                </div>
            `;

            item.addEventListener('click', () => {
                toggleMergeSelection(game);
            });

            list.appendChild(item);
        });
    }

    function toggleMergeSelection(game) {
        const existingIndex = overviewMergeSelectedGames.findIndex(selected => selected.id === game.id);
        if (existingIndex >= 0) {
            overviewMergeSelectedGames.splice(existingIndex, 1);
        } else {
            overviewMergeSelectedGames.push(game);
        }
        updateMergeUI();
    }

    function updateMergeUI() {
        const query = document.getElementById('mergeSearchInput').value.trim().toLowerCase();
        const filteredGames = query
            ? overviewAllGamesForMerge.filter(game =>
                (game.title_original || '').toLowerCase().includes(query)
                || (game.title_romaji || '').toLowerCase().includes(query)
                || (game.title_english || '').toLowerCase().includes(query)
            )
            : overviewAllGamesForMerge;

        renderMergeGamesList(filteredGames);

        const container = document.getElementById('mergeSelectedContainer');
        const list = document.getElementById('mergeSelectedList');
        if (overviewMergeSelectedGames.length > 0) {
            container.style.display = '';
            list.innerHTML = '';
            overviewMergeSelectedGames.forEach(game => {
                const tag = document.createElement('span');
                tag.className = 'merge-selected-tag';
                tag.innerHTML = `${escapeHtml(game.title_original)} <button class="remove-btn">&times;</button>`;
                tag.querySelector('.remove-btn').addEventListener('click', event => {
                    event.stopPropagation();
                    toggleMergeSelection(game);
                });
                list.appendChild(tag);
            });
        } else {
            container.style.display = 'none';
        }

        document.getElementById('confirmMergeBtn').disabled = overviewMergeSelectedGames.length === 0;
    }

    function openUnlinkModal() {
        if (!_currentManagedGameData) {
            return;
        }
        document.getElementById('unlinkGameName').textContent = getCurrentManagedGameName();
        document.getElementById('unlinkError').style.display = 'none';
        document.getElementById('unlinkLoading').style.display = 'none';
        openModal('unlinkGameModal');
    }

    function openDeleteModal() {
        if (!_currentManagedGameData) {
            return;
        }
        document.getElementById('deleteGameName').textContent = getCurrentManagedGameName();
        document.getElementById('deleteGameSentences').textContent = _currentManagedGameStats
            ? Number(_currentManagedGameStats.total_sentences || 0).toLocaleString()
            : '-';
        document.getElementById('deleteError').style.display = 'none';
        document.getElementById('deleteLoading').style.display = 'none';
        openModal('deleteGameModal');
    }

    async function repullCurrentManagedGameMetadata() {
        const gameId = getCurrentManagedGameId();
        if (!gameId || !_currentManagedGameData) {
            return;
        }

        const gameName = getCurrentManagedGameName();
        if (!window.confirm(`Re-pull metadata for "${gameName}"?\n\nThis will update all non-manually-edited fields with fresh data from the linked source (Jiten, VNDB, AniList, or IGDB).`)) {
            return;
        }

        try {
            const response = await fetch(`/api/games/${gameId}/repull-jiten`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || 'Unknown error');
            }

            let message = 'Metadata re-pulled successfully!';
            if (result.sources_used && result.sources_used.length > 0) {
                message += `\nSources: ${result.sources_used.join(', ')}`;
            }
            if (result.updated_fields && result.updated_fields.length > 0) {
                message += `\nUpdated: ${result.updated_fields.join(', ')}`;
            }
            if (result.skipped_fields && result.skipped_fields.length > 0) {
                message += `\nSkipped (manually edited): ${result.skipped_fields.join(', ')}`;
            }

            alert(message);
            refreshOverviewAfterGameManagement();
        } catch (error) {
            alert(`Failed to re-pull metadata: ${error.message}`);
        }
    }

    let currentSessionGameImportWidget = null;

    function getCurrentSessionGameImportWidget() {
        if (!currentSessionGameImportWidget) {
            if (!window.GameImportWidget || typeof window.GameImportWidget.create !== 'function') {
                throw new Error('Game import widget is not loaded. Please refresh the page.');
            }

            currentSessionGameImportWidget = window.GameImportWidget.create({
                buildCurrentPreviewHtml: function(context, helpers) {
                    return ''
                        + `<h5>${helpers.escapeHtml(context.displayName || '')}</h5>`
                        + '<div style="color: var(--text-secondary); font-size: 13px; margin-top: 4px;">'
                            + `${helpers.formatNumber(context.sentenceCount)} sentences, `
                            + `${helpers.formatNumber(context.characterCount)} characters`
                        + '</div>';
                },
                onSuccess: function(payload) {
                    if (payload.isJitenSource) {
                        alert(`Successfully linked to ${payload.sourceLabel}! ${payload.apiResult.lines_linked || 0} lines linked.`);
                    } else if (payload.source === 'igdb') {
                        alert(`Successfully updated with ${payload.sourceLabel} metadata!\nNote: IGDB does not include character data.`);
                    } else {
                        alert(`Successfully updated with ${payload.sourceLabel} metadata!\nNote: Character counts and difficulty are only available from Jiten.`);
                    }

                    refreshOverviewAfterGameManagement();
                },
            });
        }

        return currentSessionGameImportWidget;
    }

    function openLinkSearchModal() {
        if (!_currentManagedGameData) {
            return;
        }

        try {
            getCurrentSessionGameImportWidget().open({
                gameId: getCurrentManagedGameId(),
                game: _currentManagedGameData,
                displayName: getCurrentManagedGameName(),
                searchTerm: getCurrentManagedGameName(),
                sentenceCount: (_currentManagedGameStats && _currentManagedGameStats.total_sentences) || 0,
                characterCount: (_currentManagedGameStats && _currentManagedGameStats.total_characters) || 0,
            });
        } catch (error) {
            alert(error.message);
        }
    }

    function updateCurrentGameDashboard(stats) {
        _cachedCurrentGameStats = stats;
        if (!stats) {
            showNoDashboardData('currentGameCard', 'No current game data available');
            return;
        }

        // Track which game is currently displayed so session navigation
        // can skip re-fetching when the game hasn't changed
        if (stats.game_id) {
            _currentlyDisplayedGameId = stats.game_id;
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
            
            // Update genres (limit to 5)
            const genresContainer = document.getElementById('gameGenresContainer');
            const genresPills = document.getElementById('gameGenresPills');
            if (stats.genres && stats.genres.length > 0) {
                genresPills.innerHTML = '';
                
                const genresToShow = stats.genres.slice(0, 5);
                genresToShow.forEach(genre => {
                    const pill = document.createElement('span');
                    pill.className = 'game-genre-pill';
                    pill.textContent = genre;
                    genresPills.appendChild(pill);
                });
                
                genresContainer.style.display = 'flex';
            } else {
                genresContainer.style.display = 'none';
            }
            
            // Update tags (limit to 5)
            const tagsContainer = document.getElementById('gameTagsContainer');
            const tagsPills = document.getElementById('gameTagsPills');
            if (stats.tags && stats.tags.length > 0) {
                tagsPills.innerHTML = '';
                
                const tagsToShow = stats.tags.slice(0, 5);
                tagsToShow.forEach(tag => {
                    const pill = document.createElement('span');
                    pill.className = 'game-tag-pill';
                    pill.textContent = tag;
                    tagsPills.appendChild(pill);
                });
                
                tagsContainer.style.display = 'flex';
            } else {
                tagsContainer.style.display = 'none';
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
        
        document.getElementById('currentTotalTime').textContent = window.formatTime(stats.total_time_hours || 0);
        
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
        _cachedAllGamesStats = stats;
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
        
        document.getElementById('allTotalTime').textContent = window.formatTime(stats.total_time_hours || 0);
        
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
        if (!card) return;
        const statsGrid = card.querySelector('.dashboard-stats-grid');
        const progressSection = card.querySelector('.dashboard-progress-section');
        
        // Hide stats and progress sections
        if (statsGrid) statsGrid.style.display = 'none';
        if (progressSection) progressSection.style.display = 'none';
        
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

    if (currentSessionSettingsCogBtn && currentSessionSettingsCogDropdown) {
        currentSessionSettingsCogBtn.addEventListener('click', function(event) {
            event.stopPropagation();
            if (!getCurrentManagedGameId()) {
                return;
            }
            currentSessionSettingsCogDropdown.classList.toggle('show');
        });

        currentSessionSettingsCogDropdown.addEventListener('click', function(event) {
            event.stopPropagation();
        });

        document.addEventListener('click', function() {
            closeCurrentSessionSettingsDropdown();
        });

        currentSessionSettingsCogDropdown.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', function() {
                const action = this.getAttribute('data-action');
                closeCurrentSessionSettingsDropdown();

                switch (action) {
                    case 'editGame':
                        openEditModal();
                        break;
                    case 'linkExternal':
                        openLinkSearchModal();
                        break;
                    case 'repullMetadata':
                        repullCurrentManagedGameMetadata();
                        break;
                    case 'markComplete':
                        markCurrentManagedGameComplete();
                        break;
                    case 'mergeGames':
                        openMergeModal();
                        break;
                    case 'unlinkGame':
                        openUnlinkModal();
                        break;
                    case 'deleteGame':
                        openDeleteModal();
                        break;
                    default:
                        break;
                }
            });
        });
    }

    const editImageUpload = document.getElementById('editImageUpload');
    if (editImageUpload) {
        editImageUpload.addEventListener('change', function(event) {
            const file = event.target.files[0];
            if (!file) {
                return;
            }

            const reader = new FileReader();
            reader.onload = function(loadEvent) {
                document.getElementById('editImagePreviewImg').src = loadEvent.target.result;
                document.getElementById('editImagePreview').style.display = '';
            };
            reader.readAsDataURL(file);
        });
    }

    const saveGameEditsBtn = document.getElementById('saveGameEditsBtn');
    if (saveGameEditsBtn) {
        saveGameEditsBtn.addEventListener('click', saveCurrentManagedGameEdits);
    }

    document.querySelectorAll('[data-action="closeEditModal"]').forEach(btn => {
        btn.addEventListener('click', function() {
            closeModal('editGameModal');
        });
    });

    const mergeSearchInput = document.getElementById('mergeSearchInput');
    if (mergeSearchInput) {
        mergeSearchInput.addEventListener('input', function() {
            const query = this.value.trim().toLowerCase();
            const filteredGames = query
                ? overviewAllGamesForMerge.filter(game =>
                    (game.title_original || '').toLowerCase().includes(query)
                    || (game.title_romaji || '').toLowerCase().includes(query)
                    || (game.title_english || '').toLowerCase().includes(query)
                )
                : overviewAllGamesForMerge;
            renderMergeGamesList(filteredGames);
        });
    }

    const confirmMergeBtn = document.getElementById('confirmMergeBtn');
    if (confirmMergeBtn) {
        confirmMergeBtn.addEventListener('click', async function() {
            if (overviewMergeSelectedGames.length === 0 || !_currentManagedGameData) {
                return;
            }

            const errorEl = document.getElementById('mergeError');
            const loadingEl = document.getElementById('mergeLoading');
            errorEl.style.display = 'none';
            loadingEl.style.display = 'flex';
            this.disabled = true;

            try {
                const response = await fetch('/api/merge_games', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        target_game: getCurrentManagedGameSceneName(),
                        games_to_merge: overviewMergeSelectedGames.map(game =>
                            game.obs_scene_name || game.title_original || game.title_romaji || game.title_english
                        ),
                    }),
                });

                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    throw new Error(errData.error || 'Merge failed');
                }

                closeModal('mergeGamesModal');
                refreshOverviewAfterGameManagement();
            } catch (error) {
                errorEl.textContent = error.message;
                errorEl.style.display = '';
            } finally {
                loadingEl.style.display = 'none';
                this.disabled = overviewMergeSelectedGames.length === 0;
            }
        });
    }

    document.querySelectorAll('[data-action="closeMergeModal"]').forEach(btn => {
        btn.addEventListener('click', function() {
            closeModal('mergeGamesModal');
        });
    });

    const confirmUnlinkBtn = document.getElementById('confirmUnlinkBtn');
    if (confirmUnlinkBtn) {
        confirmUnlinkBtn.addEventListener('click', async function() {
            const gameId = getCurrentManagedGameId();
            if (!gameId) {
                return;
            }

            const errorEl = document.getElementById('unlinkError');
            const loadingEl = document.getElementById('unlinkLoading');
            errorEl.style.display = 'none';
            loadingEl.style.display = 'flex';
            this.disabled = true;

            try {
                const response = await fetch(`/api/games/${gameId}`, {
                    method: 'DELETE',
                });

                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    throw new Error(errData.error || 'Unlink failed');
                }

                closeModal('unlinkGameModal');
                refreshOverviewAfterGameManagement();
            } catch (error) {
                errorEl.textContent = error.message;
                errorEl.style.display = '';
            } finally {
                loadingEl.style.display = 'none';
                this.disabled = false;
            }
        });
    }

    document.querySelectorAll('[data-action="closeUnlinkModal"]').forEach(btn => {
        btn.addEventListener('click', function() {
            closeModal('unlinkGameModal');
        });
    });

    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', async function() {
            const gameId = getCurrentManagedGameId();
            if (!gameId) {
                return;
            }

            const errorEl = document.getElementById('deleteError');
            const loadingEl = document.getElementById('deleteLoading');
            errorEl.style.display = 'none';
            loadingEl.style.display = 'flex';
            this.disabled = true;

            try {
                const response = await fetch(`/api/games/${gameId}/delete-lines`, {
                    method: 'DELETE',
                });

                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    throw new Error(errData.error || 'Delete failed');
                }

                closeModal('deleteGameModal');
                refreshOverviewAfterGameManagement({ preserveCurrentSelection: false });
            } catch (error) {
                errorEl.textContent = error.message;
                errorEl.style.display = '';
            } finally {
                loadingEl.style.display = 'none';
                this.disabled = false;
            }
        });
    }

    document.querySelectorAll('[data-action="closeDeleteModal"]').forEach(btn => {
        btn.addEventListener('click', function() {
            closeModal('deleteGameModal');
        });
    });

    // Game completion button handler
    const gameCompletionBtn = document.getElementById('gameCompletionBtn');
    if (gameCompletionBtn) {
        gameCompletionBtn.addEventListener('click', async function() {
            if (this.disabled || !getCurrentManagedGameId()) {
                return;
            }

            const confirmMsg = `Mark "${getCurrentManagedGameName()}" as completed?`;
            if (!confirm(confirmMsg)) {
                return;
            }

            try {
                await markCurrentManagedGameComplete({ celebrate: true });
            } catch (error) {
                console.error('Error marking game as complete:', error);
            }
        });
    }

});
