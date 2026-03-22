/**
 * Third-Party Stats Management Module
 *
 * Handles manual entry, Mokuro import, API documentation, and
 * listing/deletion of third-party reading stats on the database management page.
 */

(function () {
    'use strict';

    // State
    let allEntries = [];
    let activeFilter = 'all';
    let knownSources = [];

    // -------------------------------------------------------
    // Initialization
    // -------------------------------------------------------

    document.addEventListener('DOMContentLoaded', function () {
        loadThirdPartySummary();

        // Wire up the "Manage External Stats" button
        const btn = document.querySelector('[data-action="openThirdPartyStatsModal"]');
        if (btn) {
            btn.addEventListener('click', function () {
                const modal = document.getElementById('thirdPartyStatsModal');
                modal.classList.add('show');
                activateTab('manual');
            });
        }

        // Wire up close buttons
        document.querySelectorAll('[data-action="closeModal"][data-modal="thirdPartyStatsModal"]').forEach(function (el) {
            el.addEventListener('click', function () {
                document.getElementById('thirdPartyStatsModal').classList.remove('show');
            });
        });

        // Wire up tab buttons
        document.querySelectorAll('[data-tp-tab]').forEach(function (tabBtn) {
            tabBtn.addEventListener('click', function () {
                activateTab(this.getAttribute('data-tp-tab'));
            });
        });

        // Set default date to today
        const dateInput = document.getElementById('tpManualDate');
        if (dateInput) {
            dateInput.value = new Date().toISOString().split('T')[0];
        }
    });

    // -------------------------------------------------------
    // Tab Switching
    // -------------------------------------------------------

    function activateTab(tabName) {
        // Deactivate all tab buttons
        document.querySelectorAll('[data-tp-tab]').forEach(function (btn) {
            btn.classList.remove('active');
        });
        // Activate clicked tab button
        const activeBtn = document.querySelector('[data-tp-tab="' + tabName + '"]');
        if (activeBtn) activeBtn.classList.add('active');

        // Hide all tab content
        document.querySelectorAll('#thirdPartyStatsModal .tab-content').forEach(function (content) {
            content.classList.remove('active');
        });

        // Show target tab content
        var tabMap = {
            'manual': 'tpTabManual',
            'mokuro': 'tpTabMokuro',
            'api': 'tpTabApi',
            'entries': 'tpTabEntries'
        };
        var targetId = tabMap[tabName];
        if (targetId) {
            document.getElementById(targetId).classList.add('active');
        }

        // Load entries when switching to entries tab
        if (tabName === 'entries') {
            loadThirdPartyEntries();
        }
    }

    // -------------------------------------------------------
    // Summary (Card on database page)
    // -------------------------------------------------------

    function loadThirdPartySummary() {
        fetch('/api/third-party-stats/summary')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                document.getElementById('thirdPartyTotalEntries').textContent = data.total_entries || 0;
                document.getElementById('thirdPartyTotalChars').textContent =
                    (data.total_characters || 0).toLocaleString();

                var totalMinutes = Math.round((data.total_time_seconds || 0) / 60);
                var hours = Math.floor(totalMinutes / 60);
                var mins = totalMinutes % 60;
                document.getElementById('thirdPartyTotalTime').textContent =
                    hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';

                // Show per-source breakdown badges
                var sourcesDiv = document.getElementById('thirdPartySources');
                if (sourcesDiv && data.by_source) {
                    sourcesDiv.innerHTML = '';
                    Object.keys(data.by_source).forEach(function (source) {
                        var info = data.by_source[source];
                        var entryCount = info.count != null ? info.count : (info.entries || 0);
                        var badge = document.createElement('span');
                        badge.className = 'tp-source-badge ' + getSourceClass(source);
                        badge.textContent = source + ' (' + entryCount + ')';
                        sourcesDiv.appendChild(badge);
                    });
                }
            })
            .catch(function () {
                document.getElementById('thirdPartyTotalEntries').textContent = '0';
                document.getElementById('thirdPartyTotalChars').textContent = '0';
                document.getElementById('thirdPartyTotalTime').textContent = '0m';
            });
    }

    // -------------------------------------------------------
    // Manual Entry
    // -------------------------------------------------------

    function submitManualEntry() {
        var date = document.getElementById('tpManualDate').value;
        var label = document.getElementById('tpManualLabel').value;
        var source = (document.getElementById('tpManualSource').value || '').trim() || 'manual';
        var chars = parseInt(document.getElementById('tpManualChars').value) || 0;
        var minutes = parseFloat(document.getElementById('tpManualMinutes').value) || 0;
        var resultDiv = document.getElementById('manualEntryResult');

        if (!date) {
            showResult(resultDiv, 'error', 'Please select a date.');
            return;
        }
        if (chars <= 0 && minutes <= 0) {
            showResult(resultDiv, 'error', 'Please enter characters read or time read.');
            return;
        }

        fetch('/api/third-party-stats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                date: date,
                characters_read: chars,
                time_read_seconds: minutes * 60,
                source: source,
                label: label
            })
        })
            .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
            .then(function (resp) {
                if (resp.status === 201) {
                    showResult(resultDiv, 'success',
                        'Entry added: ' + chars.toLocaleString() + ' chars, ' + minutes + 'min on ' + date +
                        ' (source: ' + source + ')');
                    // Reset form fields (keep date and source)
                    document.getElementById('tpManualChars').value = '0';
                    document.getElementById('tpManualMinutes').value = '0';
                    document.getElementById('tpManualLabel').value = '';
                    loadThirdPartySummary();
                } else {
                    showResult(resultDiv, 'error', resp.data.error || 'Failed to add entry');
                }
            })
            .catch(function (err) {
                showResult(resultDiv, 'error', 'Network error: ' + err.message);
            });
    }
    // Expose to global scope for onclick
    window.submitManualEntry = submitManualEntry;

    // -------------------------------------------------------
    // Mokuro Import
    // -------------------------------------------------------

    function importMokuroData() {
        var fileInput = document.getElementById('mokuroFileInput');
        var clearPrevious = document.getElementById('mokuroClearPrevious').checked;
        var resultDiv = document.getElementById('mokuroImportResult');

        if (!fileInput.files || !fileInput.files[0]) {
            showResult(resultDiv, 'error', 'Please select a volume-data.json file.');
            return;
        }

        var formData = new FormData();
        formData.append('file', fileInput.files[0]);
        formData.append('clear_previous', clearPrevious ? 'true' : 'false');

        showResult(resultDiv, 'info', 'Importing... please wait.');

        fetch('/api/import-mokuro', {
            method: 'POST',
            body: formData
        })
            .then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); })
            .then(function (resp) {
                if (resp.status === 200) {
                    var data = resp.data;
                    var html = '<div class="tp-import-result-title success">Import Successful</div>';
                    html += '<div class="stats-row"><span class="stats-label">Daily entries created:</span><span class="stats-value">' + data.imported_count + '</span></div>';
                    html += '<div class="stats-row"><span class="stats-label">Volumes with data:</span><span class="stats-value">' + data.volumes_with_data + '</span></div>';
                    html += '<div class="stats-row"><span class="stats-label">Total characters:</span><span class="stats-value">' + (data.total_characters || 0).toLocaleString() + '</span></div>';
                    html += '<div class="stats-row"><span class="stats-label">Total time:</span><span class="stats-value">' + (data.total_time_minutes || 0) + ' min</span></div>';
                    if (data.date_range && data.date_range.min) {
                        html += '<div class="stats-row"><span class="stats-label">Date range:</span><span class="stats-value">' + data.date_range.min + ' to ' + data.date_range.max + '</span></div>';
                    }
                    if (data.cleared_count > 0) {
                        html += '<div class="stats-row"><span class="stats-label">Previous entries cleared:</span><span class="stats-value">' + data.cleared_count + '</span></div>';
                    }
                    if (data.volumes && data.volumes.length > 0) {
                        html += '<br><details><summary style="cursor:pointer; color: var(--text-secondary); font-weight: 500;">Volumes imported (' + data.volumes.length + ')</summary>';
                        html += '<ul style="margin-top: 8px; font-size: 13px; color: var(--text-secondary); padding-left: 20px;">';
                        data.volumes.forEach(function (v) { html += '<li>' + escapeHtml(v) + '</li>'; });
                        html += '</ul></details>';
                    }
                    resultDiv.className = 'tp-import-result';
                    resultDiv.style.display = 'block';
                    resultDiv.innerHTML = html;
                    loadThirdPartySummary();
                    fileInput.value = '';
                } else {
                    showResult(resultDiv, 'error', resp.data.error || 'Import failed');
                }
            })
            .catch(function (err) {
                showResult(resultDiv, 'error', 'Network error: ' + err.message);
            });
    }
    window.importMokuroData = importMokuroData;

    // -------------------------------------------------------
    // Entries List
    // -------------------------------------------------------

    function loadThirdPartyEntries() {
        var loading = document.getElementById('tpEntriesLoading');
        var scroll = document.getElementById('tpEntriesScroll');
        var empty = document.getElementById('tpEntriesEmpty');

        loading.style.display = 'flex';
        scroll.style.display = 'none';
        empty.style.display = 'none';

        fetch('/api/third-party-stats')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                loading.style.display = 'none';
                allEntries = data.entries || [];

                if (allEntries.length === 0) {
                    empty.style.display = 'block';
                    buildFilterButtons([]);
                    buildClearButtons([]);
                    return;
                }

                // Sort by date descending
                allEntries.sort(function (a, b) { return b.date.localeCompare(a.date); });

                // Discover sources
                var sourceSet = {};
                allEntries.forEach(function (e) { sourceSet[e.source] = true; });
                knownSources = Object.keys(sourceSet).sort();

                buildFilterButtons(knownSources);
                buildClearButtons(knownSources);
                renderEntries();
            })
            .catch(function (err) {
                loading.style.display = 'none';
                empty.style.display = 'block';
                empty.querySelector('p').textContent = 'Error loading entries: ' + err.message;
            });
    }

    function buildFilterButtons(sources) {
        var group = document.querySelector('.tp-filter-group');
        if (!group) return;
        group.innerHTML = '';

        // "All" button
        var allBtn = document.createElement('button');
        allBtn.className = 'tp-filter-btn' + (activeFilter === 'all' ? ' active' : '');
        allBtn.setAttribute('data-tp-filter', 'all');
        allBtn.textContent = 'All (' + allEntries.length + ')';
        allBtn.addEventListener('click', function () { setFilter('all'); });
        group.appendChild(allBtn);

        // Per-source buttons
        sources.forEach(function (source) {
            var count = allEntries.filter(function (e) { return e.source === source; }).length;
            var btn = document.createElement('button');
            btn.className = 'tp-filter-btn' + (activeFilter === source ? ' active' : '');
            btn.setAttribute('data-tp-filter', source);
            btn.textContent = source + ' (' + count + ')';
            btn.addEventListener('click', function () { setFilter(source); });
            group.appendChild(btn);
        });
    }

    function buildClearButtons(sources) {
        var group = document.getElementById('tpClearButtons');
        if (!group) return;
        group.innerHTML = '';

        sources.forEach(function (source) {
            var btn = document.createElement('button');
            btn.className = 'action-btn warning';
            btn.style.cssText = 'padding: 5px 12px; font-size: 12px;';
            btn.textContent = 'Clear ' + source;
            btn.title = 'Delete all ' + source + ' entries';
            btn.addEventListener('click', function () { deleteAllBySource(source); });
            group.appendChild(btn);
        });
    }

    function setFilter(source) {
        activeFilter = source;
        // Update button states
        document.querySelectorAll('.tp-filter-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-tp-filter') === source);
        });
        renderEntries();
    }

    function renderEntries() {
        var tbody = document.getElementById('tpEntriesBody');
        var scroll = document.getElementById('tpEntriesScroll');
        var empty = document.getElementById('tpEntriesEmpty');

        var filtered = activeFilter === 'all'
            ? allEntries
            : allEntries.filter(function (e) { return e.source === activeFilter; });

        if (filtered.length === 0) {
            scroll.style.display = 'none';
            empty.style.display = 'block';
            return;
        }

        tbody.innerHTML = '';
        filtered.forEach(function (entry) {
            var tr = document.createElement('tr');
            var minutes = Math.round(entry.time_read_seconds / 60);
            var hours = Math.floor(minutes / 60);
            var mins = minutes % 60;
            var timeStr = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
            var sourceClass = getSourceClass(entry.source);

            tr.innerHTML =
                '<td>' + escapeHtml(entry.date) + '</td>' +
                '<td><span class="tp-source-badge ' + sourceClass + '">' + escapeHtml(entry.source) + '</span></td>' +
                '<td class="label-cell" title="' + escapeHtml(entry.label || '') + '">' + escapeHtml(entry.label || '-') + '</td>' +
                '<td class="text-right">' + (entry.characters_read || 0).toLocaleString() + '</td>' +
                '<td class="text-right">' + timeStr + '</td>' +
                '<td class="text-center"><button class="action-btn danger delete-entry-btn" data-entry-id="' + entry.id + '">Delete</button></td>';

            // Wire up delete button
            tr.querySelector('.delete-entry-btn').addEventListener('click', function () {
                deleteThirdPartyEntry(entry.id);
            });

            tbody.appendChild(tr);
        });

        scroll.style.display = 'block';
        empty.style.display = 'none';
    }

    // -------------------------------------------------------
    // Delete Operations
    // -------------------------------------------------------

    function deleteThirdPartyEntry(id) {
        showDatabaseConfirm('Delete this entry?', function () {
            fetch('/api/third-party-stats/' + id, { method: 'DELETE' })
                .then(function (r) { return r.json(); })
                .then(function () {
                    loadThirdPartyEntries();
                    loadThirdPartySummary();
                })
                .catch(function (err) {
                    showDatabaseError('Failed to delete: ' + err.message);
                });
        });
    }

    function deleteAllBySource(source) {
        showDatabaseConfirm('Delete ALL "' + source + '" entries? This cannot be undone.', function () {
            fetch('/api/third-party-stats/source/' + encodeURIComponent(source), { method: 'DELETE' })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    showDatabaseSuccess(data.message || 'Deleted successfully');
                    loadThirdPartyEntries();
                    loadThirdPartySummary();
                })
                .catch(function (err) {
                    showDatabaseError('Failed to delete: ' + err.message);
                });
        });
    }
    window.deleteAllBySource = deleteAllBySource;

    // -------------------------------------------------------
    // Popup Helpers (use existing database popups)
    // -------------------------------------------------------

    function showDatabaseSuccess(message) {
        var popup = document.getElementById('databaseSuccessPopup');
        var msg = document.getElementById('databaseSuccessMessage');
        if (popup && msg) {
            msg.textContent = message;
            popup.classList.remove('hidden');
        }
    }

    function showDatabaseError(message) {
        var popup = document.getElementById('databaseErrorPopup');
        var msg = document.getElementById('databaseErrorMessage');
        if (popup && msg) {
            msg.textContent = message;
            popup.classList.remove('hidden');
        }
    }

    function showDatabaseConfirm(message, onYes) {
        var popup = document.getElementById('databaseConfirmPopup');
        var msg = document.getElementById('databaseConfirmMessage');
        var yesBtn = document.getElementById('databaseConfirmYesBtn');
        var noBtn = document.getElementById('databaseConfirmNoBtn');

        if (!popup || !msg || !yesBtn || !noBtn) {
            // Fallback to native confirm if popups aren't available
            if (confirm(message)) onYes();
            return;
        }

        msg.textContent = message;
        popup.classList.remove('hidden');

        // Clone and replace to remove old listeners
        var newYes = yesBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(newYes, yesBtn);
        var newNo = noBtn.cloneNode(true);
        noBtn.parentNode.replaceChild(newNo, noBtn);

        newYes.addEventListener('click', function () {
            popup.classList.add('hidden');
            onYes();
        });
        newNo.addEventListener('click', function () {
            popup.classList.add('hidden');
        });
    }

    // -------------------------------------------------------
    // Result Display Helper
    // -------------------------------------------------------

    function showResult(div, type, message) {
        div.style.display = 'block';
        var typeClass = type === 'success' ? '' : (type === 'error' ? ' error' : ' info');
        div.className = 'tp-import-result' + typeClass;

        var titleClass = type;
        var icon = type === 'success' ? '&#10003; ' : (type === 'error' ? '&#10007; ' : '');
        div.innerHTML = '<div class="tp-import-result-title ' + titleClass + '">' + icon + escapeHtml(message) + '</div>';
    }

    // -------------------------------------------------------
    // Utility
    // -------------------------------------------------------

    function getSourceClass(source) {
        var s = (source || '').toLowerCase();
        if (s === 'mokuro') return 'mokuro';
        if (s === 'manual') return 'manual';
        if (s === 'ttsu' || s === 'ttu') return 'ttsu';
        return 'generic';
    }

    function escapeHtml(str) {
        if (!str) return '';
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

})();
