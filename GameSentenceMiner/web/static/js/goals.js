// Goals Page JavaScript
// Dependencies: shared.js (provides utility functions like showElement, hideElement, escapeHtml)

// ================================
// Constants
// ================================
const ALLOWED_METRIC_TYPES = ['hours', 'characters', 'games', 'cards', 'mature_cards', /* 'anki_backlog', */ 'custom'];

// ================================
// Shared Utility Functions
// ================================
const GoalsUtils = {
    // Get user's timezone
    getUserTimezone() {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch (e) {
            console.warn('Could not detect timezone, defaulting to UTC:', e);
            return 'UTC';
        }
    },

    // Get headers with timezone for API requests
    getHeadersWithTimezone() {
        return {
            'Content-Type': 'application/json',
            'X-Timezone': this.getUserTimezone()
        };
    },

    // Format date as YYYY-MM-DD
    formatDateString(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    },

    // Get today's date string
    getTodayDateString() {
        return this.formatDateString(new Date());
    },

    // Metric labels mapping
    getMetricLabels() {
        return {
            'hours': 'Hours',
            'characters': 'Characters',
            'games': 'Games',
            'cards': 'Cards Mined',
            'mature_cards': 'Mature Anki Cards'
            // 'anki_backlog': 'New Cards'
            // Requires keeping track of how many new cards a day are done, otherwise we can only calculate from today to the end date. Because of this, we cannot create nice dailies or progress bars that makes this no different from doing it by hand. Commenting out and might revisit later
        };
    },

    // Capitalize first letter of a string
    capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    },

    // Get goals from localStorage or database
    async getGoalsWithFallback() {
        let currentGoals = CustomGoalsManager.getAll();

        if (!currentGoals || currentGoals.length === 0) {
            try {
                const goalsResponse = await fetch('/api/goals/latest_goals');
                if (goalsResponse.ok) {
                    const goalsData = await goalsResponse.json();
                    currentGoals = goalsData.current_goals || [];
                }
            } catch (error) {
                console.warn('Could not fetch goals from database, using empty array:', error);
                currentGoals = [];
            }
        }

        return currentGoals;
    },

    // Prepare goals settings object with easy days and AnkiConnect settings
    async prepareGoalsSettings() {
        return {
            easyDays: await EasyDaysManager.getSettings(),
            ankiConnect: await AnkiConnectManager.getSettings()
        };
    },

    // Render action buttons for goal cards
    renderActionButtons(goalId) {
        return `
            <div class="custom-goal-actions" style="margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end;">
                <button onclick="editCustomGoal('${goalId}')" class="goal-action-btn edit-btn" title="Edit goal">
                    ✏️ Edit
                </button>
                <button onclick="deleteCustomGoal('${goalId}')" class="goal-action-btn delete-btn" title="Delete goal">
                    🗑️ Delete
                </button>
            </div>
        `;
    }
};

// ================================
// AnkiConnect Manager Module
// ================================
const AnkiConnectManager = {
    STORAGE_KEY: 'gsm_anki_connect_settings_v2',

    // Get default settings
    getDefaultSettings() {
        return {
            deckName: ''
        };
    },
    
    // Get versioned data from localStorage
    getVersionedLocal() {
        const stored = localStorage.getItem(this.STORAGE_KEY);
        if (stored) {
            try {
                return JSON.parse(stored);
            } catch (e) {
                return { version: 0, data: this.getDefaultSettings(), lastModified: 0 };
            }
        }
        
        return { version: 0, data: this.getDefaultSettings(), lastModified: 0 };
    },
    
    // Save versioned data to localStorage
    saveVersionedLocal(versionedData) {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(versionedData));
    },

    // Get settings from localStorage (returns just the data, not the version wrapper)
    async getSettings() {
        try {
            const localVersioned = this.getVersionedLocal();
            return localVersioned.data;
        } catch (error) {
            console.error('Error reading AnkiConnect settings:', error);
            return this.getDefaultSettings();
        }
    },

    // Save settings to localStorage (increments version)
    saveSettings(settings) {
        try {
            const current = this.getVersionedLocal();
            const newVersioned = {
                version: (current.version || 0) + 1,
                data: settings,
                lastModified: Date.now()
            };
            this.saveVersionedLocal(newVersioned);
            console.log(`Saved AnkiConnect settings with version ${newVersioned.version}`);
            return { success: true };
        } catch (error) {
            console.error('Error saving AnkiConnect settings to localStorage:', error);
            return {
                success: false,
                error: 'Failed to save settings'
            };
        }
    }
};

// ================================
// Easy Days Manager Module
// ================================
const EasyDaysManager = {
    STORAGE_KEY: 'gsm_easy_days_settings_v2',

    // Get default settings (all days at 100%)
    getDefaultSettings() {
        return {
            monday: 100,
            tuesday: 100,
            wednesday: 100,
            thursday: 100,
            friday: 100,
            saturday: 100,
            sunday: 100
        };
    },
    
    // Get versioned data from localStorage
    getVersionedLocal() {
        const stored = localStorage.getItem(this.STORAGE_KEY);
        if (stored) {
            try {
                return JSON.parse(stored);
            } catch (e) {
                return { version: 0, data: this.getDefaultSettings(), lastModified: 0 };
            }
        }
        
        return { version: 0, data: this.getDefaultSettings(), lastModified: 0 };
    },
    
    // Save versioned data to localStorage
    saveVersionedLocal(versionedData) {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(versionedData));
    },

    // Get settings from localStorage (returns just the data, not the version wrapper)
    async getSettings() {
        try {
            const localVersioned = this.getVersionedLocal();
            return localVersioned.data;
        } catch (error) {
            console.error('Error reading easy days settings:', error);
            return this.getDefaultSettings();
        }
    },

    // Save settings to localStorage with validation (increments version)
    saveSettings(settings) {
        // Validate: at least one day must be at 100%
        const values = Object.values(settings);
        const hasFullDay = values.some(val => val === 100);

        if (!hasFullDay) {
            return {
                success: false,
                error: 'At least one day must be set to 100%'
            };
        }

        try {
            const current = this.getVersionedLocal();
            const newVersioned = {
                version: (current.version || 0) + 1,
                data: settings,
                lastModified: Date.now()
            };
            this.saveVersionedLocal(newVersioned);
            console.log(`Saved easy days settings with version ${newVersioned.version}`);
            return { success: true };
        } catch (error) {
            console.error('Error saving easy days settings to localStorage:', error);
            return {
                success: false,
                error: 'Failed to save settings'
            };
        }
    }
};

// ================================
// Custom Goal Checkbox Manager Module
// ================================
const CustomGoalCheckboxManager = {
    STORAGE_KEY: 'gsm_custom_goal_checkboxes',

    // Get today's date string in YYYY-MM-DD format
    getTodayDateString() {
        return GoalsUtils.getTodayDateString();
    },

    // Get all checkbox states from localStorage
    getAll() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            return stored ? JSON.parse(stored) : {};
        } catch (error) {
            console.error('Error reading checkbox states from localStorage:', error);
            return {};
        }
    },

    // Save all checkbox states to localStorage
    saveAll(states) {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(states));
            return true;
        } catch (error) {
            console.error('Error saving checkbox states to localStorage:', error);
            return false;
        }
    },

    // Get state for a specific goal
    getState(goalId) {
        const allStates = this.getAll();
        return allStates[goalId] || {
            completionDates: [],
            currentStreak: 0,
            longestStreak: 0,
            lastCheckedDate: null,
            lastResetDate: null
        };
    },

    // Check if goal is completed today
    isCompletedToday(goalId) {
        const state = this.getState(goalId);
        const today = this.getTodayDateString();
        return state.lastCheckedDate === today;
    },

    // Check if goal needs reset (new day)
    needsReset(goalId) {
        const state = this.getState(goalId);
        const today = this.getTodayDateString();
        return state.lastResetDate !== today;
    },

    // Reset checkbox for new day
    resetForNewDay(goalId) {
        const allStates = this.getAll();
        const state = this.getState(goalId);
        const today = this.getTodayDateString();

        state.lastResetDate = today;
        allStates[goalId] = state;

        this.saveAll(allStates);
        return state;
    },

    // Calculate streak from completion dates
    calculateStreak(completionDates) {
        if (!completionDates || completionDates.length === 0) {
            return 0;
        }

        // Sort dates in descending order (most recent first)
        const sortedDates = [...completionDates].sort((a, b) => b.localeCompare(a));

        // Start from the most recent completion date
        let streak = 1;
        let prevDate = new Date(sortedDates[0]);

        // Count consecutive days backwards from the most recent date
        for (let i = 1; i < sortedDates.length; i++) {
            // Calculate expected previous date
            prevDate.setDate(prevDate.getDate() - 1);
            const expectedDate = GoalsUtils.formatDateString(prevDate);

            if (sortedDates[i] === expectedDate) {
                streak++;
            } else {
                // Streak is broken, stop counting
                break;
            }
        }

        return streak;
    },

    // Mark goal as completed for today
    markCompleted(goalId) {
        const allStates = this.getAll();
        const state = this.getState(goalId);
        const today = this.getTodayDateString();

        // Add today to completion dates if not already there
        if (!state.completionDates.includes(today)) {
            state.completionDates.push(today);
        }

        state.lastCheckedDate = today;
        state.lastResetDate = today;

        // Calculate current streak
        state.currentStreak = this.calculateStreak(state.completionDates);

        // Update longest streak if current is higher
        if (state.currentStreak > state.longestStreak) {
            state.longestStreak = state.currentStreak;
        }

        allStates[goalId] = state;
        this.saveAll(allStates);

        return state;
    },

    // Initialize or reset all custom goals for new day
    async initializeForNewDay() {
        const allGoals = await CustomGoalsManager.getAll();
        const customGoals = allGoals.filter(g => g.metricType === 'custom');

        for (const goal of customGoals) {
            if (this.needsReset(goal.id)) {
                this.resetForNewDay(goal.id);
            }
        }
    }
};

