/**
 * Game Detail Page - game-stats.js
 * Fetches game stats, renders game info, handles settings cog management actions.
 */

(function() {
    'use strict';

    const PLACEHOLDER_IMAGE = '/static/favicon-96x96.png';
    const gameId = window.gameConfig ? window.gameConfig.gameId : null;

    if (!gameId) {
        console.error('No gameId found in config');
        return;
    }

    // Current game data (cached for management actions)
    let currentGameData = null;
    let currentStatsData = null;
    let dailySpeedChart = null;
    let dailyCharsChart = null;
    let cumulativeCharsChart = null;
    let dailyTimeChart = null;
    let miningDensityChart = null;
    let movingAverageVisible = false;
    let cachedDailySpeed = null;

    // Selected games for merge
    let mergeSelectedGames = [];
    let allGamesForMerge = [];

    // ================================================================
    //  DOM References
    // ================================================================
    const gameDetailLoading = document.getElementById('gameDetailLoading');
    const gameDetailError = document.getElementById('gameDetailError');
    const gameDetailErrorMessage = document.getElementById('gameDetailErrorMessage');
    const gameDetailContent = document.getElementById('gameDetailContent');

    // Game info elements
    const gameDetailCard = document.getElementById('gameDetailCard');
    const gameDetailHeaderTitle = document.getElementById('gameDetailHeaderTitle');
    const gamePhoto = document.getElementById('gamePhoto');
    const gamePhotoSection = document.getElementById('gamePhotoSection');
    const gameTitleOriginal = document.getElementById('gameTitleOriginal');
    const gameTitleRomaji = document.getElementById('gameTitleRomaji');
    const gameTitleEnglish = document.getElementById('gameTitleEnglish');
    const gameTypeBadge = document.getElementById('gameTypeBadge');
    const gameDescription = document.getElementById('gameDescription');
    const descriptionExpandBtn = document.getElementById('descriptionExpandBtn');
    const gameLinksContainer = document.getElementById('gameLinksContainer');
    const gameLinksPills = document.getElementById('gameLinksPills');
    const gameGenresContainer = document.getElementById('gameGenresContainer');
    const gameGenresPills = document.getElementById('gameGenresPills');
    const gameTagsContainer = document.getElementById('gameTagsContainer');
    const gameTagsPills = document.getElementById('gameTagsPills');
    const gameProgressContainer = document.getElementById('gameProgressContainer');
    const gameProgressPercentage = document.getElementById('gameProgressPercentage');
    const gameProgressFill = document.getElementById('gameProgressFill');
    const gameStartDate = document.getElementById('gameStartDate');
    const gameEstimatedEndDate = document.getElementById('gameEstimatedEndDate');

    // Stats elements
    const statTotalChars = document.getElementById('statTotalChars');
    const statReadingSpeed = document.getElementById('statReadingSpeed');
    const statTotalTime = document.getElementById('statTotalTime');
    const statEstTimeLeft = document.getElementById('statEstTimeLeft');
    const statTotalSentences = document.getElementById('statTotalSentences');
    const statCardsMined = document.getElementById('statCardsMined');

    // Settings cog
    const settingsCogBtn = document.getElementById('settingsCogBtn');
    const settingsCogDropdown = document.getElementById('settingsCogDropdown');

    // ================================================================
    //  Utilities
    // ================================================================
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatNumber(num) {
        if (!num && num !== 0) return '0';
        return Number(num).toLocaleString();
    }

    function getImageSrc(image) {
        if (!image || image === '') return '';
        if (image.startsWith('data:')) return image;
        return 'data:image/png;base64,' + image;
    }

    function showState(state) {
        gameDetailLoading.style.display = state === 'loading' ? 'flex' : 'none';
        gameDetailError.style.display = state === 'error' ? 'flex' : 'none';
        gameDetailContent.style.display = state === 'loaded' ? '' : 'none';
    }

    function formatDateReadable(dateStr) {
        if (!dateStr) return '-';
        var parts = dateStr.split('-');
        var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function formatCompactNumber(num) {
        if (!num && num !== 0) return '0';
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return Math.round(num).toLocaleString();
    }

    function formatTimeHM(hours) {
        if (!hours || hours <= 0) return '-';
        return window.formatTime(hours);
    }

    function calculateMovingAverage(data, windowSize) {
        windowSize = windowSize || 7;
        var result = [];
        for (var i = 0; i < data.length; i++) {
            var actualWindow = Math.min(windowSize, i + 1);
            var start = Math.max(0, i - actualWindow + 1);
            var slice = data.slice(start, i + 1);
            var sum = 0;
            for (var j = 0; j < slice.length; j++) sum += slice[j];
            result.push(sum / slice.length);
        }
        return result;
    }

    function parseLocalDate(dateStr) {
        var parts = dateStr.split('-');
        return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    }

    function getChartColor(varName, alpha) {
        var raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        // Resolve nested var() references by reading the computed value
        if (!raw) return alpha !== undefined && alpha < 1 ? 'rgba(128,128,128,' + alpha + ')' : '#888';
        if (alpha !== undefined && alpha < 1) {
            // Convert hex to rgba
            if (raw.startsWith('#')) {
                var hex = raw.replace('#', '');
                if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
                var r = parseInt(hex.substring(0, 2), 16);
                var g = parseInt(hex.substring(2, 4), 16);
                var b = parseInt(hex.substring(4, 6), 16);
                return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
            }
            // If already rgb/rgba, inject alpha
            if (raw.startsWith('rgb(')) {
                return raw.replace('rgb(', 'rgba(').replace(')', ',' + alpha + ')');
            }
            if (raw.startsWith('rgba(')) {
                return raw.replace(/,[^,]*\)$/, ',' + alpha + ')');
            }
        }
        return raw;
    }

    function openModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.classList.add('show');
    }

    function closeModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.classList.remove('show');
    }

    function getLinkLabel(url) {
        if (!url) return 'Link';
        try {
            const hostname = new URL(url).hostname.replace('www.', '');
            const knownSites = {
                'vndb.org': 'VNDB',
                'anilist.co': 'AniList',
                'myanimelist.net': 'MAL',
                'jiten.moe': 'Jiten.moe',
                'store.steampowered.com': 'Steam',
                'dlsite.com': 'DLsite',
            };
            return knownSites[hostname] || hostname;
        } catch {
            return 'Link';
        }
    }

    // ================================================================
    //  Render Game Detail
    // ================================================================
    function renderGameInfo(game) {
        // Header title
        gameDetailHeaderTitle.textContent = game.title_original || 'Game Details';

        // Cover image
        const imageSrc = getImageSrc(game.image);
        if (imageSrc) {
            gamePhoto.src = imageSrc;
            gamePhoto.style.display = '';
            gamePhoto.onerror = function() {
                this.style.display = 'none';
                gamePhotoSection.innerHTML = '<div class="game-photo-placeholder"><img src="' + PLACEHOLDER_IMAGE + '" alt="No cover"></div>';
            };
        } else {
            gamePhoto.style.display = 'none';
            gamePhotoSection.innerHTML = '<div class="game-photo-placeholder"><img src="' + PLACEHOLDER_IMAGE + '" alt="No cover"></div>';
        }

        // Titles
        gameTitleOriginal.textContent = game.title_original || '';
        gameTitleRomaji.textContent = game.title_romaji || '';
        gameTitleEnglish.textContent = game.title_english || '';

        // Type badge
        if (game.type) {
            gameTypeBadge.textContent = game.type;
            gameTypeBadge.style.display = '';
        } else {
            gameTypeBadge.style.display = 'none';
        }

        // Description
        if (game.description) {
            gameDescription.textContent = game.description;
            // Check if text overflows
            requestAnimationFrame(function() {
                if (gameDescription.scrollHeight > gameDescription.clientHeight) {
                    descriptionExpandBtn.style.display = '';
                }
            });
        }

        // Links
        const links = game.links || [];
        if (links.length > 0) {
            gameLinksPills.innerHTML = '';
            links.forEach(function(link) {
                const url = typeof link === 'string' ? link : (link.url || '');
                if (!url) return;
                const pill = document.createElement('a');
                pill.className = 'game-link-pill';
                pill.href = url;
                pill.target = '_blank';
                pill.rel = 'noopener noreferrer';
                pill.textContent = getLinkLabel(url);
                gameLinksPills.appendChild(pill);
            });
            gameLinksContainer.style.display = '';
        }

        // Genres
        const genres = game.genres || [];
        if (genres.length > 0) {
            gameGenresPills.innerHTML = '';
            genres.forEach(function(genre) {
                const pill = document.createElement('span');
                pill.className = 'game-genre-pill';
                pill.textContent = genre;
                gameGenresPills.appendChild(pill);
            });
            gameGenresContainer.style.display = '';
        }

        // Tags
        const tags = game.tags || [];
        if (tags.length > 0) {
            gameTagsPills.innerHTML = '';
            tags.forEach(function(tag) {
                const pill = document.createElement('span');
                pill.className = 'game-tag-pill';
                pill.textContent = tag;
                gameTagsPills.appendChild(pill);
            });
            gameTagsContainer.style.display = '';
        }

        // Completed state
        if (game.completed) {
            gameDetailCard.classList.add('completed');
            // Update the mark-complete dropdown item
            const markCompleteItem = document.querySelector('[data-action="markComplete"]');
            if (markCompleteItem) {
                markCompleteItem.innerHTML = '&#9989; Completed';
                markCompleteItem.disabled = true;
                markCompleteItem.style.opacity = '0.5';
                markCompleteItem.style.cursor = 'default';
            }
        }
    }

    function renderStats(stats, game) {
        // Stats
        statTotalChars.textContent = stats.total_characters_formatted || formatNumber(stats.total_characters);
        statReadingSpeed.textContent = stats.reading_speed_formatted || formatNumber(stats.reading_speed);
        statTotalTime.textContent = stats.total_time_hours ? formatTimeHM(stats.total_time_hours) : '-';
        statTotalSentences.textContent = formatNumber(stats.total_sentences);
        statCardsMined.textContent = formatNumber(stats.total_cards_mined);

        // Estimate time left
        const characterCount = game.character_count || 0;
        const totalChars = stats.total_characters || 0;
        const readingSpeed = stats.reading_speed || 0;

        if (characterCount > 0 && totalChars > 0 && readingSpeed > 0) {
            const remainingChars = Math.max(0, characterCount - totalChars);
            const remainingHours = remainingChars / readingSpeed;

            if (remainingHours < 1) {
                statEstTimeLeft.textContent = Math.round(remainingHours * 60) + 'm';
            } else {
                statEstTimeLeft.textContent = remainingHours.toFixed(1) + 'h';
            }

            // Progress bar
            const percentage = Math.min(100, Math.round((totalChars / characterCount) * 100));
            gameProgressPercentage.textContent = percentage + '%';
            gameProgressFill.style.width = percentage + '%';
            gameProgressContainer.style.display = '';

            // Dates
            if (stats.first_date) {
                gameStartDate.textContent = stats.first_date;
            }

            // Estimate end date
            if (remainingHours > 0 && stats.total_time_hours > 0 && stats.first_date && stats.last_date) {
                // Calculate average hours per day
                const firstDate = new Date(stats.first_date);
                const lastDate = new Date(stats.last_date);
                const daysDiff = Math.max(1, (lastDate - firstDate) / (1000 * 60 * 60 * 24));
                const hoursPerDay = stats.total_time_hours / daysDiff;
                if (hoursPerDay > 0) {
                    const daysLeft = remainingHours / hoursPerDay;
                    const estEnd = new Date();
                    estEnd.setDate(estEnd.getDate() + Math.round(daysLeft));
                    gameEstimatedEndDate.textContent = '~' + estEnd.toISOString().split('T')[0];
                }
            }
        } else {
            statEstTimeLeft.textContent = '-';
            if (stats.first_date) {
                gameStartDate.textContent = stats.first_date;
                gameProgressContainer.style.display = '';
                gameProgressPercentage.textContent = game.completed ? '100%' : '-';
                gameProgressFill.style.width = game.completed ? '100%' : '0%';
            }
        }
    }

    // ================================================================
    //  Render Key Dates & Activity Stats
    // ================================================================
    function renderKeyDatesStats(stats, dailySpeed) {
        if (!stats.first_date || !dailySpeed || !dailySpeed.labels || dailySpeed.labels.length === 0) return;

        var card = document.getElementById('keyDatesCard');
        card.style.display = '';

        // Start Date
        document.getElementById('statStartDate').textContent = formatDateReadable(stats.first_date);

        // Last Active
        document.getElementById('statLastActive').textContent = formatDateReadable(stats.last_date);

        // Days Active
        var daysActive = dailySpeed.labels.length;
        document.getElementById('statDaysActive').textContent = daysActive;

        // Total Day Span
        var firstDate = parseLocalDate(stats.first_date);
        var lastDate = parseLocalDate(stats.last_date);
        var totalDaySpan = Math.round((lastDate - firstDate) / (1000 * 60 * 60 * 24)) + 1;
        document.getElementById('statTotalDaySpan').textContent = totalDaySpan;

        // Avg Chars/Day (per active day)
        var totalChars = stats.total_characters || 0;
        if (daysActive > 0 && totalChars > 0) {
            document.getElementById('statAvgCharsDay').textContent = formatCompactNumber(totalChars / daysActive);
        }

        // Avg Time/Day (per active day)
        var totalHours = stats.total_time_hours || 0;
        if (daysActive > 0 && totalHours > 0) {
            document.getElementById('statAvgTimeDay').textContent = formatTimeHM(totalHours / daysActive);
        }
    }

    // ================================================================
    //  Render Highlights & Mining Stats
    // ================================================================
    function renderHighlightsStats(stats, dailySpeed) {
        if (!dailySpeed || !dailySpeed.labels || dailySpeed.labels.length === 0) return;

        var card = document.getElementById('highlightsCard');
        card.style.display = '';

        // Mining Rate
        var totalSentences = stats.total_sentences || 0;
        var cardsMined = stats.total_cards_mined || 0;
        if (totalSentences > 0) {
            var miningRate = (cardsMined / totalSentences * 100).toFixed(1);
            document.getElementById('statMiningRate').textContent = miningRate + '%';
        } else {
            document.getElementById('statMiningRate').textContent = '-';
        }

        // Best Day (Chars)
        if (dailySpeed.charsData && dailySpeed.charsData.length > 0) {
            var maxChars = 0;
            var maxCharsIdx = 0;
            for (var i = 0; i < dailySpeed.charsData.length; i++) {
                if (dailySpeed.charsData[i] > maxChars) {
                    maxChars = dailySpeed.charsData[i];
                    maxCharsIdx = i;
                }
            }
            document.getElementById('statBestDayChars').textContent = formatCompactNumber(maxChars);
            document.getElementById('statBestDayCharsDate').textContent = formatDateReadable(dailySpeed.labels[maxCharsIdx]);
        }

        // Best Day (Speed)
        if (dailySpeed.speedData && dailySpeed.speedData.length > 0) {
            var maxSpeed = 0;
            var maxSpeedIdx = 0;
            for (var i = 0; i < dailySpeed.speedData.length; i++) {
                if (dailySpeed.speedData[i] > maxSpeed) {
                    maxSpeed = dailySpeed.speedData[i];
                    maxSpeedIdx = i;
                }
            }
            document.getElementById('statBestDaySpeed').textContent = formatCompactNumber(maxSpeed) + '/hr';
            document.getElementById('statBestDaySpeedDate').textContent = formatDateReadable(dailySpeed.labels[maxSpeedIdx]);
        }

        // Best Day (Time)
        if (dailySpeed.timeData && dailySpeed.timeData.length > 0) {
            var maxTime = 0;
            var maxTimeIdx = 0;
            for (var i = 0; i < dailySpeed.timeData.length; i++) {
                if (dailySpeed.timeData[i] > maxTime) {
                    maxTime = dailySpeed.timeData[i];
                    maxTimeIdx = i;
                }
            }
            document.getElementById('statBestDayTime').textContent = formatTimeHM(maxTime);
            document.getElementById('statBestDayTimeDate').textContent = formatDateReadable(dailySpeed.labels[maxTimeIdx]);
        }
    }

    // ================================================================
    //  Render Daily Speed Chart (speed bars + optional moving average)
    // ================================================================
    function renderDailySpeedChart(dailySpeed) {
        if (!dailySpeed || !dailySpeed.labels || dailySpeed.labels.length === 0) return;

        cachedDailySpeed = dailySpeed;

        var container = document.getElementById('dailySpeedChartContainer');
        container.style.display = '';

        var ctx = document.getElementById('dailySpeedChart').getContext('2d');

        if (dailySpeedChart) {
            dailySpeedChart.destroy();
        }

        var datasets = [
            {
                label: 'Reading Speed (chars/hr)',
                data: dailySpeed.speedData,
                backgroundColor: getChartColor('--chart-accent', 0.6),
                borderColor: getChartColor('--chart-accent', 0.9),
                borderWidth: 1,
                borderRadius: 3,
            },
        ];

        // Add moving average if enabled
        if (movingAverageVisible && dailySpeed.speedData.length >= 3) {
            var movingAvg = calculateMovingAverage(dailySpeed.speedData, 7);
            datasets.push({
                type: 'line',
                label: '7-Day Moving Avg',
                data: movingAvg,
                borderColor: getChartColor('--chart-danger'),
                backgroundColor: getChartColor('--chart-danger', 0.1),
                borderWidth: 3,
                fill: false,
                tension: 0.4,
                order: -1,
                pointRadius: 0,
                pointHoverRadius: 5,
                borderDash: [5, 5],
            });
        }

        dailySpeedChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: dailySpeed.labels,
                datasets: datasets,
            },
            options: {
                responsive: true,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: {
                    x: {
                        ticks: { color: getChartColor('--chart-text'), maxRotation: 45 },
                        grid: { display: false },
                    },
                    y: {
                        title: { display: true, text: 'Chars/Hour', color: getChartColor('--chart-text') },
                        ticks: { color: getChartColor('--chart-text') },
                        grid: { color: getChartColor('--chart-grid') },
                        beginAtZero: true,
                    },
                },
                plugins: {
                    legend: {
                        labels: { color: getChartColor('--chart-text') },
                    },
                },
            },
        });
    }

    // ================================================================
    //  Render Daily Characters Read Chart
    // ================================================================
    function renderDailyCharsChart(dailySpeed) {
        if (!dailySpeed || !dailySpeed.labels || dailySpeed.labels.length === 0 || !dailySpeed.charsData) return;

        var container = document.getElementById('dailyCharsChartContainer');
        container.style.display = '';

        var ctx = document.getElementById('dailyCharsChart').getContext('2d');

        if (dailyCharsChart) {
            dailyCharsChart.destroy();
        }

        dailyCharsChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: dailySpeed.labels,
                datasets: [{
                    label: 'Characters Read',
                    data: dailySpeed.charsData,
                    backgroundColor: getChartColor('--chart-success', 0.6),
                    borderColor: getChartColor('--chart-success', 0.9),
                    borderWidth: 1,
                    borderRadius: 3,
                }],
            },
            options: {
                responsive: true,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: {
                    x: {
                        ticks: { color: getChartColor('--chart-text'), maxRotation: 45 },
                        grid: { display: false },
                    },
                    y: {
                        title: { display: true, text: 'Characters', color: getChartColor('--chart-text') },
                        ticks: {
                            color: getChartColor('--chart-text'),
                            callback: function(value) {
                                return formatCompactNumber(value);
                            },
                        },
                        grid: { color: getChartColor('--chart-grid') },
                        beginAtZero: true,
                    },
                },
                plugins: {
                    legend: {
                        labels: { color: getChartColor('--chart-text') },
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return 'Characters: ' + formatNumber(context.parsed.y);
                            },
                        },
                    },
                },
            },
        });
    }

    // ================================================================
    //  Render Cumulative Characters & Time Over Time Chart (dual axis)
    // ================================================================
    function renderCumulativeCharsChart(dailySpeed, game) {
        if (!dailySpeed || !dailySpeed.labels || dailySpeed.labels.length === 0) return;

        var container = document.getElementById('cumulativeCharsChartContainer');
        container.style.display = '';

        var ctx = document.getElementById('cumulativeCharsChart').getContext('2d');

        if (cumulativeCharsChart) {
            cumulativeCharsChart.destroy();
        }

        // Compute cumulative characters
        var cumChars = [];
        var runningChars = 0;
        for (var i = 0; i < dailySpeed.charsData.length; i++) {
            runningChars += dailySpeed.charsData[i];
            cumChars.push(runningChars);
        }

        // Compute cumulative hours
        var cumHours = [];
        var runningHours = 0;
        var hasTimeData = false;
        if (dailySpeed.timeData) {
            for (var i = 0; i < dailySpeed.timeData.length; i++) {
                runningHours += dailySpeed.timeData[i];
                cumHours.push(Math.round(runningHours * 100) / 100);
                if (dailySpeed.timeData[i] > 0) hasTimeData = true;
            }
        }

        var datasets = [
            {
                label: 'Cumulative Characters',
                data: cumChars,
                borderColor: getChartColor('--chart-info'),
                backgroundColor: getChartColor('--chart-info', 0.15),
                borderWidth: 2,
                fill: true,
                tension: 0.3,
                pointRadius: 2,
                pointHoverRadius: 5,
                yAxisID: 'y',
            },
        ];

        // Add cumulative time on right axis
        if (hasTimeData) {
            datasets.push({
                label: 'Cumulative Hours',
                data: cumHours,
                borderColor: getChartColor('--chart-warning'),
                backgroundColor: 'transparent',
                borderWidth: 2,
                borderDash: [4, 2],
                fill: false,
                tension: 0.3,
                pointRadius: 1,
                pointHoverRadius: 4,
                yAxisID: 'y1',
            });
        }

        // Add horizontal target line if character_count exists
        var characterCount = game && game.character_count ? game.character_count : 0;
        if (characterCount > 0) {
            var targetLine = [];
            for (var i = 0; i < dailySpeed.labels.length; i++) {
                targetLine.push(characterCount);
            }
            datasets.push({
                label: 'Total Game Length (' + formatCompactNumber(characterCount) + ')',
                data: targetLine,
                borderColor: getChartColor('--chart-danger', 0.6),
                backgroundColor: 'transparent',
                borderWidth: 2,
                borderDash: [8, 4],
                fill: false,
                pointRadius: 0,
                pointHoverRadius: 0,
                yAxisID: 'y',
            });
        }

        var maxCumulative = cumChars.length > 0 ? cumChars[cumChars.length - 1] : 0;
        var yAxisConfig = {
            type: 'linear',
            position: 'left',
            title: { display: true, text: 'Characters', color: getChartColor('--chart-text') },
            ticks: {
                color: getChartColor('--chart-text'),
                callback: function(value) { return formatCompactNumber(value); },
            },
            grid: { color: getChartColor('--chart-grid') },
            beginAtZero: true,
        };

        if (characterCount > 0 && maxCumulative > 0) {
            if (characterCount <= maxCumulative * 3) {
                yAxisConfig.suggestedMax = Math.ceil(characterCount * 1.1);
            } else {
                yAxisConfig.max = Math.ceil(maxCumulative * 1.5);
            }
        }

        var scales = {
            x: {
                ticks: { color: getChartColor('--chart-text'), maxRotation: 45 },
                grid: { display: false },
            },
            y: yAxisConfig,
        };

        if (hasTimeData) {
            scales.y1 = {
                type: 'linear',
                position: 'right',
                title: { display: true, text: 'Hours', color: getChartColor('--chart-warning') },
                ticks: {
                    color: getChartColor('--chart-warning'),
                    callback: function(value) { return value.toFixed(1) + 'h'; },
                },
                grid: { drawOnChartArea: false },
                beginAtZero: true,
            };
        }

        cumulativeCharsChart = new Chart(ctx, {
            type: 'line',
            data: { labels: dailySpeed.labels, datasets: datasets },
            options: {
                responsive: true,
                interaction: { mode: 'index', intersect: false },
                scales: scales,
                plugins: {
                    legend: { labels: { color: getChartColor('--chart-text') } },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                if (context.dataset.yAxisID === 'y1') {
                                    return context.dataset.label + ': ' + formatTimeHM(context.parsed.y);
                                }
                                return context.dataset.label + ': ' + formatNumber(context.parsed.y);
                            },
                        },
                    },
                },
            },
        });
    }

    // ================================================================
    //  Render Daily Time Spent Chart
    // ================================================================
    function renderDailyTimeChart(dailySpeed) {
        if (!dailySpeed || !dailySpeed.labels || dailySpeed.labels.length === 0 || !dailySpeed.timeData) return;

        // Check if there's any time data
        var hasTimeData = false;
        for (var i = 0; i < dailySpeed.timeData.length; i++) {
            if (dailySpeed.timeData[i] > 0) { hasTimeData = true; break; }
        }
        if (!hasTimeData) return;

        var container = document.getElementById('dailyTimeChartContainer');
        container.style.display = '';

        var ctx = document.getElementById('dailyTimeChart').getContext('2d');

        if (dailyTimeChart) {
            dailyTimeChart.destroy();
        }

        dailyTimeChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: dailySpeed.labels,
                datasets: [{
                    label: 'Hours Spent',
                    data: dailySpeed.timeData,
                    backgroundColor: getChartColor('--chart-warning', 0.6),
                    borderColor: getChartColor('--chart-warning', 0.9),
                    borderWidth: 1,
                    borderRadius: 3,
                }],
            },
            options: {
                responsive: true,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: {
                    x: {
                        ticks: { color: getChartColor('--chart-text'), maxRotation: 45 },
                        grid: { display: false },
                    },
                    y: {
                        title: { display: true, text: 'Hours', color: getChartColor('--chart-text') },
                        ticks: {
                            color: getChartColor('--chart-text'),
                            callback: function(value) {
                                return value.toFixed(1) + 'h';
                            },
                        },
                        grid: { color: getChartColor('--chart-grid') },
                        beginAtZero: true,
                    },
                },
                plugins: {
                    legend: {
                        labels: { color: getChartColor('--chart-text') },
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                var hours = context.parsed.y;
                                return 'Time: ' + formatTimeHM(hours);
                            },
                        },
                    },
                },
            },
        });
    }

    // ================================================================
    //  Render Mining Density Chart (cards per 10k characters)
    // ================================================================
    function renderMiningDensityChart(dailySpeed) {
        if (!dailySpeed || !dailySpeed.cardsData || !dailySpeed.charsData) return;
        if (dailySpeed.labels.length < 2) return;

        // Check if there are any cards at all
        var totalCards = 0;
        for (var i = 0; i < dailySpeed.cardsData.length; i++) {
            totalCards += dailySpeed.cardsData[i];
        }
        if (totalCards === 0) return;

        var container = document.getElementById('miningDensityChartContainer');
        container.style.display = '';

        var ctx = document.getElementById('miningDensityChart').getContext('2d');

        if (miningDensityChart) {
            miningDensityChart.destroy();
        }

        // Build running ratio: cards per 10k cumulative characters
        var cumCards = 0;
        var cumChars = 0;
        var densityData = [];
        for (var i = 0; i < dailySpeed.labels.length; i++) {
            cumCards += dailySpeed.cardsData[i];
            cumChars += dailySpeed.charsData[i];
            var density = cumChars > 0 ? (cumCards / cumChars) * 10000 : 0;
            densityData.push(Math.round(density * 100) / 100);
        }

        miningDensityChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: dailySpeed.labels,
                datasets: [{
                    label: 'Cards per 10k Chars',
                    data: densityData,
                    borderColor: getChartColor('--chart-success'),
                    backgroundColor: getChartColor('--chart-success', 0.1),
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 2,
                    pointHoverRadius: 5,
                }],
            },
            options: {
                responsive: true,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: {
                        ticks: { color: getChartColor('--chart-text'), maxRotation: 45 },
                        grid: { display: false },
                    },
                    y: {
                        title: { display: true, text: 'Cards per 10k Chars', color: getChartColor('--chart-text') },
                        ticks: { color: getChartColor('--chart-text') },
                        grid: { color: getChartColor('--chart-grid') },
                        beginAtZero: true,
                    },
                },
                plugins: {
                    legend: { labels: { color: getChartColor('--chart-text') } },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return context.parsed.y.toFixed(1) + ' cards per 10k chars';
                            },
                        },
                    },
                },
            },
        });
    }

    // ================================================================
    //  Render Reading Speed Heatmap
    // ================================================================
    function renderSpeedHeatmap(heatmapData) {
        if (!heatmapData || Object.keys(heatmapData).length === 0) return;

        var container = document.getElementById('speedHeatmapContainer');
        container.style.display = '';

        var renderer = new HeatmapRenderer({
            containerId: 'gameSpeedHeatmap',
            metricName: 'chars/hr',
            metricLabel: 'reading speed (chars/hr)',
        });
        renderer.render(heatmapData, []);
    }

    // ================================================================
    //  Load Game Data
    // ================================================================
    async function loadGameData() {
        showState('loading');

        try {
            const response = await fetch('/api/game/' + gameId + '/stats');
            if (!response.ok) {
                if (response.status === 404) {
                    gameDetailErrorMessage.textContent = 'Game not found';
                } else {
                    gameDetailErrorMessage.textContent = 'Failed to load game data (HTTP ' + response.status + ')';
                }
                showState('error');
                return;
            }

            const data = await response.json();
            currentGameData = data.game;
            currentStatsData = data.stats;
            cachedDailySpeed = data.dailySpeed;

            renderGameInfo(data.game);
            renderStats(data.stats, data.game);
            renderKeyDatesStats(data.stats, data.dailySpeed);
            renderHighlightsStats(data.stats, data.dailySpeed);
            renderCumulativeCharsChart(data.dailySpeed, data.game);
            renderDailySpeedChart(data.dailySpeed);
            renderDailyCharsChart(data.dailySpeed);
            renderDailyTimeChart(data.dailySpeed);
            renderMiningDensityChart(data.dailySpeed);
            renderSpeedHeatmap(data.heatmapData);

            showState('loaded');
        } catch (error) {
            console.error('Error loading game data:', error);
            gameDetailErrorMessage.textContent = error.message || 'Failed to load game data';
            showState('error');
        }
    }

    // ================================================================
    //  Refresh time displays when time format toggle changes
    // ================================================================
    window.refreshTimeDisplays = function() {
        if (currentStatsData && currentGameData) {
            renderStats(currentStatsData, currentGameData);
            if (cachedDailySpeed) {
                renderKeyDatesStats(currentStatsData, cachedDailySpeed);
                renderHighlightsStats(currentStatsData, cachedDailySpeed);
                renderDailyTimeChart(cachedDailySpeed);
            }
        }
    };

    // ================================================================
    //  Description Expand/Collapse
    // ================================================================
    if (descriptionExpandBtn) {
        descriptionExpandBtn.addEventListener('click', function() {
            const expandText = this.querySelector('.expand-text');
            const collapseText = this.querySelector('.collapse-text');
            const isExpanded = gameDescription.classList.toggle('expanded');

            expandText.style.display = isExpanded ? 'none' : '';
            collapseText.style.display = isExpanded ? '' : 'none';
        });
    }

    // ================================================================
    //  Moving Average Toggle
    // ================================================================
    var toggleBtn = document.getElementById('toggleMovingAvgBtn');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', function() {
            movingAverageVisible = !movingAverageVisible;
            this.classList.toggle('active', movingAverageVisible);
            if (cachedDailySpeed) {
                renderDailySpeedChart(cachedDailySpeed);
            }
        });
    }

    // ================================================================
    //  Settings Cog Dropdown
    // ================================================================
    settingsCogBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        settingsCogDropdown.classList.toggle('show');
    });

    document.addEventListener('click', function() {
        settingsCogDropdown.classList.remove('show');
    });

    settingsCogDropdown.addEventListener('click', function(e) {
        e.stopPropagation();
    });

    // Dropdown action routing
    settingsCogDropdown.querySelectorAll('.dropdown-item').forEach(function(item) {
        item.addEventListener('click', function() {
            const action = this.getAttribute('data-action');
            settingsCogDropdown.classList.remove('show');

            switch (action) {
                case 'editGame': openEditModal(); break;
                case 'linkExternal': openLinkSearchModal(); break;
                case 'repullMetadata': repullMetadata(); break;
                case 'markComplete': markGameComplete(); break;
                case 'mergeGames': openMergeModal(); break;
                case 'unlinkGame': openUnlinkModal(); break;
                case 'deleteGame': openDeleteModal(); break;
            }
        });
    });

    // ================================================================
    //  Edit Game Modal
    // ================================================================
    function openEditModal() {
        if (!currentGameData) return;

        const g = currentGameData;
        document.getElementById('editTitleOriginal').value = g.title_original || '';
        document.getElementById('editTitleRomaji').value = g.title_romaji || '';
        document.getElementById('editTitleEnglish').value = g.title_english || '';
        document.getElementById('editType').value = g.type || '';
        document.getElementById('editDescription').value = g.description || '';
        document.getElementById('editDifficulty').value = g.difficulty || '';
        document.getElementById('editDeckId').value = g.deck_id || '';
        document.getElementById('editVndbId').value = g.vndb_id || '';
        document.getElementById('editAnilistId').value = g.anilist_id || '';
        document.getElementById('editCharacterCount').value = g.character_count || '';
        document.getElementById('editReleaseDate').value = g.release_date || '';
        document.getElementById('editCharacterSummary').value = g.character_summary || '';
        document.getElementById('editCompleted').checked = g.completed || false;

        // Links
        const links = g.links || [];
        const linkLines = links.map(function(link) {
            return typeof link === 'string' ? link : (link.url || '');
        }).filter(Boolean);
        document.getElementById('editLinksList').value = linkLines.join('\n');

        // Image preview
        const preview = document.getElementById('editImagePreview');
        const previewImg = document.getElementById('editImagePreviewImg');
        const imageSrc = getImageSrc(g.image);
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

    // Image upload handler
    document.getElementById('editImageUpload').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(ev) {
            document.getElementById('editImagePreviewImg').src = ev.target.result;
            document.getElementById('editImagePreview').style.display = '';
        };
        reader.readAsDataURL(file);
    });

    // Save game edits
    document.getElementById('saveGameEditsBtn').addEventListener('click', async function() {
        const errorEl = document.getElementById('editGameError');
        const loadingEl = document.getElementById('editGameLoading');
        errorEl.style.display = 'none';
        loadingEl.style.display = 'flex';

        try {
            // Build links from textarea
            const linkLines = document.getElementById('editLinksList').value.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
            const links = linkLines.map(function(url) {
                return { linkType: 4, url: url };
            });

            // Handle image upload
            let imageValue = undefined;
            const fileInput = document.getElementById('editImageUpload');
            if (fileInput.files && fileInput.files[0]) {
                imageValue = await new Promise(function(resolve) {
                    const reader = new FileReader();
                    reader.onload = function(e) { resolve(e.target.result); };
                    reader.readAsDataURL(fileInput.files[0]);
                });
            }

            const data = {
                title_original: document.getElementById('editTitleOriginal').value,
                title_romaji: document.getElementById('editTitleRomaji').value,
                title_english: document.getElementById('editTitleEnglish').value,
                type: document.getElementById('editType').value,
                description: document.getElementById('editDescription').value,
                difficulty: document.getElementById('editDifficulty').value ? parseInt(document.getElementById('editDifficulty').value) : '',
                deck_id: document.getElementById('editDeckId').value ? parseInt(document.getElementById('editDeckId').value) : '',
                vndb_id: document.getElementById('editVndbId').value,
                anilist_id: document.getElementById('editAnilistId').value,
                character_count: document.getElementById('editCharacterCount').value ? parseInt(document.getElementById('editCharacterCount').value) : '',
                release_date: document.getElementById('editReleaseDate').value,
                character_summary: document.getElementById('editCharacterSummary').value,
                links: links,
                completed: document.getElementById('editCompleted').checked,
            };

            if (imageValue !== undefined) {
                data.image = imageValue;
            }

            const response = await fetch('/api/games/' + gameId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });

            if (!response.ok) {
                const errData = await response.json().catch(function() { return {}; });
                throw new Error(errData.error || 'Failed to save');
            }

            closeModal('editGameModal');
            // Reload page to reflect changes
            loadGameData();
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.style.display = '';
        } finally {
            loadingEl.style.display = 'none';
        }
    });

    // Close edit modal handlers
    document.querySelectorAll('[data-action="closeEditModal"]').forEach(function(btn) {
        btn.addEventListener('click', function() { closeModal('editGameModal'); });
    });

    // ================================================================
    //  Mark as Completed
    // ================================================================
    async function markGameComplete() {
        if (!currentGameData) return;
        if (currentGameData.completed) return;

        try {
            const response = await fetch('/api/games/' + gameId + '/mark-complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (!response.ok) {
                const errData = await response.json().catch(function() { return {}; });
                alert('Failed to mark as completed: ' + (errData.error || 'Unknown error'));
                return;
            }

            // Reload to reflect changes
            loadGameData();
        } catch (error) {
            alert('Failed to mark as completed: ' + error.message);
        }
    }

    // ================================================================
    //  Merge Games Modal
    // ================================================================
    async function openMergeModal() {
        if (!currentGameData) return;

        mergeSelectedGames = [];
        document.getElementById('mergeTargetName').textContent = currentGameData.title_original;
        document.getElementById('mergeSearchInput').value = '';
        document.getElementById('mergeError').style.display = 'none';
        document.getElementById('mergeLoading').style.display = 'none';
        document.getElementById('mergeSelectedContainer').style.display = 'none';
        document.getElementById('confirmMergeBtn').disabled = true;

        openModal('mergeGamesModal');

        // Load all games for the merge picker
        try {
            const response = await fetch('/api/games-management?sort=title');
            if (!response.ok) throw new Error('Failed to load games');
            const data = await response.json();
            allGamesForMerge = (data.games || []).filter(function(g) {
                return g.id !== gameId;
            });
            renderMergeGamesList(allGamesForMerge);
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

        games.forEach(function(game) {
            const item = document.createElement('div');
            item.className = 'merge-game-item' + (mergeSelectedGames.some(function(s) { return s.id === game.id; }) ? ' selected' : '');

            const isChecked = mergeSelectedGames.some(function(s) { return s.id === game.id; });

            item.innerHTML = `
                <input type="checkbox" ${isChecked ? 'checked' : ''}>
                <div class="merge-game-info">
                    <div class="merge-game-name">${escapeHtml(game.title_original)}</div>
                    <div class="merge-game-stats">${formatNumber(game.line_count)} lines, ${formatNumber(game.mined_character_count)} chars</div>
                </div>
            `;

            item.addEventListener('click', function() {
                toggleMergeSelection(game);
            });

            list.appendChild(item);
        });
    }

    function toggleMergeSelection(game) {
        const idx = mergeSelectedGames.findIndex(function(s) { return s.id === game.id; });
        if (idx >= 0) {
            mergeSelectedGames.splice(idx, 1);
        } else {
            mergeSelectedGames.push(game);
        }
        updateMergeUI();
    }

    function updateMergeUI() {
        // Re-render the list to update checkboxes
        const query = document.getElementById('mergeSearchInput').value.trim().toLowerCase();
        const filtered = query
            ? allGamesForMerge.filter(function(g) {
                return (g.title_original || '').toLowerCase().includes(query) ||
                       (g.title_romaji || '').toLowerCase().includes(query) ||
                       (g.title_english || '').toLowerCase().includes(query);
            })
            : allGamesForMerge;
        renderMergeGamesList(filtered);

        // Update selected tags
        const container = document.getElementById('mergeSelectedContainer');
        const list = document.getElementById('mergeSelectedList');

        if (mergeSelectedGames.length > 0) {
            container.style.display = '';
            list.innerHTML = '';
            mergeSelectedGames.forEach(function(game) {
                const tag = document.createElement('span');
                tag.className = 'merge-selected-tag';
                tag.innerHTML = escapeHtml(game.title_original) + ' <button class="remove-btn">&times;</button>';
                tag.querySelector('.remove-btn').addEventListener('click', function(e) {
                    e.stopPropagation();
                    toggleMergeSelection(game);
                });
                list.appendChild(tag);
            });
        } else {
            container.style.display = 'none';
        }

        document.getElementById('confirmMergeBtn').disabled = mergeSelectedGames.length === 0;
    }

    // Merge search
    document.getElementById('mergeSearchInput').addEventListener('input', function() {
        const query = this.value.trim().toLowerCase();
        const filtered = query
            ? allGamesForMerge.filter(function(g) {
                return (g.title_original || '').toLowerCase().includes(query) ||
                       (g.title_romaji || '').toLowerCase().includes(query) ||
                       (g.title_english || '').toLowerCase().includes(query);
            })
            : allGamesForMerge;
        renderMergeGamesList(filtered);
    });

    // Confirm merge
    document.getElementById('confirmMergeBtn').addEventListener('click', async function() {
        if (mergeSelectedGames.length === 0 || !currentGameData) return;

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
                    target_game: currentGameData.title_original,
                    games_to_merge: mergeSelectedGames.map(function(g) { return g.title_original; }),
                }),
            });

            if (!response.ok) {
                const errData = await response.json().catch(function() { return {}; });
                throw new Error(errData.error || 'Merge failed');
            }

            closeModal('mergeGamesModal');
            loadGameData();
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.style.display = '';
        } finally {
            loadingEl.style.display = 'none';
            this.disabled = mergeSelectedGames.length === 0;
        }
    });

    document.querySelectorAll('[data-action="closeMergeModal"]').forEach(function(btn) {
        btn.addEventListener('click', function() { closeModal('mergeGamesModal'); });
    });

    // ================================================================
    //  Unlink Game Modal
    // ================================================================
    function openUnlinkModal() {
        if (!currentGameData) return;
        document.getElementById('unlinkGameName').textContent = currentGameData.title_original || '-';
        document.getElementById('unlinkError').style.display = 'none';
        document.getElementById('unlinkLoading').style.display = 'none';
        openModal('unlinkGameModal');
    }

    document.getElementById('confirmUnlinkBtn').addEventListener('click', async function() {
        const errorEl = document.getElementById('unlinkError');
        const loadingEl = document.getElementById('unlinkLoading');
        errorEl.style.display = 'none';
        loadingEl.style.display = 'flex';
        this.disabled = true;

        try {
            const response = await fetch('/api/games/' + gameId, {
                method: 'DELETE',
            });

            if (!response.ok) {
                const errData = await response.json().catch(function() { return {}; });
                throw new Error(errData.error || 'Unlink failed');
            }

            // Redirect to games grid
            window.location.href = '/games';
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.style.display = '';
        } finally {
            loadingEl.style.display = 'none';
            this.disabled = false;
        }
    });

    document.querySelectorAll('[data-action="closeUnlinkModal"]').forEach(function(btn) {
        btn.addEventListener('click', function() { closeModal('unlinkGameModal'); });
    });

    // ================================================================
    //  Delete Game Modal
    // ================================================================
    function openDeleteModal() {
        if (!currentGameData) return;
        document.getElementById('deleteGameName').textContent = currentGameData.title_original || '-';
        document.getElementById('deleteGameSentences').textContent = currentStatsData ? formatNumber(currentStatsData.total_sentences) : '-';
        document.getElementById('deleteError').style.display = 'none';
        document.getElementById('deleteLoading').style.display = 'none';
        openModal('deleteGameModal');
    }

    document.getElementById('confirmDeleteBtn').addEventListener('click', async function() {
        const errorEl = document.getElementById('deleteError');
        const loadingEl = document.getElementById('deleteLoading');
        errorEl.style.display = 'none';
        loadingEl.style.display = 'flex';
        this.disabled = true;

        try {
            const response = await fetch('/api/games/' + gameId + '/delete-lines', {
                method: 'DELETE',
            });

            if (!response.ok) {
                const errData = await response.json().catch(function() { return {}; });
                throw new Error(errData.error || 'Delete failed');
            }

            // Redirect to games grid
            window.location.href = '/games';
        } catch (error) {
            errorEl.textContent = error.message;
            errorEl.style.display = '';
        } finally {
            loadingEl.style.display = 'none';
            this.disabled = false;
        }
    });

    document.querySelectorAll('[data-action="closeDeleteModal"]').forEach(function(btn) {
        btn.addEventListener('click', function() { closeModal('deleteGameModal'); });
    });

    // ================================================================
    //  Re-pull Metadata
    // ================================================================
    async function repullMetadata() {
        if (!currentGameData) return;

        var gameName = currentGameData.title_original || 'this game';
        if (!window.confirm('Re-pull metadata for "' + gameName + '"?\n\nThis will update all non-manually-edited fields with fresh data from the linked source (Jiten, VNDB, or AniList).')) {
            return;
        }

        try {
            var response = await fetch('/api/games/' + gameId + '/repull-jiten', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            var result = await response.json();

            if (!response.ok) {
                alert('Failed to re-pull metadata: ' + (result.error || 'Unknown error'));
                return;
            }

            var message = 'Metadata re-pulled successfully!';

            if (result.sources_used && result.sources_used.length > 0) {
                message += '\nSources: ' + result.sources_used.join(', ');
            }
            if (result.updated_fields && result.updated_fields.length > 0) {
                message += '\nUpdated: ' + result.updated_fields.join(', ');
            }
            if (result.skipped_fields && result.skipped_fields.length > 0) {
                message += '\nSkipped (manually edited): ' + result.skipped_fields.join(', ');
            }

            alert(message);
            loadGameData();
        } catch (error) {
            alert('Failed to re-pull metadata: ' + error.message);
        }
    }

    // ================================================================
    //  Link to External Sources (Jiten.moe / VNDB / AniList)
    // ================================================================
    //
    // TODO(anyone reading this): This search-select-confirm flow is largely
    // duplicated from database-jiten-integration.js.  Both pages use the same
    // backend endpoints (/api/unified-search, /api/games/<id>/link-jiten, PUT
    // /api/games/<id>) and the same UnifiedSearch module.  The two copies
    // should be unified into a single shared module that both pages import.
    // The game-stats page just needs its own "after link" callback
    // (loadGameData) instead of the database page's refreshAfterLinking().
    //

    var selectedLinkResult = null; // Stores the currently selected search result

    function openLinkSearchModal() {
        if (!currentGameData) return;

        selectedLinkResult = null;

        var searchInput = document.getElementById('linkSearchInput');
        var gameName = document.getElementById('linkSearchGameName');
        var resultsDiv = document.getElementById('linkSearchResults');
        var errorDiv = document.getElementById('linkSearchError');
        var loadingDiv = document.getElementById('linkSearchLoading');

        gameName.textContent = currentGameData.title_original || '';
        searchInput.value = currentGameData.title_original || '';
        resultsDiv.style.display = 'none';
        errorDiv.style.display = 'none';
        loadingDiv.style.display = 'none';

        openModal('linkSearchModal');
    }

    async function searchDatabases() {
        var searchInput = document.getElementById('linkSearchInput');
        var resultsDiv = document.getElementById('linkSearchResults');
        var resultsListDiv = document.getElementById('linkSearchResultsList');
        var errorDiv = document.getElementById('linkSearchError');
        var loadingDiv = document.getElementById('linkSearchLoading');

        var searchTerm = searchInput.value.trim();
        if (!searchTerm) {
            errorDiv.textContent = 'Please enter a search term';
            errorDiv.style.display = 'block';
            return;
        }

        errorDiv.style.display = 'none';
        resultsDiv.style.display = 'none';
        loadingDiv.style.display = 'flex';

        try {
            if (typeof UnifiedSearch === 'undefined') {
                throw new Error('Search module not loaded. Please refresh the page.');
            }

            var searchResult = await UnifiedSearch.search(searchTerm);

            if (searchResult.error) {
                errorDiv.textContent = searchResult.error;
                errorDiv.style.display = 'block';
            } else if (searchResult.results && searchResult.results.length > 0) {
                UnifiedSearch.renderResults(searchResult.results, resultsListDiv, onSelectResult);
                resultsDiv.style.display = 'block';
            } else {
                errorDiv.textContent = 'No results found. Try a different search term or enable more sources.';
                errorDiv.style.display = 'block';
            }
        } catch (error) {
            console.error('Error searching databases:', error);
            errorDiv.textContent = 'Search failed: ' + error.message;
            errorDiv.style.display = 'block';
        } finally {
            loadingDiv.style.display = 'none';
        }
    }

    function onSelectResult(result) {
        if (!result || !currentGameData) return;

        selectedLinkResult = result;

        // Populate current game preview
        var currentPreview = document.getElementById('linkConfirmCurrentGame');
        currentPreview.innerHTML =
            '<h5>' + escapeHtml(currentGameData.title_original || '') + '</h5>' +
            '<div style="color: var(--text-secondary); font-size: 13px; margin-top: 4px;">' +
                (currentStatsData ? formatNumber(currentStatsData.total_sentences) + ' sentences, ' + formatNumber(currentStatsData.total_characters) + ' characters' : '') +
            '</div>';

        // Determine source info
        var source = result.source || 'jiten';
        var sourceLabels = { jiten: 'Jiten', vndb: 'VNDB', anilist: 'AniList' };
        var sourceBadgeClasses = { jiten: 'jiten-badge', vndb: 'vndb-badge', anilist: 'anilist-badge' };
        var sourceEmojis = { jiten: '🟢', vndb: '🔵', anilist: '🟠' };
        var sourceWarnings = {
            jiten: '',
            vndb: '<div class="source-warning" style="margin-top: 10px;">⚠️ Visual Novel data only - character counts and difficulty not available</div>',
            anilist: '<div class="source-warning" style="margin-top: 10px;">⚠️ Anime/Manga data only - character counts and difficulty not available</div>'
        };

        var primaryTitle = result.title || result.title_jp || result.title_en || 'Unknown Title';
        var secondaryTitle = result.title_en && result.title_en !== primaryTitle ? result.title_en : '';
        var coverUrl = result.cover_url || '';
        var description = result.description ? escapeHtml(result.description.substring(0, 150)) + (result.description.length > 150 ? '...' : '') : '';

        // Populate matched game preview
        var matchedPreview = document.getElementById('linkConfirmMatchedGame');
        matchedPreview.innerHTML =
            '<div style="display: flex; align-items: flex-start; gap: 10px;">' +
                (coverUrl
                    ? '<img src="' + escapeHtml(coverUrl) + '" style="width: 60px; height: 80px; object-fit: cover; border-radius: 4px; flex-shrink: 0;" onerror="this.style.display=\'none\'">'
                    : '<div style="width: 60px; height: 80px; background: var(--bg-primary); border-radius: 4px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">🎮</div>') +
                '<div style="flex: 1; min-width: 0;">' +
                    '<div style="margin-bottom: 4px;"><span class="source-badge ' + (sourceBadgeClasses[source] || '') + '">' + (sourceEmojis[source] || '') + ' ' + (sourceLabels[source] || source) + '</span></div>' +
                    '<h5 style="margin: 0 0 4px 0;">' + escapeHtml(primaryTitle) + '</h5>' +
                    (secondaryTitle ? '<p style="margin: 2px 0; color: var(--text-secondary); font-size: 13px;">' + escapeHtml(secondaryTitle) + '</p>' : '') +
                '</div>' +
            '</div>' +
            (sourceWarnings[source] || '') +
            (description ? '<div style="margin-top: 10px; color: var(--text-secondary); font-size: 14px;">' + description + '</div>' : '');

        // Update modal title
        var titleEl = document.getElementById('linkConfirmTitle');
        if (titleEl) {
            titleEl.textContent = source === 'jiten' ? 'Confirm Game Link' : 'Confirm Game Link (' + (sourceLabels[source] || source) + ')';
        }

        // Reset state
        document.getElementById('linkConfirmError').style.display = 'none';
        document.getElementById('linkConfirmLoading').style.display = 'none';
        document.getElementById('confirmLinkBtn').disabled = false;

        closeModal('linkSearchModal');
        openModal('linkConfirmModal');
    }

    async function confirmGameLink() {
        if (!selectedLinkResult || !currentGameData) return;

        var errorDiv = document.getElementById('linkConfirmError');
        var loadingDiv = document.getElementById('linkConfirmLoading');
        var confirmBtn = document.getElementById('confirmLinkBtn');

        errorDiv.style.display = 'none';
        loadingDiv.style.display = 'flex';
        confirmBtn.disabled = true;

        var source = selectedLinkResult.source || 'jiten';
        var isJitenSource = source === 'jiten' && selectedLinkResult._raw && selectedLinkResult._raw.deck_id;

        try {
            var response, result;

            if (isJitenSource) {
                // Jiten: use the dedicated link endpoint
                var cleanJitenData = Object.assign({}, selectedLinkResult._raw);

                response = await fetch('/api/games/' + gameId + '/link-jiten', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        deck_id: selectedLinkResult._raw.deck_id,
                        jiten_data: cleanJitenData,
                    }),
                });

                result = await response.json();
            } else {
                // VNDB / AniList: update game metadata via PUT
                var updateData = {
                    title_original: selectedLinkResult.title_jp || selectedLinkResult.title || currentGameData.title_original,
                    title_english: selectedLinkResult.title_en || currentGameData.title_english || '',
                    title_romaji: selectedLinkResult.title || currentGameData.title_romaji || '',
                    description: selectedLinkResult.description || currentGameData.description || '',
                    type: source === 'vndb' ? 'Visual Novel' : 'Anime',
                };

                if (source === 'vndb' && selectedLinkResult.id) {
                    updateData.vndb_id = selectedLinkResult.id;
                } else if (source === 'anilist' && selectedLinkResult.id) {
                    updateData.anilist_id = selectedLinkResult.id;
                }

                if (selectedLinkResult.source_url) {
                    updateData.links = [{
                        deckId: 1,
                        linkId: 1,
                        linkType: source === 'vndb' ? 4 : 5,
                        url: selectedLinkResult.source_url,
                    }];
                }

                response = await fetch('/api/games/' + gameId, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(updateData),
                });

                result = await response.json();
            }

            if (!response.ok) {
                throw new Error(result.error || 'Failed to link game');
            }

            closeModal('linkConfirmModal');

            var sourceLabel = { jiten: 'Jiten.moe', vndb: 'VNDB', anilist: 'AniList' }[source] || source;
            if (isJitenSource) {
                var lineCount = result.lines_linked || 0;
                alert('Successfully linked to ' + sourceLabel + '! ' + lineCount + ' lines linked.');
            } else {
                alert('Successfully updated with ' + sourceLabel + ' metadata!\nNote: Character counts and difficulty are only available from Jiten.');
            }

            loadGameData();
        } catch (error) {
            errorDiv.textContent = error.message;
            errorDiv.style.display = 'block';
        } finally {
            loadingDiv.style.display = 'none';
            confirmBtn.disabled = false;
        }
    }

    // Wire up link search modal events
    document.getElementById('linkSearchBtn').addEventListener('click', searchDatabases);

    document.getElementById('linkSearchInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            searchDatabases();
        }
    });

    document.getElementById('confirmLinkBtn').addEventListener('click', confirmGameLink);

    document.querySelectorAll('[data-action="closeLinkSearchModal"]').forEach(function(btn) {
        btn.addEventListener('click', function() { closeModal('linkSearchModal'); });
    });

    document.querySelectorAll('[data-action="closeLinkConfirmModal"]').forEach(function(btn) {
        btn.addEventListener('click', function() { closeModal('linkConfirmModal'); });
    });

    // ================================================================
    //  Initialize
    // ================================================================
    loadGameData();

})();
