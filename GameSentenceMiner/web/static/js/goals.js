// Goals Page JavaScript
// Dependencies: shared.js (provides utility functions like showElement, hideElement, escapeHtml)

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
            const currentGames = allGamesStats.unique_games || 0;
            
            // Calculate 90-day averages for projections (reusing logic from stats.js)
            const dailyHoursAvg = calculate90DayAverage(allLinesData, 'hours');
            const dailyCharsAvg = calculate90DayAverage(allLinesData, 'characters');
            const dailyGamesAvg = calculate90DayAverage(allLinesData, 'games');
            
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
            
            goalProgressLoading.style.display = 'none';
            
        } catch (error) {
            console.error('Error loading goal progress:', error);
            goalProgressLoading.style.display = 'none';
            goalProgressError.style.display = 'block';
        }
    }

    // Function to calculate 90-day rolling average (copied from stats.js)
    function calculate90DayAverage(allLinesData, metricType) {
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
            if (data.hours && data.hours.has_target && !data.hours.expired) {
                hasAnyTarget = true;
                document.getElementById('hoursGoalItem').style.display = 'block';
                document.getElementById('hoursProgressItem').style.display = 'block';
                document.getElementById('hoursDaysRemaining').style.display = 'block';
                
                document.getElementById('todayHoursRequired').textContent = formatHours(data.hours.required);
                document.getElementById('todayHoursProgress').textContent = formatHours(data.hours.progress);
                document.getElementById('hoursRemainingValue').textContent = data.hours.days_remaining;
            } else {
                document.getElementById('hoursGoalItem').style.display = 'none';
                document.getElementById('hoursProgressItem').style.display = 'none';
                document.getElementById('hoursDaysRemaining').style.display = 'none';
            }
            
            // Update characters goal
            if (data.characters && data.characters.has_target && !data.characters.expired) {
                hasAnyTarget = true;
                document.getElementById('charsGoalItem').style.display = 'block';
                document.getElementById('charsProgressItem').style.display = 'block';
                document.getElementById('charsDaysRemaining').style.display = 'block';
                
                document.getElementById('todayCharsRequired').textContent = formatGoalNumber(data.characters.required);
                document.getElementById('todayCharsProgress').textContent = formatGoalNumber(data.characters.progress);
                document.getElementById('charsRemainingValue').textContent = data.characters.days_remaining;
            } else {
                document.getElementById('charsGoalItem').style.display = 'none';
                document.getElementById('charsProgressItem').style.display = 'none';
                document.getElementById('charsDaysRemaining').style.display = 'none';
            }
            
            // Update games goal (not displayed in today's goals as it's cumulative)
            
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
                document.getElementById('hoursAvgItem').style.display = 'block';
                document.getElementById('hoursProjectionSummary').style.display = 'block';
                
                document.getElementById('projectionHoursValue').textContent = 
                    Math.floor(data.hours.projection).toLocaleString() + 'h';
                document.getElementById('projectionHoursAvg').textContent = 
                    formatHours(data.hours.daily_average);
                
                // Status message
                const hoursStatus = document.getElementById('hoursProjectionStatus');
                if (data.hours.projection >= data.hours.target) {
                    hoursStatus.textContent = 'On track! ✅';
                    hoursStatus.className = 'dashboard-progress-value positive';
                } else {
                    const shortfall = data.hours.target - data.hours.projection;
                    hoursStatus.textContent = `${Math.floor(shortfall)}h short`;
                    hoursStatus.className = 'dashboard-progress-value neutral';
                }
            } else {
                document.getElementById('hoursProjectionItem').style.display = 'none';
                document.getElementById('hoursAvgItem').style.display = 'none';
                document.getElementById('hoursProjectionSummary').style.display = 'none';
            }
            
            // Update characters projection
            if (data.characters && data.characters.target_date) {
                hasAnyProjection = true;
                document.getElementById('charsProjectionItem').style.display = 'block';
                document.getElementById('charsAvgItem').style.display = 'block';
                document.getElementById('charsProjectionSummary').style.display = 'block';
                
                document.getElementById('projectionCharsValue').textContent = formatGoalNumber(data.characters.projection);
                document.getElementById('projectionCharsAvg').textContent = formatGoalNumber(data.characters.daily_average);
                
                // Status message
                const charsStatus = document.getElementById('charsProjectionStatus');
                if (data.characters.projection >= data.characters.target) {
                    charsStatus.textContent = 'On track! ✅';
                    charsStatus.className = 'dashboard-progress-value positive';
                } else {
                    const shortfall = data.characters.target - data.characters.projection;
                    charsStatus.textContent = `${formatGoalNumber(shortfall)} short`;
                    charsStatus.className = 'dashboard-progress-value neutral';
                }
            } else {
                document.getElementById('charsProjectionItem').style.display = 'none';
                document.getElementById('charsAvgItem').style.display = 'none';
                document.getElementById('charsProjectionSummary').style.display = 'none';
            }
            
            // Update games projection
            if (data.games && data.games.target_date) {
                hasAnyProjection = true;
                document.getElementById('gamesProjectionItem').style.display = 'block';
                document.getElementById('gamesAvgItem').style.display = 'block';
                document.getElementById('gamesProjectionSummary').style.display = 'block';
                
                document.getElementById('projectionGamesValue').textContent = data.games.projection.toLocaleString();
                document.getElementById('projectionGamesAvg').textContent = data.games.daily_average.toFixed(2);
                
                // Status message
                const gamesStatus = document.getElementById('gamesProjectionStatus');
                if (data.games.projection >= data.games.target) {
                    gamesStatus.textContent = 'On track! ✅';
                    gamesStatus.className = 'dashboard-progress-value positive';
                } else {
                    const shortfall = data.games.target - data.games.projection;
                    gamesStatus.textContent = `${shortfall} short`;
                    gamesStatus.className = 'dashboard-progress-value neutral';
                }
            } else {
                document.getElementById('gamesProjectionItem').style.display = 'none';
                document.getElementById('gamesAvgItem').style.display = 'none';
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
                    games_target_date: document.getElementById('gamesTargetDate').value || ''
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
                        gamesTargetDate: formData.games_target_date
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