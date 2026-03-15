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

    // Cache for time-display refresh
    let _cachedPeakDailyStats = null;
    let _cachedPeakSessionStats = null;
    let _cachedTimePeriodAverages = null;
    const MAX_GAME_COMPARISON_ITEMS = 5;
    const NEW_WORDS_BY_GAME_PAGE_SIZE = 5;
    let newWordsByGamePage = 0;
    let cachedNewWordsByGameData = null;
    let cachedNewWordsByGameTokenizationStatus = null;

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
                        display: false,
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

    function destroyChart(canvasId) {
        if (window.myCharts && window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
            delete window.myCharts[canvasId];
        }
    }

    function setCanvasHeightForItems(canvasId, itemCount, rowHeight = 42, minHeight = 220) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return null;

        const computedHeight = Math.max(minHeight, itemCount * rowHeight + 40);
        canvas.height = computedHeight;
        canvas.style.height = `${computedHeight}px`;
        return canvas;
    }

    function sortLabeledValues(labels, values) {
        return labels
            .map((label, index) => ({
                label,
                value: Number(values[index]),
            }))
            .filter((item) => item.label && Number.isFinite(item.value) && item.value > 0)
            .sort((left, right) => {
                if (right.value !== left.value) {
                    return right.value - left.value;
                }
                return left.label.localeCompare(right.label);
            });
    }

    function formatRangeBoundary(dateStr, includeYear = false) {
        const date = parseLocalDate(dateStr);
        const options = includeYear
            ? { month: 'short', day: 'numeric', year: 'numeric' }
            : { month: 'short', day: 'numeric' };
        return date.toLocaleDateString('en-US', options);
    }

    function formatSelectedRangeLabel(labels) {
        if (!labels || labels.length === 0) {
            return 'Selected Range';
        }

        const firstLabel = labels[0];
        const lastLabel = labels[labels.length - 1];
        if (firstLabel === lastLabel) {
            return formatRangeBoundary(firstLabel, true);
        }

        const includeYear = firstLabel.slice(0, 4) !== lastLabel.slice(0, 4);
        const startLabel = formatRangeBoundary(firstLabel, includeYear);
        const endLabel = formatRangeBoundary(lastLabel, true);
        return `${startLabel} to ${endLabel}`;
    }

    function updateSectionTitle(elementId, prefix, labels) {
        const titleElement = document.getElementById(elementId);
        if (!titleElement) return;
        titleElement.textContent = `${prefix} (${formatSelectedRangeLabel(labels)})`;
    }

    function formatDailyAxisLabels(labels) {
        return labels.map((dateStr) => {
            const date = parseLocalDate(dateStr);
            const dayOfWeek = date.getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const monthDay = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return isWeekend ? `${dayNames[dayOfWeek]} ${monthDay} 📅` : `${dayNames[dayOfWeek]} ${monthDay}`;
        });
    }

    function createHorizontalComparisonChart(canvasId, labels, values, options = {}) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return null;

        destroyChart(canvasId);

        const sortedRows = sortLabeledValues(labels, values);
        const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
            ? options.maxItems
            : null;
        const displayRows = maxItems ? sortedRows.slice(0, maxItems) : sortedRows;
        if (displayRows.length === 0) {
            return null;
        }

        const sortedLabels = displayRows.map((row) => row.label);
        const sortedValues = displayRows.map((row) => row.value);
        setCanvasHeightForItems(
            canvasId,
            displayRows.length,
            options.rowHeight || 42,
            options.minHeight || 220
        );

        const chart = new BarChartComponent(canvasId, {
            title: '',
            type: 'horizontal',
            colorScheme: options.colorScheme || 'gradient',
            yAxisLabel: '',
            xAxisLabel: options.xAxisLabel || '',
            datasetLabel: options.datasetLabel || 'Value',
            maxRotation: 0,
            minRotation: 0,
            valueFormatter: options.valueFormatter || null,
            tooltipFormatter: {
                title: (context) => sortedLabels[context[0].dataIndex],
                label: (context) => {
                    if (options.tooltipLabelFormatter) {
                        return options.tooltipLabelFormatter(context.parsed.x);
                    }
                    return `${options.datasetLabel || 'Value'}: ${context.parsed.x.toLocaleString()}`;
                },
            },
        });

        return chart.render(sortedValues, sortedLabels);
    }

    function createGameBarChart(canvasId, chartData, options = {}) {
        if (!chartData || !Array.isArray(chartData.labels) || !Array.isArray(chartData.totals)) {
            return null;
        }

        return createHorizontalComparisonChart(canvasId, chartData.labels, chartData.totals, {
            datasetLabel: 'Characters Read',
            xAxisLabel: 'Characters Read',
            tooltipLabelFormatter: (value) => `Characters: ${value.toLocaleString()}`,
            rowHeight: 44,
            minHeight: 240,
            maxItems: options.maxItems,
        });
    }

    function createGameBarChartWithCustomFormat(
        canvasId,
        chartData,
        datasetLabel,
        xAxisLabel,
        formatFunction,
        options = {}
    ) {
        if (!chartData || !Array.isArray(chartData.labels) || !Array.isArray(chartData.totals)) {
            return null;
        }

        return createHorizontalComparisonChart(canvasId, chartData.labels, chartData.totals, {
            datasetLabel,
            xAxisLabel,
            tooltipLabelFormatter: (value) => formatFunction(value),
            rowHeight: 44,
            minHeight: 240,
            maxItems: options.maxItems,
        });
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

    function formatCompactStat(num) {
        const value = Number(num || 0);
        if (value >= 1000000) {
            return `${(value / 1000000).toFixed(1)}M`;
        }
        if (value >= 1000) {
            return `${(value / 1000).toFixed(1)}K`;
        }
        return Math.round(value).toLocaleString();
    }

    function formatOneDecimal(value) {
        return Number(value || 0).toFixed(1);
    }

    function formatPercentComplete(value) {
        const numericValue = Number(value || 0);
        return Number.isInteger(numericValue) ? numericValue.toFixed(0) : numericValue.toFixed(1);
    }

    function getTokenizationIncompleteMessage(tokenizationStatus) {
        if (!tokenizationStatus || !tokenizationStatus.enabled) {
            return '';
        }

        const percentComplete = Number(tokenizationStatus.percentComplete || 0);
        if (percentComplete >= 100) {
            return '';
        }

        return `Based on tokenized lines only (${formatPercentComplete(percentComplete)}% tokenized)`;
    }

    function resetVocabularySnapshot() {
        const card = document.getElementById('vocabularySnapshotCard');
        const subtitle = document.getElementById('vocabularySnapshotSubtitle');
        if (card) {
            card.style.display = 'none';
        }
        if (subtitle) {
            subtitle.style.display = 'none';
            subtitle.textContent = '';
        }

        const uniqueWordsEl = document.getElementById('vocabUniqueWordsSeen');
        const newWordsEl = document.getElementById('vocabNewWordsFirstSeen');
        const densityEl = document.getElementById('vocabNewWordsPer10kChars');
        if (uniqueWordsEl) uniqueWordsEl.textContent = '-';
        if (newWordsEl) newWordsEl.textContent = '-';
        if (densityEl) densityEl.textContent = '-';
    }

    function renderVocabularySnapshot(tokenizationStatus, vocabularyStats) {
        const card = document.getElementById('vocabularySnapshotCard');
        if (!card) {
            return;
        }

        if (!tokenizationStatus || !tokenizationStatus.enabled) {
            resetVocabularySnapshot();
            return;
        }

        const stats = vocabularyStats || {};
        card.style.display = '';

        const subtitle = document.getElementById('vocabularySnapshotSubtitle');
        const incompleteMessage = getTokenizationIncompleteMessage(tokenizationStatus);
        if (subtitle) {
            if (incompleteMessage) {
                subtitle.textContent = incompleteMessage;
                subtitle.style.display = '';
            } else {
                subtitle.textContent = '';
                subtitle.style.display = 'none';
            }
        }

        const uniqueWordsEl = document.getElementById('vocabUniqueWordsSeen');
        const newWordsEl = document.getElementById('vocabNewWordsFirstSeen');
        const densityEl = document.getElementById('vocabNewWordsPer10kChars');
        if (uniqueWordsEl) uniqueWordsEl.textContent = formatCompactStat(stats.uniqueWordsSeen || 0);
        if (newWordsEl) newWordsEl.textContent = formatCompactStat(stats.newWordsFirstSeen || 0);
        if (densityEl) densityEl.textContent = formatOneDecimal(stats.newWordsPer10kChars);
    }

    function resetNewWordsChartSection() {
        const container = document.getElementById('newWordsChartContainer');
        const subtitle = document.getElementById('newWordsChartSubtitle');
        const noData = document.getElementById('newWordsNoData');
        const canvas = document.getElementById('newWordsChart');

        destroyChart('newWordsChart');

        if (container) {
            container.style.display = 'none';
        }
        if (subtitle) {
            subtitle.textContent = 'First-ever GSM word encounters in the selected range';
        }
        if (noData) {
            noData.style.display = 'none';
        }
        if (canvas) {
            canvas.style.display = '';
        }
    }

    function hasNewWordSeriesData(series) {
        if (!series || !Array.isArray(series.dailyNew)) {
            return false;
        }
        return series.dailyNew.some((value) => Number(value) > 0);
    }

    function createNewWordsChart(canvasId, series) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !series || !Array.isArray(series.labels)) {
            return null;
        }

        const ctx = canvas.getContext('2d');
        const originalLabels = series.labels;
        const formattedLabels = formatDailyAxisLabels(originalLabels);
        const dailyNew = (series.dailyNew || []).map((value) => Number(value || 0));
        const cumulative = (series.cumulative || []).map((value) => Number(value || 0));

        destroyChart(canvasId);

        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: formattedLabels,
                datasets: [
                    {
                        type: 'bar',
                        label: 'New Words',
                        data: dailyNew,
                        backgroundColor: 'rgba(34, 197, 94, 0.45)',
                        borderColor: 'rgba(34, 197, 94, 0.95)',
                        borderWidth: 1,
                        borderRadius: 4,
                        yAxisID: 'y',
                        order: 2,
                    },
                    {
                        type: 'line',
                        label: 'Cumulative New Words',
                        data: cumulative,
                        borderColor: 'rgba(59, 130, 246, 1)',
                        backgroundColor: 'rgba(59, 130, 246, 0.12)',
                        borderWidth: 3,
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        pointBackgroundColor: 'rgba(59, 130, 246, 1)',
                        tension: 0.28,
                        fill: false,
                        yAxisID: 'y1',
                        order: 1,
                    },
                ],
            },
            options: {
                responsive: true,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: getThemeTextColor(),
                            usePointStyle: true,
                            padding: 15,
                        },
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                return originalLabels[context[0].dataIndex];
                            },
                            label: function(context) {
                                const value = Number(context.parsed.y || 0).toLocaleString();
                                if (context.dataset.label === 'Cumulative New Words') {
                                    return `Cumulative: ${value}`;
                                }
                                return `New words: ${value}`;
                            },
                        },
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: 'rgba(255, 255, 255, 0.2)',
                        borderWidth: 1,
                        cornerRadius: 8,
                        displayColors: true,
                    },
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: 'Date',
                            color: getThemeTextColor(),
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            autoSkip: true,
                            maxRotation: 45,
                            minRotation: 0,
                        },
                    },
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'New Words',
                            color: getThemeTextColor(),
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            precision: 0,
                        },
                    },
                    y1: {
                        beginAtZero: true,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Cumulative New Words',
                            color: getThemeTextColor(),
                        },
                        ticks: {
                            color: getThemeTextColor(),
                            precision: 0,
                        },
                        grid: {
                            drawOnChartArea: false,
                        },
                    },
                },
                animation: {
                    duration: 1000,
                    easing: 'easeOutQuart',
                },
            },
        });

        return window.myCharts[canvasId];
    }

    function renderNewWordsChartSection(tokenizationStatus, series) {
        const container = document.getElementById('newWordsChartContainer');
        if (!container) {
            return;
        }

        if (!tokenizationStatus || !tokenizationStatus.enabled) {
            resetNewWordsChartSection();
            return;
        }

        const subtitle = document.getElementById('newWordsChartSubtitle');
        const noData = document.getElementById('newWordsNoData');
        const canvas = document.getElementById('newWordsChart');
        const incompleteMessage = getTokenizationIncompleteMessage(tokenizationStatus);
        const baseSubtitle = 'First-ever GSM word encounters in the selected range';

        container.style.display = '';
        if (subtitle) {
            subtitle.textContent = incompleteMessage
                ? `${baseSubtitle}. ${incompleteMessage}`
                : baseSubtitle;
        }

        if (!series || !Array.isArray(series.labels) || !hasNewWordSeriesData(series)) {
            destroyChart('newWordsChart');
            if (canvas) {
                canvas.style.display = 'none';
            }
            if (noData) {
                noData.style.display = 'block';
            }
            return;
        }

        if (canvas) {
            canvas.style.display = '';
        }
        if (noData) {
            noData.style.display = 'none';
        }
        createNewWordsChart('newWordsChart', series);
    }

    function resetNewWordsByGameChartSection() {
        const container = document.getElementById('newWordsByGameChartContainer');
        const subtitle = document.getElementById('newWordsByGameChartSubtitle');
        const noData = document.getElementById('newWordsByGameNoData');
        const pagination = document.getElementById('newWordsByGamePagination');
        const paginationInfo = document.getElementById('newWordsByGamePaginationInfo');
        const canvas = document.getElementById('newWordsByGameChart');

        destroyChart('newWordsByGameChart');
        cachedNewWordsByGameData = null;
        cachedNewWordsByGameTokenizationStatus = null;
        newWordsByGamePage = 0;

        if (container) {
            container.style.display = 'none';
        }
        if (subtitle) {
            subtitle.textContent = 'Globally new words first encountered in the selected date range';
        }
        if (noData) {
            noData.style.display = 'none';
        }
        if (pagination) {
            pagination.style.display = 'none';
        }
        if (paginationInfo) {
            paginationInfo.textContent = '';
        }
        if (canvas) {
            canvas.style.display = '';
        }
    }

    function renderNewWordsByGameChartSection(
        tokenizationStatus,
        chartData,
        resetPage = true
    ) {
        const container = document.getElementById('newWordsByGameChartContainer');
        if (!container) {
            return;
        }

        if (!tokenizationStatus || !tokenizationStatus.enabled) {
            resetNewWordsByGameChartSection();
            return;
        }

        const subtitle = document.getElementById('newWordsByGameChartSubtitle');
        const noData = document.getElementById('newWordsByGameNoData');
        const pagination = document.getElementById('newWordsByGamePagination');
        const paginationInfo = document.getElementById('newWordsByGamePaginationInfo');
        const prevBtn = document.getElementById('newWordsByGamePrevBtn');
        const nextBtn = document.getElementById('newWordsByGameNextBtn');
        const canvas = document.getElementById('newWordsByGameChart');
        const baseSubtitle = 'Globally new words first encountered in the selected date range';
        const incompleteMessage = getTokenizationIncompleteMessage(tokenizationStatus);
        const labels = Array.isArray(chartData?.labels) ? chartData.labels : [];
        const totals = Array.isArray(chartData?.totals)
            ? chartData.totals.map((value) => Number(value || 0))
            : [];

        cachedNewWordsByGameData = { labels, totals };
        cachedNewWordsByGameTokenizationStatus = tokenizationStatus;
        if (resetPage) {
            newWordsByGamePage = 0;
        }

        container.style.display = '';
        if (subtitle) {
            subtitle.textContent = incompleteMessage
                ? `${baseSubtitle}. ${incompleteMessage}`
                : baseSubtitle;
        }

        if (!labels.length || !totals.some((value) => value > 0)) {
            destroyChart('newWordsByGameChart');
            if (canvas) {
                canvas.style.display = 'none';
            }
            if (noData) {
                noData.style.display = 'block';
            }
            if (pagination) {
                pagination.style.display = 'none';
            }
            return;
        }

        const totalPages = Math.ceil(labels.length / NEW_WORDS_BY_GAME_PAGE_SIZE);
        if (newWordsByGamePage >= totalPages) {
            newWordsByGamePage = Math.max(0, totalPages - 1);
        }

        const startIndex = newWordsByGamePage * NEW_WORDS_BY_GAME_PAGE_SIZE;
        const endIndex = Math.min(
            startIndex + NEW_WORDS_BY_GAME_PAGE_SIZE,
            labels.length
        );
        const pageLabels = labels.slice(startIndex, endIndex);
        const pageTotals = totals.slice(startIndex, endIndex);

        if (canvas) {
            canvas.style.display = '';
        }
        if (noData) {
            noData.style.display = 'none';
        }

        createHorizontalComparisonChart('newWordsByGameChart', pageLabels, pageTotals, {
            datasetLabel: 'New Words',
            xAxisLabel: 'New Words',
            tooltipLabelFormatter: (value) => `New words: ${value.toLocaleString()}`,
            rowHeight: 44,
            minHeight: 240,
        });

        if (pagination && totalPages > 1) {
            pagination.style.display = 'flex';
            if (paginationInfo) {
                paginationInfo.textContent =
                    `Showing ${startIndex + 1}-${endIndex} of ${labels.length} games` +
                    ` • Page ${newWordsByGamePage + 1} of ${totalPages}`;
            }
            if (prevBtn) {
                prevBtn.disabled = newWordsByGamePage === 0;
            }
            if (nextBtn) {
                nextBtn.disabled = newWordsByGamePage >= totalPages - 1;
            }
        } else if (pagination) {
            pagination.style.display = 'none';
        }
    }

    // Function to create hourly activity bar chart
    function createHourlyActivityChart(canvasId, hourlyData) {
        if (!hourlyData || !Array.isArray(hourlyData)) return null;
        
        // Destroy existing chart if it exists
        if (window.myCharts && window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
            delete window.myCharts[canvasId];
        }
        
        // Create hour labels (0-23)
        const hourLabels = [];
        for (let i = 0; i < 24; i++) {
            const hour12 = i === 0 ? 12 : i > 12 ? i - 12 : i;
            const ampm = i < 12 ? 'AM' : 'PM';
            hourLabels.push(`${hour12}${ampm}`);
        }
        
        const chart = new BarChartComponent(canvasId, {
            title: '',
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
        if (!readingSpeedHeatmapData) return null;

        const allDays = [];
        for (const year in readingSpeedHeatmapData) {
            for (const date in readingSpeedHeatmapData[year]) {
                const speed = readingSpeedHeatmapData[year][date];
                if (speed > 0) {
                    allDays.push({ date, speed });
                }
            }
        }

        const top5Days = allDays
            .sort((a, b) => b.speed - a.speed)
            .slice(0, 5);

        return createHorizontalComparisonChart(
            canvasId,
            top5Days.map((day) => day.date),
            top5Days.map((day) => day.speed),
            {
                datasetLabel: 'Reading Speed',
                xAxisLabel: 'Reading Speed (chars/hour)',
                tooltipLabelFormatter: (value) => `Speed: ${value.toLocaleString()} chars/hour`,
                colorScheme: 'performance',
                rowHeight: 40,
                minHeight: 220,
            }
        );
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
        
        const charsData = dayOfWeekData.chars || [0, 0, 0, 0, 0, 0, 0];

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
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    },
                    title: {
                        display: false,
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
                                const value = context.parsed.y;
                                return `Characters Read: ${value.toLocaleString()} chars`;
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
        
        // Destroy existing chart if it exists
        if (window.myCharts && window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
            delete window.myCharts[canvasId];
        }
        
        const dayLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const hoursData = dayOfWeekData.avg_hours || [0, 0, 0, 0, 0, 0, 0];
        
        const chart = new BarChartComponent(canvasId, {
            title: '',
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
                        display: false,
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
        
        // Destroy existing chart if it exists
        if (window.myCharts && window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
            delete window.myCharts[canvasId];
        }
        
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
            title: '',
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

    // Function to create genre reading speed bar chart
    function createGenreSpeedChart(canvasId, genreSpeedData) {
        const canvas = document.getElementById(canvasId);
        const noDataEl = document.getElementById('genreSpeedNoData');
        
        if (!canvas) return null;
        
        // Destroy existing chart if it exists
        if (window.myCharts && window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
            delete window.myCharts[canvasId];
        }
        
        if (!genreSpeedData || !genreSpeedData.labels || genreSpeedData.labels.length === 0) {
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
        
        return createHorizontalComparisonChart(
            canvasId,
            genreSpeedData.labels,
            genreSpeedData.speeds,
            {
                datasetLabel: 'Reading Speed',
                xAxisLabel: 'Reading Speed (chars/hour)',
                tooltipLabelFormatter: (value) => `Speed: ${value.toLocaleString()} chars/hour`,
                rowHeight: 40,
                minHeight: 220,
            }
        );
    }

    // Function to create genre characters read bar chart
    function createGenreCharsChart(canvasId, genreCharsData) {
        const canvas = document.getElementById(canvasId);
        const noDataEl = document.getElementById('genreCharsNoData');
        
        if (!canvas) return null;
        
        // Destroy existing chart if it exists
        if (window.myCharts && window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
            delete window.myCharts[canvasId];
        }
        
        if (!genreCharsData || !genreCharsData.labels || genreCharsData.labels.length === 0) {
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
        
        return createHorizontalComparisonChart(
            canvasId,
            genreCharsData.labels,
            genreCharsData.chars,
            {
                datasetLabel: 'Characters',
                xAxisLabel: 'Characters Read',
                tooltipLabelFormatter: (value) => `Characters: ${value.toLocaleString()}`,
                rowHeight: 40,
                minHeight: 220,
            }
        );
    }

    // Function to create tag reading speed bar chart
    function createTagSpeedChart(canvasId, tagSpeedData) {
        const canvas = document.getElementById(canvasId);
        const noDataEl = document.getElementById('tagSpeedNoData');
        
        if (!canvas) return null;
        
        // Destroy existing chart if it exists
        if (window.myCharts && window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
            delete window.myCharts[canvasId];
        }
        
        if (!tagSpeedData || !tagSpeedData.labels || tagSpeedData.labels.length === 0) {
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
        
        return createHorizontalComparisonChart(
            canvasId,
            tagSpeedData.labels,
            tagSpeedData.speeds,
            {
                datasetLabel: 'Reading Speed',
                xAxisLabel: 'Reading Speed (chars/hour)',
                tooltipLabelFormatter: (value) => `Speed: ${value.toLocaleString()} chars/hour`,
                rowHeight: 40,
                minHeight: 220,
            }
        );
    }

    // Function to create tag characters read bar chart
    function createTagCharsChart(canvasId, tagCharsData) {
        const canvas = document.getElementById(canvasId);
        const noDataEl = document.getElementById('tagCharsNoData');
        
        if (!canvas) return null;
        
        // Destroy existing chart if it exists
        if (window.myCharts && window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
            delete window.myCharts[canvasId];
        }
        
        if (!tagCharsData || !tagCharsData.labels || tagCharsData.labels.length === 0) {
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
        
        return createHorizontalComparisonChart(
            canvasId,
            tagCharsData.labels,
            tagCharsData.chars,
            {
                datasetLabel: 'Characters',
                xAxisLabel: 'Characters Read',
                tooltipLabelFormatter: (value) => `Characters: ${value.toLocaleString()}`,
                rowHeight: 40,
                minHeight: 220,
            }
        );
    }


    function createCardsMinedChart(canvasId, chartData) {
        const canvas = document.getElementById(canvasId);
        const noDataEl = document.getElementById('cardsMinedNoData');
        if (!canvas) return null;

        destroyChart(canvasId);
        updateSectionTitle(
            'cardsMinedChartTitle',
            'Cards Mined',
            chartData && Array.isArray(chartData.labels) ? chartData.labels : []
        );

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
            const date = parseLocalDate(dateStr);
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
                                const index = context.dataIndex;
                                const date = parseLocalDate(chartData.labels[index]);
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

        const allDays = [];
        for (const year in heatmapData) {
            for (const date in heatmapData[year]) {
                const chars = heatmapData[year][date];
                if (chars > 0) {
                    allDays.push({ date, chars });
                }
            }
        }

        const top5Days = allDays
            .sort((a, b) => b.chars - a.chars)
            .slice(0, 5);

        return createHorizontalComparisonChart(
            canvasId,
            top5Days.map((day) => day.date),
            top5Days.map((day) => day.chars),
            {
                datasetLabel: 'Characters Read',
                xAxisLabel: 'Characters Read',
                tooltipLabelFormatter: (value) => `Characters: ${value.toLocaleString()}`,
                colorScheme: 'performance',
                rowHeight: 40,
                minHeight: 220,
            }
        );
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
                        display: false,
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
    
    // Helper to parse date string as local date
    function parseLocalDate(dateStr) {
        const [year, month, day] = dateStr.split('-').map(Number);
        return new Date(year, month - 1, day);
    }

    // Function to create daily time bar chart with weekend markers
    function createDailyTimeChart(canvasId, chartData) {
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
        
        const formattedLabels = formatDailyAxisLabels(chartData.labels);
        updateSectionTitle('dailyTimeChartTitle', '📊 Daily Reading Time', chartData.labels);
        
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
                                const index = context.dataIndex;
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
                                const index = context.dataIndex;
                                const date = parseLocalDate(chartData.labels[index]);
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
    function createDailyCharsChart(canvasId, chartData) {
        if (!chartData) return null;
        
        const formattedLabels = formatDailyAxisLabels(chartData.labels);
        
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
        
        updateSectionTitle('dailyCharsChartTitle', '📚 Daily Characters Read', chartData.labels);
        
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
                                const index = context.dataIndex;
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
                                const index = context.dataIndex;
                                const date = parseLocalDate(chartData.labels[index]);
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

    // Helper function to calculate simple moving average
    function calculateMovingAverage(data, windowSize = 7) {
        const result = [];
        for (let i = 0; i < data.length; i++) {
            const start = Math.max(0, i - windowSize + 1);
            const window = data
                .slice(start, i + 1)
                .filter((value) => typeof value === 'number' && !Number.isNaN(value));

            if (window.length === 0) {
                result.push(null);
                continue;
            }

            const sum = window.reduce((acc, val) => acc + val, 0);
            result.push(sum / window.length);
        }
        return result;
    }

    // Track moving average visibility state and cached data
    let speedChartMovingAverageVisible = false;
    let cachedSpeedChartData = null;

    // Function to create daily reading speed line chart
    function createDailySpeedChart(canvasId, chartData, showMovingAverage = speedChartMovingAverageVisible) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !chartData) return null;
        
        // Cache the data for re-rendering without API calls
        cachedSpeedChartData = chartData;
        
        const ctx = canvas.getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.myCharts[canvasId]) {
            window.myCharts[canvasId].destroy();
        }
        
        const formattedLabels = formatDailyAxisLabels(chartData.labels);
        const alignedSpeedData = chartData.labels.map((dateStr, index) => {
            const hasReadingData =
                Number(chartData.timeData?.[index] || 0) > 0 &&
                Number(chartData.charsData?.[index] || 0) > 0;
            return hasReadingData ? chartData.speedData[index] : null;
        });
        const movingAverageData = calculateMovingAverage(alignedSpeedData, 7);

        const pointColors = chartData.labels.map(dateStr => {
            const date = parseLocalDate(dateStr);
            const dayOfWeek = date.getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            return isWeekend ? 'rgba(171, 71, 188, 1)' : 'rgba(54, 162, 235, 1)';
        });
        const pointRadius = alignedSpeedData.map((value) => (value === null ? 0 : 5));
        const pointHoverRadius = alignedSpeedData.map((value) => (value === null ? 0 : 7));

        updateSectionTitle('dailySpeedChartTitle', '⚡ Daily Reading Speed', chartData.labels);
        
        // Build datasets array
        const datasets = [{
            label: 'Reading Speed (chars/hour)',
            data: alignedSpeedData,
            borderColor: 'rgba(54, 162, 235, 1)',
            backgroundColor: 'rgba(54, 162, 235, 0.1)',
            pointBackgroundColor: pointColors,
            pointBorderColor: pointColors,
            pointRadius: pointRadius,
            pointHoverRadius: pointHoverRadius,
            borderWidth: 2,
            tension: 0.3,
            fill: true,
            spanGaps: false,
            order: 2
        }];
        
        // Add moving average dataset if enabled
        if (showMovingAverage) {
            datasets.push({
                label: '7-Day Moving Average',
                data: movingAverageData,
                borderColor: 'rgba(255, 99, 132, 1)',
                backgroundColor: 'rgba(255, 99, 132, 0.1)',
                pointRadius: 0,
                pointHoverRadius: 5,
                borderWidth: 3,
                tension: 0.4,
                fill: false,
                order: 1,
                borderDash: [5, 5]
            });
        }
        
        window.myCharts[canvasId] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: formattedLabels,
                datasets: datasets
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: showMovingAverage,
                        position: 'top',
                        labels: {
                            color: getThemeTextColor(),
                            usePointStyle: true,
                            padding: 15
                        }
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
                                const speed = context.parsed.y;
                                const datasetLabel = context.dataset.label;
                                if (speed === null) {
                                    return 'No reading activity';
                                }
                                return `${datasetLabel}: ${speed.toLocaleString()} chars/hour`;
                            },
                            afterLabel: function(context) {
                                const index = Array.isArray(context) ? context[0].dataIndex : context.dataIndex;
                                const date = parseLocalDate(chartData.labels[index]);
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

        // Update the display elements
        const maxDailyCharsEl = document.getElementById('maxDailyChars');
        const maxDailyHoursEl = document.getElementById('maxDailyHours');
        const longestSessionEl = document.getElementById('longestSession');
        const maxSessionCharsEl = document.getElementById('maxSessionChars');

        if (maxDailyCharsEl) {
            maxDailyCharsEl.textContent = formatLargeNumber(peakDailyStats.max_daily_chars || 0);
        }

        if (maxDailyHoursEl) {
            maxDailyHoursEl.textContent = window.formatTime(peakDailyStats.max_daily_hours || 0);
        }

        if (longestSessionEl) {
            longestSessionEl.textContent = window.formatTime(peakSessionStats.longest_session_hours || 0);
        }

        if (maxSessionCharsEl) {
            maxSessionCharsEl.textContent = formatLargeNumber(peakSessionStats.max_session_chars || 0);
        }
    }

    // Function to update average statistics for time period display
    function updateTimePeriodAverages(timePeriodAverages) {
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

        // Update the average display elements
        const avgHoursEl = document.getElementById('avgHoursPerDay');
        const avgCharsEl = document.getElementById('avgCharsPerDay');
        const avgSpeedEl = document.getElementById('avgSpeedPerDay');

        if (avgHoursEl) {
            avgHoursEl.textContent = window.formatTime(timePeriodAverages.avgHoursPerDay || 0);
        }

        if (avgCharsEl) {
            avgCharsEl.textContent = formatLargeNumber(timePeriodAverages.avgCharsPerDay || 0);
        }

        if (avgSpeedEl) {
            avgSpeedEl.textContent = formatLargeNumber(timePeriodAverages.avgSpeedPerDay || 0);
        }

        // Update the totals display elements
        const totalHoursEl = document.getElementById('totalHoursForPeriod');
        const totalCharsEl = document.getElementById('totalCharsForPeriod');

        if (totalHoursEl) {
            totalHoursEl.textContent = window.formatTime(timePeriodAverages.totalHours || 0);
        }

        if (totalCharsEl) {
            totalCharsEl.textContent = formatLargeNumber(timePeriodAverages.totalChars || 0);
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
    async function loadDailyActivityCharts(startTimestamp = null, endTimestamp = null) {
        try {
            let url = '/api/daily-activity';
            const params = new URLSearchParams();

            if (startTimestamp !== null && endTimestamp !== null) {
                params.append('start', startTimestamp);
                params.append('end', endTimestamp);
            }

            const queryString = params.toString();
            if (queryString) {
                url += `?${queryString}`;
            }

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error('Failed to load daily activity data');
            }
            
            const data = await response.json();
            
            if (data.labels && data.labels.length > 0) {
                createDailyTimeChart('dailyTimeChart', data);
                createDailyCharsChart('dailyCharsChart', data);
                createDailySpeedChart('dailySpeedChart', data);
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
        
        return fetch(url)
            .then(response => response.json())
            .then(data => {
                renderVocabularySnapshot(data.tokenizationStatus, data.vocabularyStats);
                renderNewWordsChartSection(data.tokenizationStatus, data.newWordsSeries);
                renderNewWordsByGameChartSection(
                    data.tokenizationStatus,
                    data.newWordsByGame,
                    true
                );

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
                    createGameBarChart('readingCharsChart', data.totalCharsPerGame, {
                        maxItems: MAX_GAME_COMPARISON_ITEMS,
                    });
                }

                // Create reading time quantity chart if data exists (with trendline)
                if (data.readingTimePerGame) {
                    createGameBarChartWithCustomFormat(
                        'readingTimeChart',
                        data.readingTimePerGame,
                        'Reading Time',
                        'Time (hours)',
                        formatTime,
                        { maxItems: MAX_GAME_COMPARISON_ITEMS }
                    );
                }

                // Create reading speed per game chart if data exists (with trendline)
                if (data.readingSpeedPerGame) {
                    createGameBarChartWithCustomFormat(
                        'readingSpeedPerGameChart',
                        data.readingSpeedPerGame,
                        'Reading Speed',
                        'Reading Speed (chars/hour)',
                        formatSpeed,
                        { maxItems: MAX_GAME_COMPARISON_ITEMS }
                    );
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

                // Create genre and tag charts if data exists
                if (data.genreTagData) {
                    if (data.genreTagData.genres) {
                        createGenreSpeedChart('genreSpeedChart', data.genreTagData.genres.top_speed);
                        createGenreCharsChart('genreCharsChart', data.genreTagData.genres.top_chars);
                    }
                    if (data.genreTagData.tags) {
                        createTagSpeedChart('tagSpeedChart', data.genreTagData.tags.top_speed);
                        createTagCharsChart('tagCharsChart', data.genreTagData.tags.top_chars);
                    }
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
                loadDailyActivityCharts(start_timestamp, end_timestamp);

                // Update peak statistics if data exists
                if (data.peakDailyStats && data.peakSessionStats) {
                    _cachedPeakDailyStats = data.peakDailyStats;
                    _cachedPeakSessionStats = data.peakSessionStats;
                    updatePeakStatistics(data.peakDailyStats, data.peakSessionStats);
                }

                // Update time period averages if data exists
                if (data.timePeriodAverages) {
                    _cachedTimePeriodAverages = data.timePeriodAverages;
                    updateTimePeriodAverages(data.timePeriodAverages);
                }

                // Fire parallel fetches for lazy-loaded sections
                const kanjiUrl = '/api/stats/kanji-grid' + (queryString ? `?${queryString}` : '');
                fetch(kanjiUrl)
                    .then(resp => resp.json())
                    .then(kanjiData => createKanjiGrid(kanjiData))
                    .catch(err => console.error('Failed to load kanji grid:', err));

                fetch('/api/stats/game-milestones')
                    .then(resp => resp.json())
                    .then(milestones => {
                        if (milestones) {
                            updateGameMilestones(milestones);
                        }
                    })
                    .catch(err => console.error('Failed to load game milestones:', err));

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
        reloadStatsForCurrentDateRange();
    });

    function reloadStatsForCurrentDateRange() {
        const fromDate = fromDateInput ? fromDateInput.value : sessionStorage.getItem("fromDate");
        const toDate = toDateInput ? toDateInput.value : sessionStorage.getItem("toDate");
        const { startTimestamp, endTimestamp } = getUnixTimestamps(fromDate, toDate);

        return loadStatsData(startTimestamp, endTimestamp);
    }

     
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

        reloadStatsForCurrentDateRange();
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

    window.addEventListener('settingsUpdated', function() {
        reloadStatsForCurrentDateRange();
    });

    // Refresh time displays when time format toggle changes
    window.refreshTimeDisplays = function() {
        if (_cachedPeakDailyStats && _cachedPeakSessionStats) {
            updatePeakStatistics(_cachedPeakDailyStats, _cachedPeakSessionStats);
        }
        if (_cachedTimePeriodAverages) {
            updateTimePeriodAverages(_cachedTimePeriodAverages);
        }
    };
    
    // Setup moving average toggle button
    const toggleMovingAverageBtn = document.getElementById('toggleMovingAverageBtn');
    if (toggleMovingAverageBtn) {
        toggleMovingAverageBtn.addEventListener('click', function() {
            speedChartMovingAverageVisible = !speedChartMovingAverageVisible;
            
            // Update button text and style
            if (speedChartMovingAverageVisible) {
                this.textContent = 'Hide Moving Average';
                this.classList.add('active');
            } else {
                this.textContent = 'Show Moving Average';
                this.classList.remove('active');
            }
            
            // Re-render the chart with cached data (no API call)
            if (cachedSpeedChartData) {
                createDailySpeedChart('dailySpeedChart', cachedSpeedChartData, speedChartMovingAverageVisible);
            }
        });
    }

    const newWordsByGamePrevBtn = document.getElementById('newWordsByGamePrevBtn');
    if (newWordsByGamePrevBtn) {
        newWordsByGamePrevBtn.addEventListener('click', function() {
            if (newWordsByGamePage === 0 || !cachedNewWordsByGameData) {
                return;
            }
            newWordsByGamePage -= 1;
            renderNewWordsByGameChartSection(
                cachedNewWordsByGameTokenizationStatus,
                cachedNewWordsByGameData,
                false
            );
        });
    }

    const newWordsByGameNextBtn = document.getElementById('newWordsByGameNextBtn');
    if (newWordsByGameNextBtn) {
        newWordsByGameNextBtn.addEventListener('click', function() {
            if (!cachedNewWordsByGameData) {
                return;
            }
            const totalPages = Math.ceil(
                cachedNewWordsByGameData.labels.length / NEW_WORDS_BY_GAME_PAGE_SIZE
            );
            if (newWordsByGamePage >= totalPages - 1) {
                return;
            }
            newWordsByGamePage += 1;
            renderNewWordsByGameChartSection(
                cachedNewWordsByGameTokenizationStatus,
                cachedNewWordsByGameData,
                false
            );
        });
    }

});