// ================================
// Custom Goals Manager Module
// ================================
const CustomGoalsManager = {
    STORAGE_KEY: 'gsm_custom_goals_v2',

    // Generate unique ID for goals
    generateId() {
        return 'goal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
    },
    
    // Get versioned data from localStorage
    getVersionedLocal() {
        const stored = localStorage.getItem(this.STORAGE_KEY);
        if (stored) {
            try {
                return JSON.parse(stored);
            } catch (e) {
                return { version: 0, data: [], lastModified: 0 };
            }
        }
        
        return { version: 0, data: [], lastModified: 0 };
    },
    
    // Save versioned data to localStorage
    saveVersionedLocal(versionedData) {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(versionedData));
    },

    // Get all custom goals (returns just the data, not the version wrapper)
    async getAll() {
        try {
            const localVersioned = this.getVersionedLocal();
            return localVersioned.data;
        } catch (error) {
            console.error('Error reading custom goals:', error);
            return [];
        }
    },

    // Get active goals (within current date or future)
    async getActive() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().split('T')[0];

        const allGoals = await this.getAll();
        return allGoals.filter(goal => {
            // Custom goals are always active
            if (goal.metricType === 'custom') return true;
            return goal.endDate >= todayStr;
        });
    },

    // Get goals that are currently in progress (today is within date range)
    async getInProgress() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().split('T')[0];

        const allGoals = await this.getAll();
        return allGoals.filter(goal => {
            // Custom goals are always in progress
            if (goal.metricType === 'custom') return true;
            return goal.startDate <= todayStr && goal.endDate >= todayStr;
        });
    },

    // Save all goals to localStorage (increments version)
    saveAll(goals) {
        try {
            const current = this.getVersionedLocal();
            const newVersioned = {
                version: (current.version || 0) + 1,
                data: goals,
                lastModified: Date.now()
            };
            this.saveVersionedLocal(newVersioned);
            console.log(`Saved custom goals with version ${newVersioned.version}`);
            return true;
        } catch (error) {
            console.error('Error saving custom goals to localStorage:', error);
            return false;
        }
    },

    // Create new goal
    async create(goalData) {
        const goals = await this.getAll();
        const newGoal = {
            id: this.generateId(),
            name: goalData.name,
            metricType: goalData.metricType,
            targetValue: goalData.targetValue,
            startDate: goalData.startDate,
            endDate: goalData.endDate,
            icon: goalData.icon || this.getDefaultIcon(goalData.metricType),
            createdAt: Date.now()
        };

        goals.push(newGoal);
        this.saveAll(goals);
        return newGoal;
    },

    // Update existing goal
    async update(id, goalData) {
        const goals = await this.getAll();
        const index = goals.findIndex(g => g.id === id);

        if (index === -1) {
            return false;
        }

        goals[index] = {
            ...goals[index],
            name: goalData.name,
            metricType: goalData.metricType,
            targetValue: goalData.targetValue,
            startDate: goalData.startDate,
            endDate: goalData.endDate,
            icon: goalData.icon || goals[index].icon
        };

        return this.saveAll(goals);
    },

    // Delete goal
    async delete(id) {
        const goals = await this.getAll();
        const filtered = goals.filter(g => g.id !== id);
        return this.saveAll(filtered);
    },

    // Get goal by ID
    async getById(id) {
        const goals = await this.getAll();
        return goals.find(g => g.id === id);
    },

    // Get default icon for metric type
    getDefaultIcon(metricType) {
        const icons = {
            'hours': '⏱️',
            'characters': '📖',
            'games': '🎮',
            'cards': '🎴',
            'mature_cards': '📚',
            // 'anki_backlog': '📥',
            // Requires keeping track of how many new cards a day are done, otherwise we can only calculate from today to the end date. Because of this, we cannot create nice dailies or progress bars that makes this no different from doing it by hand. Commenting out and might revisit later
            'custom': '✅'
        };
        return icons[metricType] || '🎯';
    },

    // Validate goal data
    validate(goalData) {
        const errors = [];

        if (!goalData.name || goalData.name.trim() === '') {
            errors.push('Goal name is required');
        }

        if (!goalData.metricType || !ALLOWED_METRIC_TYPES.includes(goalData.metricType)) {
            errors.push('Valid metric type is required (hours, characters, games, cards, mature_cards, or custom)');
        }

        // For custom goals, targetValue and startDate are optional
        // For anki_backlog goals (commented out), targetValue and startDate are optional
        if (goalData.metricType !== 'custom' /* && goalData.metricType !== 'anki_backlog' */) {
            if (!goalData.targetValue || goalData.targetValue <= 0) {
                errors.push('Target value must be greater than 0');
            }

            if (!goalData.startDate) {
                errors.push('Start date is required');
            }

            if (!goalData.endDate) {
                errors.push('End date is required');
            }

            if (goalData.startDate && goalData.endDate && goalData.startDate > goalData.endDate) {
                errors.push('End date must be after start date');
            }
        }
        // Requires keeping track of how many new cards a day are done, otherwise we can only calculate from today to the end date. Because of this, we cannot create nice dailies or progress bars that makes this no different from doing it by hand. Commenting out and might revisit later
        /* else if (goalData.metricType === 'anki_backlog') {
            // For anki_backlog, only end date is required
            if (!goalData.endDate) {
                errors.push('End date is required for backlog goals');
            }
        } */

        return errors;
    }
};

// ================================
// Module-level cache for date string conversions
// ================================
const dateStrCache = new Map();

