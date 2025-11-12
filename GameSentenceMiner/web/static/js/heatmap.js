/**
 * Shared Heatmap Component for GSM
 * Provides reusable GitHub-style heatmap visualization
 */

class HeatmapRenderer {
    constructor(options = {}) {
        this.containerId = options.containerId || 'heatmapContainer';
        this.metricName = options.metricName || 'characters';
        this.metricLabel = options.metricLabel || 'characters';
        this.calculateStreaks = options.calculateStreaks || this.defaultCalculateStreaks.bind(this);
    }

    /**
     * Helper function to get week number of year (GitHub style - week starts on Sunday)
     */
    getWeekOfYear(date) {
        const yearStart = new Date(date.getFullYear(), 0, 1);
        const dayOfYear = Math.floor((date - yearStart) / (24 * 60 * 60 * 1000)) + 1;
        const dayOfWeek = yearStart.getDay(); // 0 = Sunday
        
        // Calculate week number (1-indexed)
        const weekNum = Math.ceil((dayOfYear + dayOfWeek) / 7);
        return Math.min(53, weekNum); // Cap at 53 weeks
    }
    
    /**
     * Helper function to get the first Sunday of the year (or before)
     */
    getFirstSunday(year) {
        const jan1 = new Date(year, 0, 1);
        const dayOfWeek = jan1.getDay();
        const firstSunday = new Date(year, 0, 1 - dayOfWeek);
        return firstSunday;
    }
    
    /**
     * Default streak calculation function
     */
    defaultCalculateStreaks(grid, yearData, allLinesForYear) {
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
        let currentStreak = 0;
        if (todayIndex >= 0) {
            for (let i = todayIndex; i >= 0; i--) {
                if (dates[i].activity >= streakRequirement) {
                    currentStreak++;
                } else {
                    break;
                }
            }
        }
        
        // Calculate average metric (e.g., avg daily characters or avg daily mining)
        let totalActivity = 0;
        let activeDays = 0;
        for (let i = 0; i < dates.length; i++) {
            if (dates[i].activity > 0) {
                totalActivity += dates[i].activity;
                activeDays++;
            }
        }
        const avgDaily = activeDays > 0 ? Math.round(totalActivity / activeDays) : 0;
        
        return { longestStreak, currentStreak, avgDaily };
    }
    
    /**
     * Create GitHub-style heatmap visualization
     * @param {Object} heatmapData - Object with year keys containing date->value mappings
     * @param {Array} allLinesData - Optional array of all line data for detailed calculations
     */
    render(heatmapData, allLinesData = []) {
        const container = document.getElementById(this.containerId);
        if (!container) {
            console.error(`Heatmap container #${this.containerId} not found`);
            return;
        }
        
        container.innerHTML = ''; // Clear existing content
        
        if (!heatmapData || Object.keys(heatmapData).length === 0) {
            container.innerHTML = `<p style="text-align: center; color: var(--text-tertiary); padding: 20px;">No ${this.metricLabel} data available for the selected date range.</p>`;
            return;
        }
        
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
            const firstSunday = this.getFirstSunday(parseInt(year));
            
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
                            // Check if custom color function is provided
                            if (this.customColorFunction) {
                                cell.style.backgroundColor = this.customColorFunction(activity, maxActivity);
                            } else {
                                // Default color calculation
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
                        }
                        
                        // Format tooltip based on metric type
                        const activityLabel = this.metricName === 'sentences'
                            ? `sentence${activity !== 1 ? 's' : ''} mined`
                            : `${this.metricLabel}`;
                        cell.title = `${dateStr}: ${activity} ${activityLabel}`;
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
            
            // Filter allLinesData for this specific year
            const yearLines = allLinesData ? allLinesData.filter(line => {
                if (!line.timestamp) return false;
                const lineYear = new Date(parseFloat(line.timestamp) * 1000).getFullYear();
                return lineYear === parseInt(year);
            }) : [];
            
            // Calculate and display streaks with year-specific data
            const streaks = this.calculateStreaks(grid, yearData, yearLines);
            const streaksDiv = document.createElement('div');
            streaksDiv.className = 'heatmap-streaks';
            
            // Format the third metric label based on type
            const thirdMetricLabel = this.metricName === 'sentences' ? 'Avg Daily Mining' : 'Avg Daily Time';
            const fourthMetricLabel = this.metricName === 'sentences' ? 'Avg Last 7 Days' : 'Avg Daily Time Last 7 Days';
            const fifthMetricLabel = this.metricName === 'sentences' ? "Avg Last 30 Days" : "Avg Daily Time Last 30 Days";
            
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
                    <div class="heatmap-streak-label">${thirdMetricLabel}</div>
                </div>
            `;
            if (streaks.avgDaily7 !== undefined) {
                streaksDiv.innerHTML += `
                <div class="heatmap-streak-item">
                    <div class="heatmap-streak-number">${streaks.avgDaily7}</div>
                    <div class="heatmap-streak-label">${fourthMetricLabel}</div>
                </div>
                `;
            }
            if (streaks.avgDaily30 !== undefined) {
                streaksDiv.innerHTML += `
                <div class="heatmap-streak-item">
                    <div class="heatmap-streak-number">${streaks.avgDaily30}</div>
                    <div class="heatmap-streak-label">${fifthMetricLabel}</div>
                </div>
                `;
            }
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
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
    window.HeatmapRenderer = HeatmapRenderer;
}