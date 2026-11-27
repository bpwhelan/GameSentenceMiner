/**
 * Unified Bar Chart Component for GSM Statistics
 * Provides a consistent interface for creating bar charts with the app's color system
 */

class BarChartComponent {
    constructor(canvasId, options = {}) {
        this.canvasId = canvasId;
        this.canvas = document.getElementById(canvasId);
        this.chart = null;
        
        // Default options
        this.options = {
            title: options.title || '',
            type: options.type || 'vertical', // 'vertical' or 'horizontal'
            yAxisLabel: options.yAxisLabel || '',
            xAxisLabel: options.xAxisLabel || '',
            colorScheme: options.colorScheme || 'gradient', // 'gradient', 'fixed', 'weekendHighlight', 'performance'
            showLegend: options.showLegend !== undefined ? options.showLegend : false,
            tooltipFormatter: options.tooltipFormatter || null,
            valueFormatter: options.valueFormatter || null,
            ...options
        };
    }

    /**
     * Generate colors based on the specified color scheme
     */
    generateColors(data, scheme = 'gradient') {
        const length = data.length;
        const colors = [];
        const borderColors = [];
        const isDark = getCurrentTheme() === 'dark';

        switch (scheme) {
            case 'gradient':
                // Orange to blue gradient based on normalized values (performance theme)
                const maxVal = Math.max(...data.filter(v => v > 0));
                const minVal = Math.min(...data.filter(v => v > 0));
                
                data.forEach(value => {
                    if (value === 0) {
                        colors.push(isDark ? 'rgba(100, 100, 100, 0.3)' : 'rgba(200, 200, 200, 0.3)');
                        borderColors.push(isDark ? 'rgba(100, 100, 100, 0.6)' : 'rgba(200, 200, 200, 0.6)');
                    } else {
                        const normalized = maxVal > minVal ? (value - minVal) / (maxVal - minVal) : 0.5;
                        const hue = 30 + (normalized * 170); // 30 = orange, 200 = blue
                        colors.push(`hsla(${hue}, 70%, 50%, 0.8)`);
                        borderColors.push(`hsla(${hue}, 70%, 40%, 1)`);
                    }
                });
                break;

            case 'reverseGradient':
                // Blue to orange gradient (for difficulty, etc.)
                data.forEach((_, index) => {
                    const ratio = index / Math.max(length - 1, 1);
                    const hue = 200 - (ratio * 170); // 200 (blue) to 30 (orange)
                    colors.push(`hsla(${hue}, 70%, 50%, 0.8)`);
                    borderColors.push(`hsla(${hue}, 70%, 40%, 1)`);
                });
                break;

            case 'fixed':
                // Fixed color scheme for day of week - cohesive gradient
                const fixedColors = [
                    'rgba(54, 162, 235, 0.8)',   // Monday - Blue
                    'rgba(75, 192, 192, 0.8)',   // Tuesday - Teal
                    'rgba(102, 187, 106, 0.8)',  // Wednesday - Green
                    'rgba(255, 167, 38, 0.8)',   // Thursday - Orange
                    'rgba(239, 83, 80, 0.8)',    // Friday - Red
                    'rgba(171, 71, 188, 0.8)',   // Saturday - Purple
                    'rgba(126, 87, 194, 0.8)'    // Sunday - Deep Purple
                ];
                const fixedBorders = [
                    'rgba(54, 162, 235, 1)',
                    'rgba(75, 192, 192, 1)',
                    'rgba(102, 187, 106, 1)',
                    'rgba(255, 167, 38, 1)',
                    'rgba(239, 83, 80, 1)',
                    'rgba(171, 71, 188, 1)',
                    'rgba(126, 87, 194, 1)'
                ];
                colors.push(...fixedColors.slice(0, length));
                borderColors.push(...fixedBorders.slice(0, length));
                break;

            case 'weekendHighlight':
                // Highlight weekends with different colors
                this.options.labels.forEach((dateStr, index) => {
                    const date = new Date(dateStr);
                    const dayOfWeek = date.getDay();
                    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                    
                    if (data[index] === 0) {
                        colors.push(isDark ? 'rgba(100, 100, 100, 0.3)' : 'rgba(200, 200, 200, 0.3)');
                        borderColors.push(isDark ? 'rgba(100, 100, 100, 0.6)' : 'rgba(200, 200, 200, 0.6)');
                    } else if (isWeekend) {
                        colors.push(this.options.weekendColor || 'rgba(171, 71, 188, 0.8)');
                        borderColors.push(this.options.weekendBorderColor || 'rgba(171, 71, 188, 1)');
                    } else {
                        colors.push(this.options.weekdayColor || 'rgba(54, 162, 235, 0.8)');
                        borderColors.push(this.options.weekdayBorderColor || 'rgba(54, 162, 235, 1)');
                    }
                });
                break;

            case 'performance':
                // Blue gradient for top performance charts
                data.forEach((_, index) => {
                    const reverseIndex = length - 1 - index;
                    const hue = 200 - (reverseIndex * 15); // 200 (blue) to 155 (cyan)
                    colors.push(`hsla(${hue}, 70%, 50%, 0.8)`);
                    borderColors.push(`hsla(${hue}, 70%, 40%, 1)`);
                });
                break;

            case 'single':
                // Single primary color
                const primaryColor = isDark ? '#4e9fff' : '#2980b9';
                data.forEach(() => {
                    colors.push(`${primaryColor}CC`);
                    borderColors.push(primaryColor);
                });
                break;

            default:
                // Default to gradient
                return this.generateColors(data, 'gradient');
        }

        return { colors, borderColors };
    }

