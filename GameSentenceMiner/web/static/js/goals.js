// Goals Page JavaScript
// Dependencies: shared.js (provides utility functions like showElement, hideElement, escapeHtml)

// ================================
// Custom Goal Checkbox Manager Module
// ================================
const CustomGoalCheckboxManager = {
    STORAGE_KEY: 'gsm_custom_goal_checkboxes',
    
    // Get today's date string in YYYY-MM-DD format
    getTodayDateString() {
        const today = new Date();
        return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
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
        
        const today = this.getTodayDateString();
        let streak = 0;
        let currentDate = new Date(today);
        
        // Check if today is completed
        if (sortedDates[0] === today) {
            streak = 1;
            currentDate.setDate(currentDate.getDate() - 1);
        } else {
            // If today is not completed, check if yesterday was
            currentDate.setDate(currentDate.getDate() - 1);
            const yesterday = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
            
            if (sortedDates[0] !== yesterday) {
                return 0; // Streak is broken
            }
            streak = 1;
            currentDate.setDate(currentDate.getDate() - 1);
        }
        
        // Count consecutive days backwards
        for (let i = (sortedDates[0] === today ? 1 : 1); i < sortedDates.length; i++) {
            const expectedDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
            
            if (sortedDates[i] === expectedDate) {
                streak++;
                currentDate.setDate(currentDate.getDate() - 1);
            } else {
                break; // Streak is broken
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
    initializeForNewDay() {
        const customGoals = CustomGoalsManager.getAll().filter(g => g.metricType === 'custom');
        
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
    STORAGE_KEY: 'gsm_custom_goals',
    
    // Generate unique ID for goals
    generateId() {
        return 'goal_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    },
    
    // Get all custom goals from localStorage
    getAll() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.error('Error reading custom goals from localStorage:', error);
            return [];
        }
    },
    
    // Get active goals (within current date or future)
    getActive() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().split('T')[0];
        
        return this.getAll().filter(goal => {
            // Custom goals are always active
            if (goal.metricType === 'custom') return true;
            return goal.endDate >= todayStr;
        });
    },
    
    // Get goals that are currently in progress (today is within date range)
    getInProgress() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().split('T')[0];
        
        return this.getAll().filter(goal => {
            // Custom goals are always in progress
            if (goal.metricType === 'custom') return true;
            return goal.startDate <= todayStr && goal.endDate >= todayStr;
        });
    },
    
    // Save all goals to localStorage
    saveAll(goals) {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(goals));
            return true;
        } catch (error) {
            console.error('Error saving custom goals to localStorage:', error);
            return false;
        }
    },
    
    // Create new goal
    create(goalData) {
        const goals = this.getAll();
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
    update(id, goalData) {
        const goals = this.getAll();
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
    delete(id) {
        const goals = this.getAll();
        const filtered = goals.filter(g => g.id !== id);
        return this.saveAll(filtered);
    },
    
    // Get goal by ID
    getById(id) {
        return this.getAll().find(g => g.id === id);
    },
    
    // Get default icon for metric type
    getDefaultIcon(metricType) {
        const icons = {
            'hours': '⏱️',
            'characters': '📖',
            'games': '🎮',
            'cards': '🎴',
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
        
        if (!goalData.metricType || !['hours', 'characters', 'games', 'cards', 'custom'].includes(goalData.metricType)) {
            errors.push('Valid metric type is required (hours, characters, games, cards, or custom)');
        }
        
        // For custom goals, targetValue, startDate, and endDate are optional
        if (goalData.metricType !== 'custom') {
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
        
        return errors;
    }
};

document.addEventListener('DOMContentLoaded', function () {
    
    // Initialize checkbox states for new day
    CustomGoalCheckboxManager.initializeForNewDay();
    
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
            const response = await fetch('/api/goals/progress', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    metric_type: goal.metricType,
                    start_date: goal.startDate,
                    end_date: goal.endDate
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
                    <div class="custom-goal-streak-display" style="margin: 12px 0; padding: 12px; background: var(--bg-secondary); border-radius: 8px; border: 2px solid var(--border-color);">
                        <div style="display: flex; justify-content: space-around; gap: 20px;">
                            <div style="text-align: center;">
                                <div style="font-size: 2em; font-weight: 700; color: var(--success-color);">${state.currentStreak}</div>
                                <div style="font-size: 0.85em; color: var(--text-tertiary); margin-top: 4px;">Current Streak</div>
                            </div>
                            <div style="text-align: center;">
                                <div style="font-size: 2em; font-weight: 700; color: var(--primary-color);">${state.longestStreak}</div>
                                <div style="font-size: 0.85em; color: var(--text-tertiary); margin-top: 4px;">Longest Streak</div>
                            </div>
                        </div>
                        <div style="margin-top: 12px; text-align: center; font-size: 0.9em; color: var(--text-secondary);">
                            <span style="opacity: 0.8;">🔥</span>
                            <span style="margin-left: 4px;">${state.completionDates.length} days completed</span>
                        </div>
                    </div>
                    <div class="custom-goal-actions" style="margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end;">
                        <button onclick="editCustomGoal('${goal.id}')" class="goal-action-btn edit-btn" title="Edit goal">
                            ✏️ Edit
                        </button>
                        <button onclick="deleteCustomGoal('${goal.id}')" class="goal-action-btn delete-btn" title="Delete goal">
                            🗑️ Delete
                        </button>
                    </div>
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
                    <span class="goal-projection">${formatProjection(currentProgress, goal.targetValue, dailyAverage)}</span>
                </div>
                <div class="custom-goal-actions" style="margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end;">
                    <button onclick="editCustomGoal('${goal.id}')" class="goal-action-btn edit-btn" title="Edit goal">
                        ✏️ Edit
                    </button>
                    <button onclick="deleteCustomGoal('${goal.id}')" class="goal-action-btn delete-btn" title="Delete goal">
                        🗑️ Delete
                    </button>
                </div>
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
            const customGoals = CustomGoalsManager.getActive();
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
        
        if (metricType === 'hours') {
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
                    const afkTimerSeconds = 120; // Default AFK timer
                    for (let i = 1; i < timestamps.length; i++) {
                        const gap = timestamps[i] - timestamps[i-1];
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
                const dateObj = new Date(ts * 1000);
                const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
                dailyTotals[dateStr] = (dailyTotals[dateStr] || 0) + (line.characters || 0);
            }
        } else if (metricType === 'games') {
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
        const metricLabels = {
            'hours': 'Hours',
            'characters': 'Characters',
            'games': 'Games'
        };
        
        const metricLabel = metricLabels[goal.metricType] || 'Progress';
        
        // Format values based on metric type
        let formattedProgress, formattedRequired;
        if (goal.metricType === 'hours') {
            formattedProgress = formatHours(todayData.progress);
            formattedRequired = formatHours(todayData.required);
        } else if (goal.metricType === 'characters') {
            formattedProgress = formatGoalNumber(todayData.progress);
            formattedRequired = formatGoalNumber(todayData.required);
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
                </span>
                <span class="dashboard-stat-label">${goal.name} - ${metricLabel} Required</span>
            </div>
        `;
    }
    
    // Global function to handle custom goal checkbox clicks
    window.handleCustomGoalCheckboxClick = function(goalId) {
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
            const response = await fetch('/api/goals-today');
            if (!response.ok) throw new Error('Failed to fetch today goals');
            
            const today = new Date();
            const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            document.getElementById('todayGoalsDate').textContent = dateStr;
            
            let hasAnyTarget = false;
            
            // Load custom goals today progress
            const customGoals = CustomGoalsManager.getInProgress();
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
                            const response = await fetch('/api/goals/today-progress', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    goal_id: goal.id,
                                    metric_type: goal.metricType,
                                    target_value: goal.targetValue,
                                    start_date: goal.startDate,
                                    end_date: goal.endDate
                                })
                            });
                            
                            if (!response.ok) {
                                console.error(`Failed to fetch today progress for goal ${goal.id}`);
                                continue;
                            }
                            
                            const todayData = await response.json();
                            
                            // Only show if has target and not expired/not started
                            if (todayData.has_target && !todayData.expired && !todayData.not_started) {
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
        const metricLabels = {
            'hours': 'Hours',
            'characters': 'Characters',
            'games': 'Games',
            'cards': 'Cards Mined'
        };
        
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
        
        return {
            statItemHTML: `
                <div class="dashboard-stat-item custom-goal-projection-item tooltip"
                     data-tooltip="Total ${metricLabel.toLowerCase()} you'll have by ${formattedTargetDate}"
                     data-goal-id="${goal.id}">
                    <span class="dashboard-stat-value">
                        <span class="goal-icon" style="margin-right: 4px;">${goal.icon}</span>
                        ${formattedProjection}
                    </span>
                    <span class="dashboard-stat-label">${goal.name} by ${formattedTargetDate}</span>
                </div>
            `,
            summaryItemHTML: `
                <div class="dashboard-progress-item custom-goal-projection-summary"
                     data-goal-id="${goal.id}">
                    <div class="${statusClass}" style="${percentDiff < -5 ? 'color: var(--warning-color);' : ''} ${percentDiff < -15 ? 'color: var(--danger-color);' : ''}">
                        ${statusHTML}
                    </div>
                    <div class="dashboard-progress-label">${goal.name} Status</div>
                </div>
            `
        };
    }

    // Function to load goal projections
    async function loadGoalProjections() {
        try {
            let hasAnyProjection = false;
            
            // Load custom goals projections (only for 4 core metrics)
            const customGoals = CustomGoalsManager.getActive();
            const projectionStats = document.getElementById('projectionStats');
            const projectionProgress = document.querySelector('#projectionProgress .dashboard-progress-items');
            
            // Remove existing custom goal projection items
            const existingCustomStats = projectionStats.querySelectorAll('.custom-goal-projection-item');
            existingCustomStats.forEach(el => el.remove());
            const existingCustomSummaries = projectionProgress.querySelectorAll('.custom-goal-projection-summary');
            existingCustomSummaries.forEach(el => el.remove());
            
            // Filter for only the 4 core metrics
            const coreMetrics = ['hours', 'characters', 'games', 'cards'];
            const customGoalsWithProjections = customGoals.filter(goal =>
                coreMetrics.includes(goal.metricType)
            );
            
            // Add custom goal projection items
            if (customGoalsWithProjections.length > 0) {
                console.log(`Loading projections for ${customGoalsWithProjections.length} custom goals`);
                for (const goal of customGoalsWithProjections) {
                    try {
                        const response = await fetch('/api/goals/projection', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                goal_id: goal.id,
                                metric_type: goal.metricType,
                                target_value: goal.targetValue,
                                end_date: goal.endDate
                            })
                        });
                        
                        if (!response.ok) {
                            console.error(`Failed to fetch projection for goal ${goal.id}`);
                            continue;
                        }
                        
                        const projectionData = await response.json();
                        hasAnyProjection = true;
                        
                        // Render both stat item and summary
                        const rendered = renderCustomGoalProjectionItem(goal, projectionData);
                        projectionStats.insertAdjacentHTML('beforeend', rendered.statItemHTML);
                        projectionProgress.insertAdjacentHTML('beforeend', rendered.summaryItemHTML);
                        
                    } catch (error) {
                        console.error(`Error loading projection for goal ${goal.id}:`, error);
                    }
                }
            }
            
            // Show/hide sections
            if (hasAnyProjection) {
                document.getElementById('noProjectionsMessage').style.display = 'none';
                document.getElementById('projectionStats').style.display = 'grid';
                document.getElementById('projectionProgress').style.display = 'block';
            } else {
                document.getElementById('noProjectionsMessage').style.display = 'block';
                document.getElementById('projectionStats').style.display = 'none';
                document.getElementById('projectionProgress').style.display = 'none';
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
        const helpText = document.getElementById('customGoalHelpText');
        const targetValueInput = document.getElementById('goalTargetValue');
        const startDateInput = document.getElementById('goalStartDate');
        const endDateInput = document.getElementById('goalEndDate');
        
        if (metricType === 'custom') {
            // Hide fields for custom goals - use display none for complete removal
            targetValueContainer.style.display = 'none';
            datesContainer.style.display = 'none';
            helpText.style.display = 'block';
            
            // Remove required attributes
            targetValueInput.removeAttribute('required');
            startDateInput.removeAttribute('required');
            endDateInput.removeAttribute('required');
            
            // Clear values to prevent validation issues
            targetValueInput.value = '';
            startDateInput.value = '';
            endDateInput.value = '';
        } else if (metricType) {
            // Show fields for regular goals
            targetValueContainer.style.display = 'block';
            datesContainer.style.display = 'grid';
            helpText.style.display = 'none';
            
            // Add required attributes back
            targetValueInput.setAttribute('required', 'required');
            startDateInput.setAttribute('required', 'required');
            endDateInput.setAttribute('required', 'required');
        } else {
            // No metric type selected - hide help text but show fields
            helpText.style.display = 'none';
            targetValueContainer.style.display = 'block';
            datesContainer.style.display = 'grid';
        }
    }
    
    // Add event listener to metric type select
    const goalMetricTypeSelect = document.getElementById('goalMetricType');
    if (goalMetricTypeSelect) {
        goalMetricTypeSelect.addEventListener('change', updateFormFieldsVisibility);
    }
    
    // Open modal for creating new goal
    if (addCustomGoalBtn) {
        addCustomGoalBtn.addEventListener('click', function() {
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
        saveCustomGoalBtn.addEventListener('click', function() {
            clearCustomGoalMessages();
            
            const goalData = {
                name: document.getElementById('goalName').value.trim(),
                metricType: document.getElementById('goalMetricType').value,
                targetValue: parseInt(document.getElementById('goalTargetValue').value),
                startDate: document.getElementById('goalStartDate').value,
                endDate: document.getElementById('goalEndDate').value,
                icon: document.getElementById('goalIcon').value.trim()
            };
            
            // Validate
            const errors = CustomGoalsManager.validate(goalData);
            if (errors.length > 0) {
                showCustomGoalError(errors.join(', '));
                return;
            }
            
            try {
                if (editingGoalId) {
                    // Update existing goal
                    CustomGoalsManager.update(editingGoalId, goalData);
                    showCustomGoalSuccess('Goal updated successfully!');
                } else {
                    // Create new goal
                    CustomGoalsManager.create(goalData);
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
    window.editCustomGoal = function(goalId) {
        const goal = CustomGoalsManager.getById(goalId);
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
        document.getElementById('goalIcon').value = goal.icon;
        
        customGoalModal.style.display = 'flex';
        customGoalModal.classList.add('show');
        clearCustomGoalMessages();
        
        // Update field visibility based on goal type
        updateFormFieldsVisibility();
    };
    
    // Function to delete custom goal
    window.deleteCustomGoal = function(goalId) {
        const goal = CustomGoalsManager.getById(goalId);
        if (!goal) {
            alert('Goal not found');
            return;
        }
        
        if (confirm(`Are you sure you want to delete the goal "${goal.name}"?`)) {
            CustomGoalsManager.delete(goalId);
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
            const lastCompletionDate = data.last_completion_date;
            
            // Update streak display
            document.getElementById('currentStreakValue').textContent = currentStreak;
            
            // For longest streak, we need to check if there's a stored value
            // For now, we'll use current streak as longest (API doesn't track longest separately yet)
            // In a real implementation, you'd want to track this in the database
            const longestStreak = Math.max(currentStreak, parseInt(localStorage.getItem('gsm_longest_dailies_streak') || '0'));
            document.getElementById('longestStreakValue').textContent = longestStreak;
            
            // Store longest streak in localStorage
            if (currentStreak > longestStreak) {
                localStorage.setItem('gsm_longest_dailies_streak', currentStreak.toString());
            }
            
            // Show the streak section
            document.getElementById('dailiesStreakSection').style.display = 'block';
            
            // Check if already completed today
            const today = new Date().toISOString().split('T')[0];
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
    
    // Function to handle Complete Dailies button click
    async function handleCompleteDailies() {
        const completeDailiesBtn = document.getElementById('completeDailiesBtn');
        const dailiesMessage = document.getElementById('dailiesMessage');
        
        // Disable button during processing
        completeDailiesBtn.disabled = true;
        completeDailiesBtn.textContent = 'Processing...';
        
        try {
            // Get current goals from localStorage
            let currentGoals = CustomGoalsManager.getAll();
            
            // If localStorage is empty, try fetching from database
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
            
            // Call the API
            const response = await fetch('/api/goals/complete_todays_dailies', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    current_goals: currentGoals
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || 'Failed to complete dailies');
            }
            
            // Success!
            const newStreak = data.streak;
            
            // Update streak display
            document.getElementById('currentStreakValue').textContent = newStreak;
            
            // Update longest streak if needed
            const currentLongest = parseInt(document.getElementById('longestStreakValue').textContent);
            if (newStreak > currentLongest) {
                document.getElementById('longestStreakValue').textContent = newStreak;
                localStorage.setItem('gsm_longest_dailies_streak', newStreak.toString());
            }
            
            // Update button
            completeDailiesBtn.textContent = 'Completed Today ✓';
            
            // Show success message
            dailiesMessage.textContent = data.message || `Dailies completed! Current streak: ${newStreak} days 🔥`;
            dailiesMessage.className = 'dailies-message success';
            dailiesMessage.style.display = 'block';
            
            // Trigger confetti celebration!
            triggerStreakConfetti(newStreak);
            
        } catch (error) {
            console.error('Error completing dailies:', error);
            
            // Show error message
            dailiesMessage.textContent = error.message || 'Failed to complete dailies. Please try again.';
            dailiesMessage.className = 'dailies-message error';
            dailiesMessage.style.display = 'block';
            
            // Re-enable button on error
            completeDailiesBtn.disabled = false;
            completeDailiesBtn.textContent = 'Complete Dailies?';
        }
    }
    
    // Attach event listener to Complete Dailies button
    const completeDailiesBtn = document.getElementById('completeDailiesBtn');
    if (completeDailiesBtn) {
        completeDailiesBtn.addEventListener('click', handleCompleteDailies);
    }
    
    // Load initial data
    loadDailiesStreak();
    loadGoalProgress();
    loadTodayGoals();
    loadGoalProjections();

    // Settings modal functionality
    const settingsModal = document.getElementById('settingsModal');
    const settingsToggle = document.getElementById('settingsToggle');
    const closeSettingsModal = document.getElementById('closeSettingsModal');
    const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const settingsForm = document.getElementById('settingsForm');

    // Open settings modal
    if (settingsToggle) {
        settingsToggle.addEventListener('click', function() {
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
    settingsModal.addEventListener('click', function(e) {
        if (e.target === settingsModal) {
            closeModal();
        }
    });

    // Save settings (currently no settings to save for goals page)
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', async function() {
            // Close modal since there are no settings to save
            closeModal();
        });
    }

    // Make functions globally available
    window.loadGoalProgress = loadGoalProgress;
    window.loadTodayGoals = loadTodayGoals;
    window.loadGoalProjections = loadGoalProjections;
});