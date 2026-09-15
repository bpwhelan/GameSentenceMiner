(() => {
    'use strict';
    const card = document.getElementById('kechimochiSyncCard');
    if (!card) return;
    const el = name => document.getElementById(`kechimochi${name}`);
    const number = value => Number(value || 0).toLocaleString();
    const dateTime = timestamp => new Date(timestamp * 1000).toLocaleString();
    let loaded = false;
    let dirty = false;
    let busy = false;
    let running = false;
    let pollTimer;
    let refreshing = false;

    async function api(path, data) {
        const response = await fetch(`/api/kechimochi/${path}`, data === undefined ? {} : {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)
        });
        let payload;
        try { payload = await response.json(); }
        catch { throw new Error('GSM returned an unreadable response. Check that the backend is running.'); }
        if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
        return payload;
    }

    function message(text, error = false) {
        el('Message').textContent = text;
        el('Message').dataset.error = String(error);
        el('Message').hidden = !text;
    }

    function updateControls() {
        el('Fields').disabled = busy || running || !loaded;
        el('Sync').disabled = busy || running || !loaded || dirty;
        el('Preview').disabled = busy || running || !loaded || dirty;
        el('Sync').textContent = running ? 'Syncing…' : 'Sync now';
        el('TimeGroup').hidden = el('Schedule').value !== 'daily';
    }

    function fillSettings(settings) {
        el('Url').value = settings.url;
        el('Enabled').checked = settings.enabled;
        el('Schedule').value = settings.schedule;
        el('Time').value = settings.sync_time;
        el('External').checked = settings.include_external_stats;
        el('Covers').checked = settings.sync_covers;
        el('Adopt').checked = settings.adopt_matching_logs;
    }

    function renderStatus(status) {
        running = ['queued', 'running'].includes(status.status);
        if (!loaded) {
            fillSettings(status.settings);
            loaded = true;
        }
        const labels = {
            idle: 'Ready for your first full sync', completed: 'History is up to date',
            failed: 'Sync needs attention', interrupted: 'Sync will resume', queued: 'Sync queued'
        };
        el('State').textContent = running ? status.phase || 'Syncing…' : labels[status.status] || status.status;
        el('LastRun').textContent = status.last_success_at ? `Last successful sync: ${dateTime(status.last_success_at)}` : 'No completed sync yet.';
        el('NextRun').textContent = status.next_run ? `Next automatic sync: ${dateTime(status.next_run)}` : 'Automatic sync is off.';
        el('Progress').hidden = !running;
        if (status.total > 0) el('Progress').value = Math.round(status.processed / status.total * 100);
        else el('Progress').removeAttribute('value');
        const result = status.result;
        el('Result').textContent = result ?
            `${number(result.activity_count)} activities · ${number(result.characters)} characters · ${number(result.duration_minutes)} minutes. ` +
            `${number(result.logs_created)} added, ${number(result.logs_updated)} updated, ${number(result.logs_deleted)} removed.` : '';
        if (status.error) message(status.error, true);
        else if (result?.warnings?.length) message(result.warnings.join(' '));
        else if (status.status === 'completed' && el('Message').dataset.error === 'true') message('');
        updateControls();
    }

    async function refresh() {
        if (refreshing) return;
        refreshing = true;
        clearTimeout(pollTimer);
        try { renderStatus(await api('status')); }
        catch (error) { message(error.message, true); }
        finally {
            refreshing = false;
            pollTimer = setTimeout(refresh, running ? 1000 : 15000);
        }
    }

    async function action(work) {
        if (busy) return;
        busy = true;
        message('');
        updateControls();
        try { await work(); }
        catch (error) { message(error.message, true); }
        finally { busy = false; updateControls(); }
    }

    el('SettingsForm').addEventListener('input', () => {
        dirty = true;
        message('Save your changes before syncing or previewing.');
        updateControls();
    });
    el('SettingsForm').addEventListener('submit', event => {
        event.preventDefault();
        action(async () => {
            const settings = await api('settings', {
                url: el('Url').value, enabled: el('Enabled').checked,
                schedule: el('Schedule').value, sync_time: el('Time').value,
                include_external_stats: el('External').checked, sync_covers: el('Covers').checked,
                adopt_matching_logs: el('Adopt').checked
            });
            fillSettings(settings);
            dirty = false;
            message(settings.enabled ? 'Settings saved. Full history sync has started.' : 'Settings saved.');
            await refresh();
        });
    });
    el('Test').addEventListener('click', () => action(async () => {
        const result = await api('test', {url: el('Url').value});
        message(`Connected to Kechimochi (${result.version}). ${number(result.media_count)} media entries found.`);
    }));
    el('Sync').addEventListener('click', () => action(async () => {
        await api('sync', {});
        running = true;
        message('Full history sync queued. You can leave this page while it runs.');
        await refresh();
    }));
    el('Preview').addEventListener('click', () => action(async () => {
        message('Reading your complete GSM history…');
        const preview = await api('preview');
        el('PreviewSummary').textContent = `${number(preview.activity_count)} activities across ${number(preview.media_count)} media entries. ` +
            `${number(preview.characters)} characters and ${number(preview.duration_minutes)} minutes. ` +
            (preview.first_date ? `${preview.first_date} to ${preview.last_date}. ` : '') +
            (preview.activity_count > 100 ? 'Showing the first 100 activities.' : '');
        const rows = preview.entries.map(entry => {
            const row = document.createElement('tr');
            for (const value of [entry.date, entry.title, number(entry.characters), number(entry.duration_minutes)]) {
                const cell = document.createElement('td');
                cell.textContent = value;
                row.appendChild(cell);
            }
            return row;
        });
        el('PreviewRows').replaceChildren(...rows);
        el('PreviewPanel').hidden = false;
        message('This preview includes all history; unchanged entries are reused on subsequent syncs.');
    }));
    window.addEventListener('pagehide', () => clearTimeout(pollTimer));
    updateControls();
    refresh();
})();
