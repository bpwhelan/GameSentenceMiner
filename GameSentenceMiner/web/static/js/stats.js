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
        if (!hourlyData || !Array.isArray(hourlyData)) return null;
        
        // Create hour labels (0-23)
        const hourLabels = [];
        for (let i = 0; i < 24; i++) {
            const hour12 = i === 0 ? 12 : i > 12 ? i - 12 : i;
            const ampm = i < 12 ? 'AM' : 'PM';
            hourLabels.push(`${hour12}${ampm}`);
        }
        
        const chart = new BarChartComponent(canvasId, {
            title: 'Reading Activity by Hour of Day',
            colorScheme: 'gradient',
            yAxisLabel: 'Characters Read',
            xAxisLabel: 'Hour of Day',
            datasetLabel: 'Characters Read',
            maxRotation: 0,
            minRotation: 0,
            tooltipFormatter: {
                title: (context) => {
                    const hourIndex = context[0].dataIndex;
                    const hour24 = hourIndex;
                    const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
                    const ampm = hour24 < 12 ? 'AM' : 'PM';
                    return `${hour12}:00 ${ampm} (${hour24}:00)`;
                },
                label: (context) => {
                    const activity = context.parsed.y;
                    if (activity === 0) {
                        return 'No reading activity';
                    }
                    return `Characters: ${activity.toLocaleString()}`;
                },
                afterLabel: (context) => {
                    const activity = context.parsed.y;
                    if (activity === 0) return '';
                    
                    const total = hourlyData.reduce((sum, val) => sum + val, 0);
                    const percentage = total > 0 ? ((activity / total) * 100).toFixed(1) : '0.0';
                    return `${percentage}% of total activity`;
                }
            }
        });
        
        return chart.render(hourlyData, hourLabels);
    }

    // Function to create top 5 reading speed days horizontal bar chart
    function createTopReadingSpeedDaysChart(canvasId, readingSpeedHeatmapData) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !readingSpeedHeatmapData) return null;
        
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }
        
        // Extract all dates and speeds from heatmap data
        const allDays = [];
        for (const year in readingSpeedHeatmapData) {
            for (const date in readingSpeedHeatmapData[year]) {
                const speed = readingSpeedHeatmapData[year][date];
                if (speed > 0) {
                    allDays.push({ date, speed });
                }
            }
        }
        
        // Sort by speed descending and take top 5
        allDays.sort((a, b) => b.speed - a.speed);
        const top5Days = allDays.slice(0, 5);
        
        // If no data, show empty chart
        if (top5Days.length === 0) {
            return null;
        }
        
        // Prepare data for horizontal bar chart (reverse order so highest is on top)
        const labels = top5Days.reverse().map(day => day.date);
        const speeds = top5Days.map(day => day.speed);
        
        // Generate gradient colors from blue (fastest) to teal (5th fastest) - performance theme
        const colors = speeds.map((speed, index) => {
            // Reverse index so top bar gets best color
            const reverseIndex = speeds.length - 1 - index;
            const hue = 200 - (reverseIndex * 15); // 200 (blue) to 155 (cyan)
            return `hsla(${hue}, 70%, 50%, 0.8)`;
        });
        
        const borderColors = speeds.map((speed, index) => {
            const reverseIndex = speeds.length - 1 - index;
            const hue = 200 - (reverseIndex * 15);
            return `hsla(${hue}, 70%, 40%, 1)`;
        });
        
        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Reading Speed (chars/hour)',
                    data: speeds,
                    backgroundColor: colors,
                    borderColor: borderColors,
                    borderWidth: 2
                }]
            },
            options: {
                indexAxis: 'y', // This makes it horizontal
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    title: {
                        display: true,
                        text: 'Top 5 Fastest Reading Days',
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
                                return context[0].label;
                            },
                            label: function(context) {
                                const speed = context.parsed.x;
                                return `Speed: ${speed.toLocaleString()} chars/hour`;
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
                    x: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Reading Speed (chars/hour)',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            callback: function(value) {
                                return value.toLocaleString();
                            }
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Date',
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

    // Function to create day of week activity bar chart
    function createDayOfWeekChart(canvasId, dayOfWeekData) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !dayOfWeekData) return null;
        
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }
        
        // Day labels (Monday to Sunday)
        const dayLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        
        // Get data arrays
        const charsData = dayOfWeekData.chars || [0, 0, 0, 0, 0, 0, 0];
        const hoursData = dayOfWeekData.hours || [0, 0, 0, 0, 0, 0, 0];
        
        // Generate colors for each day - cohesive blue-purple gradient
        const colors = [
            'rgba(54, 162, 235, 0.8)',   // Monday - Blue
            'rgba(75, 192, 192, 0.8)',   // Tuesday - Teal
            'rgba(102, 187, 106, 0.8)',  // Wednesday - Green
            'rgba(255, 167, 38, 0.8)',   // Thursday - Orange
            'rgba(239, 83, 80, 0.8)',    // Friday - Red
            'rgba(171, 71, 188, 0.8)',   // Saturday - Purple
            'rgba(126, 87, 194, 0.8)'    // Sunday - Deep Purple
        ];
        
        const borderColors = [
            'rgba(54, 162, 235, 1)',
            'rgba(75, 192, 192, 1)',
            'rgba(102, 187, 106, 1)',
            'rgba(255, 167, 38, 1)',
            'rgba(239, 83, 80, 1)',
            'rgba(171, 71, 188, 1)',
            'rgba(126, 87, 194, 1)'
        ];
        
        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: dayLabels,
                datasets: [{
                    label: 'Characters Read',
                    data: charsData,
                    backgroundColor: colors,
                    borderColor: borderColors,
                    borderWidth: 2,
                    yAxisID: 'y'
                }, {
                    label: 'Hours Read',
                    data: hoursData,
                    backgroundColor: colors.map(c => c.replace('0.8', '0.4')),
                    borderColor: borderColors,
                    borderWidth: 2,
                    yAxisID: 'y1',
                    hidden: true
                }]
            },
            options: {
                responsive: true,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            color: getThemeTextColor()
                        }
                    },
                    title: {
                        display: true,
                        text: 'Reading Activity by Day of Week',
                        color: getThemeTextColor(),
                        font: {
                            size: 16,
                            weight: 'bold'
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const label = context.dataset.label || '';
                                const value = context.parsed.y;
                                if (label === 'Characters Read') {
                                    return `${label}: ${value.toLocaleString()} chars`;
                                } else {
                                    return `${label}: ${value.toFixed(2)} hours`;
                                }
                            }
                        },
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        titleColor: '#fff',
                        bodyColor: '#fff'
                    }
                },
                scales: {
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
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
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Hours Read',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor()
                        },
                        grid: {
                            drawOnChartArea: false
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Day of Week',
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

    // Function to create average hours by day bar chart
    function createAvgHoursByDayChart(canvasId, dayOfWeekData) {
        if (!dayOfWeekData) return null;
        
        const dayLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const hoursData = dayOfWeekData.avg_hours || [0, 0, 0, 0, 0, 0, 0];
        
        const chart = new BarChartComponent(canvasId, {
            title: 'Average Hours Read by Day of Week',
            colorScheme: 'gradient',
            yAxisLabel: 'Hours',
            xAxisLabel: 'Day of Week',
            datasetLabel: 'Hours Read',
            maxRotation: 0,
            minRotation: 0,
            yAxisFormatter: (value) => value.toFixed(1),
            tooltipFormatter: {
                label: (context) => {
                    const hours = context.parsed.y;
                    if (hours === 0) {
                        return 'No reading activity';
                    }
                    return `Hours: ${hours.toFixed(2)}`;
                },
                afterLabel: (context) => {
                    const hours = context.parsed.y;
                    if (hours === 0) return '';
                    
                    const nonZeroHours = hoursData.filter(h => h > 0);
                    if (nonZeroHours.length === 0) return '';
                    
                    const avgHours = nonZeroHours.reduce((sum, h) => sum + h, 0) / nonZeroHours.length;
                    const comparison = hours > avgHours ? 'above' : hours < avgHours ? 'below' : 'at';
                    const percentage = avgHours > 0 ? Math.abs(((hours - avgHours) / avgHours) * 100).toFixed(1) : '0';
                    
                    return `${percentage}% ${comparison} weekly average`;
                }
            }
        });
        
        return chart.render(hoursData, dayLabels);
    }

    // Function to create reading speed by difficulty bar chart
    function createDifficultySpeedChart(canvasId, difficultySpeedData) {
        const canvas = document.getElementById(canvasId);
        const noDataEl = document.getElementById('difficultySpeedNoData');
        if (!canvas) return null;
        
        // Destroy existing chart if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }
        
        const labels = difficultySpeedData?.labels || [];
        const speeds = difficultySpeedData?.speeds || [];
        
        if (!difficultySpeedData || labels.length === 0) {
            canvas.style.display = 'none';
            if (noDataEl) {
                noDataEl.style.display = 'block';
            }
            return null;
        }
        
        canvas.style.display = 'block';
        if (noDataEl) {
            noDataEl.style.display = 'none';
        }
        
        const ctx = canvas.getContext('2d');
        
        // Generate gradient colors from blue (easy) to orange (hard) - difficulty theme
        const colors = speeds.map((_, index) => {
            const ratio = index / Math.max(labels.length - 1, 1);
            const hue = 200 - (ratio * 170); // 200 (blue) to 30 (orange)
            return `hsla(${hue}, 70%, 50%, 0.8)`;
        });
        
        const borderColors = speeds.map((_, index) => {
            const ratio = index / Math.max(labels.length - 1, 1);
            const hue = 200 - (ratio * 170);
            return `hsla(${hue}, 70%, 40%, 1)`;
        });
        
        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Average Reading Speed',
                    data: speeds,
                    backgroundColor: colors,
                    borderColor: borderColors,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    title: {
                        display: true,
                        text: 'Average Reading Speed by Game Difficulty',
                        color: getThemeTextColor(),
                        font: {
                            size: 16,
                            weight: 'bold'
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const speed = context.parsed.y;
                                return `Speed: ${speed.toLocaleString()} chars/hour`;
                            }
                        },
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        titleColor: '#fff',
                        bodyColor: '#fff'
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
                            text: 'Difficulty Level',
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

    // Function to create game type distribution bar chart
    function createGameTypeChart(canvasId, gameTypeData) {
        const canvas = document.getElementById(canvasId);
        const noDataEl = document.getElementById('gameTypeNoData');
        
        if (!canvas) return null;
        
        if (!gameTypeData || !gameTypeData.labels || gameTypeData.labels.length === 0) {
            canvas.style.display = 'none';
            if (noDataEl) {
                noDataEl.style.display = 'block';
            }
            return null;
        }
        
        canvas.style.display = 'block';
        if (noDataEl) {
            noDataEl.style.display = 'none';
        }
        
        const chart = new BarChartComponent(canvasId, {
            title: 'Games by Type',
            colorScheme: 'gradient',
            yAxisLabel: 'Number of Games',
            xAxisLabel: 'Game Type',
            datasetLabel: 'Games',
            maxRotation: 45,
            minRotation: 45,
            tooltipFormatter: {
                label: (context) => {
                    const count = context.parsed.y;
                    const total = gameTypeData.counts.reduce((sum, val) => sum + val, 0);
                    const percentage = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
                    return `Games: ${count} (${percentage}%)`;
                }
            }
        });
        
        return chart.render(gameTypeData.counts, gameTypeData.labels);
    }


    function createCardsMinedChart(canvasId, chartData) {
        const canvas = document.getElementById(canvasId);
        const noDataEl = document.getElementById('cardsMinedNoData');
        if (!canvas) return null;

        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
            delete window.myCharts[canvasId];
        }

        const hasLabels =
            chartData &&
            Array.isArray(chartData.labels) &&
            chartData.labels.length > 0;

        const hasTotals =
            chartData &&
            Array.isArray(chartData.totals) &&
            chartData.totals.length > 0 &&
            chartData.labels.length === chartData.totals.length;

        const hasNonZeroTotals = hasTotals
            ? chartData.totals.some((value) => Number(value) > 0)
            : false;

        if (!hasLabels || !hasTotals || !hasNonZeroTotals) {
            canvas.style.display = 'none';
            if (noDataEl) {
                noDataEl.style.display = 'block';
            }
            return null;
        }

        canvas.style.display = 'block';
        if (noDataEl) {
            noDataEl.style.display = 'none';
        }

        const ctx = canvas.getContext('2d');
        
        // Generate gradient colors based on values (more = greener)
        const maxVal = Math.max(...chartData.totals.filter(v => v > 0));
        const minVal = Math.min(...chartData.totals.filter(v => v > 0));
        const isDark = getCurrentTheme() === 'dark';
        
        const barColors = chartData.totals.map(value => {
            if (value === 0) {
                return isDark ? 'rgba(100, 100, 100, 0.3)' : 'rgba(200, 200, 200, 0.3)';
            }
            const normalized = maxVal > minVal ? (value - minVal) / (maxVal - minVal) : 0.5;
            const hue = 30 + (normalized * 170); // 30 = orange, 200 = blue
            return `hsla(${hue}, 70%, 50%, 0.8)`;
        });
        
        const borderColors = chartData.totals.map(value => {
            if (value === 0) {
                return isDark ? 'rgba(100, 100, 100, 0.6)' : 'rgba(200, 200, 200, 0.6)';
            }
            const normalized = maxVal > minVal ? (value - minVal) / (maxVal - minVal) : 0.5;
            const hue = 30 + (normalized * 170);
            return `hsla(${hue}, 70%, 40%, 1)`;
        });

        // Format labels to show weekend indicator
        const formattedLabels = chartData.labels.map(dateStr => {
            const date = new Date(dateStr);
            const dayOfWeek = date.getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            return isWeekend ? `${dateStr} 📅` : dateStr;
        });
        
        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: formattedLabels,
                datasets: [
                    {
                        label: 'Cards Mined',
                        data: chartData.totals,
                        backgroundColor: barColors,
                        borderColor: borderColors,
                        borderWidth: 2,
                        borderRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            title: function (context) {
                                const index = context[0].dataIndex;
                                return chartData.labels[index];
                            },
                            label: function (context) {
                                const value = context.parsed.y || 0;
                                return `Cards: ${value.toLocaleString()}`;
                            },
                            afterLabel: function(context) {
                                const index = context[0].dataIndex;
                                const date = new Date(chartData.labels[index]);
                                const dayOfWeek = date.getDay();
                                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                                return isWeekend ? '📅 Weekend' : '';
                            }
                        },
                        backgroundColor: 'rgba(0, 0, 0, 0.85)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: 'rgba(255, 255, 255, 0.2)',
                        borderWidth: 1,
                        cornerRadius: 6,
                        displayColors: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Cards Mined',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            callback: function (value) {
                                return value.toLocaleString();
                            }
                        },
                        grid: {
                            color:
                                getCurrentTheme() === 'dark'
                                    ? 'rgba(255, 255, 255, 0.1)'
                                    : 'rgba(0, 0, 0, 0.1)'
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Date',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            maxRotation: 45,
                            minRotation: 45,
                            callback: function (value) {
                                return this.getLabelForValue(value);
                            }
                        },
                        grid: {
                            display: false
                        }
                    }
                }
            }
        });

        return window.myCharts[canvasId];
    }

    // Function to create top 5 character count days horizontal bar chart
    function createTopCharacterDaysChart(canvasId, heatmapData) {
        if (!heatmapData) return null;
        
        // Extract all dates and character counts from heatmap data
        const allDays = [];
        for (const year in heatmapData) {
            for (const date in heatmapData[year]) {
                const chars = heatmapData[year][date];
                if (chars > 0) {
                    allDays.push({ date, chars });
                }
            }
        }
        
        // Sort by character count descending and take top 5
        allDays.sort((a, b) => b.chars - a.chars);
        const top5Days = allDays.slice(0, 5);
        
        if (top5Days.length === 0) return null;
        
        // Prepare data for horizontal bar chart (reverse order so highest is on top)
        const labels = top5Days.reverse().map(day => day.date);
        const charCounts = top5Days.map(day => day.chars);
        
        const chart = new BarChartComponent(canvasId, {
            title: 'Top 5 Most Productive Reading Days',
            type: 'horizontal',
            colorScheme: 'performance',
            xAxisLabel: 'Characters Read',
            yAxisLabel: 'Date',
            datasetLabel: 'Characters Read',
            valueFormatter: (value) => `Characters: ${value.toLocaleString()}`
        });
        
        return chart.render(charCounts, labels);
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
            
            // Create color gradient from orange (slow) to blue (fast) - performance theme
            const normalizedSpeed = maxSpeed > minSpeed ? (speed - minSpeed) / (maxSpeed - minSpeed) : 0.5;
            const hue = 30 + (normalizedSpeed * 170); // 30 = orange, 200 = blue
            return `hsla(${hue}, 70%, 50%, 0.8)`;
        });
        
        const borderColors = hourlySpeedData.map(speed => {
            if (speed === 0) {
                return getCurrentTheme() === 'dark' ? 'rgba(100, 100, 100, 0.6)' : 'rgba(200, 200, 200, 0.6)';
            }
            
            const normalizedSpeed = maxSpeed > minSpeed ? (speed - minSpeed) / (maxSpeed - minSpeed) : 0.5;
            const hue = 30 + (normalizedSpeed * 170);
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

    // Initialize heatmap renderer with mining-specific configuration
    const miningHeatmapRenderer = new HeatmapRenderer({
        containerId: 'miningHeatmapContainer',
        metricName: 'sentences',
        metricLabel: 'sentences mined'
    });
    
    // Function to create GitHub-style heatmap for mining activity using shared component
    function createMiningHeatmap(heatmapData) {
        miningHeatmapRenderer.render(heatmapData);
    }

    // Initialize Kanji Grid Renderer (using shared component)
    const kanjiGridRenderer = new KanjiGridRenderer({
        containerSelector: '#kanjiGrid',
        counterSelector: '#kanjiCount',
        colorMode: 'backend',
        emptyMessage: 'No kanji data available'
    });
    
    // Function to create daily time bar chart with weekend markers
    function createDailyTimeChart(canvasId, chartData, isAllTime = false) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !chartData) return null;
        
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }
        
        // Generate gradient colors based on values (more = greener)
        const maxVal = Math.max(...chartData.timeData.filter(v => v > 0));
        const minVal = Math.min(...chartData.timeData.filter(v => v > 0));
        const isDark = getCurrentTheme() === 'dark';
        
        const barColors = chartData.timeData.map(value => {
            if (value === 0) {
                return isDark ? 'rgba(100, 100, 100, 0.3)' : 'rgba(200, 200, 200, 0.3)';
            }
            const normalized = maxVal > minVal ? (value - minVal) / (maxVal - minVal) : 0.5;
            const hue = 30 + (normalized * 170); // 30 = orange, 200 = blue
            return `hsla(${hue}, 70%, 50%, 0.8)`;
        });
        
        const borderColors = chartData.timeData.map(value => {
            if (value === 0) {
                return isDark ? 'rgba(100, 100, 100, 0.6)' : 'rgba(200, 200, 200, 0.6)';
            }
            const normalized = maxVal > minVal ? (value - minVal) / (maxVal - minVal) : 0.5;
            const hue = 30 + (normalized * 170);
            return `hsla(${hue}, 70%, 40%, 1)`;
        });
        
        // Format labels to show day of week with weekend indicator
        const formattedLabels = chartData.labels.map(dateStr => {
            const date = new Date(dateStr);
            const dayOfWeek = date.getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return isWeekend ? `${dayNames[dayOfWeek]} ${monthDay} 📅` : `${dayNames[dayOfWeek]} ${monthDay}`;
        });
        
        // Update the title element
        const titleElement = document.getElementById('dailyTimeChartTitle');
        if (titleElement) {
            titleElement.textContent = isAllTime ? '📊 Daily Reading Time (All Time)' : '📊 Daily Reading Time (Last 4 Weeks)';
        }
        
        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: formattedLabels,
                datasets: [{
                    label: 'Hours Read',
                    data: chartData.timeData,
                    backgroundColor: barColors,
                    borderColor: borderColors,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    title: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                const index = context[0].dataIndex;
                                return chartData.labels[index];
                            },
                            label: function(context) {
                                const hours = context.parsed.y;
                                if (hours === 0) {
                                    return 'No reading activity';
                                }
                                const wholeHours = Math.floor(hours);
                                const minutes = Math.round((hours - wholeHours) * 60);
                                if (minutes > 0) {
                                    return `Time: ${wholeHours}h ${minutes}m`;
                                } else {
                                    return `Time: ${wholeHours}h`;
                                }
                            },
                            afterLabel: function(context) {
                                const index = context[0].dataIndex;
                                const date = new Date(chartData.labels[index]);
                                const dayOfWeek = date.getDay();
                                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                                return isWeekend ? '📅 Weekend' : '';
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
                            text: 'Hours',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            callback: function(value) {
                                return value.toFixed(1);
                            }
                        }
                    },
                    x: {
                        title: {
                            display: true,
                            text: 'Date',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            maxRotation: 45,
                            minRotation: 45
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

    // Function to create daily characters bar chart with gradient colors
    function createDailyCharsChart(canvasId, chartData, isAllTime = false) {
        if (!chartData) return null;
        
        // Format labels to show day of week with weekend indicator
        const formattedLabels = chartData.labels.map(dateStr => {
            const date = new Date(dateStr);
            const dayOfWeek = date.getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return isWeekend ? `${dayNames[dayOfWeek]} ${monthDay} 📅` : `${dayNames[dayOfWeek]} ${monthDay}`;
        });
        
        // Generate gradient colors based on values (more = greener)
        const maxVal = Math.max(...chartData.charsData.filter(v => v > 0));
        const minVal = Math.min(...chartData.charsData.filter(v => v > 0));
        const isDark = getCurrentTheme() === 'dark';
        
        const barColors = chartData.charsData.map(value => {
            if (value === 0) {
                return isDark ? 'rgba(100, 100, 100, 0.3)' : 'rgba(200, 200, 200, 0.3)';
            }
            const normalized = maxVal > minVal ? (value - minVal) / (maxVal - minVal) : 0.5;
            const hue = 30 + (normalized * 170); // 30 = orange, 200 = blue
            return `hsla(${hue}, 70%, 50%, 0.8)`;
        });
        
        const borderColors = chartData.charsData.map(value => {
            if (value === 0) {
                return isDark ? 'rgba(100, 100, 100, 0.6)' : 'rgba(200, 200, 200, 0.6)';
            }
            const normalized = maxVal > minVal ? (value - minVal) / (maxVal - minVal) : 0.5;
            const hue = 30 + (normalized * 170);
            return `hsla(${hue}, 70%, 40%, 1)`;
        });
        
        const canvas = document.getElementById(canvasId);
        if (!canvas) return null;
        
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }
        
        // Update the title element
        const titleElement = document.getElementById('dailyCharsChartTitle');
        if (titleElement) {
            titleElement.textContent = isAllTime ? '📚 Daily Characters Read (All Time)' : '📚 Daily Characters Read (Last 4 Weeks)';
        }
        
        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: formattedLabels,
                datasets: [{
                    label: 'Characters Read',
                    data: chartData.charsData,
                    backgroundColor: barColors,
                    borderColor: borderColors,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    title: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                const index = context[0].dataIndex;
                                return chartData.labels[index];
                            },
                            label: function(context) {
                                const chars = context.parsed.y;
                                if (chars === 0) {
                                    return 'No reading activity';
                                }
                                return `Characters: ${chars.toLocaleString()}`;
                            },
                            afterLabel: function(context) {
                                const index = context[0].dataIndex;
                                const date = new Date(chartData.labels[index]);
                                const dayOfWeek = date.getDay();
                                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                                return isWeekend ? '📅 Weekend' : '';
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
                            text: 'Characters',
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
                            text: 'Date',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            maxRotation: 45,
                            minRotation: 45
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

    // Function to create daily reading speed line chart
    function createDailySpeedChart(canvasId, chartData, isAllTime = false) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !chartData) return null;
        
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }
        
        // Filter out days with no data for cleaner line chart
        const filteredLabels = [];
        const filteredSpeedData = [];
        const filteredOriginalLabels = [];
        
        chartData.labels.forEach((dateStr, index) => {
            if (chartData.speedData[index] > 0) {
                const date = new Date(dateStr);
                const dayOfWeek = date.getDay();
                const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                filteredLabels.push(`${dayNames[dayOfWeek]} ${monthDay}`);
                filteredSpeedData.push(chartData.speedData[index]);
                filteredOriginalLabels.push(dateStr);
            }
        });
        
        // Generate point colors based on weekend - consistent with other daily charts
        const pointColors = filteredOriginalLabels.map(dateStr => {
            const date = new Date(dateStr);
            const dayOfWeek = date.getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            return isWeekend ? 'rgba(171, 71, 188, 1)' : 'rgba(54, 162, 235, 1)';
        });
        
        // Update the title element
        const titleElement = document.getElementById('dailySpeedChartTitle');
        if (titleElement) {
            titleElement.textContent = isAllTime ? '⚡ Daily Reading Speed (All Time)' : '⚡ Daily Reading Speed (Last 4 Weeks)';
        }
        
        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: filteredLabels,
                datasets: [{
                    label: 'Reading Speed (chars/hour)',
                    data: filteredSpeedData,
                    borderColor: 'rgba(54, 162, 235, 1)',
                    backgroundColor: 'rgba(54, 162, 235, 0.1)',
                    pointBackgroundColor: pointColors,
                    pointBorderColor: pointColors,
                    pointRadius: 5,
                    pointHoverRadius: 7,
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    title: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                const index = context[0].dataIndex;
                                return filteredOriginalLabels[index];
                            },
                            label: function(context) {
                                const speed = context.parsed.y;
                                return `Speed: ${speed.toLocaleString()} chars/hour`;
                            },
                            afterLabel: function(context) {
                                const index = context[0].dataIndex;
                                const date = new Date(filteredOriginalLabels[index]);
                                const dayOfWeek = date.getDay();
                                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                                return isWeekend ? '📅 Weekend' : '';
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
                            text: 'Date',
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            maxRotation: 45,
                            minRotation: 45
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

    // Function to create kanji grid (now using shared renderer)
    function createKanjiGrid(kanjiData) {
        kanjiGridRenderer.render(kanjiData);
    }

    // Function to update game milestones display
    function updateGameMilestones(gameMilestones) {
        const oldestCard = document.getElementById('oldestGameCard');
        const newestCard = document.getElementById('newestGameCard');
        const noDataMsg = document.getElementById('milestonesNoData');
        
        if (!gameMilestones || (!gameMilestones.oldest_game && !gameMilestones.newest_game)) {
            // No milestone data available
            if (oldestCard) oldestCard.style.display = 'none';
            if (newestCard) newestCard.style.display = 'none';
            if (noDataMsg) noDataMsg.style.display = 'block';
            return;
        }
        
        // Hide no data message
        if (noDataMsg) noDataMsg.style.display = 'none';
        
        // Update oldest game card
        if (gameMilestones.oldest_game && oldestCard) {
            const game = gameMilestones.oldest_game;
            
            // Update image with proper base64 handling
            const imageEl = document.getElementById('oldestGameImage');
            if (game.image && game.image.trim()) {
                let imageSrc = game.image.trim();
                
                // Check if it's a base64 image or URL
                if (imageSrc.startsWith('data:image')) {
                    console.log('[DEBUG] Setting base64 image with data URI for oldest game');
                    imageEl.src = imageSrc;
                    imageEl.style.display = 'block';
                } else if (imageSrc.startsWith('http')) {
                    console.log('[DEBUG] Setting URL image for oldest game:', imageSrc);
                    imageEl.src = imageSrc;
                    imageEl.style.display = 'block';
                } else if (imageSrc.startsWith('/9j/') || imageSrc.startsWith('iVBOR')) {
                    // Raw base64 data without data URI prefix - add it
                    // /9j/ is JPEG, iVBOR is PNG
                    const mimeType = imageSrc.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
                    imageSrc = `data:${mimeType};base64,${imageSrc}`;
                    console.log('[DEBUG] Added data URI prefix to raw base64 data for oldest game');
                    imageEl.src = imageSrc;
                    imageEl.style.display = 'block';
                } else {
                    // Invalid image format, use placeholder
                    console.log('[DEBUG] Invalid image format for oldest game, using placeholder');
                    imageEl.parentElement.innerHTML = '<div class="milestone-game-image placeholder">🎮</div>';
                }
                
                imageEl.onerror = function() {
                    this.style.display = 'none';
                    this.parentElement.innerHTML = '<div class="milestone-game-image placeholder">🎮</div>';
                };
            } else {
                console.log('[DEBUG] No image data for oldest game, using placeholder');
                imageEl.parentElement.innerHTML = '<div class="milestone-game-image placeholder">🎮</div>';
            }
            
            // Update title
            document.getElementById('oldestGameTitle').textContent = game.title_original || 'Unknown Game';
            
            // Update subtitle (romaji or english)
            const subtitle = game.title_romaji || game.title_english || '';
            const subtitleEl = document.getElementById('oldestGameSubtitle');
            if (subtitle) {
                subtitleEl.textContent = subtitle;
                subtitleEl.style.display = 'block';
            } else {
                subtitleEl.style.display = 'none';
            }
            
            // Update release date
            document.getElementById('oldestGameReleaseYear').textContent = game.release_date || 'Unknown';
            
            
            oldestCard.style.display = 'flex';
        }
        
        // Update newest game card
        if (gameMilestones.newest_game && newestCard) {
            const game = gameMilestones.newest_game;
            
            // Update image with proper base64 handling
            const imageEl = document.getElementById('newestGameImage');
            if (game.image && game.image.trim()) {
                let imageSrc = game.image.trim();
                
                // Check if it's a base64 image or URL
                if (imageSrc.startsWith('data:image')) {
                    console.log('[DEBUG] Setting base64 image with data URI for newest game');
                    imageEl.src = imageSrc;
                    imageEl.style.display = 'block';
                } else if (imageSrc.startsWith('http')) {
                    console.log('[DEBUG] Setting URL image for newest game:', imageSrc);
                    imageEl.src = imageSrc;
                    imageEl.style.display = 'block';
                } else if (imageSrc.startsWith('/9j/') || imageSrc.startsWith('iVBOR')) {
                    // Raw base64 data without data URI prefix - add it
                    // /9j/ is JPEG, iVBOR is PNG
                    const mimeType = imageSrc.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
                    imageSrc = `data:${mimeType};base64,${imageSrc}`;
                    console.log('[DEBUG] Added data URI prefix to raw base64 data for newest game');
                    imageEl.src = imageSrc;
                    imageEl.style.display = 'block';
                } else {
                    // Invalid image format, use placeholder
                    console.log('[DEBUG] Invalid image format for newest game, using placeholder');
                    imageEl.parentElement.innerHTML = '<div class="milestone-game-image placeholder">🎮</div>';
                }
                
                imageEl.onerror = function() {
                    this.style.display = 'none';
                    this.parentElement.innerHTML = '<div class="milestone-game-image placeholder">🎮</div>';
                };
            } else {
                console.log('[DEBUG] No image data for newest game, using placeholder');
                imageEl.parentElement.innerHTML = '<div class="milestone-game-image placeholder">🎮</div>';
            }
            
            // Update title
            document.getElementById('newestGameTitle').textContent = game.title_original || 'Unknown Game';
            
            // Update subtitle (romaji or english)
            const subtitle = game.title_romaji || game.title_english || '';
            const subtitleEl = document.getElementById('newestGameSubtitle');
            if (subtitle) {
                subtitleEl.textContent = subtitle;
                subtitleEl.style.display = 'block';
            } else {
                subtitleEl.style.display = 'none';
            }
            
            // Update release date
            document.getElementById('newestGameReleaseYear').textContent = game.release_date || 'Unknown';
            
            
            newestCard.style.display = 'flex';
        }
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

    // Cache for filtered datasets to avoid re-filtering
    let cachedFilteredDatasets = null;
    
    // Function to get or create filtered datasets
    function getFilteredDatasets(data) {
        // Return cached version if available and data hasn't changed
        if (cachedFilteredDatasets && cachedFilteredDatasets.sourceData === data.datasets) {
            return cachedFilteredDatasets;
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
        
        // Cache the result
        cachedFilteredDatasets = {
            sourceData: data.datasets,
            linesData: linesData,
            charsData: charsData
        };
        
        return cachedFilteredDatasets;
    }

    // Function to load and render daily activity charts
    async function loadDailyActivityCharts(useAllTimeData = false) {
        try {
            let url = '/api/daily-activity';
            if (useAllTimeData) {
                url += '?all_time=true';
            }
            
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error('Failed to load daily activity data');
            }
            
            const data = await response.json();
            
            // Create the charts with the isAllTime flag
            if (data.labels && data.labels.length > 0) {
                createDailyTimeChart('dailyTimeChart', data, useAllTimeData);
                createDailyCharsChart('dailyCharsChart', data, useAllTimeData);
                createDailySpeedChart('dailySpeedChart', data, useAllTimeData);
            } else {
                console.log('No daily activity data available');
            }
        } catch (error) {
            console.error('Error loading daily activity charts:', error);
        }
    }

    // Function to load mining heatmap data
    async function loadMiningHeatmap(start_timestamp = null, end_timestamp = null) {
        try {
            let url = '/api/mining_heatmap';
            const params = new URLSearchParams();

            if (start_timestamp && end_timestamp) {
                params.append('start', start_timestamp);
                params.append('end', end_timestamp);
            }

            const queryString = params.toString();
            if (queryString) {
                url += `?${queryString}`;
            }

            const resp = await fetch(url);
            if (!resp.ok) throw new Error('Failed to load mining heatmap');
            const data = await resp.json();
            
            if (data && Object.keys(data).length > 0) {
                createMiningHeatmap(data);
            } else {
                const container = document.getElementById('miningHeatmapContainer');
                if (container) {
                    container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 20px;">No mining data available for the selected date range.</p>';
                }
            }
        } catch (e) {
            console.error('Failed to load mining heatmap:', e);
            const container = document.getElementById('miningHeatmapContainer');
            if (container) {
                container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 20px;">Failed to load mining heatmap.</p>';
            }
        }
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
        
        // Load mining heatmap separately
        loadMiningHeatmap(start_timestamp, end_timestamp);
        
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

                // Get filtered datasets (cached if possible)
                const filtered = getFilteredDatasets(data);
                const linesData = filtered.linesData;
                const charsData = filtered.charsData;

                // Charts are re-created with the new data 
                createChart('linesChart', linesData, 'Cumulative Lines Received');
                createChart('charsChart', charsData, 'Cumulative Characters Read');

                // Create reading chars quantity chart if data exists (with trendline)
                if (data.totalCharsPerGame) {
                    createGameBarChart('readingCharsChart', data.totalCharsPerGame, 'Reading Chars Quantity', 'Characters Read', false);
                }

                // Create reading time quantity chart if data exists (with trendline)
                if (data.readingTimePerGame) {
                    createGameBarChartWithCustomFormat('readingTimeChart', data.readingTimePerGame, 'Reading Time Quantity', 'Time (hours)', formatTime, false);
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

                // Create top 5 reading speed days chart if data exists
                if (data.readingSpeedHeatmapData) {
                    createTopReadingSpeedDaysChart('topReadingSpeedDaysChart', data.readingSpeedHeatmapData);
                }

                // Create top 5 character count days chart if data exists
                if (data.heatmapData) {
                    createTopCharacterDaysChart('topCharacterDaysChart', data.heatmapData);
                }

                // Create day of week activity chart if data exists
                if (data.dayOfWeekData) {
                    createDayOfWeekChart('dayOfWeekChart', data.dayOfWeekData);
                }

                // Create average hours by day chart if data exists
                if (data.dayOfWeekData) {
                    createAvgHoursByDayChart('avgHoursByDayChart', data.dayOfWeekData);
                }

                // Create difficulty speed chart if data exists
                if (data.difficultySpeedData) {
                    createDifficultySpeedChart('difficultySpeedChart', data.difficultySpeedData);
                }

                // Create game type chart if data exists
                if (data.gameTypeData) {
                    createGameTypeChart('gameTypeChart', data.gameTypeData);
                }

                createCardsMinedChart('cardsMinedChart', data.cardsMinedLast30Days || null);

                // Create mining heatmap if data exists
                if (data.miningHeatmapData) {
                    if (Object.keys(data.miningHeatmapData).length > 0) {
                        createMiningHeatmap(data.miningHeatmapData);
                    } else {
                        const container = document.getElementById('miningHeatmapContainer');
                        if (container) {
                            container.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 20px;">No mining data available for the selected date range.</p>';
                        }
                    }
                }

                // Load and create daily activity charts
                loadDailyActivityCharts();

                // Create kanji grid if data exists
                if (data.kanjiGridData) {
                    createKanjiGrid(data.kanjiGridData);
                }

                // Update peak statistics if data exists
                if (data.peakDailyStats && data.peakSessionStats) {
                    updatePeakStatistics(data.peakDailyStats, data.peakSessionStats);
                }

                // Update game milestones if data exists
                if (data.gameMilestones) {
                    updateGameMilestones(data.gameMilestones);
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
    // Initialize date inputs with sessionStorage or use config values
    // Dispatches "datesSet" event once dates are set
    // ================================
    function initializeDates() {
        const fromDateInput = document.getElementById('fromDate');
        const toDateInput = document.getElementById('toDate');

        if (!fromDateInput || !toDateInput) return; // Null check

        const fromDate = sessionStorage.getItem("fromDate");
        const toDate = sessionStorage.getItem("toDate");

        if (!(fromDate && toDate)) {
            // Use first_date from statsConfig if available (avoids extra API call)
            const firstDate = window.statsConfig && window.statsConfig.firstDate
                ? window.statsConfig.firstDate
                : new Date().toLocaleDateString('en-CA'); // Fallback to today
            
            fromDateInput.value = firstDate;

            // Get today's date
            const today = new Date();
            const todayStr = today.toLocaleDateString('en-CA');
            toDateInput.value = todayStr;

            // Save in sessionStorage
            sessionStorage.setItem("fromDate", firstDate);
            sessionStorage.setItem("toDate", todayStr);

            document.dispatchEvent(new Event("datesSet"));
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
    
    // Add toggle button functionality for all three daily charts
    const toggleTimeDataBtn = document.getElementById('toggleTimeDataBtn');
    const toggleCharsDataBtn = document.getElementById('toggleCharsDataBtn');
    const toggleSpeedDataBtn = document.getElementById('toggleSpeedDataBtn');
    
    // Helper function to handle toggle button clicks
    function setupToggleButton(button) {
        if (!button) return;
        
        button.addEventListener('click', function() {
            const currentMode = this.getAttribute('data-mode');
            
            if (currentMode === '30days') {
                // Switch to all-time data
                this.setAttribute('data-mode', 'alltime');
                this.textContent = 'View 30 days data';
                loadDailyActivityCharts(true);
                
                // Update all other buttons to match
                [toggleTimeDataBtn, toggleCharsDataBtn, toggleSpeedDataBtn].forEach(btn => {
                    if (btn && btn !== this) {
                        btn.setAttribute('data-mode', 'alltime');
                        btn.textContent = 'View 30 days data';
                    }
                });
            } else {
                // Switch back to 30 days data
                this.setAttribute('data-mode', '30days');
                this.textContent = 'View all time data';
                loadDailyActivityCharts(false);
                
                // Update all other buttons to match
                [toggleTimeDataBtn, toggleCharsDataBtn, toggleSpeedDataBtn].forEach(btn => {
                    if (btn && btn !== this) {
                        btn.setAttribute('data-mode', '30days');
                        btn.textContent = 'View all time data';
                    }
                });
            }
        });
    }
    
    // Setup all toggle buttons
    setupToggleButton(toggleTimeDataBtn);
    setupToggleButton(toggleCharsDataBtn);
    setupToggleButton(toggleSpeedDataBtn);

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