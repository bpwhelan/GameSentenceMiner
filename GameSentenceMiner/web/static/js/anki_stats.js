// anki_stats.js: Loads missing high-frequency kanji stats

document.addEventListener('DOMContentLoaded', function () {
    const loading = document.getElementById('ankiStatsLoading');
    const error = document.getElementById('ankiStatsError');
    const missingKanjiGrid = document.getElementById('missingKanjiGrid');
    const missingKanjiCount = document.getElementById('missingKanjiCount');
    const ankiTotalKanji = document.getElementById('ankiTotalKanji');
    const gsmTotalKanji = document.getElementById('gsmTotalKanji');
    const ankiCoverage = document.getElementById('ankiCoverage');
    const fromDateInput = document.getElementById('fromDate');
    const toDateInput = document.getElementById('toDate');
    const ankiConnectWarning = document.getElementById('ankiConnectWarning');
    const ankiSessionId = window.ANKI_API_SESSION_ID || sessionStorage.getItem('ankiApiSessionId');
    const DEFAULT_ANKI_TABLE_PAGE_SIZE = 25;
    const ANKI_STATS_INITIAL_SECTIONS = ['kanji_stats', 'game_stats'];
    const ANKI_STATS_DEFERRED_SECTIONS = ['reading_impact'];
    const DEFERRED_WORDS_NOT_IN_ANKI_TIMEOUT_MS = 1500;
    const DEFERRED_READING_IMPACT_TIMEOUT_MS = 750;
    let deferredWordsNotInAnkiLoadHandle = null;
    let deferredReadingImpactLoadHandle = null;
    let readingImpactRequestId = 0;

    function getAnkiTablePageSize(tableId) {
        const table = document.getElementById(tableId);
        const rawPageSize = Number.parseInt(table?.dataset?.pageSize ?? '', 10);

        if (Number.isFinite(rawPageSize) && rawPageSize > 0) {
            return rawPageSize;
        }

        return DEFAULT_ANKI_TABLE_PAGE_SIZE;
    }

    const paginatedAnkiTables = {
        cardsPerGame: {
            items: [],
            page: 0,
            pageSize: getAnkiTablePageSize('cardsPerGameTable'),
            itemLabel: 'games',
            bodyId: 'cardsPerGameTableBody',
            emptyId: 'cardsPerGameEmpty',
            paginationId: 'cardsPerGamePagination',
            prevId: 'cardsPerGamePrev',
            nextId: 'cardsPerGameNext',
            infoId: 'cardsPerGamePageInfo',
            defaultEmptyText:
                document.getElementById('cardsPerGameEmpty')?.textContent?.trim() ||
                'No card data available for the selected date range.',
            currentEmptyText: '',
            buildRow(game) {
                const row = document.createElement('tr');

                const nameCell = document.createElement('td');
                nameCell.textContent = game.game_name;
                row.appendChild(nameCell);

                const countCell = document.createElement('td');
                countCell.textContent = game.card_count || 0;
                row.appendChild(countCell);

                return row;
            },
        },
        gameStats: {
            items: [],
            page: 0,
            pageSize: getAnkiTablePageSize('gameStatsTable'),
            itemLabel: 'games',
            bodyId: 'gameStatsTableBody',
            emptyId: 'gameStatsEmpty',
            paginationId: 'gameStatsPagination',
            prevId: 'gameStatsPrev',
            nextId: 'gameStatsNext',
            infoId: 'gameStatsPageInfo',
            defaultEmptyText:
                document.getElementById('gameStatsEmpty')?.textContent?.trim() ||
                'No game statistics available for the selected date range.',
            currentEmptyText: '',
            buildRow(game) {
                const row = document.createElement('tr');

                const nameCell = document.createElement('td');
                nameCell.textContent = game.game_name;
                row.appendChild(nameCell);

                const timeCell = document.createElement('td');
                timeCell.textContent = formatTime(game.avg_time_per_card);
                row.appendChild(timeCell);

                const retentionCell = document.createElement('td');
                retentionCell.textContent = game.retention_pct + '%';
                retentionCell.style.color = getRetentionColor(game.retention_pct);
                row.appendChild(retentionCell);

                return row;
            },
        },
        readingImpactRollup: {
            items: [],
            page: 0,
            pageSize: getAnkiTablePageSize('readingImpactRollupTable'),
            itemLabel: 'weeks',
            bodyId: 'readingImpactRollupTableBody',
            emptyId: 'readingImpactRollupEmpty',
            paginationId: 'readingImpactRollupPagination',
            prevId: 'readingImpactRollupPrev',
            nextId: 'readingImpactRollupNext',
            infoId: 'readingImpactRollupPageInfo',
            defaultEmptyText:
                document.getElementById('readingImpactRollupEmpty')?.textContent?.trim() ||
                'Not enough mature-card history is available to build the weekly rollup yet.',
            currentEmptyText: '',
            buildRow(week) {
                const row = document.createElement('tr');
                const cells = [
                    {
                        text: formatWeekLabel(week.sourceLabel),
                        className: 'reading-impact-rollup-week',
                    },
                    {
                        text: week.outcomeLabel ? formatWeekLabel(week.outcomeLabel) : 'Pending',
                    },
                    { text: week.readingChars.toLocaleString() },
                    { text: week.cardsMined.toLocaleString() },
                    {
                        text:
                            week.matureWords == null ? 'Pending' : week.matureWords.toLocaleString(),
                    },
                    {
                        text:
                            week.matureKanji == null ? 'Pending' : week.matureKanji.toLocaleString(),
                    },
                    {
                        text: week.yieldPer100k == null ? '—' : week.yieldPer100k.toFixed(1),
                        tooltip: week.yieldTooltip,
                    },
                ];

                cells.forEach(({ text, className, tooltip }) => {
                    const cell = document.createElement('td');
                    cell.textContent = text;
                    if (className) {
                        cell.className = className;
                    }
                    if (tooltip) {
                        cell.title = tooltip;
                    }
                    row.appendChild(cell);
                });

                return row;
            },
        },
    };

    Object.values(paginatedAnkiTables).forEach((config) => {
        config.currentEmptyText = config.defaultEmptyText;
    });

    function fetchAnkiApi(path, options = {}) {
        const headers = {
            ...(ankiSessionId ? { 'X-Anki-Session': ankiSessionId } : {}),
            ...(options.headers || {}),
        };
        return fetch(path, { ...options, headers });
    }

    const readingImpactState = {
        metric: 'words',
        data: null,
        charts: {
            immediate: null,
            pipeline: null,
        },
    };

    // Function to show/hide AnkiConnect warning
    function showAnkiConnectWarning(show) {
        if (ankiConnectWarning) {
            ankiConnectWarning.style.display = show ? 'block' : 'none';
        }
    }

    function formatIsoTimestamp(isoTimestamp) {
        if (!isoTimestamp) {
            return null;
        }

        const parsed = new Date(isoTimestamp);
        if (Number.isNaN(parsed.getTime())) {
            return null;
        }

        return parsed.toLocaleString();
    }

    function formatAutoSyncMessage(data) {
        if (!data || data.auto_sync_enabled === false) {
            return 'Anki auto-sync is disabled.';
        }

        const schedule =
            typeof data.auto_sync_schedule === 'string' && data.auto_sync_schedule
                ? data.auto_sync_schedule
                : 'daily';
        const nextAutoSyncText = formatIsoTimestamp(data.next_auto_sync);

        if (nextAutoSyncText) {
            const nextAutoSyncDate = new Date(data.next_auto_sync);
            if (
                !Number.isNaN(nextAutoSyncDate.getTime()) &&
                nextAutoSyncDate.getTime() <= Date.now()
            ) {
                return `Anki auto-sync runs ${schedule} and is due to run soon.`;
            }
            return `Anki auto-sync runs ${schedule} (next: ${nextAutoSyncText}).`;
        }

        return `Anki auto-sync runs ${schedule}.`;
    }

    function buildSyncBannerMessage(data) {
        const manualPrompt = 'Want to manually sync Anki now?';
        const autoSyncMessage = formatAutoSyncMessage(data);
        const cacheMessage = data?.cache_populated
            ? `Cache: ${data.note_count} notes, ${data.card_count} cards.`
            : 'No cached Anki data yet.';
        const lastSyncedText = formatIsoTimestamp(data?.last_synced);

        const parts = [manualPrompt, autoSyncMessage, cacheMessage];
        if (lastSyncedText) {
            parts.push(`Last synced: ${lastSyncedText}.`);
        }

        return parts.join(' ');
    }

    // Fetch sync status and update UI accordingly
    async function loadSyncStatus() {
        const syncStatusBar = document.getElementById('syncStatusBar');
        const syncStatusText = document.getElementById('syncStatusText');
        const syncNowButton = document.getElementById('syncNowButton');
        try {
            const resp = await fetchAnkiApi('/api/anki_sync_status');
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}`);
            }
            const data = await resp.json();
            showAnkiConnectWarning(!data.cache_populated);

            if (syncStatusBar && syncStatusText) {
                syncStatusText.textContent = buildSyncBannerMessage(data);
                syncStatusBar.style.display = 'flex';
            }
        } catch (e) {
            console.warn('Failed to load sync status:', e);
            if (syncStatusBar && syncStatusText) {
                syncStatusText.textContent =
                    'Want to manually sync Anki now? Anki auto-sync runs daily. Sync status is temporarily unavailable.';
                syncStatusBar.style.display = 'flex';
            }
            showAnkiConnectWarning(true);
        } finally {
            if (syncNowButton) {
                syncNowButton.disabled = false;
            }
        }
    }

    async function queueManualAnkiSync() {
        const syncStatusText = document.getElementById('syncStatusText');
        const syncNowButton = document.getElementById('syncNowButton');

        if (!syncNowButton) {
            return;
        }

        const originalLabel = syncNowButton.textContent;
        syncNowButton.disabled = true;
        syncNowButton.textContent = 'Queuing...';

        try {
            const resp = await fetchAnkiApi('/api/anki_sync_now', { method: 'POST' });
            if (!resp.ok) {
                const payload = await resp.json().catch(() => ({}));
                throw new Error(payload.error || `HTTP ${resp.status}`);
            }

            if (syncStatusText) {
                syncStatusText.textContent = 'Manual sync queued. Checking sync status...';
            }

            await loadSyncStatus();
        } catch (e) {
            console.warn('Failed to queue manual Anki sync:', e);
            if (syncStatusText) {
                syncStatusText.textContent =
                    'Manual sync could not be queued. Make sure Anki is running, then try again.';
            }
        } finally {
            syncNowButton.disabled = false;
            syncNowButton.textContent = originalLabel;
        }
    }

    function scheduleSyncStatusLoad(timeoutMs = 500) {
        const runLoad = () => {
            void loadSyncStatus();
        };

        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(runLoad, { timeout: timeoutMs });
            return;
        }

        window.setTimeout(runLoad, 0);
    }

    // Kick off sync status after the primary stats path has had a chance to render.
    const syncNowButton = document.getElementById('syncNowButton');
    if (syncNowButton) {
        syncNowButton.addEventListener('click', queueManualAnkiSync);
    }

    scheduleSyncStatusLoad();

    // Initialize heatmap renderer with mining-specific configuration
    const miningHeatmapRenderer = new HeatmapRenderer({
        containerId: 'miningHeatmapContainer',
        metricName: 'sentences',
        metricLabel: 'sentences mined',
    });

    // Function to create GitHub-style heatmap for mining activity using shared component
    function createMiningHeatmap(heatmapData) {
        miningHeatmapRenderer.render(heatmapData);
    }

    function destroyChartInstance(chart) {
        if (chart && typeof chart.destroy === 'function') {
            chart.destroy();
        }
    }

    function getReadingImpactPalette() {
        const styles = getComputedStyle(document.documentElement);
        return {
            chars: styles.getPropertyValue('--primary-color').trim() || '#3b82f6',
            cards: styles.getPropertyValue('--warning-color').trim() || '#f59e0b',
            maturity: styles.getPropertyValue('--success-color').trim() || '#10b981',
            maturityAlt: styles.getPropertyValue('--accent-color').trim() || '#8b5cf6',
            retention: '#ef4444',
            text: styles.getPropertyValue('--text-secondary').trim() || '#94a3b8',
            grid: styles.getPropertyValue('--border-color').trim() || 'rgba(148, 163, 184, 0.25)',
        };
    }

    function formatCompactNumber(value, maximumFractionDigits = 1) {
        return new Intl.NumberFormat(undefined, {
            notation: 'compact',
            compactDisplay: 'short',
            maximumFractionDigits,
        }).format(Number(value || 0));
    }

    function formatWeekLabel(dateString) {
        const parsed = new Date((dateString || '') + 'T00:00:00');
        if (Number.isNaN(parsed.getTime())) {
            return dateString;
        }
        return parsed.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
        });
    }

    function getReadingImpactMetricLabel(metric = readingImpactState.metric) {
        return metric === 'kanji' ? 'Mature Kanji' : 'Mature Words';
    }

    function getReadingImpactYieldLabel(metric = readingImpactState.metric) {
        return `${getReadingImpactMetricLabel(metric)} / 100k chars`;
    }

    function getReadingImpactYieldMetricTooltip(
        metricLabel = getReadingImpactMetricLabel(),
        lagWeeks = 3,
    ) {
        return `${metricLabel} per 100k chars compares mature outcomes ${lagWeeks} weeks later against reading chars from the source week.`;
    }

    function getReadingImpactYieldTooltip({
        metricLabel,
        sourceLabel,
        outcomeLabel,
        readingChars,
        metricValue,
        lagWeeks,
    }) {
        const metric = metricLabel.toLowerCase();
        if (!sourceLabel || readingChars <= 0) {
            return `No reading chars for ${sourceLabel || 'this week'} to calculate ${metric} yield.`;
        }
        if (!outcomeLabel || metricValue == null) {
            return `No mature ${metric} was recorded in the ${lagWeeks}-week lagged outcome window yet.`;
        }
        return `Formula: (${metricValue.toLocaleString()} ${metric} / ${readingChars.toLocaleString()} chars) × 100,000.`;
    }

    function getReadingImpactMaturitySeries(data, metric = readingImpactState.metric) {
        return metric === 'kanji' ? data.lagged_mature_kanji || [] : data.lagged_mature_words || [];
    }

    function hasReadingImpactLaggedData(data, metric = readingImpactState.metric) {
        return getReadingImpactMaturitySeries(data, metric).some(
            (value) => value !== null && value !== undefined,
        );
    }

    function setChartVisibility(canvasId, emptyId, shouldShowCanvas, emptyMessage = '') {
        const canvas = document.getElementById(canvasId);
        const empty = document.getElementById(emptyId);
        if (canvas) {
            canvas.style.display = shouldShowCanvas ? '' : 'none';
        }
        if (empty) {
            empty.style.display = shouldShowCanvas ? 'none' : 'block';
            if (emptyMessage) {
                empty.textContent = emptyMessage;
            }
        }
    }

    function updateReadingImpactToggleButtons() {
        document.querySelectorAll('[data-reading-impact-metric]').forEach((button) => {
            button.classList.toggle(
                'active',
                button.dataset.readingImpactMetric === readingImpactState.metric,
            );
        });
    }

    function getReadingImpactTotals(data) {
        const laggedSeries = getReadingImpactMaturitySeries(data);
        return {
            totalReadingChars: (data.reading_chars || []).reduce(
                (sum, value) => sum + Number(value || 0),
                0,
            ),
            totalCards: (data.cards_mined || []).reduce(
                (sum, value) => sum + Number(value || 0),
                0,
            ),
            totalLaggedMaturity: laggedSeries.reduce(
                (sum, value) => sum + (value == null ? 0 : Number(value || 0)),
                0,
            ),
        };
    }

    function updateReadingImpactKpis(data) {
        const cardsPer10kEl = document.getElementById('readingImpactCardsPer10kChars');
        const maturityYieldEl = document.getElementById('readingImpactMaturityYield');
        const maturityYieldLabel = document.getElementById('readingImpactMaturityYieldLabel');
        const maturityYieldItem = document.getElementById('readingImpactMaturityYieldItem');
        const tokenizationMessage = document.getElementById('readingImpactTokenizationMessage');
        const readingImpactRollupYieldHeader = document.getElementById(
            'readingImpactRollupYieldHeader',
        );
        const metricLabel = getReadingImpactMetricLabel();
        const lagWeeks = Number(data.lag_weeks || 3);

        const totals = getReadingImpactTotals(data);
        const cardsPer10k =
            totals.totalReadingChars > 0
                ? (totals.totalCards / totals.totalReadingChars) * 10000
                : 0;
        const maturityPer100k =
            totals.totalReadingChars > 0
                ? (totals.totalLaggedMaturity / totals.totalReadingChars) * 100000
                : 0;

        if (cardsPer10kEl) {
            cardsPer10kEl.textContent = Number.isFinite(cardsPer10k)
                ? cardsPer10k.toFixed(1)
                : '0.0';
        }

        const maturityEnabled =
            Boolean(data.tokenization_enabled) && hasReadingImpactLaggedData(data);

        if (maturityYieldLabel) {
            maturityYieldLabel.textContent = getReadingImpactYieldLabel();
        }
        if (readingImpactRollupYieldHeader) {
            readingImpactRollupYieldHeader.textContent = getReadingImpactYieldLabel();
            readingImpactRollupYieldHeader.title = getReadingImpactYieldMetricTooltip(metricLabel, lagWeeks);
        }

        if (maturityYieldItem) {
            maturityYieldItem.style.display = maturityEnabled ? '' : 'none';
            maturityYieldItem.title = getReadingImpactYieldMetricTooltip(metricLabel, lagWeeks);
        }

        if (maturityYieldEl) {
            maturityYieldEl.textContent =
                maturityEnabled && Number.isFinite(maturityPer100k)
                    ? maturityPer100k.toFixed(1)
                    : '—';
        }

        if (tokenizationMessage) {
            tokenizationMessage.style.display = data.tokenization_enabled ? 'none' : 'block';
        }
    }

    function renderReadingImpactImmediateChart(data) {
        const canvas = document.getElementById('readingImpactImmediateChart');
        const labels = (data.labels || []).map(formatWeekLabel);
        const hasImmediateData =
            (data.reading_chars || []).some((value) => Number(value || 0) > 0) ||
            (data.cards_mined || []).some((value) => Number(value || 0) > 0);

        destroyChartInstance(readingImpactState.charts.immediate);
        readingImpactState.charts.immediate = null;

        if (!canvas || !hasImmediateData) {
            setChartVisibility(
                'readingImpactImmediateChart',
                'readingImpactImmediateEmpty',
                false,
                'No GSM reading or mining data is available for the selected date range.',
            );
            return;
        }

        setChartVisibility('readingImpactImmediateChart', 'readingImpactImmediateEmpty', true);
        const palette = getReadingImpactPalette();
        readingImpactState.charts.immediate = new Chart(canvas, {
            data: {
                labels,
                datasets: [
                    {
                        type: 'bar',
                        label: 'Reading chars',
                        data: data.reading_chars || [],
                        backgroundColor: palette.chars + '99',
                        borderColor: palette.chars,
                        borderWidth: 1,
                        yAxisID: 'y',
                    },
                    {
                        type: 'line',
                        label: 'Cards mined',
                        data: data.cards_mined || [],
                        borderColor: palette.cards,
                        backgroundColor: palette.cards,
                        yAxisID: 'yCount',
                        tension: 0.25,
                        pointRadius: 3,
                        pointHoverRadius: 5,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: (value) => formatCompactNumber(value, 0),
                        },
                        grid: { color: palette.grid },
                    },
                    yCount: {
                        beginAtZero: true,
                        position: 'right',
                        grid: { drawOnChartArea: false },
                    },
                    x: {
                        grid: { display: false },
                    },
                },
                plugins: {
                    legend: { labels: { color: palette.text } },
                    tooltip: {
                        callbacks: {
                            label(context) {
                                if (context.dataset.label === 'Reading chars') {
                                    return (
                                        'Reading chars: ' +
                                        Number(context.raw || 0).toLocaleString()
                                    );
                                }
                                return 'Cards mined: ' + Number(context.raw || 0).toLocaleString();
                            },
                        },
                    },
                },
            },
        });
    }

    function renderReadingImpactRollupTable(data, { resetPage = true } = {}) {
        const labels = Array.isArray(data.labels) ? data.labels : [];
        const lagWeeks = Number(data.lag_weeks || 3);
        const maturityEnabled =
            Boolean(data.tokenization_enabled) && hasReadingImpactLaggedData(data);
        const metricLabel = getReadingImpactMetricLabel();

        const rows = labels
            .map((label, index) => {
                const readingChars = Number(data.reading_chars?.[index] || 0);
                const cardsMined = Number(data.cards_mined?.[index] || 0);
                const matureWords = data.lagged_mature_words?.[index];
                const matureKanji = data.lagged_mature_kanji?.[index];
                const metricValue =
                    readingImpactState.metric === 'kanji' ? matureKanji : matureWords;
                const outcomeLabel = labels[index + lagWeeks] || null;
                const yieldPer100k =
                    readingChars > 0 && metricValue !== null && metricValue !== undefined
                        ? (Number(metricValue || 0) / readingChars) * 100000
                        : null;
                const yieldTooltip = getReadingImpactYieldTooltip({
                    metricLabel,
                    sourceLabel: label,
                    outcomeLabel,
                    readingChars,
                    metricValue,
                    lagWeeks,
                });

                return {
                    sourceLabel: label,
                    outcomeLabel,
                    readingChars,
                    cardsMined,
                    matureWords: matureWords == null ? null : Number(matureWords || 0),
                    matureKanji: matureKanji == null ? null : Number(matureKanji || 0),
                    yieldPer100k,
                    yieldTooltip,
                };
            })
            .filter((row) => {
                if (row.readingChars > 0 || row.cardsMined > 0) {
                    return true;
                }
                return row.matureWords != null || row.matureKanji != null;
            })
            .reverse();

        if (!maturityEnabled || rows.length === 0) {
            setPaginatedAnkiTableData(
                paginatedAnkiTables.readingImpactRollup,
                [],
                data.tokenization_enabled
                    ? 'Not enough mature-card history is available to build the weekly rollup yet.'
                    : 'Tokenization is required for the mature-outcomes rollup.',
                { resetPage },
            );
            return;
        }

        setPaginatedAnkiTableData(paginatedAnkiTables.readingImpactRollup, rows, undefined, {
            resetPage,
        });
    }

    function renderReadingImpactPipelineChart(data) {
        const canvas = document.getElementById('readingImpactPipelineChart');
        const metricLabel = getReadingImpactMetricLabel();
        const laggedSeries = getReadingImpactMaturitySeries(data);
        const hasLaggedData =
            Array.isArray(laggedSeries) && laggedSeries.some((value) => Number(value || 0) > 0);

        destroyChartInstance(readingImpactState.charts.pipeline);
        readingImpactState.charts.pipeline = null;

        if (!canvas || !data.tokenization_enabled || !hasLaggedData) {
            const message = data.tokenization_enabled
                ? 'Not enough maturity data is available to build the lagged pipeline yet.'
                : 'Tokenization is required for the lagged learning pipeline.';
            setChartVisibility(
                'readingImpactPipelineChart',
                'readingImpactPipelineEmpty',
                false,
                message,
            );
            return;
        }

        setChartVisibility('readingImpactPipelineChart', 'readingImpactPipelineEmpty', true);
        const palette = getReadingImpactPalette();
        readingImpactState.charts.pipeline = new Chart(canvas, {
            data: {
                labels: (data.labels || []).map(formatWeekLabel),
                datasets: [
                    {
                        type: 'bar',
                        label: 'Reading chars',
                        data: data.reading_chars || [],
                        backgroundColor: palette.chars + '99',
                        borderColor: palette.chars,
                        borderWidth: 1,
                        yAxisID: 'yChars',
                    },
                    {
                        type: 'line',
                        label: 'Cards mined',
                        data: data.cards_mined || [],
                        borderColor: palette.cards,
                        backgroundColor: palette.cards,
                        yAxisID: 'yCount',
                        tension: 0.25,
                        pointRadius: 3,
                    },
                    {
                        type: 'line',
                        label: metricLabel + ' (aligned +3w)',
                        data: laggedSeries,
                        borderColor: palette.maturity,
                        backgroundColor: palette.maturity,
                        yAxisID: 'yCount',
                        tension: 0.25,
                        pointRadius: 3,
                        spanGaps: false,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    yChars: {
                        beginAtZero: true,
                        grid: { color: palette.grid },
                        ticks: {
                            callback: (value) => formatCompactNumber(value, 0),
                        },
                    },
                    yCount: {
                        beginAtZero: true,
                        position: 'right',
                        grid: { drawOnChartArea: false },
                    },
                    x: {
                        grid: { display: false },
                    },
                },
                plugins: {
                    legend: { labels: { color: palette.text } },
                    tooltip: {
                        callbacks: {
                            label(context) {
                                if (context.dataset.label === 'Reading chars') {
                                    return (
                                        'Reading chars: ' +
                                        Number(context.raw || 0).toLocaleString()
                                    );
                                }
                                return (
                                    context.dataset.label +
                                    ': ' +
                                    Number(context.raw || 0).toLocaleString()
                                );
                            },
                        },
                    },
                },
            },
        });
    }

    function renderReadingImpact(data) {
        readingImpactState.data = data;
        updateReadingImpactToggleButtons();
        updateReadingImpactKpis(data);
        renderReadingImpactImmediateChart(data);
        renderReadingImpactPipelineChart(data);
        renderReadingImpactRollupTable(data);
    }

    function resetReadingImpactState(message = 'Failed to load reading impact data.') {
        Object.values(readingImpactState.charts).forEach(destroyChartInstance);
        readingImpactState.charts = {
            immediate: null,
            pipeline: null,
        };
        readingImpactState.data = null;

        const cardsPer10kEl = document.getElementById('readingImpactCardsPer10kChars');
        const maturityYieldEl = document.getElementById('readingImpactMaturityYield');
        const tokenizationMessage = document.getElementById('readingImpactTokenizationMessage');
        const maturityYieldItem = document.getElementById('readingImpactMaturityYieldItem');
        if (cardsPer10kEl) cardsPer10kEl.textContent = '—';
        if (maturityYieldEl) maturityYieldEl.textContent = '—';
        if (maturityYieldItem) maturityYieldItem.style.display = '';
        if (tokenizationMessage) {
            tokenizationMessage.style.display = 'block';
            tokenizationMessage.textContent = message;
        }

        setPaginatedAnkiTableData(paginatedAnkiTables.readingImpactRollup, [], message);

        setChartVisibility(
            'readingImpactImmediateChart',
            'readingImpactImmediateEmpty',
            false,
            message,
        );
        setChartVisibility(
            'readingImpactPipelineChart',
            'readingImpactPipelineEmpty',
            false,
            message,
        );
    }
    function showLoading(show) {
        loading.style.display = show ? '' : 'none';
    }
    function showError(show) {
        error.style.display = show ? '' : 'none';
    }

    function showReadingImpactLoading(show) {
        const readingImpactLoading = document.getElementById('readingImpactLoading');
        if (readingImpactLoading) {
            readingImpactLoading.style.display = show ? 'flex' : 'none';
        }
    }

    function renderPaginatedAnkiTable(config) {
        const tbody = document.getElementById(config.bodyId);
        const empty = document.getElementById(config.emptyId);
        const pagination = document.getElementById(config.paginationId);
        const prev = document.getElementById(config.prevId);
        const next = document.getElementById(config.nextId);
        const info = document.getElementById(config.infoId);

        if (!tbody || !empty || !pagination || !prev || !next || !info) {
            return;
        }

        if (!config.items.length) {
            tbody.innerHTML = '';
            empty.textContent = config.currentEmptyText;
            empty.style.display = 'block';
            pagination.style.display = 'none';
            info.textContent = '';
            prev.disabled = true;
            next.disabled = true;
            return;
        }

        empty.style.display = 'none';

        const totalPages = Math.ceil(config.items.length / config.pageSize);
        config.page = Math.max(0, Math.min(config.page, totalPages - 1));

        const startIndex = config.page * config.pageSize;
        const endIndex = Math.min(startIndex + config.pageSize, config.items.length);

        tbody.innerHTML = '';
        const fragment = document.createDocumentFragment();
        config.items.slice(startIndex, endIndex).forEach((item) => {
            fragment.appendChild(config.buildRow(item));
        });
        tbody.appendChild(fragment);

        pagination.style.display = 'flex';
        prev.disabled = config.page === 0;
        next.disabled = config.page >= totalPages - 1;
        info.textContent =
            totalPages > 1
                ? `Showing ${startIndex + 1}-${endIndex} of ${config.items.length} ${config.itemLabel} · Page ${config.page + 1} of ${totalPages}`
                : `Showing ${config.items.length} ${config.itemLabel}`;
    }

    function setPaginatedAnkiTableData(
        config,
        items,
        emptyText = config.defaultEmptyText,
        { resetPage = true } = {},
    ) {
        config.items = items;
        if (resetPage) {
            config.page = 0;
        }
        config.currentEmptyText = emptyText;
        renderPaginatedAnkiTable(config);
    }

    function initializePaginatedAnkiTableControls(config) {
        const prev = document.getElementById(config.prevId);
        const next = document.getElementById(config.nextId);

        if (prev) {
            prev.addEventListener('click', () => {
                if (config.page === 0) return;
                config.page -= 1;
                renderPaginatedAnkiTable(config);
            });
        }

        if (next) {
            next.addEventListener('click', () => {
                const totalPages = Math.ceil(config.items.length / config.pageSize);
                if (config.page >= totalPages - 1) return;
                config.page += 1;
                renderPaginatedAnkiTable(config);
            });
        }
    }

    Object.values(paginatedAnkiTables).forEach(initializePaginatedAnkiTableControls);

    const MISSING_KANJI_GRID_MIN_FREQUENCY = 10;

    // Initialize Kanji Grid Renderer (using shared component)
    const kanjiGridRenderer = new KanjiGridRenderer({
        containerSelector: '#missingKanjiGrid',
        counterSelector: '#missingKanjiCount',
        colorMode: 'frequency',
        emptyMessage:
            `🎉 No missing kanji with frequency ${MISSING_KANJI_GRID_MIN_FREQUENCY}+ in your configured Anki word field.`,
    });

    // Function to render kanji grid (now using shared renderer)
    function renderKanjiGrid(kanjiList) {
        kanjiGridRenderer.render(Array.isArray(kanjiList) ? kanjiList : []);
    }

    function updateStats(data) {
        const safeData = data && typeof data === 'object' ? data : {};
        const missingKanji = Array.isArray(safeData.missing_kanji) ? safeData.missing_kanji : [];
        const missingKanjiForGrid = missingKanji.filter(
            (entry) => Number(entry?.frequency || 0) >= MISSING_KANJI_GRID_MIN_FREQUENCY,
        );
        const ankiKanjiCount = Number(safeData.anki_kanji_count || 0);
        const gsmKanjiCount = Number(safeData.gsm_kanji_count || 0);

        // Remove loading skeletons and update values
        if (ankiTotalKanji) {
            ankiTotalKanji.textContent = Number.isFinite(ankiKanjiCount)
                ? ankiKanjiCount.toLocaleString()
                : '0';
        }
        if (gsmTotalKanji) {
            gsmTotalKanji.textContent = Number.isFinite(gsmKanjiCount)
                ? gsmKanjiCount.toLocaleString()
                : '0';
        }
        if (ankiCoverage) {
            const percent = Number.isFinite(Number(safeData.coverage_percent))
                ? Number(safeData.coverage_percent)
                : 0;
            ankiCoverage.textContent = percent.toFixed(1) + '%';
        }
        if (missingKanjiCount) {
            missingKanjiCount.textContent = String(missingKanji.length);
        }
        renderKanjiGrid(missingKanjiForGrid);
    }

    function getUnixTimestampsInMilliseconds(startDate, endDate) {
        // Parse the start date and create a Date object at the beginning of the day
        const start = new Date(startDate + 'T00:00:00');
        const startTimestamp = start.getTime();

        // Parse the end date and create a Date object at the end of the day
        const end = new Date(endDate + 'T23:59:59.999');
        const endTimestamp = end.getTime();

        return { startTimestamp, endTimestamp };
    }

    function buildCombinedAnkiStatsQueryString(
        start_timestamp = null,
        end_timestamp = null,
        { includeEarliestDate = false, sections = ANKI_STATS_INITIAL_SECTIONS } = {},
    ) {
        const params = new URLSearchParams();
        const requestedSections = includeEarliestDate
            ? ['earliest_date', ...sections]
            : sections;
        params.set('sections', Array.from(new Set(requestedSections)).join(','));
        if (start_timestamp !== null && start_timestamp !== undefined) {
            params.set('start_timestamp', String(start_timestamp));
        }
        if (end_timestamp !== null && end_timestamp !== undefined) {
            params.set('end_timestamp', String(end_timestamp));
        }
        return `?${params.toString()}`;
    }

    function renderKanjiStatsLoadError() {
        if (missingKanjiCount) missingKanjiCount.textContent = 'Error';
        if (ankiTotalKanji) ankiTotalKanji.textContent = '–';
        if (gsmTotalKanji) gsmTotalKanji.textContent = '–';
        if (ankiCoverage) ankiCoverage.textContent = '–';
        renderKanjiGrid([]);
    }

    function renderGameStatsLoadError() {
        setPaginatedAnkiTableData(
            paginatedAnkiTables.cardsPerGame,
            [],
            'Failed to load card statistics. Make sure Anki is running with AnkiConnect.',
        );
        setPaginatedAnkiTableData(
            paginatedAnkiTables.gameStats,
            [],
            'Failed to load game statistics. Make sure Anki is running with AnkiConnect.',
        );
        renderCollectionOverview(null);
    }

    function renderReadingImpactLoadError() {
        resetReadingImpactState(
            'Failed to load reading impact data. GSM reading and Anki data may be unavailable for this range.',
        );
    }

    function renderReadingImpactSection(readingImpact) {
        if (readingImpact) {
            renderReadingImpact(readingImpact);
        } else {
            renderReadingImpactLoadError();
        }
    }

    function renderCombinedAnkiStats(data, { includeReadingImpact = true } = {}) {
        const kanjiStats =
            data?.kanji_stats && typeof data.kanji_stats === 'object' ? data.kanji_stats : {};
        const gameStats = Array.isArray(data?.game_stats) ? data.game_stats : [];
        const readingImpact =
            data?.reading_impact &&
            typeof data.reading_impact === 'object' &&
            Array.isArray(data.reading_impact.labels)
                ? data.reading_impact
                : null;

        updateStats(kanjiStats);
        renderCardsPerGameTable(gameStats);
        renderGameStatsTable(gameStats);
        renderCollectionOverview(gameStats);

        if (includeReadingImpact) {
            renderReadingImpactSection(readingImpact);
        }
    }

    function clearDeferredReadingImpactLoad() {
        if (deferredReadingImpactLoadHandle == null) {
            return;
        }

        if (typeof deferredReadingImpactLoadHandle === 'number') {
            window.clearTimeout(deferredReadingImpactLoadHandle);
        } else if (typeof window.cancelIdleCallback === 'function') {
            window.cancelIdleCallback(deferredReadingImpactLoadHandle);
        }

        deferredReadingImpactLoadHandle = null;
    }

    async function loadReadingImpact(start_timestamp = null, end_timestamp = null) {
        const requestId = ++readingImpactRequestId;
        showReadingImpactLoading(true);

        try {
            const queryString = buildCombinedAnkiStatsQueryString(start_timestamp, end_timestamp, {
                sections: ANKI_STATS_DEFERRED_SECTIONS,
            });
            const resp = await fetchAnkiApi(`/api/anki_stats_combined${queryString}`);
            if (!resp.ok) {
                throw new Error(`Failed to load reading impact (HTTP ${resp.status})`);
            }

            const data = await resp.json();
            if (requestId !== readingImpactRequestId) {
                return null;
            }

            const readingImpact =
                data?.reading_impact &&
                typeof data.reading_impact === 'object' &&
                Array.isArray(data.reading_impact.labels)
                    ? data.reading_impact
                    : null;
            renderReadingImpactSection(readingImpact);
            return data;
        } catch (e) {
            if (requestId === readingImpactRequestId) {
                console.error('Failed to load reading impact:', e);
                renderReadingImpactLoadError();
            }
            return null;
        } finally {
            if (requestId === readingImpactRequestId) {
                showReadingImpactLoading(false);
            }
        }
    }

    function scheduleReadingImpactLoad(start_timestamp = null, end_timestamp = null) {
        clearDeferredReadingImpactLoad();

        const runLoad = () => {
            deferredReadingImpactLoadHandle = null;
            void loadReadingImpact(start_timestamp, end_timestamp);
        };

        if (typeof window.requestIdleCallback === 'function') {
            deferredReadingImpactLoadHandle = window.requestIdleCallback(runLoad, {
                timeout: DEFERRED_READING_IMPACT_TIMEOUT_MS,
            });
            return;
        }

        deferredReadingImpactLoadHandle = window.setTimeout(runLoad, 0);
    }

    // Combined data loading function - fetches the core startup payload in one request
    async function loadAllStats(
        start_timestamp = null,
        end_timestamp = null,
        { includeEarliestDate = false } = {},
    ) {
        showLoading(true);
        showError(false);
        clearDeferredReadingImpactLoad();
        readingImpactRequestId += 1;

        // Show all loading spinners
        const cardsPerGameLoading = document.getElementById('cardsPerGameLoading');
        const gameStatsLoading = document.getElementById('gameStatsLoading');
        const nsfwSfwRetentionLoading = document.getElementById('nsfwSfwRetentionLoading');
        if (cardsPerGameLoading) cardsPerGameLoading.style.display = 'flex';
        if (gameStatsLoading) gameStatsLoading.style.display = 'flex';
        if (nsfwSfwRetentionLoading) nsfwSfwRetentionLoading.style.display = 'flex';
        showReadingImpactLoading(true);

        let keepReadingImpactLoading = false;

        try {
            const queryString = buildCombinedAnkiStatsQueryString(start_timestamp, end_timestamp, {
                includeEarliestDate,
            });
            const resp = await fetchAnkiApi(`/api/anki_stats_combined${queryString}`);
            if (!resp.ok)
                throw new Error(`Failed to load combined Anki stats (HTTP ${resp.status})`);
            const data = await resp.json();
            renderCombinedAnkiStats(data, { includeReadingImpact: false });
            showAnkiConnectWarning(false);
            scheduleReadingImpactLoad(start_timestamp, end_timestamp);
            keepReadingImpactLoading = true;
            return data;
        } catch (e) {
            console.error('Failed to load combined Anki stats:', e);
            clearDeferredReadingImpactLoad();
            readingImpactRequestId += 1;
            renderKanjiStatsLoadError();
            renderGameStatsLoadError();
            renderReadingImpactLoadError();
            showAnkiConnectWarning(true);
            return null;
        } finally {
            showLoading(false);
            // Hide loading spinners
            if (cardsPerGameLoading) cardsPerGameLoading.style.display = 'none';
            if (gameStatsLoading) gameStatsLoading.style.display = 'none';
            if (nsfwSfwRetentionLoading) nsfwSfwRetentionLoading.style.display = 'none';
            if (!keepReadingImpactLoading) {
                showReadingImpactLoading(false);
            }

            // Show tables/grids
            const cardsPerGameTable = document.getElementById('cardsPerGameTable');
            const gameStatsTable = document.getElementById('gameStatsTable');
            const nsfwSfwRetentionStats = document.getElementById('nsfwSfwRetentionStats');
            if (cardsPerGameTable) cardsPerGameTable.style.display = 'table';
            if (gameStatsTable) gameStatsTable.style.display = 'table';
            if (nsfwSfwRetentionStats) nsfwSfwRetentionStats.style.display = 'grid';
        }
    }

    async function loadNsfwSfwRetention(queryString) {
        try {
            const resp = await fetchAnkiApi(`/api/anki_nsfw_sfw_retention${queryString}`);
            if (!resp.ok) throw new Error('Failed to load NSFW/SFW retention');
            const data = await resp.json();
            console.log('Received NSFW/SFW retention data:', data);
            renderNsfwSfwRetention(data);
        } catch (e) {
            console.error('Failed to load NSFW/SFW retention:', e);
            const nsfwSfwRetentionEmpty = document.getElementById('nsfwSfwRetentionEmpty');
            if (nsfwSfwRetentionEmpty) {
                nsfwSfwRetentionEmpty.style.display = 'block';
                nsfwSfwRetentionEmpty.textContent =
                    'Failed to load retention statistics. Make sure Anki is running with AnkiConnect.';
            }
        }
    }

    async function loadMiningHeatmap(queryString) {
        const container = document.getElementById('miningHeatmapContainer');
        if (!container) {
            console.debug('miningHeatmapContainer not found on this page, skipping');
            return;
        }
        try {
            const resp = await fetchAnkiApi(`/api/anki_mining_heatmap${queryString}`);
            if (!resp.ok) throw new Error('Failed to load mining heatmap');
            const data = await resp.json();
            console.log('Received mining heatmap data:', data);

            if (data && Object.keys(data).length > 0) {
                createMiningHeatmap(data);
            } else {
                container.innerHTML =
                    '<p style="text-align: center; color: var(--text-tertiary); padding: 20px;">No mining data available for the selected date range.</p>';
            }
        } catch (e) {
            console.error('Failed to load mining heatmap:', e);
            container.innerHTML =
                '<p style="text-align: center; color: var(--text-tertiary); padding: 20px;">Failed to load mining heatmap.</p>';
        }
    }

    async function initializeDates() {
        const fromDateInput = document.getElementById('fromDate');
        const toDateInput = document.getElementById('toDate');

        const fromDate = sessionStorage.getItem('fromDateAnki');
        const toDate = sessionStorage.getItem('toDateAnki');

        if (!(fromDate && toDate)) {
            const today = new Date();
            const todayStr = today.toLocaleDateString('en-CA');
            try {
                const initialData = await loadAllStats(null, null, { includeEarliestDate: true });
                const earliestDateMs = Number(initialData?.earliest_date || 0);
                const initialFromDate =
                    earliestDateMs > 0
                        ? new Date(earliestDateMs * 1000).toLocaleDateString('en-CA')
                        : todayStr;

                fromDateInput.value = initialFromDate;
                toDateInput.value = todayStr;
                sessionStorage.setItem('fromDateAnki', initialFromDate);
                sessionStorage.setItem('toDateAnki', todayStr);
            } catch (e) {
                console.error('Failed to initialize dates:', e);
                fromDateInput.value = todayStr;
                toDateInput.value = todayStr;
                sessionStorage.setItem('fromDateAnki', todayStr);
                sessionStorage.setItem('toDateAnki', todayStr);
            }
            scheduleWordsNotInAnkiLoad({ defer: true });
        } else {
            fromDateInput.value = fromDate;
            toDateInput.value = toDate;
            const { startTimestamp, endTimestamp } = getUnixTimestampsInMilliseconds(
                fromDate,
                toDate,
            );
            await loadAllStats(startTimestamp, endTimestamp);
            scheduleWordsNotInAnkiLoad({ defer: true });
        }
    }

    function handleDateChange() {
        const fromDateStr = fromDateInput.value;
        const toDateStr = toDateInput.value;

        sessionStorage.setItem('fromDateAnki', fromDateStr);
        sessionStorage.setItem('toDateAnki', toDateStr);

        // Validate date order
        if (fromDateStr && toDateStr && new Date(fromDateStr) > new Date(toDateStr)) {
            const popup = document.getElementById('dateErrorPopup');
            if (popup) popup.classList.remove('hidden');
            return;
        }

        const { startTimestamp, endTimestamp } = getUnixTimestampsInMilliseconds(
            fromDateStr,
            toDateStr,
        );

        loadAllStats(startTimestamp, endTimestamp);
        scheduleWordsNotInAnkiLoad({ defer: true });
    }

    fromDateInput.addEventListener('change', handleDateChange);
    toDateInput.addEventListener('change', handleDateChange);

    initializeDates();

    function renderCollectionOverview(gameStats) {
        const totalCardsEl = document.getElementById('overviewTotalCards');
        const totalReviewsEl = document.getElementById('overviewTotalReviews');
        const reviewTimeEl = document.getElementById('overviewReviewTime');
        const retentionEl = document.getElementById('overviewRetention');
        const emptyEl = document.getElementById('collectionOverviewEmpty');
        const statsGrid = document.getElementById('collectionOverviewStats');

        if (!gameStats || gameStats.length === 0) {
            if (totalCardsEl) totalCardsEl.innerHTML = '0';
            if (totalReviewsEl) totalReviewsEl.innerHTML = '0';
            if (reviewTimeEl) reviewTimeEl.innerHTML = '0s';
            if (retentionEl) {
                retentionEl.innerHTML = 'N/A';
                retentionEl.style.color = 'var(--text-tertiary)';
            }
            if (emptyEl) emptyEl.style.display = 'block';
            if (statsGrid) statsGrid.style.display = 'none';
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';
        if (statsGrid) statsGrid.style.display = '';

        let totalCards = 0;
        let totalReviews = 0;
        let weightedRetentionSum = 0;
        let totalReviewTimeSec = 0;

        gameStats.forEach((game) => {
            totalCards += game.card_count || 0;
            totalReviews += game.total_reviews || 0;
            // avg_time_per_card is in seconds, total_reviews is count
            totalReviewTimeSec += (game.avg_time_per_card || 0) * (game.total_reviews || 0);
            // Weight retention by number of reviews for that game
            weightedRetentionSum += (game.retention_pct || 0) * (game.total_reviews || 0);
        });

        const overallRetention = totalReviews > 0 ? weightedRetentionSum / totalReviews : 0;

        if (totalCardsEl) totalCardsEl.innerHTML = totalCards.toLocaleString();
        if (totalReviewsEl) totalReviewsEl.innerHTML = totalReviews.toLocaleString();
        if (reviewTimeEl) reviewTimeEl.innerHTML = formatDuration(totalReviewTimeSec);
        if (retentionEl) {
            retentionEl.innerHTML = overallRetention.toFixed(1) + '%';
            retentionEl.style.color = getRetentionColor(overallRetention);
        }
    }

    function formatDuration(totalSeconds) {
        if (totalSeconds < 60) {
            return totalSeconds.toFixed(0) + 's';
        } else if (totalSeconds < 3600) {
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = Math.floor(totalSeconds % 60);
            return `${minutes}m ${seconds}s`;
        } else {
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            return `${hours}h ${minutes}m`;
        }
    }

    function renderCardsPerGameTable(gameStats) {
        const sortedStats = Array.isArray(gameStats)
            ? [...gameStats].sort((a, b) => (b.card_count || 0) - (a.card_count || 0))
            : [];
        setPaginatedAnkiTableData(paginatedAnkiTables.cardsPerGame, sortedStats);
    }

    function renderGameStatsTable(gameStats) {
        const stats = Array.isArray(gameStats) ? [...gameStats] : [];
        setPaginatedAnkiTableData(paginatedAnkiTables.gameStats, stats);
    }

    function getRetentionColor(retention) {
        if (retention >= 80) {
            return 'var(--success-color, #2ecc71)';
        } else if (retention >= 70) {
            return 'var(--warning-color, #f39c12)';
        } else {
            return 'var(--danger-color, #e74c3c)';
        }
    }

    function formatTime(seconds) {
        if (seconds < 1) {
            return (seconds * 1000).toFixed(0) + 'ms';
        } else if (seconds < 60) {
            return seconds.toFixed(1) + 's';
        } else {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = Math.floor(seconds % 60);
            return `${minutes}m ${remainingSeconds}s`;
        }
    }

    // Note: Old individual loading functions (loadGameStats, loadNsfwSfwRetention, loadStats, loadMiningHeatmap)
    // have been replaced by the unified loadAllStats function for better performance

    function renderNsfwSfwRetention(data) {
        const nsfwRetentionEl = document.getElementById('nsfwRetention');
        const sfwRetentionEl = document.getElementById('sfwRetention');
        const nsfwReviewsEl = document.getElementById('nsfwReviews');
        const sfwReviewsEl = document.getElementById('sfwReviews');
        const nsfwAvgTimeEl = document.getElementById('nsfwAvgTime');
        const sfwAvgTimeEl = document.getElementById('sfwAvgTime');
        const nsfwSfwRetentionEmpty = document.getElementById('nsfwSfwRetentionEmpty');

        // Check if we have any data
        if (data.nsfw_reviews === 0 && data.sfw_reviews === 0) {
            nsfwSfwRetentionEmpty.style.display = 'block';
            document.getElementById('nsfwSfwRetentionStats').style.display = 'none';
            return;
        }

        nsfwSfwRetentionEmpty.style.display = 'none';

        // Update NSFW retention (remove skeleton and set content)
        if (data.nsfw_reviews > 0) {
            nsfwRetentionEl.innerHTML = data.nsfw_retention + '%';
            nsfwRetentionEl.style.color = getRetentionColor(data.nsfw_retention);
            nsfwReviewsEl.textContent = data.nsfw_reviews + ' reviews';
            nsfwAvgTimeEl.innerHTML = formatTime(data.nsfw_avg_time);
            nsfwAvgTimeEl.style.color = 'var(--text-primary)';
        } else {
            nsfwRetentionEl.innerHTML = 'N/A';
            nsfwRetentionEl.style.color = 'var(--text-tertiary)';
            nsfwReviewsEl.textContent = 'No reviews';
            nsfwAvgTimeEl.innerHTML = 'N/A';
            nsfwAvgTimeEl.style.color = 'var(--text-tertiary)';
        }

        // Update SFW retention (remove skeleton and set content)
        if (data.sfw_reviews > 0) {
            sfwRetentionEl.innerHTML = data.sfw_retention + '%';
            sfwRetentionEl.style.color = getRetentionColor(data.sfw_retention);
            sfwReviewsEl.textContent = data.sfw_reviews + ' reviews';
            sfwAvgTimeEl.innerHTML = formatTime(data.sfw_avg_time);
            sfwAvgTimeEl.style.color = 'var(--text-primary)';
        } else {
            sfwRetentionEl.innerHTML = 'N/A';
            sfwRetentionEl.style.color = 'var(--text-tertiary)';
            sfwReviewsEl.textContent = 'No reviews';
            sfwAvgTimeEl.innerHTML = 'N/A';
            sfwAvgTimeEl.style.color = 'var(--text-tertiary)';
        }
    }

    // Note: NSFW/SFW retention stats are now loaded via the unified loadAllStats function
    // which is triggered by the "datesSetAnki" event listener above (line 218-225)

    // ================================================================
    // Words Not In Anki — searchable, sortable, paginated table
    // ================================================================
    const WORDS_NOT_IN_ANKI_TIMEOUT_MS = 15000;
    const wordsNotInAnkiDefaultEmptyText =
        document.getElementById('wordsNotInAnkiEmpty')?.textContent?.trim() ||
        'No words found. Either all words are in Anki or tokenization is not enabled.';
    const WORDS_NOT_IN_ANKI_DEFAULTS = {
        sort: 'frequency',
        order: 'desc',
        offset: 0,
        limit: 50,
        search: '',
        pos: '',
        excludePos: '',
        vocabOnly: true,
        hasMissingAnkiKanji: false,
        scriptFilter: 'all',
        selectedGameIds: null,
        frequencyMin: null,
        frequencyMax: null,
        globalRankMin: null,
        globalRankMax: null,
    };
    const wordsNotInAnki = {
        ...WORDS_NOT_IN_ANKI_DEFAULTS,
        availableGames: [],
        isLoadingGames: false,
        hasLoadedGames: false,
        gameLoadError: false,
        frequencyBounds: { min: null, max: null },
        globalRankBounds: { min: null, max: null },
        globalRankSource: null,
        total: 0,
        debounceTimer: null,
        requestId: 0,
        listRequest: null,
        exportRequest: null,
        pendingVisibleLoad: false,
        visibilityObserver: null,
    };
    const wordDetailLinesDefaultEmptyText =
        document.getElementById('wordDetailLinesEmpty')?.textContent?.trim() ||
        'No tokenized example lines found for this word.';
    const wordDetailGamesDefaultEmptyText =
        document.getElementById('wordDetailGamesEmpty')?.textContent?.trim() ||
        'No per-game frequency data available for this word.';
    const wordDetail = {
        requestId: 0,
        word: '',
        detailRequest: null,
        searchRequest: null,
    };

    function createTimedRequest(timeoutMs) {
        const controller = new AbortController();
        let timedOut = false;
        const timeoutId = window.setTimeout(() => {
            timedOut = true;
            controller.abort(new DOMException('Request timed out.', 'TimeoutError'));
        }, timeoutMs);
        return {
            controller,
            cleanup() {
                window.clearTimeout(timeoutId);
            },
            timedOut() {
                return timedOut;
            },
        };
    }

    function abortTimedRequest(requestHandle) {
        if (!requestHandle) return;
        requestHandle.controller.abort(new DOMException('Request cancelled.', 'AbortError'));
        requestHandle.cleanup();
    }

    function clearDeferredWordsNotInAnkiLoad() {
        if (deferredWordsNotInAnkiLoadHandle == null) {
            return;
        }
        if (typeof deferredWordsNotInAnkiLoadHandle === 'number') {
            window.clearTimeout(deferredWordsNotInAnkiLoadHandle);
        } else if (typeof window.cancelIdleCallback === 'function') {
            window.cancelIdleCallback(deferredWordsNotInAnkiLoadHandle);
        }
        deferredWordsNotInAnkiLoadHandle = null;
    }

    function isWordsNotInAnkiSectionNearViewport() {
        const section = document.getElementById('wordsNotInAnkiSection');
        if (!section) {
            return true;
        }

        const rect = section.getBoundingClientRect();
        const preloadMargin = 240;
        return rect.top <= window.innerHeight + preloadMargin && rect.bottom >= -preloadMargin;
    }

    function ensureWordsNotInAnkiVisibilityObserver() {
        if (
            wordsNotInAnki.visibilityObserver ||
            typeof window.IntersectionObserver !== 'function'
        ) {
            return;
        }

        const section = document.getElementById('wordsNotInAnkiSection');
        if (!section) {
            return;
        }

        wordsNotInAnki.visibilityObserver = new IntersectionObserver(
            (entries) => {
                const hasVisibleEntry = entries.some((entry) => entry.isIntersecting);
                if (!hasVisibleEntry || !wordsNotInAnki.pendingVisibleLoad) {
                    return;
                }

                wordsNotInAnki.pendingVisibleLoad = false;
                loadWordsNotInAnki();
            },
            {
                rootMargin: '240px 0px',
            },
        );
        wordsNotInAnki.visibilityObserver.observe(section);
    }

    function scheduleWordsNotInAnkiLoad({ defer = false } = {}) {
        clearDeferredWordsNotInAnkiLoad();
        if (!defer) {
            if (isWordsNotInAnkiSectionNearViewport()) {
                wordsNotInAnki.pendingVisibleLoad = false;
                loadWordsNotInAnki();
            } else {
                if (typeof window.IntersectionObserver !== 'function') {
                    loadWordsNotInAnki();
                    return;
                }
                wordsNotInAnki.pendingVisibleLoad = true;
                ensureWordsNotInAnkiVisibilityObserver();
            }
            return;
        }

        const runLoad = () => {
            deferredWordsNotInAnkiLoadHandle = null;
            scheduleWordsNotInAnkiLoad();
        };

        if (typeof window.requestIdleCallback === 'function') {
            deferredWordsNotInAnkiLoadHandle = window.requestIdleCallback(runLoad, {
                timeout: DEFERRED_WORDS_NOT_IN_ANKI_TIMEOUT_MS,
            });
            return;
        }

        deferredWordsNotInAnkiLoadHandle = window.setTimeout(runLoad, 250);
    }

    function getWordsNotInAnkiEmptyText() {
        if (
            hasWordsNotInAnkiCustomGameSelection() &&
            wordsNotInAnki.selectedGameIds.length === 0
        ) {
            return 'No games selected. Toggle one or more games to show results.';
        }
        if (areWordsNotInAnkiGlobalRankToolsActive()) {
            return 'No ranked words match the current filters.';
        }
        if (wordsNotInAnki.hasMissingAnkiKanji) {
            return 'No words containing kanji missing from Anki match the current filters.';
        }
        if (wordsNotInAnki.scriptFilter === 'cjk') {
            return 'No CJK words match the current filters.';
        }
        if (wordsNotInAnki.scriptFilter === 'non_cjk') {
            return 'No non-CJK words match the current filters.';
        }
        if (wordsNotInAnki.vocabOnly) {
            return 'No vocabulary words found. Try enabling grammar tokens or adjusting your filters.';
        }
        return wordsNotInAnkiDefaultEmptyText;
    }

    function getWordsNotInAnkiDateRange() {
        const fromDate = fromDateInput?.value || sessionStorage.getItem('fromDateAnki');
        const toDate = toDateInput?.value || sessionStorage.getItem('toDateAnki');
        if (!fromDate || !toDate) {
            return null;
        }
        return getUnixTimestampsInMilliseconds(fromDate, toDate);
    }

    function getWordsNotInAnkiAvailableGameIds() {
        return wordsNotInAnki.availableGames.map((game) => game.id);
    }

    function hasWordsNotInAnkiCustomGameSelection() {
        return (
            Array.isArray(wordsNotInAnki.selectedGameIds) &&
            wordsNotInAnki.availableGames.length > 0
        );
    }

    function normalizeWordsNotInAnkiSelectedGameIds(selectedGameIds) {
        if (!Array.isArray(selectedGameIds)) {
            return null;
        }

        const availableGameIds = getWordsNotInAnkiAvailableGameIds();
        if (availableGameIds.length === 0) {
            return null;
        }

        const availableGameIdSet = new Set(availableGameIds);
        const nextSelectedGameIds = [];
        const seen = new Set();
        selectedGameIds.forEach((gameId) => {
            if (!availableGameIdSet.has(gameId) || seen.has(gameId)) {
                return;
            }
            nextSelectedGameIds.push(gameId);
            seen.add(gameId);
        });

        return nextSelectedGameIds.length === availableGameIds.length
            ? null
            : nextSelectedGameIds;
    }

    function formatWordsNotInAnkiGameFilterSummary() {
        if (!wordsNotInAnki.hasLoadedGames) {
            return 'All games';
        }
        if (wordsNotInAnki.gameLoadError && !wordsNotInAnki.availableGames.length) {
            return 'Games unavailable';
        }
        if (!wordsNotInAnki.availableGames.length) {
            return 'No games';
        }
        if (!hasWordsNotInAnkiCustomGameSelection()) {
            return 'All games';
        }
        if (wordsNotInAnki.selectedGameIds.length === 0) {
            return 'No games selected';
        }
        return wordsNotInAnki.selectedGameIds.length === 1
            ? '1 game'
            : `${wordsNotInAnki.selectedGameIds.length} games`;
    }

    function updateWordsNotInAnkiGameFilterSummary() {
        const summary = document.getElementById('wordsNotInAnkiGameFilterSummary');
        if (!summary) {
            return;
        }
        summary.textContent = formatWordsNotInAnkiGameFilterSummary();
    }

    function renderWordsNotInAnkiGameFilterOptions() {
        const list = document.getElementById('wordsNotInAnkiGameFilterList');
        const selectAllButton = document.getElementById('wordsNotInAnkiGameFilterSelectAll');
        const clearAllButton = document.getElementById('wordsNotInAnkiGameFilterClearAll');
        if (!list) {
            return;
        }

        list.innerHTML = '';
        const availableGames = wordsNotInAnki.availableGames;
        const isCustomSelection = hasWordsNotInAnkiCustomGameSelection();
        const selectedGameIdSet = new Set(wordsNotInAnki.selectedGameIds || []);

        if (!wordsNotInAnki.hasLoadedGames) {
            list.innerHTML =
                '<div class="words-filter-dropdown-empty">Loading games...</div>';
        } else if (wordsNotInAnki.gameLoadError && availableGames.length === 0) {
            list.innerHTML =
                '<div class="words-filter-dropdown-empty">Could not load games.</div>';
        } else if (availableGames.length === 0) {
            list.innerHTML =
                '<div class="words-filter-dropdown-empty">No games available yet.</div>';
        } else {
            const fragment = document.createDocumentFragment();
            availableGames.forEach((game) => {
                const option = document.createElement('label');
                option.className = 'words-filter-dropdown-option';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = !isCustomSelection || selectedGameIdSet.has(game.id);
                checkbox.addEventListener('change', () => {
                    const availableGameIds = getWordsNotInAnkiAvailableGameIds();
                    let nextSelectedGameIds = Array.isArray(wordsNotInAnki.selectedGameIds)
                        ? [...wordsNotInAnki.selectedGameIds]
                        : [...availableGameIds];

                    if (checkbox.checked) {
                        if (!nextSelectedGameIds.includes(game.id)) {
                            nextSelectedGameIds.push(game.id);
                        }
                    } else {
                        nextSelectedGameIds = nextSelectedGameIds.filter(
                            (selectedGameId) => selectedGameId !== game.id,
                        );
                    }

                    wordsNotInAnki.selectedGameIds =
                        normalizeWordsNotInAnkiSelectedGameIds(nextSelectedGameIds);
                    renderWordsNotInAnkiGameFilterOptions();
                    updateWordsNotInAnkiGameFilterSummary();
                    updateWordsNotInAnkiPowerUserSummary();
                    queueWordsNotInAnkiReload();
                });

                const copy = document.createElement('span');
                copy.className = 'words-filter-dropdown-option-text';

                const title = document.createElement('span');
                title.className = 'words-filter-dropdown-option-title';
                title.textContent = game.title;

                const meta = document.createElement('span');
                meta.className = 'words-filter-dropdown-option-meta';
                meta.textContent = `${Number(game.lineCount || 0).toLocaleString()} lines`;

                copy.appendChild(title);
                copy.appendChild(meta);
                option.appendChild(checkbox);
                option.appendChild(copy);
                fragment.appendChild(option);
            });
            list.appendChild(fragment);
        }

        if (selectAllButton) {
            selectAllButton.disabled =
                availableGames.length === 0 || !hasWordsNotInAnkiCustomGameSelection();
        }
        if (clearAllButton) {
            clearAllButton.disabled =
                availableGames.length === 0 ||
                (hasWordsNotInAnkiCustomGameSelection() &&
                    wordsNotInAnki.selectedGameIds.length === 0);
        }
    }

    function setWordsNotInAnkiGameFilterOpen(isOpen) {
        const dropdown = document.getElementById('wordsNotInAnkiGameFilter');
        const toggle = document.getElementById('wordsNotInAnkiGameFilterToggle');
        const menu = document.getElementById('wordsNotInAnkiGameFilterMenu');
        if (!dropdown || !toggle || !menu) {
            return;
        }

        dropdown.classList.toggle('is-open', isOpen);
        menu.hidden = !isOpen;
        toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    async function loadWordsNotInAnkiGameOptions() {
        if (wordsNotInAnki.isLoadingGames || wordsNotInAnki.hasLoadedGames) {
            return;
        }

        wordsNotInAnki.isLoadingGames = true;
        updateWordsNotInAnkiGameFilterSummary();
        renderWordsNotInAnkiGameFilterOptions();

        try {
            const response = await fetch('/api/games-management?sort=title');
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }

            wordsNotInAnki.availableGames = Array.isArray(data.games)
                ? data.games
                      .map((game) => ({
                          id: String(game.id || ''),
                          title:
                              String(
                                  game.title_original ||
                                      game.title_romaji ||
                                      game.title_english ||
                                      game.id ||
                                      'Unknown Game',
                              ).trim() || 'Unknown Game',
                          lineCount: Number(game.line_count || 0),
                      }))
                      .filter((game) => game.id)
                : [];
            wordsNotInAnki.gameLoadError = false;
            wordsNotInAnki.hasLoadedGames = true;
            wordsNotInAnki.selectedGameIds = normalizeWordsNotInAnkiSelectedGameIds(
                wordsNotInAnki.selectedGameIds,
            );
        } catch (error) {
            console.error('Failed to load Words Not In Anki game filters:', error);
            wordsNotInAnki.availableGames = [];
            wordsNotInAnki.gameLoadError = true;
            wordsNotInAnki.hasLoadedGames = true;
            wordsNotInAnki.selectedGameIds = null;
        } finally {
            wordsNotInAnki.isLoadingGames = false;
            updateWordsNotInAnkiGameFilterSummary();
            renderWordsNotInAnkiGameFilterOptions();
            updateWordsNotInAnkiPowerUserSummary();
        }
    }

    function appendWordsNotInAnkiGameScopeParams(params) {
        if (!hasWordsNotInAnkiCustomGameSelection()) {
            return;
        }

        params.set('game_scope', 'selected');
        wordsNotInAnki.selectedGameIds.forEach((gameId) => {
            params.append('game_id', gameId);
        });
    }

    function buildWordsNotInAnkiQueryParams({ includePagination = true } = {}) {
        const params = new URLSearchParams({
            sort: wordsNotInAnki.sort,
            order: wordsNotInAnki.order,
        });

        if (includePagination) {
            params.set('limit', String(wordsNotInAnki.limit));
            params.set('offset', String(wordsNotInAnki.offset));
        }

        const dateRange = getWordsNotInAnkiDateRange();
        if (dateRange) {
            params.set('start_timestamp', String(dateRange.startTimestamp));
            params.set('end_timestamp', String(dateRange.endTimestamp));
        }

        if (wordsNotInAnki.search) params.set('search', wordsNotInAnki.search);
        if (wordsNotInAnki.pos) params.set('pos', wordsNotInAnki.pos);
        if (wordsNotInAnki.excludePos) params.set('exclude_pos', wordsNotInAnki.excludePos);
        if (wordsNotInAnki.vocabOnly) params.set('vocab_only', 'true');
        if (wordsNotInAnki.hasMissingAnkiKanji) {
            params.set('has_missing_anki_kanji', 'true');
        }
        if (wordsNotInAnki.scriptFilter !== 'all') {
            params.set('script_filter', wordsNotInAnki.scriptFilter);
        }
        const frequencyRange = getWordsNotInAnkiCustomFrequencyRange();
        if (frequencyRange) {
            params.set('frequency_min', String(frequencyRange.min));
            params.set('frequency_max', String(frequencyRange.max));
        }

        const globalRankRange = getWordsNotInAnkiCustomGlobalRankRange();
        if (globalRankRange) {
            params.set('global_rank_min', String(globalRankRange.min));
            params.set('global_rank_max', String(globalRankRange.max));
        }

        appendWordsNotInAnkiGameScopeParams(params);

        return params;
    }

    function applyWordsNotInAnkiFilterStateToControls() {
        const searchInput = document.getElementById('wordsNotInAnkiSearch');
        const scriptFilterSelect = document.getElementById('wordsNotInAnkiScriptFilter');
        const includeGrammarToggle = document.getElementById('wordsNotInAnkiIncludeGrammar');
        const hasMissingAnkiKanjiToggle = document.getElementById(
            'wordsNotInAnkiHasMissingAnkiKanji',
        );
        const posIncludeInput = document.getElementById('wordsNotInAnkiPosInclude');
        const posExcludeInput = document.getElementById('wordsNotInAnkiPosExclude');
        const pageSizeSelect = document.getElementById('wordsNotInAnkiPageSize');

        if (searchInput) searchInput.value = wordsNotInAnki.search;
        if (scriptFilterSelect) scriptFilterSelect.value = wordsNotInAnki.scriptFilter;
        if (includeGrammarToggle) includeGrammarToggle.checked = !wordsNotInAnki.vocabOnly;
        if (hasMissingAnkiKanjiToggle) {
            hasMissingAnkiKanjiToggle.checked = wordsNotInAnki.hasMissingAnkiKanji;
        }
        if (posIncludeInput) posIncludeInput.value = wordsNotInAnki.pos;
        if (posExcludeInput) posExcludeInput.value = wordsNotInAnki.excludePos;
        if (pageSizeSelect) pageSizeSelect.value = String(wordsNotInAnki.limit);
        updateWordsNotInAnkiGameFilterSummary();
        renderWordsNotInAnkiGameFilterOptions();
        updateWordsNotInAnkiPowerUserSummary();
    }

    function syncWordsNotInAnkiSortHeaders() {
        document.querySelectorAll('#wordsNotInAnkiTable .sortable-header').forEach((header) => {
            header.classList.remove('active-sort');
            const base = header.textContent.replace(/ [▲▼⇅]$/, '');
            header.textContent = base + ' ⇅';
            if (header.dataset.sort === wordsNotInAnki.sort) {
                header.classList.add('active-sort');
                header.textContent = base + (wordsNotInAnki.order === 'desc' ? ' ▼' : ' ▲');
            }
        });
    }

    function updateWordsNotInAnkiActionState() {
        const downloadButton = document.getElementById('wordsNotInAnkiDownloadCsv');
        if (downloadButton) {
            downloadButton.disabled =
                wordsNotInAnki.total <= 0 ||
                Boolean(wordsNotInAnki.exportRequest) ||
                Boolean(wordsNotInAnki.listRequest);
        }
    }

    function resetWordsNotInAnkiFilters() {
        clearTimeout(wordsNotInAnki.debounceTimer);

        Object.assign(wordsNotInAnki, WORDS_NOT_IN_ANKI_DEFAULTS);
        setWordsNotInAnkiGameFilterOpen(false);
        applyWordsNotInAnkiFilterStateToControls();
        syncWordsNotInAnkiSortHeaders();
        syncWordsNotInAnkiFrequencyControls(wordsNotInAnki.frequencyBounds);
        syncWordsNotInAnkiGlobalRankControls(
            wordsNotInAnki.globalRankBounds,
            wordsNotInAnki.globalRankSource,
        );
        loadWordsNotInAnki();
    }

    function getWordsNotInAnkiCustomRange(bounds, currentMin, currentMax) {
        if (bounds.min == null || bounds.max == null || currentMin == null || currentMax == null) {
            return null;
        }

        if (currentMin <= bounds.min && currentMax >= bounds.max) {
            return null;
        }

        return {
            min: currentMin,
            max: currentMax,
        };
    }

    function getWordsNotInAnkiCustomFrequencyRange() {
        return getWordsNotInAnkiCustomRange(
            wordsNotInAnki.frequencyBounds,
            wordsNotInAnki.frequencyMin,
            wordsNotInAnki.frequencyMax,
        );
    }

    function getWordsNotInAnkiCustomGlobalRankRange() {
        if (!wordsNotInAnki.globalRankSource) {
            return null;
        }

        return getWordsNotInAnkiCustomRange(
            wordsNotInAnki.globalRankBounds,
            wordsNotInAnki.globalRankMin,
            wordsNotInAnki.globalRankMax,
        );
    }

    function getWordsNotInAnkiPowerUserFilterCount() {
        let count = 0;

        if (wordsNotInAnki.sort === 'global_rank') count += 1;
        if (wordsNotInAnki.scriptFilter !== WORDS_NOT_IN_ANKI_DEFAULTS.scriptFilter) count += 1;
        if (wordsNotInAnki.vocabOnly !== WORDS_NOT_IN_ANKI_DEFAULTS.vocabOnly) count += 1;
        if (
            wordsNotInAnki.hasMissingAnkiKanji !==
            WORDS_NOT_IN_ANKI_DEFAULTS.hasMissingAnkiKanji
        ) {
            count += 1;
        }
        if (wordsNotInAnki.pos) count += 1;
        if (wordsNotInAnki.excludePos) count += 1;
        if (hasWordsNotInAnkiCustomGameSelection()) count += 1;
        if (getWordsNotInAnkiCustomFrequencyRange()) count += 1;
        if (wordsNotInAnki.limit !== WORDS_NOT_IN_ANKI_DEFAULTS.limit) count += 1;
        if (getWordsNotInAnkiCustomGlobalRankRange()) count += 1;

        return count;
    }

    function updateWordsNotInAnkiPowerUserSummary() {
        const summaryCount = document.getElementById('wordsNotInAnkiPowerUserSummaryCount');
        const activeCount = getWordsNotInAnkiPowerUserFilterCount();
        if (!summaryCount) {
            return;
        }

        summaryCount.textContent = activeCount > 0 ? `${activeCount} active` : 'Defaults';
    }

    function areWordsNotInAnkiGlobalRankToolsActive() {
        return (
            wordsNotInAnki.globalRankSource !== null &&
            (wordsNotInAnki.sort === 'global_rank' ||
                getWordsNotInAnkiCustomGlobalRankRange() !== null)
        );
    }

    function formatWordsNotInAnkiGlobalRankSource(source) {
        if (!source || !source.name) return 'Unavailable';
        const version = source.version ? ` (${source.version})` : '';
        return `${source.name}${version}`;
    }

    function clampWordsNotInAnkiRangeValues(bounds, currentMin, currentMax) {
        if (bounds?.min == null || bounds?.max == null) {
            return {
                bounds: { min: null, max: null },
                min: null,
                max: null,
            };
        }

        const availableMin = Number(bounds.min);
        const availableMax = Number(bounds.max);
        let nextMin = currentMin == null ? availableMin : currentMin;
        let nextMax = currentMax == null ? availableMax : currentMax;

        nextMin = Math.max(availableMin, Math.min(nextMin, availableMax));
        nextMax = Math.min(availableMax, Math.max(nextMax, nextMin));

        return {
            bounds: { min: availableMin, max: availableMax },
            min: nextMin,
            max: nextMax,
        };
    }

    function setWordsNotInAnkiRangeInputsDisabled(ids, disabled) {
        ids.forEach((id) => {
            const element = document.getElementById(id);
            if (element) {
                element.disabled = disabled;
            }
        });
    }

    function updateWordsNotInAnkiRangeFill(fillId, bounds, currentMin, currentMax) {
        const fill = document.getElementById(fillId);
        if (!fill || bounds.min == null || bounds.max == null) {
            if (fill) {
                fill.style.left = '0%';
                fill.style.width = '0%';
            }
            return;
        }

        const total = bounds.max - bounds.min;
        if (total <= 0) {
            fill.style.left = '0%';
            fill.style.width = '100%';
            return;
        }

        const left = ((currentMin - bounds.min) / total) * 100;
        const right = ((currentMax - bounds.min) / total) * 100;
        fill.style.left = `${Math.max(0, left)}%`;
        fill.style.width = `${Math.max(0, right - left)}%`;
    }

    function syncWordsNotInAnkiRangeControls({
        cardId,
        bounds,
        currentMin,
        currentMax,
        minInputId,
        maxInputId,
        minRangeId,
        maxRangeId,
        resetId,
        fillId,
    }) {
        const card = document.getElementById(cardId);
        const minInput = document.getElementById(minInputId);
        const maxInput = document.getElementById(maxInputId);
        const minRange = document.getElementById(minRangeId);
        const maxRange = document.getElementById(maxRangeId);
        const controlIds = [minInputId, maxInputId, minRangeId, maxRangeId, resetId];

        const nextRange = clampWordsNotInAnkiRangeValues(bounds, currentMin, currentMax);

        if (nextRange.bounds.min == null || nextRange.bounds.max == null) {
            if (card) {
                card.style.display = 'none';
            }
            if (minInput) minInput.value = '';
            if (maxInput) maxInput.value = '';
            if (minRange) {
                minRange.min = '1';
                minRange.max = '1';
                minRange.value = '1';
            }
            if (maxRange) {
                maxRange.min = '1';
                maxRange.max = '1';
                maxRange.value = '1';
            }
            setWordsNotInAnkiRangeInputsDisabled(controlIds, true);
            updateWordsNotInAnkiRangeFill(fillId, nextRange.bounds, nextRange.min, nextRange.max);
            return nextRange;
        }

        if (card) {
            card.style.display = '';
        }

        if (minInput) {
            minInput.min = String(nextRange.bounds.min);
            minInput.max = String(nextRange.bounds.max);
            minInput.value = String(nextRange.min);
        }
        if (maxInput) {
            maxInput.min = String(nextRange.bounds.min);
            maxInput.max = String(nextRange.bounds.max);
            maxInput.value = String(nextRange.max);
        }
        if (minRange) {
            minRange.min = String(nextRange.bounds.min);
            minRange.max = String(nextRange.bounds.max);
            minRange.value = String(nextRange.min);
        }
        if (maxRange) {
            maxRange.min = String(nextRange.bounds.min);
            maxRange.max = String(nextRange.bounds.max);
            maxRange.value = String(nextRange.max);
        }

        setWordsNotInAnkiRangeInputsDisabled(controlIds, false);
        updateWordsNotInAnkiRangeFill(fillId, nextRange.bounds, nextRange.min, nextRange.max);
        return nextRange;
    }

    function syncWordsNotInAnkiFrequencyControls(bounds) {
        const nextRange = syncWordsNotInAnkiRangeControls({
            cardId: 'wordsNotInAnkiFrequencyCard',
            bounds,
            currentMin: wordsNotInAnki.frequencyMin,
            currentMax: wordsNotInAnki.frequencyMax,
            minInputId: 'wordsNotInAnkiFrequencyMin',
            maxInputId: 'wordsNotInAnkiFrequencyMax',
            minRangeId: 'wordsNotInAnkiFrequencyMinRange',
            maxRangeId: 'wordsNotInAnkiFrequencyMaxRange',
            resetId: 'wordsNotInAnkiFrequencyReset',
            fillId: 'wordsNotInAnkiFrequencyFill',
        });

        wordsNotInAnki.frequencyBounds = nextRange.bounds;
        wordsNotInAnki.frequencyMin = nextRange.min;
        wordsNotInAnki.frequencyMax = nextRange.max;
        updateWordsNotInAnkiPowerUserSummary();
    }

    function syncWordsNotInAnkiGlobalRankControls(bounds, source) {
        const sourceLabel = document.getElementById('wordsNotInAnkiGlobalRankSource');

        wordsNotInAnki.globalRankSource = source || null;
        if (sourceLabel) {
            sourceLabel.textContent = formatWordsNotInAnkiGlobalRankSource(source);
            if (source?.source_url) {
                sourceLabel.title = source.source_url;
            } else {
                sourceLabel.removeAttribute('title');
            }
        }

        const nextRange = syncWordsNotInAnkiRangeControls({
            cardId: 'wordsNotInAnkiGlobalRankCard',
            bounds: source ? bounds : null,
            currentMin: wordsNotInAnki.globalRankMin,
            currentMax: wordsNotInAnki.globalRankMax,
            minInputId: 'wordsNotInAnkiGlobalRankMinInput',
            maxInputId: 'wordsNotInAnkiGlobalRankMaxInput',
            minRangeId: 'wordsNotInAnkiGlobalRankMinRange',
            maxRangeId: 'wordsNotInAnkiGlobalRankMaxRange',
            resetId: 'wordsNotInAnkiGlobalRankReset',
            fillId: 'wordsNotInAnkiGlobalRankFill',
        });

        wordsNotInAnki.globalRankBounds = nextRange.bounds;
        wordsNotInAnki.globalRankMin = nextRange.min;
        wordsNotInAnki.globalRankMax = nextRange.max;
        updateWordsNotInAnkiPowerUserSummary();
    }

    function resetWordsNotInAnkiFrequencyRange() {
        const bounds = wordsNotInAnki.frequencyBounds;
        if (bounds.min == null || bounds.max == null) return;
        wordsNotInAnki.frequencyMin = bounds.min;
        wordsNotInAnki.frequencyMax = bounds.max;
        syncWordsNotInAnkiFrequencyControls(bounds);
        wordsNotInAnki.offset = 0;
        loadWordsNotInAnki();
    }

    function resetWordsNotInAnkiGlobalRankRange() {
        const bounds = wordsNotInAnki.globalRankBounds;
        if (bounds.min == null || bounds.max == null) return;
        wordsNotInAnki.globalRankMin = bounds.min;
        wordsNotInAnki.globalRankMax = bounds.max;
        syncWordsNotInAnkiGlobalRankControls(bounds, wordsNotInAnki.globalRankSource);
        wordsNotInAnki.offset = 0;
        loadWordsNotInAnki();
    }

    function buildWordSearchHref(word) {
        const params = new URLSearchParams({
            q: word,
            use_tokenized: 'true',
        });
        return `/search?${params.toString()}`;
    }

    function buildJishoSearchHref(word) {
        const normalizedWord = (word || '').trim();
        if (!normalizedWord) {
            return 'https://jisho.org/';
        }
        return `https://jisho.org/search/${encodeURIComponent(normalizedWord)}`;
    }

    function renderGlobalRankCell(globalRank) {
        if (globalRank == null) {
            return '<span class="words-rank-value-empty">—</span>';
        }
        return `<span class="words-rank-value">${globalRank.toLocaleString()}</span>`;
    }

    function setWordDetailSearchHref(word) {
        const openSearchLink = document.getElementById('wordDetailOpenSearch');
        if (openSearchLink) {
            openSearchLink.href = buildWordSearchHref(word);
        }
    }

    function setWordDetailJishoHref(word) {
        const openJishoLink = document.getElementById('wordDetailOpenJisho');
        if (openJishoLink) {
            openJishoLink.href = buildJishoSearchHref(word);
        }
    }

    function showWordDetailError(message) {
        const errorEl = document.getElementById('wordDetailError');
        if (!errorEl) return;
        if (!message) {
            errorEl.style.display = 'none';
            errorEl.textContent = '';
            return;
        }
        errorEl.textContent = message;
        errorEl.style.display = 'block';
    }

    function setWordDetailLoading(loading) {
        const loadingEl = document.getElementById('wordDetailLoading');
        if (loadingEl) loadingEl.style.display = loading ? 'flex' : 'none';
    }

    function setWordDetailContentVisible(visible) {
        const contentEl = document.getElementById('wordDetailContent');
        if (contentEl) contentEl.style.display = visible ? 'block' : 'none';
    }

    function abortWordDetailRequests() {
        if (wordDetail.detailRequest) {
            abortTimedRequest(wordDetail.detailRequest);
            wordDetail.detailRequest = null;
        }
        if (wordDetail.searchRequest) {
            abortTimedRequest(wordDetail.searchRequest);
            wordDetail.searchRequest = null;
        }
    }

    function resetWordDetailModal(word) {
        const titleEl = document.getElementById('wordDetailModalTitle');
        const subtitleEl = document.getElementById('wordDetailModalSubtitle');
        const gamesEl = document.getElementById('wordDetailGames');
        const linesEl = document.getElementById('wordDetailLines');
        const gamesEmptyEl = document.getElementById('wordDetailGamesEmpty');
        const linesEmptyEl = document.getElementById('wordDetailLinesEmpty');
        const linesMetaEl = document.getElementById('wordDetailLinesMeta');

        if (titleEl) titleEl.textContent = word ? `Word Details: ${word}` : 'Word Details';
        if (subtitleEl) subtitleEl.textContent = 'Tokenized examples and Anki status';
        if (document.getElementById('wordDetailWord')) {
            document.getElementById('wordDetailWord').textContent = word || '—';
        }
        if (document.getElementById('wordDetailReading')) {
            document.getElementById('wordDetailReading').textContent = '—';
        }
        if (document.getElementById('wordDetailPos')) {
            document.getElementById('wordDetailPos').textContent = '—';
        }
        if (document.getElementById('wordDetailAnkiState')) {
            const ankiStateEl = document.getElementById('wordDetailAnkiState');
            ankiStateEl.textContent = 'Not in Anki';
            ankiStateEl.classList.remove('is-known');
        }
        if (document.getElementById('wordDetailTotalOccurrences')) {
            document.getElementById('wordDetailTotalOccurrences').textContent = '0';
        }
        if (document.getElementById('wordDetailDeck')) {
            document.getElementById('wordDetailDeck').textContent = 'Not in Anki';
        }
        if (document.getElementById('wordDetailInterval')) {
            document.getElementById('wordDetailInterval').textContent = '—';
        }
        if (document.getElementById('wordDetailDue')) {
            document.getElementById('wordDetailDue').textContent = '—';
        }

        if (gamesEl) gamesEl.innerHTML = '';
        if (linesEl) linesEl.innerHTML = '';
        if (gamesEmptyEl) {
            gamesEmptyEl.textContent = wordDetailGamesDefaultEmptyText;
            gamesEmptyEl.style.display = 'none';
        }
        if (linesEmptyEl) {
            linesEmptyEl.textContent = wordDetailLinesDefaultEmptyText;
            linesEmptyEl.style.display = 'none';
        }
        if (linesMetaEl) linesMetaEl.textContent = '';

        showWordDetailError('');
        setWordDetailContentVisible(false);
        setWordDetailLoading(true);
        setWordDetailSearchHref(word);
        setWordDetailJishoHref(word);
    }

    function closeWordDetailModal() {
        abortWordDetailRequests();
        closeModal('wordDetailModal');
    }

    async function fetchJsonWithTimeout(url, requestHandle) {
        const resp = await fetch(url, { signal: requestHandle.controller.signal });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        return data;
    }

    function formatWordDetailError(error, requestHandle, fallbackMessage) {
        if (!requestHandle) return fallbackMessage;
        if (requestHandle.controller.signal.aborted && !requestHandle.timedOut()) {
            return '';
        }
        if (requestHandle.timedOut()) {
            return `${fallbackMessage} Request timed out.`;
        }
        if (error instanceof Error && error.message) {
            return `${fallbackMessage} ${error.message}`;
        }
        return fallbackMessage;
    }

    function formatWordDetailTimestamp(timestamp) {
        const numeric = Number(timestamp);
        if (!Number.isFinite(numeric) || numeric <= 0) return 'Unknown time';
        const millis = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
        const date = new Date(millis);
        if (Number.isNaN(date.getTime())) return 'Unknown time';
        return date.toLocaleString();
    }

    function renderWordDetailGames(games) {
        const gamesEl = document.getElementById('wordDetailGames');
        const gamesEmptyEl = document.getElementById('wordDetailGamesEmpty');
        if (!gamesEl || !gamesEmptyEl) return;

        gamesEl.innerHTML = '';
        if (!Array.isArray(games) || games.length === 0) {
            gamesEmptyEl.textContent = wordDetailGamesDefaultEmptyText;
            gamesEmptyEl.style.display = 'block';
            return;
        }

        gamesEmptyEl.style.display = 'none';
        const fragment = document.createDocumentFragment();
        games.forEach((game) => {
            const row = document.createElement('div');
            row.className = 'word-detail-game-row';

            const name = document.createElement('div');
            name.className = 'word-detail-game-name';
            name.textContent = game.game_name || 'Unknown game';

            const frequency = document.createElement('div');
            frequency.className = 'word-detail-game-frequency';
            frequency.textContent = `${Number(game.frequency || 0).toLocaleString()} seen`;

            row.appendChild(name);
            row.appendChild(frequency);
            fragment.appendChild(row);
        });

        gamesEl.appendChild(fragment);
    }

    function renderWordDetailSummary(detail) {
        const subtitleEl = document.getElementById('wordDetailModalSubtitle');
        const wordEl = document.getElementById('wordDetailWord');
        const readingEl = document.getElementById('wordDetailReading');
        const posEl = document.getElementById('wordDetailPos');
        const ankiStateEl = document.getElementById('wordDetailAnkiState');
        const totalOccurrencesEl = document.getElementById('wordDetailTotalOccurrences');
        const deckEl = document.getElementById('wordDetailDeck');
        const intervalEl = document.getElementById('wordDetailInterval');
        const dueEl = document.getElementById('wordDetailDue');

        const inAnki = Boolean(detail.deck_name || detail.interval != null || detail.due != null);

        if (subtitleEl) {
            const gameCount = Array.isArray(detail.games) ? detail.games.length : 0;
            subtitleEl.textContent = `${gameCount.toLocaleString()} game${gameCount === 1 ? '' : 's'} in top frequency breakdown`;
        }
        if (wordEl) wordEl.textContent = detail.word || wordDetail.word || '—';
        if (readingEl) readingEl.textContent = detail.reading || '—';
        if (posEl) posEl.textContent = detail.pos || '—';
        if (ankiStateEl) {
            ankiStateEl.textContent = inAnki ? 'In Anki' : 'Not in Anki';
            ankiStateEl.classList.toggle('is-known', inAnki);
        }
        if (totalOccurrencesEl) {
            totalOccurrencesEl.textContent = Number(detail.total_occurrences || 0).toLocaleString();
        }
        if (deckEl) deckEl.textContent = detail.deck_name || 'Not in Anki';
        if (intervalEl)
            intervalEl.textContent = detail.interval != null ? `${detail.interval}d` : '—';
        if (dueEl) dueEl.textContent = detail.due != null ? String(detail.due) : '—';

        renderWordDetailGames(detail.games || []);
    }

    function renderWordDetailLines(searchData) {
        const linesEl = document.getElementById('wordDetailLines');
        const linesEmptyEl = document.getElementById('wordDetailLinesEmpty');
        const linesMetaEl = document.getElementById('wordDetailLinesMeta');
        if (!linesEl || !linesEmptyEl || !linesMetaEl) return;

        const lines = Array.isArray(searchData?.lines) ? searchData.lines : [];
        linesEl.innerHTML = '';

        const total = Number(searchData?.total || 0);
        if (total > 0) {
            linesMetaEl.textContent =
                lines.length < total
                    ? `Showing ${lines.length.toLocaleString()} of ${total.toLocaleString()} latest matches`
                    : `${total.toLocaleString()} latest match${total === 1 ? '' : 'es'}`;
        } else {
            linesMetaEl.textContent = '';
        }

        if (lines.length === 0) {
            linesEmptyEl.textContent = wordDetailLinesDefaultEmptyText;
            linesEmptyEl.style.display = 'block';
            return;
        }

        linesEmptyEl.style.display = 'none';
        const fragment = document.createDocumentFragment();

        lines.forEach((line) => {
            const entry = document.createElement('div');
            entry.className = 'word-detail-line';

            const header = document.createElement('div');
            header.className = 'word-detail-line-header';

            const game = document.createElement('div');
            game.className = 'word-detail-line-game';
            game.textContent = line.game_name || 'Unknown game';

            const time = document.createElement('div');
            time.className = 'word-detail-line-time';
            time.textContent = formatWordDetailTimestamp(line.timestamp);

            const text = document.createElement('div');
            text.className = 'word-detail-line-text';
            text.textContent = line.text || '';

            header.appendChild(game);
            header.appendChild(time);
            entry.appendChild(header);
            entry.appendChild(text);
            fragment.appendChild(entry);
        });

        linesEl.appendChild(fragment);
    }

    async function openWordDetailModal(word) {
        if (!word) return;

        abortWordDetailRequests();

        const requestId = wordDetail.requestId + 1;
        wordDetail.requestId = requestId;
        wordDetail.word = word;

        resetWordDetailModal(word);
        openModal('wordDetailModal');

        const detailHandle = createTimedRequest(WORDS_NOT_IN_ANKI_TIMEOUT_MS);
        const searchHandle = createTimedRequest(WORDS_NOT_IN_ANKI_TIMEOUT_MS);
        wordDetail.detailRequest = detailHandle;
        wordDetail.searchRequest = searchHandle;

        const searchParams = new URLSearchParams({
            q: word,
            limit: '20',
        });
        appendWordsNotInAnkiGameScopeParams(searchParams);
        const detailParams = new URLSearchParams();
        appendWordsNotInAnkiGameScopeParams(detailParams);
        const detailQuery = detailParams.toString();
        const detailUrl = detailQuery
            ? `/api/tokenization/word/${encodeURIComponent(word)}?${detailQuery}`
            : `/api/tokenization/word/${encodeURIComponent(word)}`;

        try {
            const [detailResult, searchResult] = await Promise.allSettled([
                fetchJsonWithTimeout(detailUrl, detailHandle),
                fetchJsonWithTimeout(
                    `/api/tokenization/search?${searchParams.toString()}`,
                    searchHandle,
                ),
            ]);

            if (requestId !== wordDetail.requestId) return;

            const detailLoaded = detailResult.status === 'fulfilled';
            if (detailLoaded) {
                renderWordDetailSummary(detailResult.value);
                setWordDetailContentVisible(true);
            }

            const errorMessages = [];
            if (!detailLoaded) {
                const detailMessage = formatWordDetailError(
                    detailResult.reason,
                    detailHandle,
                    'Could not load word details.',
                );
                if (detailMessage) errorMessages.push(detailMessage);
            }

            if (searchResult.status === 'fulfilled') {
                renderWordDetailLines(searchResult.value);
                if (!detailLoaded && searchResult.value?.word?.word) {
                    const titleEl = document.getElementById('wordDetailModalTitle');
                    if (titleEl) {
                        titleEl.textContent = `Word Details: ${searchResult.value.word.word}`;
                    }
                }
            } else {
                const linesEmptyEl = document.getElementById('wordDetailLinesEmpty');
                if (linesEmptyEl) {
                    linesEmptyEl.textContent = 'Could not load latest example lines.';
                    linesEmptyEl.style.display = 'block';
                }
                const searchMessage = formatWordDetailError(
                    searchResult.reason,
                    searchHandle,
                    'Could not load latest example lines.',
                );
                if (searchMessage) errorMessages.push(searchMessage);
            }

            showWordDetailError(errorMessages.join(' '));
        } finally {
            detailHandle.cleanup();
            searchHandle.cleanup();

            if (wordDetail.detailRequest === detailHandle) {
                wordDetail.detailRequest = null;
            }
            if (wordDetail.searchRequest === searchHandle) {
                wordDetail.searchRequest = null;
            }
            if (requestId === wordDetail.requestId) {
                setWordDetailLoading(false);
            }
        }
    }

    function renderWordCell(word) {
        const href = buildWordSearchHref(word);
        return `<a href="${href}" class="word-link">${escapeHtml(word)}</a>`;
    }

    function renderWordsNotInAnkiRows(words) {
        const tbody = document.getElementById('wordsNotInAnkiTableBody');
        if (!tbody) return;

        tbody.innerHTML = '';
        const wordsFragment = document.createDocumentFragment();
        words.forEach((w) => {
            const tr = document.createElement('tr');
            tr.innerHTML =
                `<td>${renderWordCell(w.word)}</td>` +
                `<td>${escapeHtml(w.reading)}</td>` +
                `<td>${escapeHtml(w.pos)}</td>` +
                `<td>${Number(w.frequency || 0).toLocaleString()}</td>` +
                `<td>${renderGlobalRankCell(w.global_rank)}</td>`;

            const detailsCell = document.createElement('td');
            detailsCell.className = 'details-cell';

            const detailsButton = document.createElement('button');
            detailsButton.type = 'button';
            detailsButton.className = 'action-btn primary words-detail-btn';
            detailsButton.dataset.word = w.word;
            detailsButton.textContent = 'Details';

            detailsCell.appendChild(detailsButton);
            tr.appendChild(detailsCell);
            wordsFragment.appendChild(tr);
        });
        tbody.appendChild(wordsFragment);
    }

    async function loadWordsNotInAnki() {
        const loading = document.getElementById('wordsNotInAnkiLoading');
        const empty = document.getElementById('wordsNotInAnkiEmpty');
        const tbody = document.getElementById('wordsNotInAnkiTableBody');
        const totalBadge = document.getElementById('wordsNotInAnkiTotal');
        const totalValue = document.getElementById('wordsNotInAnkiTotalValue');
        const requestId = wordsNotInAnki.requestId + 1;
        wordsNotInAnki.requestId = requestId;
        wordsNotInAnki.pendingVisibleLoad = false;

        if (wordsNotInAnki.listRequest) {
            abortTimedRequest(wordsNotInAnki.listRequest);
            wordsNotInAnki.listRequest = null;
        }
        const requestHandle = createTimedRequest(WORDS_NOT_IN_ANKI_TIMEOUT_MS);
        wordsNotInAnki.listRequest = requestHandle;

        if (loading) loading.style.display = 'flex';
        updateWordsNotInAnkiActionState();
        if (empty) {
            empty.style.display = 'none';
            empty.textContent = getWordsNotInAnkiEmptyText();
        }

        try {
            if (
                hasWordsNotInAnkiCustomGameSelection() &&
                !wordsNotInAnki.hasLoadedGames &&
                !wordsNotInAnki.isLoadingGames
            ) {
                await loadWordsNotInAnkiGameOptions();
                if (requestId !== wordsNotInAnki.requestId) return;
            }

            const params = buildWordsNotInAnkiQueryParams({ includePagination: true });
            const resp = await fetchAnkiApi(
                `/api/tokenization/words/not-in-anki?${params.toString()}`,
                {
                    signal: requestHandle.controller.signal,
                },
            );
            if (!resp.ok) throw new Error('API error');
            const data = await resp.json();
            if (requestId !== wordsNotInAnki.requestId) return;

            wordsNotInAnki.total = data.total;
            if (!data.global_rank_source && wordsNotInAnki.sort === 'global_rank') {
                wordsNotInAnki.sort = 'frequency';
                wordsNotInAnki.order = 'desc';
            }
            syncWordsNotInAnkiFrequencyControls(data.frequency_bounds || null);
            syncWordsNotInAnkiGlobalRankControls(
                data.global_rank_bounds || null,
                data.global_rank_source || null,
            );
            syncWordsNotInAnkiSortHeaders();

            if (totalBadge) totalBadge.style.display = data.total > 0 ? '' : 'none';
            if (totalValue) totalValue.textContent = data.total.toLocaleString();
            updateWordsNotInAnkiActionState();

            if (!data.words || data.words.length === 0) {
                if (tbody) tbody.innerHTML = '';
                if (empty) {
                    empty.style.display = 'block';
                    empty.textContent = getWordsNotInAnkiEmptyText();
                }
            } else {
                renderWordsNotInAnkiRows(data.words);
            }

            updateWordsNotInAnkiPagination();
        } catch (e) {
            if (requestId !== wordsNotInAnki.requestId) return;
            if (requestHandle.controller.signal.aborted && !requestHandle.timedOut()) return;
            console.error('Failed to load words not in Anki:', e);
            wordsNotInAnki.total = 0;
            if (tbody) tbody.innerHTML = '';
            if (totalBadge) totalBadge.style.display = 'none';
            if (totalValue) totalValue.textContent = '0';
            updateWordsNotInAnkiPagination();
            updateWordsNotInAnkiActionState();
            if (empty) {
                empty.style.display = 'block';
                empty.textContent = requestHandle.timedOut()
                    ? 'Loading words timed out. Please try again.'
                    : 'Failed to load words. Is tokenization enabled?';
            }
        } finally {
            requestHandle.cleanup();
            if (wordsNotInAnki.listRequest === requestHandle) {
                wordsNotInAnki.listRequest = null;
            }
            if (requestId === wordsNotInAnki.requestId && loading) {
                loading.style.display = 'none';
            }
            updateWordsNotInAnkiActionState();
        }
    }

    async function downloadWordsNotInAnkiCsv() {
        if (
            wordsNotInAnki.total <= 0 ||
            wordsNotInAnki.exportRequest ||
            wordsNotInAnki.listRequest
        ) {
            return;
        }

        const downloadButton = document.getElementById('wordsNotInAnkiDownloadCsv');
        const originalLabel = downloadButton?.textContent || 'Download CSV';
        const requestHandle = createTimedRequest(WORDS_NOT_IN_ANKI_TIMEOUT_MS);
        wordsNotInAnki.exportRequest = requestHandle;

        if (downloadButton) {
            downloadButton.disabled = true;
            downloadButton.textContent = 'Preparing...';
        }

        try {
            const params = buildWordsNotInAnkiQueryParams({ includePagination: false });
            const resp = await fetchAnkiApi(
                `/api/tokenization/words/not-in-anki/export?${params.toString()}`,
                {
                    signal: requestHandle.controller.signal,
                },
            );
            if (!resp.ok) {
                const errorPayload = await resp.json().catch(() => ({}));
                throw new Error(errorPayload.error || `HTTP ${resp.status}`);
            }

            const blob = await resp.blob();
            const blobUrl = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = 'gsm_words_not_in_anki.csv';
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => window.URL.revokeObjectURL(blobUrl), 0);
        } catch (e) {
            if (!(requestHandle.controller.signal.aborted && !requestHandle.timedOut())) {
                console.error('Failed to export words not in Anki CSV:', e);
                window.alert(
                    requestHandle.timedOut()
                        ? 'Export timed out. Please try again.'
                        : 'Failed to export words CSV.',
                );
            }
        } finally {
            requestHandle.cleanup();
            if (wordsNotInAnki.exportRequest === requestHandle) {
                wordsNotInAnki.exportRequest = null;
            }
            if (downloadButton) {
                downloadButton.textContent = originalLabel;
            }
            updateWordsNotInAnkiActionState();
        }
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    function updateWordsNotInAnkiPagination() {
        const prev = document.getElementById('wordsNotInAnkiPrev');
        const next = document.getElementById('wordsNotInAnkiNext');
        const info = document.getElementById('wordsNotInAnkiPageInfo');

        const page = Math.floor(wordsNotInAnki.offset / wordsNotInAnki.limit) + 1;
        const totalPages = Math.max(1, Math.ceil(wordsNotInAnki.total / wordsNotInAnki.limit));

        if (info)
            info.textContent = `Page ${page} of ${totalPages} (${wordsNotInAnki.total.toLocaleString()} words)`;
        if (prev) prev.disabled = wordsNotInAnki.offset <= 0;
        if (next)
            next.disabled = wordsNotInAnki.offset + wordsNotInAnki.limit >= wordsNotInAnki.total;
    }

    function queueWordsNotInAnkiReload(delay = 0) {
        clearDeferredWordsNotInAnkiLoad();
        clearTimeout(wordsNotInAnki.debounceTimer);
        wordsNotInAnki.offset = 0;
        if (delay > 0) {
            wordsNotInAnki.debounceTimer = setTimeout(() => {
                loadWordsNotInAnki();
            }, delay);
            return;
        }
        loadWordsNotInAnki();
    }

    // Pagination buttons
    const prevBtn = document.getElementById('wordsNotInAnkiPrev');
    const nextBtn = document.getElementById('wordsNotInAnkiNext');
    if (prevBtn)
        prevBtn.addEventListener('click', () => {
            wordsNotInAnki.offset = Math.max(0, wordsNotInAnki.offset - wordsNotInAnki.limit);
            loadWordsNotInAnki();
        });
    if (nextBtn)
        nextBtn.addEventListener('click', () => {
            wordsNotInAnki.offset += wordsNotInAnki.limit;
            loadWordsNotInAnki();
        });

    const searchInput = document.getElementById('wordsNotInAnkiSearch');
    const scriptFilterSelect = document.getElementById('wordsNotInAnkiScriptFilter');
    const includeGrammarToggle = document.getElementById('wordsNotInAnkiIncludeGrammar');
    const hasMissingAnkiKanjiToggle = document.getElementById(
        'wordsNotInAnkiHasMissingAnkiKanji',
    );
    const posIncludeInput = document.getElementById('wordsNotInAnkiPosInclude');
    const posExcludeInput = document.getElementById('wordsNotInAnkiPosExclude');
    const frequencyMinInput = document.getElementById('wordsNotInAnkiFrequencyMin');
    const frequencyMaxInput = document.getElementById('wordsNotInAnkiFrequencyMax');
    const frequencyMinRange = document.getElementById('wordsNotInAnkiFrequencyMinRange');
    const frequencyMaxRange = document.getElementById('wordsNotInAnkiFrequencyMaxRange');
    const frequencyReset = document.getElementById('wordsNotInAnkiFrequencyReset');
    const pageSizeSelect = document.getElementById('wordsNotInAnkiPageSize');
    const gameFilterDropdown = document.getElementById('wordsNotInAnkiGameFilter');
    const gameFilterToggle = document.getElementById('wordsNotInAnkiGameFilterToggle');
    const gameFilterMenu = document.getElementById('wordsNotInAnkiGameFilterMenu');
    const gameFilterSelectAllButton = document.getElementById(
        'wordsNotInAnkiGameFilterSelectAll',
    );
    const gameFilterClearAllButton = document.getElementById(
        'wordsNotInAnkiGameFilterClearAll',
    );
    const downloadCsvButton = document.getElementById('wordsNotInAnkiDownloadCsv');
    const resetFiltersButton = document.getElementById('wordsNotInAnkiResetFilters');

    if (searchInput)
        searchInput.addEventListener('input', () => {
            wordsNotInAnki.search = searchInput.value.trim();
            queueWordsNotInAnkiReload(300);
        });

    if (scriptFilterSelect)
        scriptFilterSelect.addEventListener('change', () => {
            wordsNotInAnki.scriptFilter = scriptFilterSelect.value || 'all';
            updateWordsNotInAnkiPowerUserSummary();
            queueWordsNotInAnkiReload();
        });

    if (includeGrammarToggle)
        includeGrammarToggle.addEventListener('change', () => {
            wordsNotInAnki.vocabOnly = !includeGrammarToggle.checked;
            updateWordsNotInAnkiPowerUserSummary();
            queueWordsNotInAnkiReload();
        });

    if (hasMissingAnkiKanjiToggle)
        hasMissingAnkiKanjiToggle.addEventListener('change', () => {
            wordsNotInAnki.hasMissingAnkiKanji = hasMissingAnkiKanjiToggle.checked;
            updateWordsNotInAnkiPowerUserSummary();
            queueWordsNotInAnkiReload();
        });

    if (posIncludeInput)
        posIncludeInput.addEventListener('input', () => {
            wordsNotInAnki.pos = posIncludeInput.value.trim();
            updateWordsNotInAnkiPowerUserSummary();
            queueWordsNotInAnkiReload(300);
        });

    if (posExcludeInput)
        posExcludeInput.addEventListener('input', () => {
            wordsNotInAnki.excludePos = posExcludeInput.value.trim();
            updateWordsNotInAnkiPowerUserSummary();
            queueWordsNotInAnkiReload(300);
        });

    if (frequencyMinInput)
        frequencyMinInput.addEventListener('change', () => {
            const bounds = wordsNotInAnki.frequencyBounds;
            if (bounds.min == null || bounds.max == null) return;
            const parsed = Number.parseInt(frequencyMinInput.value, 10);
            const nextValue = Number.isFinite(parsed) ? parsed : bounds.min;
            wordsNotInAnki.frequencyMin = Math.max(
                bounds.min,
                Math.min(nextValue, wordsNotInAnki.frequencyMax ?? bounds.max),
            );
            wordsNotInAnki.frequencyMax = Math.max(
                wordsNotInAnki.frequencyMin,
                wordsNotInAnki.frequencyMax ?? bounds.max,
            );
            syncWordsNotInAnkiFrequencyControls(bounds);
            wordsNotInAnki.offset = 0;
            loadWordsNotInAnki();
        });

    if (frequencyMaxInput)
        frequencyMaxInput.addEventListener('change', () => {
            const bounds = wordsNotInAnki.frequencyBounds;
            if (bounds.min == null || bounds.max == null) return;
            const parsed = Number.parseInt(frequencyMaxInput.value, 10);
            const nextValue = Number.isFinite(parsed) ? parsed : bounds.max;
            wordsNotInAnki.frequencyMax = Math.min(
                bounds.max,
                Math.max(nextValue, wordsNotInAnki.frequencyMin ?? bounds.min),
            );
            wordsNotInAnki.frequencyMin = Math.min(
                wordsNotInAnki.frequencyMax,
                wordsNotInAnki.frequencyMin ?? bounds.min,
            );
            syncWordsNotInAnkiFrequencyControls(bounds);
            wordsNotInAnki.offset = 0;
            loadWordsNotInAnki();
        });

    if (frequencyMinRange)
        frequencyMinRange.addEventListener('input', () => {
            const bounds = wordsNotInAnki.frequencyBounds;
            if (bounds.min == null || bounds.max == null) return;
            const parsed = Number.parseInt(frequencyMinRange.value, 10);
            wordsNotInAnki.frequencyMin = Math.min(
                parsed,
                wordsNotInAnki.frequencyMax ?? bounds.max,
            );
            syncWordsNotInAnkiFrequencyControls(bounds);
            queueWordsNotInAnkiReload(150);
        });

    if (frequencyMaxRange)
        frequencyMaxRange.addEventListener('input', () => {
            const bounds = wordsNotInAnki.frequencyBounds;
            if (bounds.min == null || bounds.max == null) return;
            const parsed = Number.parseInt(frequencyMaxRange.value, 10);
            wordsNotInAnki.frequencyMax = Math.max(
                parsed,
                wordsNotInAnki.frequencyMin ?? bounds.min,
            );
            syncWordsNotInAnkiFrequencyControls(bounds);
            queueWordsNotInAnkiReload(150);
        });

    if (frequencyReset)
        frequencyReset.addEventListener('click', resetWordsNotInAnkiFrequencyRange);

    if (pageSizeSelect)
        pageSizeSelect.addEventListener('change', () => {
            const parsed = Number.parseInt(pageSizeSelect.value, 10);
            wordsNotInAnki.limit =
                Number.isFinite(parsed) && parsed > 0 ? parsed : WORDS_NOT_IN_ANKI_DEFAULTS.limit;
            updateWordsNotInAnkiPowerUserSummary();
            queueWordsNotInAnkiReload();
        });

    if (gameFilterToggle) {
        gameFilterToggle.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!wordsNotInAnki.hasLoadedGames && !wordsNotInAnki.isLoadingGames) {
                loadWordsNotInAnkiGameOptions();
            }
            const isOpen = gameFilterDropdown?.classList.contains('is-open');
            setWordsNotInAnkiGameFilterOpen(!isOpen);
        });
    }

    if (gameFilterMenu) {
        gameFilterMenu.addEventListener('click', (event) => {
            event.stopPropagation();
        });
    }

    if (gameFilterSelectAllButton) {
        gameFilterSelectAllButton.addEventListener('click', () => {
            wordsNotInAnki.selectedGameIds = null;
            renderWordsNotInAnkiGameFilterOptions();
            updateWordsNotInAnkiGameFilterSummary();
            updateWordsNotInAnkiPowerUserSummary();
            queueWordsNotInAnkiReload();
        });
    }

    if (gameFilterClearAllButton) {
        gameFilterClearAllButton.addEventListener('click', () => {
            if (!wordsNotInAnki.availableGames.length) {
                return;
            }
            wordsNotInAnki.selectedGameIds = [];
            renderWordsNotInAnkiGameFilterOptions();
            updateWordsNotInAnkiGameFilterSummary();
            updateWordsNotInAnkiPowerUserSummary();
            queueWordsNotInAnkiReload();
        });
    }

    if (downloadCsvButton) {
        downloadCsvButton.addEventListener('click', downloadWordsNotInAnkiCsv);
    }

    if (resetFiltersButton) {
        resetFiltersButton.addEventListener('click', resetWordsNotInAnkiFilters);
    }

    const globalRankMinInput = document.getElementById('wordsNotInAnkiGlobalRankMinInput');
    const globalRankMaxInput = document.getElementById('wordsNotInAnkiGlobalRankMaxInput');
    const globalRankMinRange = document.getElementById('wordsNotInAnkiGlobalRankMinRange');
    const globalRankMaxRange = document.getElementById('wordsNotInAnkiGlobalRankMaxRange');
    const globalRankReset = document.getElementById('wordsNotInAnkiGlobalRankReset');
    const closeWordDetailModalEl = document.getElementById('closeWordDetailModal');
    const closeWordDetailModalBtn = document.getElementById('closeWordDetailModalBtn');
    const wordDetailModalEl = document.getElementById('wordDetailModal');
    const wordsNotInAnkiTableBody = document.getElementById('wordsNotInAnkiTableBody');

    if (globalRankMinInput)
        globalRankMinInput.addEventListener('change', () => {
            const bounds = wordsNotInAnki.globalRankBounds;
            if (bounds.min == null || bounds.max == null) return;
            const parsed = Number.parseInt(globalRankMinInput.value, 10);
            const nextValue = Number.isFinite(parsed) ? parsed : bounds.min;
            wordsNotInAnki.globalRankMin = Math.max(
                bounds.min,
                Math.min(nextValue, wordsNotInAnki.globalRankMax ?? bounds.max),
            );
            wordsNotInAnki.globalRankMax = Math.max(
                wordsNotInAnki.globalRankMin,
                wordsNotInAnki.globalRankMax ?? bounds.max,
            );
            syncWordsNotInAnkiGlobalRankControls(bounds, wordsNotInAnki.globalRankSource);
            wordsNotInAnki.offset = 0;
            loadWordsNotInAnki();
        });

    if (globalRankMaxInput)
        globalRankMaxInput.addEventListener('change', () => {
            const bounds = wordsNotInAnki.globalRankBounds;
            if (bounds.min == null || bounds.max == null) return;
            const parsed = Number.parseInt(globalRankMaxInput.value, 10);
            const nextValue = Number.isFinite(parsed) ? parsed : bounds.max;
            wordsNotInAnki.globalRankMax = Math.min(
                bounds.max,
                Math.max(nextValue, wordsNotInAnki.globalRankMin ?? bounds.min),
            );
            wordsNotInAnki.globalRankMin = Math.min(
                wordsNotInAnki.globalRankMax,
                wordsNotInAnki.globalRankMin ?? bounds.min,
            );
            syncWordsNotInAnkiGlobalRankControls(bounds, wordsNotInAnki.globalRankSource);
            wordsNotInAnki.offset = 0;
            loadWordsNotInAnki();
        });

    if (globalRankMinRange)
        globalRankMinRange.addEventListener('input', () => {
            const bounds = wordsNotInAnki.globalRankBounds;
            if (bounds.min == null || bounds.max == null) return;
            const parsed = Number.parseInt(globalRankMinRange.value, 10);
            wordsNotInAnki.globalRankMin = Math.min(
                parsed,
                wordsNotInAnki.globalRankMax ?? bounds.max,
            );
            syncWordsNotInAnkiGlobalRankControls(bounds, wordsNotInAnki.globalRankSource);
            queueWordsNotInAnkiReload(150);
        });

    if (globalRankMaxRange)
        globalRankMaxRange.addEventListener('input', () => {
            const bounds = wordsNotInAnki.globalRankBounds;
            if (bounds.min == null || bounds.max == null) return;
            const parsed = Number.parseInt(globalRankMaxRange.value, 10);
            wordsNotInAnki.globalRankMax = Math.max(
                parsed,
                wordsNotInAnki.globalRankMin ?? bounds.min,
            );
            syncWordsNotInAnkiGlobalRankControls(bounds, wordsNotInAnki.globalRankSource);
            queueWordsNotInAnkiReload(150);
        });

    if (globalRankReset)
        globalRankReset.addEventListener('click', resetWordsNotInAnkiGlobalRankRange);

    if (closeWordDetailModalEl) {
        closeWordDetailModalEl.addEventListener('click', closeWordDetailModal);
    }
    if (closeWordDetailModalBtn) {
        closeWordDetailModalBtn.addEventListener('click', closeWordDetailModal);
    }

    if (wordsNotInAnkiTableBody) {
        wordsNotInAnkiTableBody.addEventListener('click', (event) => {
            const button = event.target.closest('.words-detail-btn');
            if (!button) return;
            openWordDetailModal(button.dataset.word || '');
        });
    }

    if (wordDetailModalEl) {
        let backdropMouseDown = false;
        wordDetailModalEl.addEventListener('mousedown', (event) => {
            backdropMouseDown = event.target === wordDetailModalEl;
        });
        wordDetailModalEl.addEventListener('mouseup', (event) => {
            if (backdropMouseDown && event.target === wordDetailModalEl) {
                abortWordDetailRequests();
            }
            backdropMouseDown = false;
        });
    }

    document.addEventListener('click', (event) => {
        if (!gameFilterDropdown?.classList.contains('is-open')) {
            return;
        }
        if (gameFilterDropdown.contains(event.target)) {
            return;
        }
        setWordsNotInAnkiGameFilterOpen(false);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && gameFilterDropdown?.classList.contains('is-open')) {
            setWordsNotInAnkiGameFilterOpen(false);
            return;
        }
        if (event.key === 'Escape' && wordDetailModalEl?.classList.contains('show')) {
            abortWordDetailRequests();
        }
    });

    // Sortable column headers
    document.querySelectorAll('#wordsNotInAnkiTable .sortable-header').forEach((th) => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (wordsNotInAnki.sort === col) {
                wordsNotInAnki.order = wordsNotInAnki.order === 'desc' ? 'asc' : 'desc';
            } else {
                wordsNotInAnki.sort = col;
                wordsNotInAnki.order = col === 'frequency' ? 'desc' : 'asc';
            }
            wordsNotInAnki.offset = 0;
            syncWordsNotInAnkiSortHeaders();
            updateWordsNotInAnkiPowerUserSummary();
            loadWordsNotInAnki();
        });
    });

    document.querySelectorAll('[data-reading-impact-metric]').forEach((button) => {
        button.addEventListener('click', () => {
            const nextMetric = button.dataset.readingImpactMetric;
            if (!nextMetric || nextMetric === readingImpactState.metric) {
                return;
            }
            readingImpactState.metric = nextMetric;
            updateReadingImpactToggleButtons();
            if (readingImpactState.data) {
                updateReadingImpactKpis(readingImpactState.data);
                renderReadingImpactPipelineChart(readingImpactState.data);
                renderReadingImpactRollupTable(readingImpactState.data, { resetPage: false });
            }
        });
    });

    // Initialize controls before the date-driven first load runs.
    applyWordsNotInAnkiFilterStateToControls();
    syncWordsNotInAnkiSortHeaders();
    updateWordsNotInAnkiActionState();
});
