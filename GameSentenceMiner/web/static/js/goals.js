// Goals Page JavaScript
// Dependencies: shared.js (provides utility functions like showElement, hideElement, escapeHtml)

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
            return goal.endDate >= todayStr;
        });
    },
    
    // Get goals that are currently in progress (today is within date range)
    getInProgress() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = today.toISOString().split('T')[0];
        
        return this.getAll().filter(goal => {
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
            'games': '🎮'
        };
        return icons[metricType] || '🎯';
    },
    
    // Validate goal data
    validate(goalData) {
        const errors = [];
        
        if (!goalData.name || goalData.name.trim() === '') {
            errors.push('Goal name is required');
        }
        
        if (!goalData.metricType || !['hours', 'characters', 'games'].includes(goalData.metricType)) {
            errors.push('Valid metric type is required (hours, characters, or games)');
        }
        
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
        
        return errors;
    }
};

document.addEventListener('DOMContentLoaded', function () {
    
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

    // Helper function to calculate progress for custom goal within date range
    function calculateCustomGoalProgress(allLinesData, goal) {
        if (!allLinesData || allLinesData.length === 0) {
            return 0;
        }
        
        const startDate = new Date(goal.startDate);
        const endDate = new Date(goal.endDate);
        endDate.setHours(23, 59, 59, 999); // Include the entire end date
        
        const filteredData = allLinesData.filter(line => {
            const lineDate = new Date(line.timestamp * 1000);
            return lineDate >= startDate && lineDate <= endDate;
        });
        
        if (filteredData.length === 0) {
            return 0;
        }
        
        if (goal.metricType === 'hours') {
            const dailyTimestamps = {};
            for (const line of filteredData) {
                const ts = parseFloat(line.timestamp);
                if (isNaN(ts)) continue;
                const dateObj = new Date(ts * 1000);
                const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
                if (!dailyTimestamps[dateStr]) {
                    dailyTimestamps[dateStr] = [];
                }
                dailyTimestamps[dateStr].push(ts);
            }
            
            let totalHours = 0;
            const afkTimerSeconds = 120;
            for (const timestamps of Object.values(dailyTimestamps)) {
                if (timestamps.length >= 2) {
                    timestamps.sort((a, b) => a - b);
                    for (let i = 1; i < timestamps.length; i++) {
                        const gap = timestamps[i] - timestamps[i-1];
                        totalHours += Math.min(gap, afkTimerSeconds) / 3600;
                    }
                } else if (timestamps.length === 1) {
                    totalHours += 1 / 3600;
                }
            }
            return totalHours;
        } else if (goal.metricType === 'characters') {
            return filteredData.reduce((sum, line) => sum + (line.characters || 0), 0);
        } else if (goal.metricType === 'games') {
            const uniqueGames = new Set(filteredData.map(line => line.game_name));
            return uniqueGames.size;
        }
        
        return 0;
    }
    
    // Helper function to render a custom goal card
    function renderCustomGoalCard(goal, currentProgress, dailyAverage) {
        const percentage = Math.min(100, (currentProgress / goal.targetValue) * 100);
        const formattedCurrent = goal.metricType === 'hours' ? Math.floor(currentProgress).toLocaleString() :
                                 goal.metricType === 'characters' ? formatGoalNumber(currentProgress) :
                                 currentProgress.toLocaleString();
        const formattedTarget = goal.metricType === 'hours' ? goal.targetValue.toLocaleString() :
                                goal.metricType === 'characters' ? formatGoalNumber(goal.targetValue) :
                                goal.targetValue.toLocaleString();
        
        const progressBarClass = `completion-${Math.floor(percentage / 25) * 25}`;
        
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
            
            if (!allGamesStats) {
                throw new Error('No stats data available');
            }
            
            // Get goal settings
            const goalSettings = window.statsConfig || {};
            const hoursTarget = goalSettings.readingHoursTarget || 1500;
            const charsTarget = goalSettings.characterCountTarget || 25000000;
            const gamesTarget = goalSettings.gamesTarget || 100;
            
            // Calculate current progress
            const currentHours = allGamesStats.total_time_hours || 0;
            const currentCharacters = allGamesStats.total_characters || 0;
            const currentGames = allGamesStats.completed_games || 0;
            
            // Calculate daily averages for projections using 90-day lookback period (reusing logic from stats.js)
            const dailyHoursAvg = calculateDailyAverage(allLinesData, 'hours');
            const dailyCharsAvg = calculateDailyAverage(allLinesData, 'characters');
            const dailyGamesAvg = calculateDailyAverage(allLinesData, 'games');
            
            // Update Hours Goal
            const hoursPercentage = Math.min(100, (currentHours / hoursTarget) * 100);
            document.getElementById('goalHoursCurrent').textContent = Math.floor(currentHours).toLocaleString();
            document.getElementById('goalHoursTarget').textContent = hoursTarget.toLocaleString();
            document.getElementById('goalHoursPercentage').textContent = Math.floor(hoursPercentage) + '%';
            document.getElementById('goalHoursProjection').textContent =
                formatProjection(currentHours, hoursTarget, dailyHoursAvg);
            
            const hoursProgressBar = document.getElementById('goalHoursProgress');
            hoursProgressBar.style.width = hoursPercentage + '%';
            hoursProgressBar.setAttribute('data-percentage', Math.floor(hoursPercentage / 25) * 25);
            updateProgressBarColor(hoursProgressBar, hoursPercentage);
            
            // Update Characters Goal
            const charsPercentage = Math.min(100, (currentCharacters / charsTarget) * 100);
            document.getElementById('goalCharsCurrent').textContent = formatGoalNumber(currentCharacters);
            document.getElementById('goalCharsTarget').textContent = formatGoalNumber(charsTarget);
            document.getElementById('goalCharsPercentage').textContent = Math.floor(charsPercentage) + '%';
            document.getElementById('goalCharsProjection').textContent =
                formatProjection(currentCharacters, charsTarget, dailyCharsAvg);
                
            const charsProgressBar = document.getElementById('goalCharsProgress');
            charsProgressBar.style.width = charsPercentage + '%';
            charsProgressBar.setAttribute('data-percentage', Math.floor(charsPercentage / 25) * 25);
            updateProgressBarColor(charsProgressBar, charsPercentage);
            
            // Update Games Goal
            const gamesPercentage = Math.min(100, (currentGames / gamesTarget) * 100);
            document.getElementById('goalGamesCurrent').textContent = currentGames.toLocaleString();
            document.getElementById('goalGamesTarget').textContent = gamesTarget.toLocaleString();
            document.getElementById('goalGamesPercentage').textContent = Math.floor(gamesPercentage) + '%';
            document.getElementById('goalGamesProjection').textContent =
                formatProjection(currentGames, gamesTarget, dailyGamesAvg);
                
            const gamesProgressBar = document.getElementById('goalGamesProgress');
            gamesProgressBar.style.width = gamesPercentage + '%';
            gamesProgressBar.setAttribute('data-percentage', Math.floor(gamesPercentage / 25) * 25);
            updateProgressBarColor(gamesProgressBar, gamesPercentage);
            
            // Load and render custom goals
            const customGoals = CustomGoalsManager.getActive();
            const goalProgressGrid = document.querySelector('.goal-progress-grid');
            
            // Remove existing custom goal cards
            const existingCustomGoals = goalProgressGrid.querySelectorAll('.custom-goal-item');
            existingCustomGoals.forEach(el => el.remove());
            
            // Add custom goal cards
            if (customGoals.length > 0) {
                customGoals.forEach(goal => {
                    const progress = calculateCustomGoalProgress(allLinesData, goal);
                    const dailyAvg = goal.metricType === 'hours' ? dailyHoursAvg :
                                    goal.metricType === 'characters' ? dailyCharsAvg :
                                    dailyGamesAvg;
                    const cardHTML = renderCustomGoalCard(goal, progress, dailyAvg);
                    goalProgressGrid.insertAdjacentHTML('beforeend', cardHTML);
                });
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

    // Function to load today's goals
    async function loadTodayGoals() {
        try {
            const response = await fetch('/api/goals-today');
            if (!response.ok) throw new Error('Failed to fetch today goals');
            
            const data = await response.json();
            const today = new Date();
            const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            document.getElementById('todayGoalsDate').textContent = dateStr;
            
            let hasAnyTarget = false;
            
            // Update hours goal
            const hoursGoalItem = document.getElementById('hoursGoalItem');
            if (data.hours && data.hours.has_target && !data.hours.expired) {
                hasAnyTarget = true;
                hoursGoalItem.style.display = 'block';
                document.getElementById('hoursDaysRemaining').style.display = 'block';
                
                document.getElementById('todayHoursProgress').textContent = formatHours(data.hours.progress);
                document.getElementById('todayHoursRequired').textContent = formatHours(data.hours.required);
                document.getElementById('hoursRemainingValue').textContent = data.hours.days_remaining;
                
                // Add green highlight if goal is met
                if (data.hours.progress >= data.hours.required) {
                    hoursGoalItem.classList.add('goal-met');
                } else {
                    hoursGoalItem.classList.remove('goal-met');
                }
            } else {
                hoursGoalItem.style.display = 'none';
                document.getElementById('hoursDaysRemaining').style.display = 'none';
            }
            
            // Update characters goal
            const charsGoalItem = document.getElementById('charsGoalItem');
            if (data.characters && data.characters.has_target && !data.characters.expired) {
                hasAnyTarget = true;
                charsGoalItem.style.display = 'block';
                document.getElementById('charsDaysRemaining').style.display = 'block';
                
                document.getElementById('todayCharsProgress').textContent = formatGoalNumber(data.characters.progress);
                document.getElementById('todayCharsRequired').textContent = formatGoalNumber(data.characters.required);
                document.getElementById('charsRemainingValue').textContent = data.characters.days_remaining;
                
                // Add green highlight if goal is met
                if (data.characters.progress >= data.characters.required) {
                    charsGoalItem.classList.add('goal-met');
                } else {
                    charsGoalItem.classList.remove('goal-met');
                }
            } else {
                charsGoalItem.style.display = 'none';
                document.getElementById('charsDaysRemaining').style.display = 'none';
            }
            
            // Update cards mined goal
            const cardsGoalItem = document.getElementById('cardsGoalItem');
            if (data.cards && data.cards.has_target) {
                hasAnyTarget = true;
                cardsGoalItem.style.display = 'block';
                
                document.getElementById('todayCardsProgress').textContent = data.cards.progress;
                document.getElementById('todayCardsRequired').textContent = data.cards.required;
                
                // Add green highlight if goal is met
                if (data.cards.progress >= data.cards.required) {
                    cardsGoalItem.classList.add('goal-met');
                } else {
                    cardsGoalItem.classList.remove('goal-met');
                }
            } else {
                cardsGoalItem.style.display = 'none';
            }
            
            // Show/hide sections based on whether any targets are set
            if (hasAnyTarget) {
                document.getElementById('noTargetsMessage').style.display = 'none';
                document.getElementById('todayGoalsStats').style.display = 'grid';
                document.getElementById('todayGoalsProgress').style.display = 'block';
            } else {
                document.getElementById('noTargetsMessage').style.display = 'block';
                document.getElementById('todayGoalsStats').style.display = 'none';
                document.getElementById('todayGoalsProgress').style.display = 'none';
            }
            
        } catch (error) {
            console.error('Error loading today goals:', error);
        }
    }

    // Function to load goal projections
    async function loadGoalProjections() {
        try {
            const response = await fetch('/api/goals-projection');
            if (!response.ok) throw new Error('Failed to fetch goal projections');
            
            const data = await response.json();
            let hasAnyProjection = false;
            
            // Update hours projection
            if (data.hours && data.hours.target_date) {
                hasAnyProjection = true;
                document.getElementById('hoursProjectionItem').style.display = 'block';
                document.getElementById('hoursProjectionSummary').style.display = 'block';
                
                document.getElementById('projectionHoursValue').textContent =
                    Math.floor(data.hours.projection).toLocaleString() + 'h';
                
                // Update label with target date (formatted in user's locale)
                const hoursLabel = document.getElementById('hoursProjectionLabel');
                if (hoursLabel) {
                    const targetDate = new Date(data.hours.target_date);
                    const formattedTargetDate = targetDate.toLocaleDateString(navigator.language);
                    hoursLabel.textContent = `Total Hours by ${formattedTargetDate}`;
                }
                
                // Calculate percentage difference
                const hoursPercentDiff = ((data.hours.projection - data.hours.target) / data.hours.target) * 100;
                
                // Calculate projected completion date
                const hoursRemaining = Math.max(0, data.hours.target - data.hours.current);
                const hoursDaysToComplete = data.hours.daily_average > 0 ? Math.ceil(hoursRemaining / data.hours.daily_average) : 0;
                const hoursCompletionDate = new Date();
                hoursCompletionDate.setDate(hoursCompletionDate.getDate() + hoursDaysToComplete);
                const hoursCompletionDateStr = hoursCompletionDate.toLocaleDateString(navigator.language);
                
                // Status message with pace badge and completion date
                const hoursStatus = document.getElementById('hoursProjectionStatus');
                if (hoursPercentDiff >= 5) {
                    // Over-achieving by 5% or more
                    const badge = `<span class="pace-badge pace-ahead">+${Math.floor(hoursPercentDiff)}%</span>`;
                    hoursStatus.innerHTML = `On Track! 🎉 ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${hoursCompletionDateStr}</small>`;
                    hoursStatus.className = 'dashboard-progress-value positive';
                } else if (hoursPercentDiff >= -5) {
                    // Within ±5% - perfect pace
                    const badge = `<span class="pace-badge pace-perfect">±${Math.abs(Math.floor(hoursPercentDiff))}%</span>`;
                    hoursStatus.innerHTML = `Perfect Pace! ✅ ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${hoursCompletionDateStr}</small>`;
                    hoursStatus.className = 'dashboard-progress-value positive';
                } else if (hoursPercentDiff >= -15) {
                    // Slightly behind (-5% to -15%)
                    const shortfall = data.hours.target - data.hours.projection;
                    const badge = `<span class="pace-badge pace-behind-mild">${Math.floor(hoursPercentDiff)}%</span>`;
                    hoursStatus.innerHTML = `${Math.floor(shortfall)}h short ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${hoursCompletionDateStr}</small>`;
                    hoursStatus.className = 'dashboard-progress-value';
                    hoursStatus.style.color = 'var(--warning-color)';
                } else {
                    // Significantly behind (< -15%)
                    const shortfall = data.hours.target - data.hours.projection;
                    const badge = `<span class="pace-badge pace-behind">${Math.floor(hoursPercentDiff)}%</span>`;
                    hoursStatus.innerHTML = `${Math.floor(shortfall)}h short ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${hoursCompletionDateStr}</small>`;
                    hoursStatus.className = 'dashboard-progress-value';
                    hoursStatus.style.color = 'var(--danger-color)';
                }
            } else {
                document.getElementById('hoursProjectionItem').style.display = 'none';
                document.getElementById('hoursProjectionSummary').style.display = 'none';
            }
            
            // Update characters projection
            if (data.characters && data.characters.target_date) {
                hasAnyProjection = true;
                document.getElementById('charsProjectionItem').style.display = 'block';
                document.getElementById('charsProjectionSummary').style.display = 'block';
                
                document.getElementById('projectionCharsValue').textContent = formatGoalNumber(data.characters.projection);
                
                // Update label with target date (formatted in user's locale)
                const charsLabel = document.getElementById('charsProjectionLabel');
                if (charsLabel) {
                    const targetDate = new Date(data.characters.target_date);
                    const formattedTargetDate = targetDate.toLocaleDateString(navigator.language);
                    charsLabel.textContent = `Total Characters by ${formattedTargetDate}`;
                }
                
                // Calculate percentage difference
                const charsPercentDiff = ((data.characters.projection - data.characters.target) / data.characters.target) * 100;
                
                // Calculate projected completion date
                const charsRemaining = Math.max(0, data.characters.target - data.characters.current);
                const charsDaysToComplete = data.characters.daily_average > 0 ? Math.ceil(charsRemaining / data.characters.daily_average) : 0;
                const charsCompletionDate = new Date();
                charsCompletionDate.setDate(charsCompletionDate.getDate() + charsDaysToComplete);
                const charsCompletionDateStr = charsCompletionDate.toLocaleDateString(navigator.language);
                
                // Status message with pace badge and completion date
                const charsStatus = document.getElementById('charsProjectionStatus');
                if (charsPercentDiff >= 5) {
                    // Over-achieving by 5% or more
                    const badge = `<span class="pace-badge pace-ahead">+${Math.floor(charsPercentDiff)}%</span>`;
                    charsStatus.innerHTML = `On Track! 🎉 ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${charsCompletionDateStr}</small>`;
                    charsStatus.className = 'dashboard-progress-value positive';
                } else if (charsPercentDiff >= -5) {
                    // Within ±5% - perfect pace
                    const badge = `<span class="pace-badge pace-perfect">±${Math.abs(Math.floor(charsPercentDiff))}%</span>`;
                    charsStatus.innerHTML = `Perfect Pace! ✅ ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${charsCompletionDateStr}</small>`;
                    charsStatus.className = 'dashboard-progress-value positive';
                } else if (charsPercentDiff >= -15) {
                    // Slightly behind (-5% to -15%)
                    const shortfall = data.characters.target - data.characters.projection;
                    const badge = `<span class="pace-badge pace-behind-mild">${Math.floor(charsPercentDiff)}%</span>`;
                    charsStatus.innerHTML = `${formatGoalNumber(shortfall)} short ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${charsCompletionDateStr}</small>`;
                    charsStatus.className = 'dashboard-progress-value';
                    charsStatus.style.color = 'var(--warning-color)';
                } else {
                    // Significantly behind (< -15%)
                    const shortfall = data.characters.target - data.characters.projection;
                    const badge = `<span class="pace-badge pace-behind">${Math.floor(charsPercentDiff)}%</span>`;
                    charsStatus.innerHTML = `${formatGoalNumber(shortfall)} short ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${charsCompletionDateStr}</small>`;
                    charsStatus.className = 'dashboard-progress-value';
                    charsStatus.style.color = 'var(--danger-color)';
                }
            } else {
                document.getElementById('charsProjectionItem').style.display = 'none';
                document.getElementById('charsProjectionSummary').style.display = 'none';
            }
            
            // Update games projection
            if (data.games && data.games.target_date) {
                hasAnyProjection = true;
                document.getElementById('gamesProjectionItem').style.display = 'block';
                document.getElementById('gamesProjectionSummary').style.display = 'block';
                
                document.getElementById('projectionGamesValue').textContent = data.games.projection.toLocaleString();
                
                // Calculate percentage difference
                const gamesPercentDiff = ((data.games.projection - data.games.target) / data.games.target) * 100;
                
                // Calculate projected completion date
                const gamesRemaining = Math.max(0, data.games.target - data.games.current);
                const gamesDaysToComplete = data.games.daily_average > 0 ? Math.ceil(gamesRemaining / data.games.daily_average) : 0;
                const gamesCompletionDate = new Date();
                gamesCompletionDate.setDate(gamesCompletionDate.getDate() + gamesDaysToComplete);
                const gamesCompletionDateStr = gamesCompletionDate.toLocaleDateString(navigator.language);
                
                // Status message with pace badge and completion date
                const gamesStatus = document.getElementById('gamesProjectionStatus');
                if (gamesPercentDiff >= 5) {
                    // Over-achieving by 5% or more
                    const badge = `<span class="pace-badge pace-ahead">+${Math.floor(gamesPercentDiff)}%</span>`;
                    gamesStatus.innerHTML = `On Track! 🎉 ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${gamesCompletionDateStr}</small>`;
                    gamesStatus.className = 'dashboard-progress-value positive';
                } else if (gamesPercentDiff >= -5) {
                    // Within ±5% - perfect pace
                    const badge = `<span class="pace-badge pace-perfect">±${Math.abs(Math.floor(gamesPercentDiff))}%</span>`;
                    gamesStatus.innerHTML = `Perfect Pace! ✅ ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${gamesCompletionDateStr}</small>`;
                    gamesStatus.className = 'dashboard-progress-value positive';
                } else if (gamesPercentDiff >= -15) {
                    // Slightly behind (-5% to -15%)
                    const shortfall = data.games.target - data.games.projection;
                    const badge = `<span class="pace-badge pace-behind-mild">${Math.floor(gamesPercentDiff)}%</span>`;
                    gamesStatus.innerHTML = `${shortfall} short ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${gamesCompletionDateStr}</small>`;
                    gamesStatus.className = 'dashboard-progress-value';
                    gamesStatus.style.color = 'var(--warning-color)';
                } else {
                    // Significantly behind (< -15%)
                    const shortfall = data.games.target - data.games.projection;
                    const badge = `<span class="pace-badge pace-behind">${Math.floor(gamesPercentDiff)}%</span>`;
                    gamesStatus.innerHTML = `${shortfall} short ${badge}<br><small style="font-size: 0.85em; opacity: 0.9;">Est. completion: ${gamesCompletionDateStr}</small>`;
                    gamesStatus.className = 'dashboard-progress-value';
                    gamesStatus.style.color = 'var(--danger-color)';
                }
            } else {
                document.getElementById('gamesProjectionItem').style.display = 'none';
                document.getElementById('gamesProjectionSummary').style.display = 'none';
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
    
    // Open modal for creating new goal
    if (addCustomGoalBtn) {
        addCustomGoalBtn.addEventListener('click', function() {
            editingGoalId = null;
            customGoalModalTitle.textContent = 'Add Custom Goal';
            customGoalForm.reset();
            customGoalModal.style.display = 'flex';
            customGoalModal.classList.add('show');
            clearCustomGoalMessages();
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
        document.getElementById('goalTargetValue').value = goal.targetValue;
        document.getElementById('goalStartDate').value = goal.startDate;
        document.getElementById('goalEndDate').value = goal.endDate;
        document.getElementById('goalIcon').value = goal.icon;
        
        customGoalModal.style.display = 'flex';
        customGoalModal.classList.add('show');
        clearCustomGoalMessages();
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

    // Load initial data
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

    // Populate settings modal with current values
    if (window.statsConfig) {
        const hoursTargetInput = document.getElementById('readingHoursTarget');
        if (hoursTargetInput) hoursTargetInput.value = window.statsConfig.readingHoursTarget || 1500;

        const charsTargetInput = document.getElementById('characterCountTarget');
        if (charsTargetInput) charsTargetInput.value = window.statsConfig.characterCountTarget || 25000000;

        const gamesTargetInput = document.getElementById('gamesTarget');
        if (gamesTargetInput) gamesTargetInput.value = window.statsConfig.gamesTarget || 100;

        const hoursDateInput = document.getElementById('readingHoursTargetDate');
        if (hoursDateInput) hoursDateInput.value = window.statsConfig.readingHoursTargetDate || '';

        const charsDateInput = document.getElementById('characterCountTargetDate');
        if (charsDateInput) charsDateInput.value = window.statsConfig.characterCountTargetDate || '';

        const gamesDateInput = document.getElementById('gamesTargetDate');
        if (gamesDateInput) gamesDateInput.value = window.statsConfig.gamesTargetDate || '';

        const cardsDailyTargetInput = document.getElementById('cardsMinedDailyTarget');
        if (cardsDailyTargetInput) cardsDailyTargetInput.value = window.statsConfig.cardsMinedDailyTarget || 10;
    }

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

    // Save settings
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', async function() {
            try {
                const formData = {
                    reading_hours_target: parseInt(document.getElementById('readingHoursTarget').value),
                    character_count_target: parseInt(document.getElementById('characterCountTarget').value),
                    games_target: parseInt(document.getElementById('gamesTarget').value),
                    reading_hours_target_date: document.getElementById('readingHoursTargetDate').value || '',
                    character_count_target_date: document.getElementById('characterCountTargetDate').value || '',
                    games_target_date: document.getElementById('gamesTargetDate').value || '',
                    cards_mined_daily_target: parseInt(document.getElementById('cardsMinedDailyTarget').value) || 10
                };

                const response = await fetch('/api/settings', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(formData)
                });

                const result = await response.json();

                if (response.ok) {
                    // Update global config
                    window.statsConfig = {
                        ...window.statsConfig,
                        readingHoursTarget: formData.reading_hours_target,
                        characterCountTarget: formData.character_count_target,
                        gamesTarget: formData.games_target,
                        readingHoursTargetDate: formData.reading_hours_target_date,
                        characterCountTargetDate: formData.character_count_target_date,
                        gamesTargetDate: formData.games_target_date,
                        cardsMinedDailyTarget: formData.cards_mined_daily_target
                    };

                    // Show success message
                    const successDiv = document.getElementById('settingsSuccess');
                    successDiv.textContent = 'Settings saved successfully!';
                    successDiv.style.display = 'block';
                    setTimeout(() => {
                        successDiv.style.display = 'none';
                    }, 3000);

                    // Reload all data
                    setTimeout(() => {
                        loadGoalProgress();
                        loadTodayGoals();
                        loadGoalProjections();
                    }, 500);

                    // Close modal after short delay
                    setTimeout(closeModal, 1500);
                } else {
                    // Show error message
                    const errorDiv = document.getElementById('settingsError');
                    errorDiv.textContent = result.error || 'Failed to save settings';
                    errorDiv.style.display = 'block';
                    setTimeout(() => {
                        errorDiv.style.display = 'none';
                    }, 5000);
                }
            } catch (error) {
                console.error('Error saving settings:', error);
                const errorDiv = document.getElementById('settingsError');
                errorDiv.textContent = 'Network error while saving settings';
                errorDiv.style.display = 'block';
            }
        });
    }

    // Make functions globally available
    window.loadGoalProgress = loadGoalProgress;
    window.loadTodayGoals = loadTodayGoals;
    window.loadGoalProjections = loadGoalProjections;
});