// Database maintenance controls. Jobs survive page navigation on the server.
let archiveFileActionRunning = false;

function updateArchiveFileControls() {
    document.querySelectorAll('[data-archive-action]').forEach(button => {
        button.disabled = archiveFileActionRunning || button.dataset.unavailable === 'true';
    });
    document.getElementById('refreshArchiveFiles').disabled = archiveFileActionRunning;
}

async function loadArchiveFiles() {
    const response = await fetch('/api/database/archive-files');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load archive files');
    document.getElementById('archiveFilesDirectory').textContent = data.directory;
    const list = document.getElementById('archiveFilesList');
    list.replaceChildren();
    if (!data.archives.length) list.textContent = 'No saved game archive files. Archive a game from Games to create one.';
    for (const file of data.archives) {
        const row = document.createElement('div');
        row.className = 'archive-file-row';
        const name = document.createElement('strong');
        name.className = 'archive-file-name';
        name.textContent = file.game_name;
        name.title = file.filename;
        const details = document.createElement('p');
        details.className = 'archive-file-details';
        details.textContent = (file.line_count == null ? '' : `${file.line_count.toLocaleString()} sentences · `) +
            `${(file.size_bytes / 1048576).toFixed(2)} MB`;
        if (file.error) details.textContent += ` · ${file.error}`;
        const actions = document.createElement('div');
        actions.className = 'archive-file-actions';
        const download = document.createElement('a');
        download.className = 'action-btn primary';
        download.href = `/api/database/archive-files/${encodeURIComponent(file.file_id)}/download`;
        download.download = file.filename;
        download.textContent = 'Download ZIP';
        download.setAttribute('aria-label', `Download archive for ${file.game_name}`);
        actions.append(download);
        for (const [action, label] of [['restore', 'Restore'], ['delete', 'Delete file']]) {
            const button = document.createElement('button');
            button.className = 'action-btn' + (action === 'delete' ? ' danger' : '');
            button.textContent = label;
            button.dataset.archiveAction = action;
            button.dataset.unavailable = String(action === 'restore' && !file.can_restore);
            button.setAttribute('aria-label', `${label} for ${file.game_name}`);
            button.addEventListener('click', () => manageArchiveFile(file, action));
            actions.append(button);
        }
        row.append(name, details, actions);
        list.append(row);
    }
    updateArchiveFileControls();
}

async function manageArchiveFile(file, action) {
    if (archiveFileActionRunning) return;
    const message = action === 'delete'
        ? `Delete the saved archive file for “${file.game_name}”?\n\nThis permanently deletes this copy of the original sentences and translations. Statistics and kanji will remain in GSM. Keep or download the ZIP first if you want to restore the sentences later.`
        : `Restore original sentences for “${file.game_name}” to the database?\n\nExisting sentences will be kept, and statistics will still count each sentence once. The ZIP will be kept. Your automatic archiving schedule will still apply.`;
    if (!window.confirm(message)) return;
    archiveFileActionRunning = true;
    updateArchiveFileControls();
    const status = document.getElementById('archiveFilesStatus');
    status.textContent = action === 'delete' ? 'Deleting archive file…' : 'Restoring sentences… This can take a while for large games.';
    try {
        const result = await runDatabaseMaintenanceJob(
            `/api/database/archive-files/${encodeURIComponent(file.file_id)}/${action}`, {confirm: true});
        await loadArchiveFiles();
        if (action === 'restore') {
            await loadDatabaseMaintenance();
            if (typeof databaseManager !== 'undefined') await databaseManager.loadDashboardStats();
        }
        status.textContent = action === 'delete'
            ? 'Archive file deleted. Statistics and kanji are unchanged.'
            : `Restored ${result.restored_lines.toLocaleString()} sentences. The archive file was kept.` +
              (result.skipped_lines ? ` ${result.skipped_lines.toLocaleString()} sentences were already in the database.` : '');
    } catch (error) { status.textContent = error.message; }
    finally { archiveFileActionRunning = false; updateArchiveFileControls(); }
}

async function loadDatabaseMaintenance() {
    const response = await fetch('/api/database/maintenance');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load database maintenance');
    const mb = value => `${(value / 1048576).toFixed(1)} MB`;
    document.getElementById('databaseStorageStatus').textContent =
        `${mb(data.storage.database_bytes)} · ${mb(data.storage.reclaimable_bytes)} reclaimable · ` +
        `${data.storage.raw_lines.toLocaleString()} original sentences · ${data.storage.archived_lines.toLocaleString()} archived`;
    const interval = document.getElementById('vacuumIntervalDays');
    if (![...interval.options].some(option => Number(option.value) === data.settings.vacuum_interval_days)) {
        interval.add(new Option(`${data.settings.vacuum_interval_days} days`, data.settings.vacuum_interval_days));
    }
    interval.value = String(data.settings.vacuum_interval_days);
    document.getElementById('archiveAfterAge').value = data.settings.archive_after_days;
    document.getElementById('archiveAgeUnit').value = '1';
    for (const id of ['vacuumIntervalDays', 'archiveAfterAge', 'archiveAgeUnit', 'saveDatabaseMaintenance']) {
        document.getElementById(id).disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const status = document.getElementById('databaseMaintenanceStatus');
    if (!status) return;
    loadDatabaseMaintenance().catch(error => { status.textContent = error.message; });
    const fileStatus = document.getElementById('archiveFilesStatus');
    loadArchiveFiles().catch(error => { fileStatus.textContent = error.message; });
    document.getElementById('refreshArchiveFiles').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await loadArchiveFiles(); fileStatus.textContent = ''; }
        catch (error) { fileStatus.textContent = error.message; }
        finally { updateArchiveFileControls(); }
    });
    document.getElementById('saveDatabaseMaintenance').addEventListener('click', async event => {
        const age = Number(document.getElementById('archiveAfterAge').value);
        const days = age * Number(document.getElementById('archiveAgeUnit').value);
        if (!Number.isInteger(age) || days < 0 || days > 3650) {
            status.textContent = 'Enter a whole number between 0 and 3650 days (up to 521 weeks).';
            return;
        }
        if (days && !window.confirm(`Automatically archive completed games after ${days} days without new sentences? Original sentences will be saved in a compressed file per game, then removed from the database. Statistics and kanji will remain. Files stay until you delete them.`)) return;
        event.currentTarget.disabled = true;
        try {
            const response = await fetch('/api/database/maintenance', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({vacuum_interval_days: Number(document.getElementById('vacuumIntervalDays').value), archive_after_days: days})
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to save schedule');
            status.textContent = 'Schedule saved. GSM checks maintenance daily while running.';
        } catch (error) { status.textContent = error.message; }
        finally { document.getElementById('saveDatabaseMaintenance').disabled = false; }
    });
    document.getElementById('vacuumDatabaseNow').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        status.textContent = 'Compacting database… Capturing new sentences may pause until this finishes.';
        try {
            const result = await runDatabaseMaintenanceJob('/api/database/vacuum', {});
            status.textContent = `Vacuum complete. Reclaimed ${(result.reclaimed_bytes / 1048576).toFixed(1)} MB.`;
            await loadDatabaseMaintenance();
        } catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
    });
});