document.addEventListener('DOMContentLoaded', function () {

    // Initialize checkbox states for new day
    CustomGoalCheckboxManager.initializeForNewDay().catch(err => {
        console.error('Error initializing checkbox states:', err);
    });

    // Helper function to format large numbers
    function formatGoalNumber(num) {
        if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + 'M';
        } else if (num >= 1000) {
            return (num / 1000).toFixed(1) + 'K';
        }
        return num.toLocaleString();
    }

    // Helper function to format hours
    function formatHours(hours) {
        if (hours < 1) {
            const minutes = Math.round(hours * 60);
            return `${minutes}m`;
        } else {
            const h = Math.floor(hours);
            const m = Math.round((hours - h) * 60);
            return h > 0 ? `${h}h${m > 0 ? ' ' + m + 'm' : ''}` : `${m}m`;
        }
    }

    // Function to update progress bar color based on percentage
    function updateProgressBarColor(progressElement, percentage) {
        progressElement.classList.remove('completion-0', 'completion-25', 'completion-50', 'completion-75', 'completion-100');

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

    // Helper function to calculate progress for custom goal within date range using API
    async function calculateCustomGoalProgress(goal) {
        try {
            const goalsSettings = await GoalsUtils.prepareGoalsSettings();

            const response = await fetch('/api/goals/progress', {
                method: 'POST',
                headers: GoalsUtils.getHeadersWithTimezone(),
                body: JSON.stringify({
                    metric_type: goal.metricType,
                    start_date: goal.startDate,
                    end_date: goal.endDate,
                    goals_settings: goalsSettings
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to fetch goal progress');
            }

            const data = await response.json();
            console.log(`Progress for goal "${goal.name}":`, data.progress);

            return data.progress;
        } catch (error) {
            console.error(`Error calculating progress for goal "${goal.name}":`, error);
            return 0;
        }
    }

    // Helper function to render a custom goal card
    function renderCustomGoalCard(goal, currentProgress, dailyAverage) {
        // Handle custom metric type differently
        if (goal.metricType === 'custom') {
            const state = CustomGoalCheckboxManager.getState(goal.id);

            return `
                <div class="goal-progress-item custom-goal-item custom-goal-checkbox-item" data-goal-id="${goal.id}">
                    <div class="goal-progress-header">
                        <div class="goal-progress-label">
                            <span class="goal-icon">${goal.icon}</span>
                            ${goal.name}
                        </div>
                    </div>
                    ${GoalsUtils.renderActionButtons(goal.id)}
                </div>
            `;
        }

        // Regular goal rendering
        const percentage = Math.min(100, (currentProgress / goal.targetValue) * 100);
        const formattedCurrent = goal.metricType === 'hours' ? Math.floor(currentProgress).toLocaleString() :
            goal.metricType === 'characters' ? formatGoalNumber(currentProgress) :
                currentProgress.toLocaleString();
        const formattedTarget = goal.metricType === 'hours' ? goal.targetValue.toLocaleString() :
            goal.metricType === 'characters' ? formatGoalNumber(goal.targetValue) :
                goal.targetValue.toLocaleString();

        const progressBarClass = `completion-${Math.floor(percentage / 25) * 25}`;

        // Format dates for display
        const startDate = new Date(goal.startDate);
        const endDate = new Date(goal.endDate);
        const formattedStartDate = startDate.toLocaleDateString(navigator.language, { month: 'short', day: 'numeric', year: 'numeric' });
        const formattedEndDate = endDate.toLocaleDateString(navigator.language, { month: 'short', day: 'numeric', year: 'numeric' });

        return `
            <div class="goal-progress-item custom-goal-item" data-goal-id="${goal.id}">
                <div class="goal-progress-header">
                    <div class="goal-progress-label">
                        <span class="goal-icon">${goal.icon}</span>
                        ${goal.name}
                    </div>
                    <div class="goal-progress-values">
                        <span class="goal-current">${formattedCurrent}</span>
                        <span class="goal-separator">/</span>
                        <span class="goal-target">${formattedTarget}</span>
                    </div>
                </div>
                <div class="custom-goal-date-range" style="margin: 8px 0; padding: 6px 12px; background: var(--bg-tertiary); border-radius: 6px; border-left: 3px solid var(--primary-color); font-size: 0.9em;">
                    <span style="opacity: 0.8;">📅</span>
                    <strong style="margin-left: 4px;">${formattedStartDate}</strong>
                    <span style="margin: 0 6px; opacity: 0.6;">→</span>
                    <strong>${formattedEndDate}</strong>
                </div>
                <div class="goal-progress-bar">
                    <div class="goal-progress-fill ${progressBarClass}" style="width: ${percentage}%"></div>
                </div>
                <div class="goal-progress-info">
                    <span class="goal-percentage">${Math.floor(percentage)}%</span>
                </div>
                ${GoalsUtils.renderActionButtons(goal.id)}
            </div>
        `;
    }

    // Function to load goal progress chart
    async function loadGoalProgress() {
        const goalProgressChart = document.getElementById('goalProgressChart');
        const goalProgressLoading = document.getElementById('goalProgressLoading');
        const goalProgressError = document.getElementById('goalProgressError');

        if (!goalProgressChart) return;

        try {
            goalProgressLoading.style.display = 'flex';
            goalProgressError.style.display = 'none';

            const response = await fetch('/api/stats');
            if (!response.ok) throw new Error('Failed to fetch stats data');

            const data = await response.json();
            const allGamesStats = data.allGamesStats;
            const allLinesData = data.allLinesData || [];

            console.log('API Response data keys:', Object.keys(data));
            console.log('allGamesStats:', allGamesStats);

            if (!allGamesStats) {
                throw new Error('No stats data available');
            }

            // Calculate daily averages for custom goals using 90-day lookback period
            const dailyHoursAvg = calculateDailyAverage(allLinesData, 'hours');
            const dailyCharsAvg = calculateDailyAverage(allLinesData, 'characters');
            const dailyGamesAvg = calculateDailyAverage(allLinesData, 'games');

            // Load and render custom goals
            const customGoals = await CustomGoalsManager.getActive();
            const goalProgressGrid = document.querySelector('.goal-progress-grid');

            // Remove existing custom goal cards
            const existingCustomGoals = goalProgressGrid.querySelectorAll('.custom-goal-item');
            existingCustomGoals.forEach(el => el.remove());

            // Add custom goal cards (using async/await for API calls)
            if (customGoals.length > 0) {
                console.log(`Rendering ${customGoals.length} custom goals`);
                for (const goal of customGoals) {
                    console.log('Processing goal:', goal);

                    // For custom goals, skip API call
                    if (goal.metricType === 'custom') {
                        const cardHTML = renderCustomGoalCard(goal, 0, 0);
                        goalProgressGrid.insertAdjacentHTML('beforeend', cardHTML);
                    } else {
                        const progress = await calculateCustomGoalProgress(goal);
                        const dailyAvg = goal.metricType === 'hours' ? dailyHoursAvg :
                            goal.metricType === 'characters' ? dailyCharsAvg :
                                dailyGamesAvg;
                        console.log(`Goal "${goal.name}" progress: ${progress}, daily avg: ${dailyAvg}`);
                        const cardHTML = renderCustomGoalCard(goal, progress, dailyAvg);
                        goalProgressGrid.insertAdjacentHTML('beforeend', cardHTML);
                    }
                }
            } else {
                console.log('No custom goals to render');
            }

            goalProgressLoading.style.display = 'none';

        } catch (error) {
            console.error('Error loading goal progress:', error);
            goalProgressLoading.style.display = 'none';
            goalProgressError.style.display = 'block';
        }
    }

    // Function to calculate daily average using a 90-day lookback period (copied from stats.js)
    function calculateDailyAverage(allLinesData, metricType) {
        if (!allLinesData || allLinesData.length === 0) {
            return 0;
        }

        const today = new Date();
        const ninetyDaysAgo = new Date(today.getTime() - (90 * 24 * 60 * 60 * 1000));

        const recentData = allLinesData.filter(line => {
            const lineDate = new Date(line.timestamp * 1000);
            return lineDate >= ninetyDaysAgo && lineDate <= today;
        });

        if (recentData.length === 0) {
            return 0;
        }

        let dailyTotals = {};

        // Helper function to get cached date string
        const getDateStr = (timestamp) => {
            if (!dateStrCache.has(timestamp)) {
                const dateObj = new Date(timestamp * 1000);
                dateStrCache.set(timestamp, GoalsUtils.formatDateString(dateObj));
            }
            return dateStrCache.get(timestamp);
        };

        if (metricType === 'hours') {
            const dailyTimestamps = {};
            for (const line of recentData) {
                const ts = parseFloat(line.timestamp);
                if (isNaN(ts)) continue;
                const dateStr = getDateStr(ts);
                if (!dailyTimestamps[dateStr]) {
                    dailyTimestamps[dateStr] = [];
                }
                dailyTimestamps[dateStr].push(ts);
            }

            for (const [dateStr, timestamps] of Object.entries(dailyTimestamps)) {
                if (timestamps.length >= 2) {
                    timestamps.sort((a, b) => a - b);
                    let dayHours = 0;
                    const afkTimerSeconds = 120; // Default AFK timer
                    for (let i = 1; i < timestamps.length; i++) {
                        const gap = timestamps[i] - timestamps[i - 1];
                        dayHours += Math.min(gap, afkTimerSeconds) / 3600;
                    }
                    dailyTotals[dateStr] = dayHours;
                } else if (timestamps.length === 1) {
                    dailyTotals[dateStr] = 1 / 3600;
                }
            }
        } else if (metricType === 'characters') {
            for (const line of recentData) {
                const ts = parseFloat(line.timestamp);
                if (isNaN(ts)) continue;
                const dateStr = getDateStr(ts);
                dailyTotals[dateStr] = (dailyTotals[dateStr] || 0) + (line.characters || 0);
            }
        } else if (metricType === 'games') {
            const dailyGames = {};
            for (const line of recentData) {
                const ts = parseFloat(line.timestamp);
                if (isNaN(ts)) continue;
                const dateStr = getDateStr(ts);
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
    function formatProjection(currentValue, targetValue, dailyAverage) {
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

    // Helper function to render a custom goal today item
    function renderCustomGoalTodayItem(goal, todayData) {
        // Handle custom metric type with checkbox
        if (goal.metricType === 'custom') {
            const isCompleted = CustomGoalCheckboxManager.isCompletedToday(goal.id);
            const checkboxClass = isCompleted ? 'custom-goal-checkbox-checked' : '';
            const disabledAttr = isCompleted ? 'disabled' : '';

            return `
                <div class="dashboard-stat-item goal-stat-item custom-goal-checkbox-item tooltip ${checkboxClass}"
                     data-tooltip="Click to mark ${goal.name} as complete for today"
                     data-goal-id="${goal.id}">
                    <div class="custom-goal-checkbox-container" onclick="handleCustomGoalCheckboxClick('${goal.id}')" ${disabledAttr}>
                        <div class="custom-goal-title">
                            <span class="goal-icon">${goal.icon}</span>
                            <span>${goal.name}</span>
                        </div>
                        <div class="custom-goal-checkbox">
                            <span class="custom-goal-checkbox-icon">${isCompleted ? '✓' : ''}</span>
                        </div>
                    </div>
                </div>
            `;
        }

        // Regular goal rendering
        const metricLabels = GoalsUtils.getMetricLabels();
        const metricLabel = metricLabels[goal.metricType] || 'Progress';

        // Format values based on metric type
        let formattedProgress, formattedRequired;
        if (goal.metricType === 'hours') {
            formattedProgress = formatHours(todayData.progress);
            formattedRequired = formatHours(todayData.required);
        } else if (goal.metricType === 'characters') {
            formattedProgress = formatGoalNumber(todayData.progress);
            formattedRequired = formatGoalNumber(todayData.required);
        } else if (goal.metricType === 'cards' || goal.metricType === 'mature_cards' /* || goal.metricType === 'anki_backlog' */) {
            formattedProgress = todayData.progress.toLocaleString();
            formattedRequired = todayData.required.toLocaleString();
        } else {
            formattedProgress = todayData.progress.toLocaleString();
            formattedRequired = todayData.required.toLocaleString();
        }

        // Check if goal is met
        const isGoalMet = todayData.progress >= todayData.required;
        const goalMetClass = isGoalMet ? 'goal-met' : '';

        return `
            <div class="dashboard-stat-item goal-stat-item custom-goal-today-item tooltip ${goalMetClass}"
                 data-tooltip="Your progress toward today's ${goal.name} goal"
                 data-goal-id="${goal.id}">
                <span class="dashboard-stat-value">
                    <span class="goal-icon" style="margin-right: 4px;">${goal.icon}</span>
                    <span>${formattedProgress}</span>
                    <span class="goal-separator">/</span>
                    <span>${formattedRequired}</span>
                    <span style="margin-left: 4px;">${metricLabel}</span>
                </span>
                <span class="dashboard-stat-label">${goal.name}</span>
            </div>
        `;
    }

    // Global function to handle custom goal checkbox clicks
    window.handleCustomGoalCheckboxClick = function (goalId) {
        const isCompleted = CustomGoalCheckboxManager.isCompletedToday(goalId);

        if (isCompleted) {
            return; // Already completed today, ignore click
        }

        // Mark as completed
        const state = CustomGoalCheckboxManager.markCompleted(goalId);

        // Update UI
        const checkboxItem = document.querySelector(`.custom-goal-checkbox-item[data-goal-id="${goalId}"]`);
        if (checkboxItem) {
            checkboxItem.classList.add('custom-goal-checkbox-checked');
            const icon = checkboxItem.querySelector('.custom-goal-checkbox-icon');
            if (icon) {
                icon.textContent = '✓';
            }

            // Disable further clicks
            const container = checkboxItem.querySelector('.custom-goal-checkbox-container');
            if (container) {
                container.setAttribute('disabled', 'true');
            }
        }

        // Reload goal progress to update streak display
        loadGoalProgress();
    };

    // Function to load today's goals
    async function loadTodayGoals() {
        try {
            // Note: Client-side date calculation is intentional to respect user's local timezone
            const dateStr = GoalsUtils.getTodayDateString();
            document.getElementById('todayGoalsDate').textContent = dateStr;

            let hasAnyTarget = false;

            // Load custom goals today progress
            const customGoals = await CustomGoalsManager.getInProgress();
            const todayGoalsStats = document.getElementById('todayGoalsStats');

            // Remove existing custom goal today items
            const existingCustomItems = todayGoalsStats.querySelectorAll('.custom-goal-today-item');
            existingCustomItems.forEach(el => el.remove());

            // Add custom goal today items
            if (customGoals.length > 0) {
                console.log(`Loading today progress for ${customGoals.length} custom goals`);
                for (const goal of customGoals) {
                    // Handle custom metric type differently
                    if (goal.metricType === 'custom') {
                        hasAnyTarget = true;
                        const itemHTML = renderCustomGoalTodayItem(goal, null);
                        todayGoalsStats.insertAdjacentHTML('beforeend', itemHTML);
                    } else {
                        try {
                            const goalsSettings = await GoalsUtils.prepareGoalsSettings();

                            const response = await fetch('/api/goals/today-progress', {
                                method: 'POST',
                                headers: GoalsUtils.getHeadersWithTimezone(),
                                body: JSON.stringify({
                                    goal_id: goal.id,
                                    metric_type: goal.metricType,
                                    target_value: goal.targetValue,
                                    start_date: goal.startDate,
                                    end_date: goal.endDate,
                                    goals_settings: goalsSettings
                                })
                            });

                            if (!response.ok) {
                                console.error(`Failed to fetch today progress for goal ${goal.id}`);
                                continue;
                            }

                            const todayData = await response.json();

                            // Only show if has target and not expired/not started and required value is not 0
                            if (todayData.has_target && !todayData.expired && !todayData.not_started && todayData.required !== 0) {
                                hasAnyTarget = true;
                                const itemHTML = renderCustomGoalTodayItem(goal, todayData);
                                todayGoalsStats.insertAdjacentHTML('beforeend', itemHTML);
                            }
                        } catch (error) {
                            console.error(`Error loading today progress for goal ${goal.id}:`, error);
                        }
                    }
                }
            }

            // Show/hide sections based on whether any targets are set
            if (hasAnyTarget) {
                document.getElementById('noTargetsMessage').style.display = 'none';
                document.getElementById('todayGoalsStats').style.display = 'grid';
            } else {
                document.getElementById('noTargetsMessage').style.display = 'block';
                document.getElementById('todayGoalsStats').style.display = 'none';
            }

        } catch (error) {
            console.error('Error loading today goals:', error);
        }
    }

    // Helper function to render a custom goal projection item
    function renderCustomGoalProjectionItem(goal, projectionData) {
        const metricLabels = GoalsUtils.getMetricLabels();
        const metricLabel = metricLabels[goal.metricType] || 'Progress';

        // Format projected value based on metric type
        let formattedProjection;
        if (goal.metricType === 'hours') {
            formattedProjection = Math.floor(projectionData.projection).toLocaleString() + 'h';
        } else if (goal.metricType === 'characters') {
            formattedProjection = formatGoalNumber(projectionData.projection);
        } else {
            formattedProjection = projectionData.projection.toLocaleString();
        }

        // Format target date
        const targetDate = new Date(projectionData.end_date);
        const formattedTargetDate = targetDate.toLocaleDateString(navigator.language);

        // Calculate projected completion date
        const remaining = Math.max(0, projectionData.target - projectionData.current);
        const daysToComplete = projectionData.daily_average > 0 ?
            Math.ceil(remaining / projectionData.daily_average) : 0;
        const completionDate = new Date();
        completionDate.setDate(completionDate.getDate() + daysToComplete);
        const completionDateStr = completionDate.toLocaleDateString(navigator.language);

        // Determine pace status and badge
        const percentDiff = projectionData.percent_difference;
        let statusHTML, statusClass;

        if (percentDiff >= 5) {
            // Over-achieving by 5% or more
            const badge = `<span class="pace-badge pace-ahead">+${Math.floor(percentDiff)}%</span>`;
            statusHTML = `On Track! 🎉 ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${completionDateStr}</small>`;
            statusClass = 'dashboard-progress-value positive';
        } else if (percentDiff >= -5) {
            // Within ±5% - perfect pace
            const badge = `<span class="pace-badge pace-perfect">±${Math.abs(Math.floor(percentDiff))}%</span>`;
            statusHTML = `Perfect Pace! ✅ ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${completionDateStr}</small>`;
            statusClass = 'dashboard-progress-value positive';
        } else if (percentDiff >= -15) {
            // Slightly behind (-5% to -15%)
            const shortfall = projectionData.target - projectionData.projection;
            const formattedShortfall = goal.metricType === 'hours' ?
                Math.floor(shortfall) + 'h' :
                (goal.metricType === 'characters' ? formatGoalNumber(shortfall) : shortfall);
            const badge = `<span class="pace-badge pace-behind-mild">${Math.floor(percentDiff)}%</span>`;
            statusHTML = `${formattedShortfall} short ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${completionDateStr}</small>`;
            statusClass = 'dashboard-progress-value';
        } else {
            // Significantly behind (< -15%)
            const shortfall = projectionData.target - projectionData.projection;
            const formattedShortfall = goal.metricType === 'hours' ?
                Math.floor(shortfall) + 'h' :
                (goal.metricType === 'characters' ? formatGoalNumber(shortfall) : shortfall);
            const badge = `<span class="pace-badge pace-behind">${Math.floor(percentDiff)}%</span>`;
            statusHTML = `${formattedShortfall} short ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${completionDateStr}</small>`;
            statusClass = 'dashboard-progress-value';
        }

        // Return combined HTML with status summary inside the box
        return `
            <div class="dashboard-stat-item custom-goal-projection-item tooltip"
                 data-tooltip="Total ${metricLabel.toLowerCase()} you'll have by ${formattedTargetDate}"
                 data-goal-id="${goal.id}">
                <span class="dashboard-stat-value">
                    <span class="goal-icon" style="margin-right: 4px;">${goal.icon}</span>
                    ${formattedProjection}
                </span>
                <span class="dashboard-stat-label">${goal.name} by ${formattedTargetDate}</span>
                <div class="projection-status ${statusClass}" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color); ${percentDiff < -5 ? 'color: var(--warning-color);' : ''} ${percentDiff < -15 ? 'color: var(--danger-color);' : ''}">
                    ${statusHTML}
                </div>
            </div>
        `;
    }

    // Function to load goal projections
    async function loadGoalProjections() {
        try {
            let hasAnyProjection = false;

            // Load custom goals projections (only for 4 core metrics)
            const customGoals = await CustomGoalsManager.getActive();
            const projectionStats = document.getElementById('projectionStats');

            // If projectionStats doesn't exist (not on overview page), skip this function
            if (!projectionStats) {
                return;
            }

            // Remove existing custom goal projection items
            const existingCustomStats = projectionStats.querySelectorAll('.custom-goal-projection-item');
            existingCustomStats.forEach(el => el.remove());

            // Filter for only the 5 core metrics and goals that have started
            const coreMetrics = ['hours', 'characters', 'games', 'cards', 'mature_cards'];
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayStr = today.toISOString().split('T')[0];

            const customGoalsWithProjections = customGoals.filter(goal => {
                // Must be a core metric
                if (!coreMetrics.includes(goal.metricType)) return false;

                // Must have started (today >= start_date)
                if (goal.startDate && goal.startDate > todayStr) return false;

                return true;
            });

            // Add custom goal projection items
            if (customGoalsWithProjections.length > 0) {
                console.log(`Loading projections for ${customGoalsWithProjections.length} custom goals`);
                for (const goal of customGoalsWithProjections) {
                    try {
                        const goalsSettings = await GoalsUtils.prepareGoalsSettings();

                        const response = await fetch('/api/goals/projection', {
                            method: 'POST',
                            headers: GoalsUtils.getHeadersWithTimezone(),
                            body: JSON.stringify({
                                goal_id: goal.id,
                                metric_type: goal.metricType,
                                target_value: goal.targetValue,
                                start_date: goal.startDate,
                                end_date: goal.endDate,
                                goals_settings: goalsSettings
                            })
                        });

                        if (!response.ok) {
                            console.error(`Failed to fetch projection for goal ${goal.id}`);
                            continue;
                        }

                        const projectionData = await response.json();
                        hasAnyProjection = true;

                        // Render combined stat item with status inside
                        const rendered = renderCustomGoalProjectionItem(goal, projectionData);
                        projectionStats.insertAdjacentHTML('beforeend', rendered);

                    } catch (error) {
                        console.error(`Error loading projection for goal ${goal.id}:`, error);
                    }
                }
            }

            // Show/hide sections
            if (hasAnyProjection) {
                document.getElementById('noProjectionsMessage').style.display = 'none';
                document.getElementById('projectionStats').style.display = 'grid';
            } else {
                document.getElementById('noProjectionsMessage').style.display = 'block';
                document.getElementById('projectionStats').style.display = 'none';
            }

        } catch (error) {
            console.error('Error loading goal projections:', error);
        }
    }

    // ================================
    // Custom Goal Modal Functionality
    // ================================
    const customGoalModal = document.getElementById('customGoalModal');
    const addCustomGoalBtn = document.getElementById('addCustomGoalBtn');
    const closeCustomGoalModal = document.getElementById('closeCustomGoalModal');
    const cancelCustomGoalBtn = document.getElementById('cancelCustomGoalBtn');
    const saveCustomGoalBtn = document.getElementById('saveCustomGoalBtn');
    const customGoalForm = document.getElementById('customGoalForm');
    const customGoalError = document.getElementById('customGoalError');
    const customGoalSuccess = document.getElementById('customGoalSuccess');
    const customGoalModalTitle = document.getElementById('customGoalModalTitle');

    let editingGoalId = null;

    // Function to update form field visibility based on metric type
    function updateFormFieldsVisibility() {
        const metricType = document.getElementById('goalMetricType').value;
        const targetValueContainer = document.getElementById('goalTargetValueContainer');
        const datesContainer = document.getElementById('goalDatesContainer');
        const startDateContainer = document.getElementById('goalStartDateContainer');
        const customHelpText = document.getElementById('customGoalHelpText');
        const ankiBacklogHelpText = document.getElementById('ankiBacklogHelpText');
        const targetValueInput = document.getElementById('goalTargetValue');
        const startDateInput = document.getElementById('goalStartDate');
        const endDateInput = document.getElementById('goalEndDate');
        const endDateLabel = document.getElementById('goalEndDateLabel');
        const goalValueHelp = document.getElementById('goalValueHelp');
        const goalIconSelector = document.getElementById('goalIconSelector');
        const customGoalIcon = document.getElementById('customGoalIcon');

        console.log(`Updating form fields visibility for metric type: ${metricType}`);
        goalIconSelector.value = CustomGoalsManager.getDefaultIcon(metricType);

        if (metricType === 'custom') {
            // Hide fields for custom goals - use display none for complete removal
            targetValueContainer.style.display = 'none';
            datesContainer.style.display = 'none';
            customHelpText.style.display = 'block';
            if (ankiBacklogHelpText) ankiBacklogHelpText.style.display = 'none';

            // Remove required attributes
            targetValueInput.removeAttribute('required');
            startDateInput.removeAttribute('required');
            endDateInput.removeAttribute('required');

            // Clear values to prevent validation issues
            targetValueInput.value = '';
            startDateInput.value = '';
            endDateInput.value = '';
        }
        // Requires keeping track of how many new cards a day are done, otherwise we can only calculate from today to the end date. Because of this, we cannot create nice dailies or progress bars that makes this no different from doing it by hand. Commenting out and might revisit later
        /* else if (metricType === 'anki_backlog') {
            // For anki_backlog, hide target value and start date, only show end date
            targetValueContainer.style.display = 'none';
            datesContainer.style.display = 'grid';
            if (startDateContainer) startDateContainer.style.display = 'none';
            customHelpText.style.display = 'none';
            if (ankiBacklogHelpText) ankiBacklogHelpText.style.display = 'block';
            if (endDateLabel) endDateLabel.textContent = 'Clear Backlog By';
            
            // Remove required attributes for target and start date
            targetValueInput.removeAttribute('required');
            startDateInput.removeAttribute('required');
            endDateInput.setAttribute('required', 'required');
            
            // Clear target value and start date
            targetValueInput.value = '';
            startDateInput.value = '';
        } */
        else if (metricType) {
            // Show fields for regular goals
            targetValueContainer.style.display = 'block';
            datesContainer.style.display = 'grid';
            if (startDateContainer) startDateContainer.style.display = 'block';
            customHelpText.style.display = 'none';
            if (ankiBacklogHelpText) ankiBacklogHelpText.style.display = 'none';
            if (endDateLabel) endDateLabel.textContent = 'End Date';

            // Add required attributes back
            targetValueInput.setAttribute('required', 'required');
            startDateInput.setAttribute('required', 'required');
            endDateInput.setAttribute('required', 'required');

            // Suggestion logic for characters/hours
            if (goalValueHelp) {
                let suggestion = '';
                // Helper to calculate days between two dates (inclusive)
                function getDaysBetween(start, end) {
                    if (!start || !end) return null;
                    const startDate = new Date(start);
                    const endDate = new Date(end);
                    if (isNaN(startDate) || isNaN(endDate)) return null;
                    // Add 1 to include both start and end dates
                    return Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
                }

                const startDateVal = document.getElementById('goalStartDate').value;
                const endDateVal = document.getElementById('goalEndDate').value;
                const days = getDaysBetween(startDateVal, endDateVal);

                if (metricType === 'characters') {
                    if (window.averagePaceForPredictions && typeof window.averagePaceForPredictions.average_characters_per_day === 'number' && days && days > 0) {
                        const recommended = Math.round(window.averagePaceForPredictions.average_characters_per_day * days);
                        suggestion = `Tip: Your recent average is <b>${window.averagePaceForPredictions.average_characters_per_day.toLocaleString()}</b> characters/day.<br>For this date range (<b>${days}</b> days), some suggested targets are:
                        <ul>
                        <li>Maintain: <b>${recommended.toLocaleString()}</b> characters.</li>
                        <li>+5%: <b>${Math.round(recommended * 1.05).toLocaleString()}</b> characters.</li>
                        <li>+10%: <b>${Math.round(recommended * 1.1).toLocaleString()}</b> characters.</li>
                        <li>+15%: <b>${Math.round(recommended * 1.15).toLocaleString()}</b> characters.</li>
                        </ul>`;
                    } else if (window.averagePaceForPredictions && typeof window.averagePaceForPredictions.average_characters_per_day === 'number') {
                        suggestion = `Tip: Your recent average is <b>${window.averagePaceForPredictions.average_characters_per_day.toLocaleString()}</b> characters per day.`;
                    } else {
                        suggestion = 'Enter the total number of characters you want to reach.';
                    }
                    goalValueHelp.innerHTML = suggestion;
                } else if (metricType === 'hours') {
                    if (window.averagePaceForPredictions && typeof window.averagePaceForPredictions.average_hours_per_day === 'number' && days && days > 0) {
                        const recommended = (window.averagePaceForPredictions.average_hours_per_day * days).toFixed(2);
                        suggestion = `Tip: Your recent average is <b>${window.averagePaceForPredictions.average_hours_per_day.toFixed(2)}</b> hours/day.<br>For this date range (<b>${days}</b> days), some recommended targets are:
                        <ul>
                        <li>Maintain: <b>${recommended}</b> hours<br></li>
                        <li>+5%: <b>${(recommended * 1.05).toFixed(2)}</b> hours<br></li>
                        <li>+10%: <b>${(recommended * 1.1).toFixed(2)}</b> hours<br></li>
                        <li>+15%: <b>${(recommended * 1.15).toFixed(2)}</b> hours</li>
                        </ul>`;
                    } else if (window.averagePaceForPredictions && typeof window.averagePaceForPredictions.average_hours_per_day === 'number') {
                        suggestion = `Tip: Your recent average is <b>${window.averagePaceForPredictions.average_hours_per_day.toFixed(2)}</b> hours per day.`;
                    } else {
                        suggestion = 'Enter the total number of hours you want to reach.';
                    }
                    goalValueHelp.innerHTML = suggestion;
                } else {
                    goalValueHelp.innerText = 'Enter the target value for your goal.';
                }
            }
        } else {
            // No metric type selected - hide help text but show fields
            customHelpText.style.display = 'none';
            if (ankiBacklogHelpText) ankiBacklogHelpText.style.display = 'none';
            targetValueContainer.style.display = 'block';
            datesContainer.style.display = 'grid';
            if (startDateContainer) startDateContainer.style.display = 'block';
            if (endDateLabel) endDateLabel.textContent = 'End Date';
        }
    }

    // Add event listener to metric type select
    const goalMetricTypeSelect = document.getElementById('goalMetricType');
    const startDateInput = document.getElementById('goalStartDate');
    const endDateInput = document.getElementById('goalEndDate');
    if (goalMetricTypeSelect) {
        goalMetricTypeSelect.addEventListener('change', updateFormFieldsVisibility);
    }
    if (startDateInput) {
        startDateInput.addEventListener('change', updateFormFieldsVisibility);
        startDateInput.addEventListener('input', updateFormFieldsVisibility);
    }
    if (endDateInput) {
        endDateInput.addEventListener('change', updateFormFieldsVisibility);
        endDateInput.addEventListener('input', updateFormFieldsVisibility);
    }
    const goalIconSelector = document.getElementById('goalIconSelector');

    if (goalIconSelector) {
        goalIconSelector.addEventListener('change', function () {
            const selectedIcon = goalIconSelector.value;
            const customGoalIconInput = document.getElementById('customGoalIcon');
            if (customGoalIconInput) {
                customGoalIconInput.value = selectedIcon;
            }
        });
    }

    // Open modal for creating new goal
    if (addCustomGoalBtn) {
        addCustomGoalBtn.addEventListener('click', function () {
            editingGoalId = null;
            customGoalModalTitle.textContent = 'Add Custom Goal';
            customGoalForm.reset();
            customGoalModal.style.display = 'flex';
            customGoalModal.classList.add('show');
            clearCustomGoalMessages();
            // Reset field visibility
            updateFormFieldsVisibility();
        });
    }

    // Close custom goal modal function
    function closeCustomGoalModalFunc() {
        customGoalModal.style.display = 'none';
        customGoalModal.classList.remove('show');
        customGoalForm.reset();
        editingGoalId = null;
        clearCustomGoalMessages();
    }

    if (closeCustomGoalModal) {
        closeCustomGoalModal.addEventListener('click', closeCustomGoalModalFunc);
    }

    if (cancelCustomGoalBtn) {
        cancelCustomGoalBtn.addEventListener('click', closeCustomGoalModalFunc);
    }

    // Clear error/success messages
    function clearCustomGoalMessages() {
        if (customGoalError) customGoalError.style.display = 'none';
        if (customGoalSuccess) customGoalSuccess.style.display = 'none';
    }

    // Show error message
    function showCustomGoalError(message) {
        if (customGoalError) {
            customGoalError.textContent = message;
            customGoalError.style.display = 'block';
        }
        if (customGoalSuccess) {
            customGoalSuccess.style.display = 'none';
        }
    }

    // Show success message
    function showCustomGoalSuccess(message) {
        if (customGoalSuccess) {
            customGoalSuccess.textContent = message;
            customGoalSuccess.style.display = 'block';
        }
        if (customGoalError) {
            customGoalError.style.display = 'none';
        }
    }

    // Save custom goal (create or update)
    if (saveCustomGoalBtn) {
        saveCustomGoalBtn.addEventListener('click', async function () {
            clearCustomGoalMessages();

            const metricType = document.getElementById('goalMetricType').value;
            const icon = document.getElementById('customGoalIcon').value.trim() || document.getElementById('goalIconSelector').value.trim();
            const goalData = {
                name: document.getElementById('goalName').value.trim(),
                metricType: metricType,
                targetValue: parseInt(document.getElementById('goalTargetValue').value),
                startDate: document.getElementById('goalStartDate').value,
                endDate: document.getElementById('goalEndDate').value,
                icon: icon
            };

            // Requires keeping track of how many new cards a day are done, otherwise we can only calculate from today to the end date. Because of this, we cannot create nice dailies or progress bars that makes this no different from doing it by hand. Commenting out and might revisit later
            /* // For anki_backlog, set defaults for optional fields
            if (metricType === 'anki_backlog') {
                goalData.targetValue = 0;  // Always target 0 (clear all backlog)
                goalData.startDate = GoalsUtils.getTodayDateString();  // Start today
            } */

            // Validate
            const errors = CustomGoalsManager.validate(goalData);
            if (errors.length > 0) {
                showCustomGoalError(errors.join(', '));
                return;
            }

            try {
                if (editingGoalId) {
                    // Update existing goal
                    await CustomGoalsManager.update(editingGoalId, goalData);
                    showCustomGoalSuccess('Goal updated successfully!');
                } else {
                    // Create new goal
                    await CustomGoalsManager.create(goalData);
                    showCustomGoalSuccess('Goal created successfully!');
                }

                // Reload goal displays
                setTimeout(() => {
                    loadGoalProgress();
                    loadTodayGoals();
                    loadGoalProjections();
                    closeCustomGoalModalFunc();
                }, 1000);

            } catch (error) {
                console.error('Error saving custom goal:', error);
                showCustomGoalError('Failed to save goal: ' + error.message);
            }
        });
    }

    // Function to open edit modal for existing goal
    window.editCustomGoal = async function (goalId) {
        const goal = await CustomGoalsManager.getById(goalId);
        if (!goal) {
            alert('Goal not found');
            return;
        }

        editingGoalId = goalId;
        customGoalModalTitle.textContent = 'Edit Custom Goal';

        document.getElementById('goalName').value = goal.name;
        document.getElementById('goalMetricType').value = goal.metricType;
        document.getElementById('goalTargetValue').value = goal.targetValue || '';
        document.getElementById('goalStartDate').value = goal.startDate || '';
        document.getElementById('goalEndDate').value = goal.endDate || '';
        document.getElementById('goalIconSelector').value = goal.icon;
        document.getElementById('customGoalIcon').value = goal.icon;

        customGoalModal.style.display = 'flex';
        customGoalModal.classList.add('show');
        clearCustomGoalMessages();

        // Update field visibility based on goal type
        updateFormFieldsVisibility();
    };

    // Function to delete custom goal
    window.deleteCustomGoal = async function (goalId) {
        const goal = await CustomGoalsManager.getById(goalId);
        if (!goal) {
            alert('Goal not found');
            return;
        }

        if (confirm(`Are you sure you want to delete the goal "${goal.name}"?`)) {
            await CustomGoalsManager.delete(goalId);
            loadGoalProgress();
            loadTodayGoals();
            loadGoalProjections();
        }
    };

    // ================================
    // Dailies Streak Functionality
    // ================================

    // Function to load and display dailies streak
    async function loadDailiesStreak() {
        try {
            const response = await fetch('/api/goals/current_streak');
            if (!response.ok) {
                throw new Error('Failed to fetch streak data');
            }

            const data = await response.json();
            const currentStreak = data.streak || 0;
            const longestStreak = data.longest_streak || 0;
            const lastCompletionDate = data.last_completion_date;

            // Update streak displays from database
            // If current streak is higher than longest streak, show current as longest too
            const displayLongestStreak = Math.max(currentStreak, longestStreak);
            document.getElementById('currentStreakValue').textContent = currentStreak;
            document.getElementById('longestStreakValue').textContent = displayLongestStreak;

            // Show the streak section
            document.getElementById('dailiesStreakSection').style.display = 'block';

            // Check if already completed today (use local timezone for consistency)
            const today = GoalsUtils.getTodayDateString();
            const isCompletedToday = lastCompletionDate === today;

            const completeDailiesBtn = document.getElementById('completeDailiesBtn');
            if (isCompletedToday) {
                completeDailiesBtn.textContent = 'Completed Today ✓';
                completeDailiesBtn.disabled = true;
            }

        } catch (error) {
            console.error('Error loading dailies streak:', error);
            // Still show the section with 0 streak
            document.getElementById('dailiesStreakSection').style.display = 'block';
        }
    }

    // Function to trigger confetti celebration with streak-based scaling
    function triggerStreakConfetti(streak) {
        if (typeof confetti === 'undefined') {
            console.warn('Confetti library not loaded');
            return;
        }

        // Calculate particle count: linear scaling from 50 to 200, capped at 100 days
        const effectiveStreak = Math.min(streak, 100);
        const particleCount = Math.floor(50 + (effectiveStreak * 1.5));

        // Fire confetti from multiple angles for a nice effect
        const duration = 3000;
        const animationEnd = Date.now() + duration;

        const fireConfetti = () => {
            const timeLeft = animationEnd - Date.now();

            if (timeLeft <= 0) {
                return;
            }

            // Fire from left side
            confetti({
                particleCount: Math.floor(particleCount / 3),
                angle: 60,
                spread: 55,
                origin: { x: 0, y: 0.6 },
                colors: ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e']
            });

            // Fire from center
            confetti({
                particleCount: Math.floor(particleCount / 3),
                angle: 90,
                spread: 70,
                origin: { x: 0.5, y: 0.6 },
                colors: ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e']
            });

            // Fire from right side
            confetti({
                particleCount: Math.floor(particleCount / 3),
                angle: 120,
                spread: 55,
                origin: { x: 1, y: 0.6 },
                colors: ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#22c55e']
            });

            // Continue animation for higher streaks
            if (streak > 7) {
                requestAnimationFrame(fireConfetti);
            }
        };

        fireConfetti();
    }

    // Function to show the complete dailies confirmation modal
    async function showCompleteDailiesModal() {
        const modal = document.getElementById('completeDailiesModal');
        const loadingDiv = document.getElementById('tomorrowRequirementsLoading');
        const errorDiv = document.getElementById('tomorrowRequirementsError');
        const tableDiv = document.getElementById('tomorrowRequirementsTable');
        const noRequirementsDiv = document.getElementById('noRequirementsTomorrow');
        const tbody = document.getElementById('tomorrowRequirementsBody');

        // Show modal
        modal.style.display = 'flex';
        modal.classList.add('show');

        // Show loading state
        loadingDiv.style.display = 'block';
        errorDiv.style.display = 'none';
        tableDiv.style.display = 'none';
        noRequirementsDiv.style.display = 'none';
        tbody.innerHTML = '';

        try {
            const currentGoals = await GoalsUtils.getGoalsWithFallback();
            const goalsSettings = await GoalsUtils.prepareGoalsSettings();

            // Fetch tomorrow's requirements
            const response = await fetch('/api/goals/tomorrow-requirements', {
                method: 'POST',
                headers: GoalsUtils.getHeadersWithTimezone(),
                body: JSON.stringify({
                    current_goals: currentGoals,
                    goals_settings: goalsSettings
                })
            });

            if (!response.ok) {
                throw new Error('Failed to fetch tomorrow\'s requirements');
            }

            const data = await response.json();
            const requirements = data.requirements || [];

            // Hide loading
            loadingDiv.style.display = 'none';

            if (requirements.length === 0) {
                // Show no requirements message
                noRequirementsDiv.style.display = 'block';
            } else {
                // Populate table
                requirements.forEach(req => {
                    const row = document.createElement('tr');
                    row.innerHTML = `
                        <td>
                            <div class="goal-name-cell">
                                <span class="goal-icon">${req.goal_icon}</span>
                                <span>${req.goal_name}</span>
                            </div>
                        </td>
                        <td style="text-align: right;">
                            <span class="requirement-value">${req.formatted_required}</span>
                        </td>
                    `;
                    tbody.appendChild(row);
                });

                tableDiv.style.display = 'block';
            }

        } catch (error) {
            console.error('Error fetching tomorrow\'s requirements:', error);
            loadingDiv.style.display = 'none';
            errorDiv.textContent = error.message || 'Failed to load tomorrow\'s requirements';
            errorDiv.style.display = 'block';
        }
    }

    // Function to close the complete dailies modal
    function closeCompleteDailiesModal() {
        const modal = document.getElementById('completeDailiesModal');
        modal.style.display = 'none';
        modal.classList.remove('show');
    }

    // Function to handle Complete Dailies button click (now shows modal)
    async function handleCompleteDailies() {
        showCompleteDailiesModal();
    }

    // Function to actually complete dailies (called from modal confirmation)
    async function confirmCompleteDailies() {
        const completeDailiesBtn = document.getElementById('completeDailiesBtn');
        const dailiesMessage = document.getElementById('dailiesMessage');
        const confirmBtn = document.getElementById('confirmCompleteDailiesBtn');

        // Disable confirm button during processing
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Processing...';

        try {
            const currentGoals = await GoalsUtils.getGoalsWithFallback();
            const goalsSettings = await GoalsUtils.prepareGoalsSettings();
            
            // Get current versions from localStorage
            const goalsVersioned = CustomGoalsManager.getVersionedLocal();
            const easyDaysVersioned = EasyDaysManager.getVersionedLocal();
            const ankiConnectVersioned = AnkiConnectManager.getVersionedLocal();
            
            const currentVersions = {
                goals: goalsVersioned.version || 0,
                easyDays: easyDaysVersioned.version || 0,
                ankiConnect: ankiConnectVersioned.version || 0
            };

            // Call the API with versions
            const response = await fetch('/api/goals/complete_todays_dailies', {
                method: 'POST',
                headers: GoalsUtils.getHeadersWithTimezone(),
                body: JSON.stringify({
                    current_goals: currentGoals,
                    goals_settings: goalsSettings,
                    versions: currentVersions
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to complete dailies');
            }

            // Success! Close modal
            closeCompleteDailiesModal();

            const newStreak = data.streak;
            const newVersions = data.versions;

            // Update localStorage with new versions from server
            if (newVersions) {
                CustomGoalsManager.saveVersionedLocal({
                    version: newVersions.goals,
                    data: currentGoals,
                    lastModified: Date.now()
                });
                EasyDaysManager.saveVersionedLocal({
                    version: newVersions.easyDays,
                    data: goalsSettings.easyDays,
                    lastModified: Date.now()
                });
                AnkiConnectManager.saveVersionedLocal({
                    version: newVersions.ankiConnect,
                    data: goalsSettings.ankiConnect,
                    lastModified: Date.now()
                });
                console.log('📊 Updated versions after completing dailies:', newVersions);
            }

            // Update streak displays from API response
            document.getElementById('currentStreakValue').textContent = newStreak;

            // Update longest streak from API response
            // If current streak is higher than longest streak, show current as longest too
            const newLongestStreak = data.longest_streak || newStreak;
            const displayLongestStreak = Math.max(newStreak, newLongestStreak);
            document.getElementById('longestStreakValue').textContent = displayLongestStreak;

            // Update button
            completeDailiesBtn.disabled = true;
            completeDailiesBtn.textContent = 'Completed Today ✓';

            // Show success message
            dailiesMessage.textContent = data.message || `Dailies completed! Current streak: ${newStreak} days 🔥`;
            dailiesMessage.className = 'dailies-message success';
            dailiesMessage.style.display = 'block';

            // Trigger confetti celebration!
            triggerStreakConfetti(newStreak);

        } catch (error) {
            console.error('Error completing dailies:', error);

            // Close modal
            closeCompleteDailiesModal();

            // Show error message
            dailiesMessage.textContent = error.message || 'Failed to complete dailies. Please try again.';
            dailiesMessage.className = 'dailies-message error';
            dailiesMessage.style.display = 'block';

            // Re-enable confirm button
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Complete Today';
        }
    }

    // Attach event listener to Complete Dailies button
    const completeDailiesBtn = document.getElementById('completeDailiesBtn');
    if (completeDailiesBtn) {
        completeDailiesBtn.addEventListener('click', handleCompleteDailies);
    }

    // Complete Dailies Modal event listeners
    const closeCompleteDailiesModalBtn = document.getElementById('closeCompleteDailiesModal');
    if (closeCompleteDailiesModalBtn) {
        closeCompleteDailiesModalBtn.addEventListener('click', closeCompleteDailiesModal);
    }

    const cancelCompleteDailiesBtn = document.getElementById('cancelCompleteDailiesBtn');
    if (cancelCompleteDailiesBtn) {
        cancelCompleteDailiesBtn.addEventListener('click', closeCompleteDailiesModal);
    }

    const confirmCompleteDailiesBtn = document.getElementById('confirmCompleteDailiesBtn');
    if (confirmCompleteDailiesBtn) {
        confirmCompleteDailiesBtn.addEventListener('click', confirmCompleteDailies);
    }

    // Close modal when clicking outside
    const completeDailiesModal = document.getElementById('completeDailiesModal');
    if (completeDailiesModal) {
        completeDailiesModal.addEventListener('click', function (e) {
            if (e.target === completeDailiesModal) {
                closeCompleteDailiesModal();
            }
        });
    }

    // Load initial data
    loadDailiesStreak();
    loadGoalProgress();
    loadTodayGoals();
    loadGoalProjections();

    // ================================
    // Easy Days Settings UI Functions
    // ================================

    // Load easy days settings into UI
    async function loadEasyDaysUI() {
        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        
        try {
            // First load from localStorage for immediate UI update
            const localSettings = await EasyDaysManager.getSettings();
            
            days.forEach(day => {
                const slider = document.getElementById(`easyDay${day.charAt(0).toUpperCase() + day.slice(1)}`);
                const valueDisplay = document.getElementById(`easyDay${day.charAt(0).toUpperCase() + day.slice(1)}Value`);

                if (slider && valueDisplay) {
                    slider.value = localSettings[day];
                    valueDisplay.textContent = localSettings[day] + '%';
                }
            });
            
            // Then try to sync with database in the background
            try {
                const response = await fetch('/api/settings');
                if (response.ok) {
                    const dbData = await response.json();
                    
                    // Update UI with database values if they differ
                    days.forEach(day => {
                        const fieldName = `easy_days_${day}`;
                        const dbValue = dbData[fieldName];
                        
                        if (dbValue !== undefined) {
                            const slider = document.getElementById(`easyDay${day.charAt(0).toUpperCase() + day.slice(1)}`);
                            const valueDisplay = document.getElementById(`easyDay${day.charAt(0).toUpperCase() + day.slice(1)}Value`);

                            if (slider && valueDisplay) {
                                slider.value = dbValue;
                                valueDisplay.textContent = dbValue + '%';
                            }
                        }
                    });
                    
                    console.log('Easy days settings synced with database');
                }
            } catch (dbError) {
                console.warn('Could not sync easy days settings with database, using localStorage values:', dbError);
            }
            
        } catch (error) {
            console.error('Error loading easy days settings:', error);
            // If all else fails, use defaults
            const defaultSettings = EasyDaysManager.getDefaultSettings();

            days.forEach(day => {
                const slider = document.getElementById(`easyDay${day.charAt(0).toUpperCase() + day.slice(1)}`);
                const valueDisplay = document.getElementById(`easyDay${day.charAt(0).toUpperCase() + day.slice(1)}Value`);

                if (slider && valueDisplay) {
                    slider.value = defaultSettings[day];
                    valueDisplay.textContent = defaultSettings[day] + '%';
                }
            });
        }
    }

    // Setup slider event listeners to update value displays
    function setupEasyDaySliders() {
        const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

        days.forEach(day => {
            const slider = document.getElementById(`easyDay${day}`);
            const valueDisplay = document.getElementById(`easyDay${day}Value`);

            if (slider && valueDisplay) {
                slider.addEventListener('input', function () {
                    valueDisplay.textContent = this.value + '%';
                });
            }
        });
    }

    // Initialize easy days settings from localStorage or database
    async function initializeEasyDaysSettings() {
        // This function is now handled by initializeGoalsDataWithSync()
        // Keeping it as a no-op for backward compatibility
        console.log('Easy days initialization handled by version sync');
    }

    // Fetch and store average reading pace for predictions

    async function getAveragePaceForPredictions() {
        try {
            const response = await fetch('/api/goals/reading-pace', {
                method: 'GET',
                headers: GoalsUtils.getHeadersWithTimezone()
            });
            if (response.ok) {
                window.averagePaceForPredictions = await response.json();
                console.log('Fetched average pace for predictions:', window.averagePaceForPredictions);
            } else {
                window.averagePaceForPredictions = null;
                console.error('Failed to fetch average pace');
            }
        } catch (error) {
            window.averagePaceForPredictions = null;
            console.error('Error fetching average pace:', error);
        }
    }

    // Settings modal functionality
    const settingsModal = document.getElementById('settingsModal');
    const settingsToggle = document.getElementById('settingsToggle');
    const closeSettingsModal = document.getElementById('closeSettingsModal');
    const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const settingsForm = document.getElementById('settingsForm');
    const settingsError = document.getElementById('settingsError');
    const settingsSuccess = document.getElementById('settingsSuccess');

    // Setup easy day sliders
    setupEasyDaySliders();

    // Load AnkiConnect settings into UI
    async function loadAnkiConnectUI() {
        const settings = await AnkiConnectManager.getSettings();
        const deckNameInput = document.getElementById('ankiDeckName');

        if (deckNameInput) {
            deckNameInput.value = settings.deckName || '';
        }
    }

    // Open settings modal
    if (settingsToggle) {
        settingsToggle.addEventListener('click', async function () {
            await loadEasyDaysUI();
            await loadAnkiConnectUI();
            settingsModal.style.display = 'flex';
            settingsModal.classList.add('show');
        });
    }

    // Close settings modal
    function closeModal() {
        settingsModal.style.display = 'none';
        settingsModal.classList.remove('show');
    }

    if (closeSettingsModal) {
        closeSettingsModal.addEventListener('click', closeModal);
    }

    if (cancelSettingsBtn) {
        cancelSettingsBtn.addEventListener('click', closeModal);
    }

    // Close modal when clicking outside
    settingsModal.addEventListener('click', function (e) {
        if (e.target === settingsModal) {
            closeModal();
        }
    });

    // Save settings
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', async function () {
            // Clear previous messages
            if (settingsError) settingsError.style.display = 'none';
            if (settingsSuccess) settingsSuccess.style.display = 'none';

            // Read all slider values
            const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
            const easyDaysSettings = {};

            days.forEach(day => {
                const slider = document.getElementById(`easyDay${day.charAt(0).toUpperCase() + day.slice(1)}`);
                if (slider) {
                    easyDaysSettings[day] = parseInt(slider.value);
                }
            });

            // Read AnkiConnect settings
            const deckNameInput = document.getElementById('ankiDeckName');
            const ankiConnectSettings = {
                deckName: deckNameInput ? deckNameInput.value.trim() : ''
            };

            // Validate and save easy days to localStorage first
            const easyDaysResult = EasyDaysManager.saveSettings(easyDaysSettings);

            if (!easyDaysResult.success) {
                if (settingsError) {
                    settingsError.textContent = easyDaysResult.error;
                    settingsError.style.display = 'block';
                }
                return;
            }

            // Save AnkiConnect settings to localStorage
            const ankiResult = AnkiConnectManager.saveSettings(ankiConnectSettings);

            // Prepare data for API call
            const apiData = {};
            
            // Add easy days settings to API data
            days.forEach(day => {
                const fieldName = `easy_days_${day}`;
                apiData[fieldName] = easyDaysSettings[day];
            });

            try {
                // Send settings to API
                const response = await fetch('/api/settings', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(apiData)
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.error || 'Failed to save settings to database');
                }

                if (settingsSuccess) {
                    settingsSuccess.textContent = 'Settings saved successfully!';
                    settingsSuccess.style.display = 'block';
                }

                // Close modal after a short delay
                setTimeout(() => {
                    closeModal();
                }, 1000);

            } catch (error) {
                console.error('Error saving settings to database:', error);
                if (settingsError) {
                    settingsError.textContent = 'Failed to save settings to database: ' + error.message;
                    settingsError.style.display = 'block';
                }
            }
        });
    }

    // Initialize easy days settings on page load
    initializeEasyDaysSettings();
    getAveragePaceForPredictions();
    
    // Initialize goals data with version synchronization
    initializeGoalsDataWithSync();

    // Make functions globally available
    window.loadGoalProgress = loadGoalProgress;
    window.loadTodayGoals = loadTodayGoals;
    window.loadGoalProjections = loadGoalProjections;
});

// ================================
// Version Synchronization Function
// ================================
async function initializeGoalsDataWithSync() {
    try {
        console.log('🔄 Initializing goals data with version synchronization...');
        
        // Fetch latest from database
        const response = await fetch('/api/goals/latest_goals');
        if (!response.ok) {
            console.warn('Could not fetch goals from database for sync');
            return;
        }
        
        const dbData = await response.json();
        const dbVersions = dbData.versions || {goals: 0, easyDays: 0, ankiConnect: 0};
        
        console.log('📊 Database versions:', dbVersions);
        
        // Sync Custom Goals
        const localGoalsVersioned = CustomGoalsManager.getVersionedLocal();
        console.log(`📝 Local goals version: ${localGoalsVersioned.version}, DB version: ${dbVersions.goals}`);
        
        if (dbVersions.goals > localGoalsVersioned.version) {
            // DB is newer - use it
            const newVersioned = {
                version: dbVersions.goals,
                data: dbData.current_goals || [],
                lastModified: Date.now()
            };
            CustomGoalsManager.saveVersionedLocal(newVersioned);
            console.log(`✅ Synced custom goals from DB (v${dbVersions.goals})`);
        } else if (localGoalsVersioned.version > dbVersions.goals) {
            // Local is newer - will be synced on next "Complete Dailies"
            console.log(`⚠️ Local goals (v${localGoalsVersioned.version}) newer than DB (v${dbVersions.goals}) - will sync on next save`);
        } else {
            console.log(`✓ Custom goals already in sync (v${localGoalsVersioned.version})`);
        }
        
        // Sync Easy Days Settings
        const localEasyDaysVersioned = EasyDaysManager.getVersionedLocal();
        console.log(`⚙️ Local easy days version: ${localEasyDaysVersioned.version}, DB version: ${dbVersions.easyDays}`);
        
        if (dbData.goals_settings?.easyDays && dbVersions.easyDays > localEasyDaysVersioned.version) {
            const newVersioned = {
                version: dbVersions.easyDays,
                data: dbData.goals_settings.easyDays,
                lastModified: Date.now()
            };
            EasyDaysManager.saveVersionedLocal(newVersioned);
            console.log(`✅ Synced easy days settings from DB (v${dbVersions.easyDays})`);
        } else if (localEasyDaysVersioned.version > dbVersions.easyDays) {
            console.log(`⚠️ Local easy days (v${localEasyDaysVersioned.version}) newer than DB (v${dbVersions.easyDays}) - will sync on next save`);
        } else {
            console.log(`✓ Easy days settings already in sync (v${localEasyDaysVersioned.version})`);
        }
        
        // Sync AnkiConnect Settings
        const localAnkiVersioned = AnkiConnectManager.getVersionedLocal();
        console.log(`🎴 Local AnkiConnect version: ${localAnkiVersioned.version}, DB version: ${dbVersions.ankiConnect}`);
        
        if (dbData.goals_settings?.ankiConnect && dbVersions.ankiConnect > localAnkiVersioned.version) {
            const newVersioned = {
                version: dbVersions.ankiConnect,
                data: dbData.goals_settings.ankiConnect,
                lastModified: Date.now()
            };
            AnkiConnectManager.saveVersionedLocal(newVersioned);
            console.log(`✅ Synced AnkiConnect settings from DB (v${dbVersions.ankiConnect})`);
        } else if (localAnkiVersioned.version > dbVersions.ankiConnect) {
            console.log(`⚠️ Local AnkiConnect (v${localAnkiVersioned.version}) newer than DB (v${dbVersions.ankiConnect}) - will sync on next save`);
        } else {
            console.log(`✓ AnkiConnect settings already in sync (v${localAnkiVersioned.version})`);
        }
        
        console.log('✅ Goals data synchronization complete!');
    } catch (error) {
        console.error('❌ Error synchronizing goals data:', error);
    }
}