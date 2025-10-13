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

    // Global object to store chart instances
    window.myCharts = window.myCharts || {};

    // Helper function to create a chart to avoid repeating code
    function createChart(canvasId, datasets, chartTitle) {
        const ctx = document.getElementById(canvasId);
        if (!ctx) return null;  // Add null check
        
        const context = ctx.getContext('2d');

        // Destroy existing chart on this canvas if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }

        window.myCharts[canvasId] = new Chart(context, {
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
        return window.myCharts[canvasId];   
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
    function createGameBarChart(canvasId, chartData, chartTitle, yAxisLabel, showTrendline = false) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return null;  // Add null check
        
        const ctx = canvas.getContext('2d');
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
        
        // Calculate trendline if requested
        let trendlineData = null;
        if (showTrendline && chartData.totals.length > 1) {
            const trendline = calculateTrendline(chartData.totals);
            trendlineData = trendline.points;
        }
        
        // Destroy existing chart on this canvas if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }
        
        // Build datasets array
        const datasets = [{
            label: chartTitle,
            data: chartData.totals,
            backgroundColor: colors.map(color => color + '99'), // Semi-transparent
            borderColor: colors,
            borderWidth: 2,
            order: 2
        }];
        
        // Add trendline dataset if available
        if (trendlineData) {
            datasets.push({
                label: 'Trendline',
                data: trendlineData,
                type: 'line',
                borderColor: '#ff6384',
                borderWidth: 3,
                borderDash: [5, 5],
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 0,
                order: 1
            });
        }
        
        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: chartData.labels, // Each game as a separate label
                datasets: datasets
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

        return window.myCharts[canvasId];
    }

    // Specialized function for charts with custom formatting (time/speed)
    function createGameBarChartWithCustomFormat(canvasId, chartData, chartTitle, yAxisLabel, formatFunction, showTrendline = false) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return null;  // Add null check
        
        const ctx = canvas.getContext('2d');
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
        
        // Calculate trendline if requested
        let trendlineData = null;
        if (showTrendline && chartData.totals.length > 1) {
            const trendline = calculateTrendline(chartData.totals);
            trendlineData = trendline.points;
        }
        
        // Destroy existing chart if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }

        // Build datasets array
        const datasets = [{
            label: chartTitle,
            data: chartData.totals,
            backgroundColor: colors.map(color => color + '99'), // Semi-transparent
            borderColor: colors,
            borderWidth: 2,
            order: 2
        }];
        
        // Add trendline dataset if available
        if (trendlineData) {
            datasets.push({
                label: 'Trendline',
                data: trendlineData,
                type: 'line',
                borderColor: '#ff6384',
                borderWidth: 3,
                borderDash: [5, 5],
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 0,
                order: 1
            });
        }

        // Create new chart and store globally
        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: chartData.labels, // Each game as a separate label
                datasets: datasets
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
        return window.myCharts[canvasId];
    }

    // Helper function to calculate linear regression trendline
    function calculateTrendline(data) {
        const n = data.length;
        if (n === 0) return { slope: 0, intercept: 0, points: [] };
        
        // Calculate means
        let sumX = 0, sumY = 0;
        for (let i = 0; i < n; i++) {
            sumX += i;
            sumY += data[i];
        }
        const meanX = sumX / n;
        const meanY = sumY / n;
        
        // Calculate slope
        let numerator = 0, denominator = 0;
        for (let i = 0; i < n; i++) {
            numerator += (i - meanX) * (data[i] - meanY);
            denominator += (i - meanX) * (i - meanX);
        }
        const slope = denominator !== 0 ? numerator / denominator : 0;
        const intercept = meanY - slope * meanX;
        
        // Generate trendline points
        const points = [];
        for (let i = 0; i < n; i++) {
            points.push(slope * i + intercept);
        }
        
        return { slope, intercept, points };
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

    // Function to create hourly activity bar chart
    function createHourlyActivityChart(canvasId, hourlyData) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !hourlyData || !Array.isArray(hourlyData)) return null;
        
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }
        
        // Create hour labels (0-23)
        const hourLabels = [];
        for (let i = 0; i < 24; i++) {
            const hour12 = i === 0 ? 12 : i > 12 ? i - 12 : i;
            const ampm = i < 12 ? 'AM' : 'PM';
            hourLabels.push(`${hour12}${ampm}`);
        }
        
        // Generate gradient colors for bars based on activity values
        const maxActivity = Math.max(...hourlyData.filter(activity => activity > 0));
        const minActivity = Math.min(...hourlyData.filter(activity => activity > 0));
        
        const barColors = hourlyData.map(activity => {
            if (activity === 0) {
                return getCurrentTheme() === 'dark' ? 'rgba(100, 100, 100, 0.3)' : 'rgba(200, 200, 200, 0.3)';
            }
            
            // Create color gradient from red (low activity) to green (high activity)
            const normalizedActivity = maxActivity > minActivity ? (activity - minActivity) / (maxActivity - minActivity) : 0.5;
            const hue = normalizedActivity * 120; // 0 = red, 120 = green
            return `hsla(${hue}, 70%, 50%, 0.8)`;
        });
        
        const borderColors = hourlyData.map(activity => {
            if (activity === 0) {
                return getCurrentTheme() === 'dark' ? 'rgba(100, 100, 100, 0.6)' : 'rgba(200, 200, 200, 0.6)';
            }
            
            const normalizedActivity = maxActivity > minActivity ? (activity - minActivity) / (maxActivity - minActivity) : 0.5;
            const hue = normalizedActivity * 120;
            return `hsla(${hue}, 70%, 40%, 1)`;
        });

        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: hourLabels,
                datasets: [{
                    label: 'Characters Read',
                    data: hourlyData,
                    backgroundColor: barColors,
                    borderColor: borderColors,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false // Hide legend for cleaner look
                    },
                    title: {
                        display: true,
                        text: 'Reading Activity by Hour of Day',
                        color: getThemeTextColor(),
                        font: {
                            size: 16,
                            weight: 'bold'
                        },
                        padding: {
                            top: 10,
                            bottom: 20
                        }
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                const hourIndex = context[0].dataIndex;
                                const hour24 = hourIndex;
                                const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
                                const ampm = hour24 < 12 ? 'AM' : 'PM';
                                return `${hour12}:00 ${ampm} (${hour24}:00)`;
                            },
                            label: function(context) {
                                const activity = context.parsed.y;
                                if (activity === 0) {
                                    return 'No reading activity';
                                }
                                return `Characters: ${activity.toLocaleString()}`;
                            },
                            afterLabel: function(context) {
                                const activity = context.parsed.y;
                                if (activity === 0) return '';
                                
                                const total = hourlyData.reduce((sum, val) => sum + val, 0);
                                const percentage = total > 0 ? ((activity / total) * 100).toFixed(1) : '0.0';
                                return `${percentage}% of total activity`;
                            }
                        },
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: 'rgba(255, 255, 255, 0.2)',
                        borderWidth: 1,
                        cornerRadius: 8,
                        displayColors: true
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Characters Read',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            callback: function(value) {
                                return value.toLocaleString();
                            }
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Hour of Day',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor()
                        }
                    }
                },
                animation: {
                    duration: 1000,
                    easing: 'easeOutQuart'
                }
            }
        });
        
        return window.myCharts[canvasId];
    }

    // Function to create hourly reading speed bar chart
    function createHourlyReadingSpeedChart(canvasId, hourlySpeedData) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !hourlySpeedData || !Array.isArray(hourlySpeedData)) return null;
        
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }
        
        // Create hour labels (0-23)
        const hourLabels = [];
        for (let i = 0; i < 24; i++) {
            const hour12 = i === 0 ? 12 : i > 12 ? i - 12 : i;
            const ampm = i < 12 ? 'AM' : 'PM';
            hourLabels.push(`${hour12}${ampm}`);
        }
        
        // Generate gradient colors for bars based on speed values
        const maxSpeed = Math.max(...hourlySpeedData.filter(speed => speed > 0));
        const minSpeed = Math.min(...hourlySpeedData.filter(speed => speed > 0));
        
        const barColors = hourlySpeedData.map(speed => {
            if (speed === 0) {
                return getCurrentTheme() === 'dark' ? 'rgba(100, 100, 100, 0.3)' : 'rgba(200, 200, 200, 0.3)';
            }
            
            // Create color gradient from red (slow) to green (fast)
            const normalizedSpeed = maxSpeed > minSpeed ? (speed - minSpeed) / (maxSpeed - minSpeed) : 0.5;
            const hue = normalizedSpeed * 120; // 0 = red, 120 = green
            return `hsla(${hue}, 70%, 50%, 0.8)`;
        });
        
        const borderColors = hourlySpeedData.map(speed => {
            if (speed === 0) {
                return getCurrentTheme() === 'dark' ? 'rgba(100, 100, 100, 0.6)' : 'rgba(200, 200, 200, 0.6)';
            }
            
            const normalizedSpeed = maxSpeed > minSpeed ? (speed - minSpeed) / (maxSpeed - minSpeed) : 0.5;
            const hue = normalizedSpeed * 120;
            return `hsla(${hue}, 70%, 40%, 1)`;
        });

        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: hourLabels,
                datasets: [{
                    label: 'Average Reading Speed',
                    data: hourlySpeedData,
                    backgroundColor: barColors,
                    borderColor: borderColors,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false // Hide legend for cleaner look
                    },
                    title: {
                        display: true,
                        text: 'Average Reading Speed by Hour',
                        color: getThemeTextColor(),
                        font: {
                            size: 16,
                            weight: 'bold'
                        },
                        padding: {
                            top: 10,
                            bottom: 20
                        }
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                const hourIndex = context[0].dataIndex;
                                const hour24 = hourIndex;
                                const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
                                const ampm = hour24 < 12 ? 'AM' : 'PM';
                                return `${hour12}:00 ${ampm} (${hour24}:00)`;
                            },
                            label: function(context) {
                                const speed = context.parsed.y;
                                if (speed === 0) {
                                    return 'No reading activity';
                                }
                                return `Speed: ${speed.toLocaleString()} chars/hour`;
                            },
                            afterLabel: function(context) {
                                const speed = context.parsed.y;
                                if (speed === 0) return '';
                                
                                const nonZeroSpeeds = hourlySpeedData.filter(s => s > 0);
                                const avgSpeed = nonZeroSpeeds.reduce((sum, s) => sum + s, 0) / nonZeroSpeeds.length;
                                const comparison = speed > avgSpeed ? 'above' : speed < avgSpeed ? 'below' : 'at';
                                const percentage = avgSpeed > 0 ? Math.abs(((speed - avgSpeed) / avgSpeed) * 100).toFixed(1) : '0';
                                
                                return `${percentage}% ${comparison} average`;
                            }
                        },
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: 'rgba(255, 255, 255, 0.2)',
                        borderWidth: 1,
                        cornerRadius: 8,
                        displayColors: true
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Characters per Hour',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            callback: function(value) {
                                return value.toLocaleString();
                            }
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Hour of Day',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor()
                        }
                    }
                },
                animation: {
                    duration: 1000,
                    easing: 'easeOutQuart'
                }
            }
        });
        
        return window.myCharts[canvasId];
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

    // Function to update peak statistics display
    function updatePeakStatistics(peakDailyStats, peakSessionStats) {
        // Helper function to format large numbers
        function formatLargeNumber(num) {
            if (num >= 1000000) {
                return (num / 1000000).toFixed(1) + 'M';
            } else if (num >= 1000) {
                return (num / 1000).toFixed(1) + 'K';
            } else {
                return num.toString();
            }
        }

        // Helper function to format time in human-readable format
        function formatTimeHuman(hours) {
            if (hours < 1) {
                const minutes = Math.round(hours * 60);
                return minutes + 'm';
            } else if (hours < 24) {
                const wholeHours = Math.floor(hours);
                const minutes = Math.round((hours - wholeHours) * 60);
                if (minutes > 0) {
                    return wholeHours + 'h ' + minutes + 'm';
                } else {
                    return wholeHours + 'h';
                }
            } else {
                const days = Math.floor(hours / 24);
                const remainingHours = Math.floor(hours % 24);
                if (remainingHours > 0) {
                    return days + 'd ' + remainingHours + 'h';
                } else {
                    return days + 'd';
                }
            }
        }

        // Update the display elements
        const maxDailyCharsEl = document.getElementById('maxDailyChars');
        const maxDailyHoursEl = document.getElementById('maxDailyHours');
        const longestSessionEl = document.getElementById('longestSession');
        const maxSessionCharsEl = document.getElementById('maxSessionChars');

        if (maxDailyCharsEl) {
            maxDailyCharsEl.textContent = formatLargeNumber(peakDailyStats.max_daily_chars || 0);
        }

        if (maxDailyHoursEl) {
            maxDailyHoursEl.textContent = formatTimeHuman(peakDailyStats.max_daily_hours || 0);
        }

        if (longestSessionEl) {
            longestSessionEl.textContent = formatTimeHuman(peakSessionStats.longest_session_hours || 0);
        }

        if (maxSessionCharsEl) {
            maxSessionCharsEl.textContent = formatLargeNumber(peakSessionStats.max_session_chars || 0);
        }
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
                // Store all lines data globally for potential future use
                if (data.allLinesData && Array.isArray(data.allLinesData)) {
                    window.allLinesData = data.allLinesData;
                } else {
                    window.allLinesData = [];
                }
                
                if (!data.labels || data.labels.length === 0) {
                    console.log("No data to display.");
                    showNoDataPopup();
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

                // Charts are re-created with the new data 
                createChart('linesChart', linesData, 'Cumulative Lines Received');
                createChart('charsChart', charsData, 'Cumulative Characters Read');

                // Create reading chars quantity chart if data exists (with trendline)
                if (data.totalCharsPerGame) {
                    createGameBarChart('readingCharsChart', data.totalCharsPerGame, 'Reading Chars Quantity', 'Characters Read', true);
                }

                // Create reading time quantity chart if data exists (with trendline)
                if (data.readingTimePerGame) {
                    createGameBarChartWithCustomFormat('readingTimeChart', data.readingTimePerGame, 'Reading Time Quantity', 'Time (hours)', formatTime, true);
                }

                // Create reading speed per game chart if data exists (with trendline)
                if (data.readingSpeedPerGame) {
                    createGameBarChartWithCustomFormat('readingSpeedPerGameChart', data.readingSpeedPerGame, 'Reading Speed Improvement', 'Speed (chars/hour)', formatSpeed, true);
                }

                // Create hourly activity polar chart if data exists
                if (data.hourlyActivityData) {
                    createHourlyActivityChart('hourlyActivityChart', data.hourlyActivityData);
                }

                // Create hourly reading speed chart if data exists
                if (data.hourlyReadingSpeedData) {
                    createHourlyReadingSpeedChart('hourlyReadingSpeedChart', data.hourlyReadingSpeedData);
                }

                // Create kanji grid if data exists
                if (data.kanjiGridData) {
                    createKanjiGrid(data.kanjiGridData);
                }

                // Update peak statistics if data exists
                if (data.peakDailyStats && data.peakSessionStats) {
                    updatePeakStatistics(data.peakDailyStats, data.peakSessionStats);
                }

                return data;
            })
            .catch(error => {
                console.error('Error fetching chart data:', error);
                throw error;
            });
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

        if (!fromDateInput || !toDateInput) return; // Null check

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
            if (popup) popup.classList.remove("hidden");
            return; 
        }

        const { startTimestamp, endTimestamp } = getUnixTimestamps(fromDateStr, toDateStr);

        loadStatsData(startTimestamp, endTimestamp);
    }

    // Attach listeners to both date inputs
    if (fromDateInput) fromDateInput.addEventListener("change", handleDateChange);
    if (toDateInput) toDateInput.addEventListener("change", handleDateChange);

    initializeDates();

    // Popup close button
    if (closePopupBtn) {
        closePopupBtn.addEventListener("click", () => {
            if (popup) popup.classList.add("hidden");
        });
    }

    // Populate settings modal with global config values on load
    if (window.statsConfig) {
        const sessionGapInput = document.getElementById('sessionGap');
        if (sessionGapInput) sessionGapInput.value = window.statsConfig.sessionGapSeconds || 3600;

        const streakReqInput = document.getElementById('streakRequirement');
        if (streakReqInput) streakReqInput.value = window.statsConfig.streakRequirementHours || 1.0;

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

    // Make functions globally available
    window.loadStatsData = loadStatsData;

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