    /**
     * Create the bar chart
     */
    render(data, labels) {
        if (!this.canvas) {
            console.error(`Canvas with id '${this.canvasId}' not found`);
            return null;
        }

        // Destroy existing chart
        if (this.chart) {
            this.chart.destroy();
        }

        const ctx = this.canvas.getContext('2d');
        const { colors, borderColors } = this.generateColors(data, this.options.colorScheme);

        const chartConfig = {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: this.options.datasetLabel || this.options.title,
                    data: data,
                    backgroundColor: colors,
                    borderColor: borderColors,
                    borderWidth: 2,
                    borderRadius: this.options.borderRadius || 4
                }]
            },
            options: {
                indexAxis: this.options.type === 'horizontal' ? 'y' : 'x',
                responsive: true,
                plugins: {
                    legend: {
                        display: this.options.showLegend,
                        labels: {
                            color: getThemeTextColor()
                        }
                    },
                    title: {
                        display: !!this.options.title,
                        text: this.options.title,
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
                            title: (context) => {
                                if (this.options.tooltipFormatter?.title) {
                                    return this.options.tooltipFormatter.title(context);
                                }
                                // Get the actual label from the dataset
                                const index = context[0].dataIndex;
                                return labels[index];
                            },
                            label: (context) => {
                                if (this.options.tooltipFormatter?.label) {
                                    return this.options.tooltipFormatter.label(context);
                                }
                                // For horizontal charts, value is in parsed.x; for vertical, it's in parsed.y
                                const value = chartConfig.options.indexAxis === 'y' ? context.parsed.x : context.parsed.y;
                                if (this.options.valueFormatter) {
                                    return this.options.valueFormatter(value);
                                }
                                return `${this.options.datasetLabel || 'Value'}: ${value.toLocaleString()}`;
                            },
                            afterLabel: (context) => {
                                if (this.options.tooltipFormatter?.afterLabel) {
                                    return this.options.tooltipFormatter.afterLabel(context);
                                }
                                return '';
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
                            display: !!this.options.yAxisLabel,
                            text: this.options.yAxisLabel,
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            callback: function(value) {
                                // For horizontal charts, Y-axis shows labels (dates, etc.)
                                if (chartConfig.options.indexAxis === 'y') {
                                    return this.getLabelForValue(value);
                                }
                                // For vertical charts, Y-axis shows numeric values
                                if (chartConfig.options.yAxisFormatter) {
                                    return chartConfig.options.yAxisFormatter(value);
                                }
                                return value.toLocaleString();
                            }
                        },
                        grid: {
                            color: getCurrentTheme() === 'dark'
                                ? 'rgba(255, 255, 255, 0.1)'
                                : 'rgba(0, 0, 0, 0.1)'
                        }
                    },
                    x: {
                        title: {
                            display: !!this.options.xAxisLabel,
                            text: this.options.xAxisLabel,
                            color: getThemeTextColor()
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            maxRotation: this.options.maxRotation || 45,
                            minRotation: this.options.minRotation || 45,
                            callback: function(value) {
                                // For horizontal charts, X-axis shows numeric values
                                if (chartConfig.options.indexAxis === 'y') {
                                    return value.toLocaleString();
                                }
                                // For vertical charts, X-axis shows labels
                                return this.getLabelForValue(value);
                            }
                        },
                        grid: {
                            display: this.options.type === 'horizontal'
                        }
                    }
                },
                animation: {
                    duration: 1000,
                    easing: 'easeOutQuart'
                }
            }
        };

        this.chart = new Chart(ctx, chartConfig);
        
        // Store in global charts object
        if (window.myCharts) {
            window.myCharts[this.canvasId] = this.chart;
        }

        return this.chart;
    }

    /**
     * Update chart data
     */
    update(data, labels) {
        if (!this.chart) {
            return this.render(data, labels);
        }

        const { colors, borderColors } = this.generateColors(data, this.options.colorScheme);
        
        this.chart.data.labels = labels;
        this.chart.data.datasets[0].data = data;
        this.chart.data.datasets[0].backgroundColor = colors;
        this.chart.data.datasets[0].borderColor = borderColors;
        this.chart.update();
    }

    /**
     * Destroy the chart
     */
    destroy() {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }
}

// Helper function to get theme text color (should match stats.js)
function getThemeTextColor() {
    const theme = getCurrentTheme();
    return theme === 'dark' ? '#fff' : '#222';
}

// Helper function to get current theme (should match stats.js)
function getCurrentTheme() {
    const dataTheme = document.documentElement.getAttribute('data-theme');
    if (dataTheme === 'dark' || dataTheme === 'light') {
        return dataTheme;
    }
    
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
    }
    return 'light';
}