// Saved lines page: list lines saved for later, play their audio, enrich the latest Anki card, trash them.
(() => {
    const $ = (id) => document.getElementById(id);
    const list = $('savedList');
    const status = $('savedStatus');
    const search = $('savedSearch');
    const sort = $('savedSort');
    const count = $('savedCount');
    const empty = $('savedEmpty');
    const selectionBar = $('savedSelection');
    const selectAll = $('savedSelectAll');
    const deleteSelected = $('savedDeleteSelected');
    const player = new Audio();
    const enrichParts = {
        warnings: $('enrichWarnings'),
        cardWord: $('enrichCardWord'),
        cardSentence: $('enrichCardSentence'),
        cardPicture: $('enrichCardPicture'),
        cardAudio: $('enrichCardAudio'),
        cardNoMedia: $('enrichCardNoMedia'),
        savedSentence: $('enrichSavedSentence'),
        savedAudio: $('enrichSavedAudio'),
    };
    let items = [];
    let disk = { saved: 0, total: null, used: null, free: null };
    let playingId = '';
    const selected = new Set();

    function showStatus(message, isError = false) {
        status.textContent = message;
        status.classList.toggle('is-error', isError);
        status.hidden = !message;
        if (message) status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes)) return '';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = bytes;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit += 1;
        }
        return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
    }

    function formatTime(iso) {
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatDay(iso) {
        const date = new Date(iso);
        return Number.isNaN(date.getTime())
            ? 'Unknown date'
            : date.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function shownItems() {
        const query = search.value.trim().toLowerCase();
        const shown = items.filter(
            (item) => !query || item.sentence.toLowerCase().includes(query) || item.game.toLowerCase().includes(query)
        );
        if (sort.value === 'largest') shown.sort((a, b) => b.size_bytes - a.size_bytes);
        else if (sort.value === 'oldest') shown.sort((a, b) => a.line_time.localeCompare(b.line_time));
        return shown;
    }

    function renderItem(item, grouped) {
        const card = element('article', 'saved-item');
        card.classList.toggle('is-selected', selected.has(item.id));
        const pick = element('input', 'saved-item-select');
        pick.type = 'checkbox';
        pick.checked = selected.has(item.id);
        pick.setAttribute('aria-label', 'Select this saved line');
        pick.addEventListener('change', () => {
            if (pick.checked) selected.add(item.id);
            else selected.delete(item.id);
            render();
        });
        card.append(pick);

        const before = item.lines.filter((line) => line.role === 'previous').map((line) => line.text).join('\n');
        const after = item.lines.filter((line) => line.role === 'next').map((line) => line.text).join('\n');
        if (before) card.append(element('p', 'saved-context', before));
        const sentence = element('p', 'saved-sentence', item.sentence);
        sentence.lang = 'ja';
        card.append(sentence);
        if (after) card.append(element('p', 'saved-context', after));

        const meta = element('div', 'saved-meta');
        if (item.game) meta.append(element('span', '', item.game));
        const when = grouped ? formatTime(item.line_time) : `${formatDay(item.line_time)} ${formatTime(item.line_time)}`;
        meta.append(element('span', '', when));
        const size = element('span', 'saved-size', formatBytes(item.size_bytes));
        size.title = 'Disk space used by this saved line';
        meta.append(size);
        if (item.cards.length) {
            const badge = element('span', 'saved-badge', item.cards.length === 1 ? '1 card' : `${item.cards.length} cards`);
            badge.title = item.cards.map((c) => c.word).filter(Boolean).join(', ');
            meta.append(badge);
        }
        card.append(meta);

        const actions = element('div', 'saved-actions');
        const play = element('button', 'saved-play', playingId === item.id ? '⏹ Stop' : '▶ Play');
        play.addEventListener('click', () => togglePlay(item.id));
        const enrich = element('button', 'saved-enrich', '✨ Enrich latest card');
        enrich.title = "Add this line's audio and screenshot to the card you added to Anki most recently";
        enrich.addEventListener('click', () => enrichLatest(item.id, enrich));
        const trash = element('button', 'saved-delete', '🗑 Delete');
        trash.title = 'Move to the trash (can be restored from there)';
        trash.addEventListener('click', () => trashItems([item.id]));
        actions.append(play, enrich, trash);
        card.append(actions);
        return card;
    }

    function renderDisk() {
        const box = $('savedDisk');
        if (!Number.isFinite(disk.total) || disk.total <= 0) {
            box.hidden = true;
            return;
        }
        box.hidden = false;
        const other = Math.max(0, (disk.used || 0) - disk.saved);
        $('savedDiskSaved').style.width = `${(disk.saved / disk.total) * 100}%`;
        $('savedDiskSaved').hidden = disk.saved === 0;
        $('savedDiskOther').style.width = `${(other / disk.total) * 100}%`;
        $('savedDiskSavedLabel').textContent = `Saved lines ${formatBytes(disk.saved)}`;
        $('savedDiskOtherLabel').textContent = `Other files ${formatBytes(other)}`;
        $('savedDiskFreeLabel').textContent = `Free ${formatBytes(disk.free)} of ${formatBytes(disk.total)}`;
        $('savedDiskBar').setAttribute(
            'aria-label',
            `Saved lines use ${formatBytes(disk.saved)}; ${formatBytes(disk.free)} of ${formatBytes(disk.total)} free`
        );
    }

    function render() {
        const shown = shownItems();
        const grouped = sort.value !== 'largest';
        list.replaceChildren();
        let currentDay = '';
        for (const item of shown) {
            const day = formatDay(item.line_time);
            if (grouped && day !== currentDay) {
                list.append(element('h2', 'saved-day', day));
                currentDay = day;
            }
            list.append(renderItem(item, grouped));
        }

        for (const id of [...selected]) if (!items.some((item) => item.id === id)) selected.delete(id);
        const shownSelected = shown.filter((item) => selected.has(item.id)).length;
        selectAll.checked = shown.length > 0 && shownSelected === shown.length;
        selectAll.indeterminate = shownSelected > 0 && shownSelected < shown.length;
        const selectedBytes = items.filter((item) => selected.has(item.id)).reduce((sum, item) => sum + item.size_bytes, 0);
        deleteSelected.disabled = selected.size === 0;
        deleteSelected.textContent = selected.size
            ? `🗑 Delete selected (${selected.size} · ${formatBytes(selectedBytes)})`
            : '🗑 Delete selected';
        selectionBar.hidden = items.length === 0;

        const noun = items.length === 1 ? 'line' : 'lines';
        count.textContent = items.length
            ? shown.length === items.length
                ? `${items.length} ${noun}`
                : `${shown.length} of ${items.length} ${noun}`
            : '';
        empty.hidden = items.length > 0;
        renderDisk();
    }

    async function load() {
        try {
            const response = await fetch('/api/saved-lines', { cache: 'no-store' });
            const data = await response.json();
            items = data.saved_lines || [];
            const number = (value) => (Number.isFinite(value) ? value : null);
            disk = {
                saved: data.total_bytes || 0,
                total: number(data.disk_total_bytes),
                used: number(data.disk_used_bytes),
                free: number(data.disk_free_bytes),
            };
            if (data.error) showStatus(data.error, true);
            render();
        } catch (error) {
            showStatus(`Could not load saved lines: ${error.message}`, true);
        }
    }

    function togglePlay(id) {
        if (playingId === id) {
            player.pause();
            playingId = '';
        } else {
            player.src = `/api/saved-lines/audio?id=${encodeURIComponent(id)}`;
            player.play().catch((error) => showStatus(`Could not play the audio: ${error.message}`, true));
            playingId = id;
        }
        render();
    }

    player.addEventListener('ended', () => {
        playingId = '';
        render();
    });

    function stopPlayback() {
        player.pause();
        playingId = '';
    }

    // Opens a modal; resolves true when its confirm button is pressed, false on cancel, Escape or backdrop.
    function openModal(modal) {
        modal.classList.add('show');
        modal.querySelector('[data-modal-confirm]').focus();
        return new Promise((resolve) => {
            const close = (result) => {
                modal.classList.remove('show');
                modal.querySelectorAll('audio').forEach((audio) => audio.pause());
                modal.removeEventListener('click', onClick);
                document.removeEventListener('keydown', onKey);
                resolve(result);
            };
            const onClick = (event) => {
                if (event.target === modal || event.target.closest('[data-modal-close]')) close(false);
                else if (event.target.closest('[data-modal-confirm]')) close(true);
            };
            const onKey = (event) => {
                if (event.key === 'Escape') close(false);
            };
            modal.addEventListener('click', onClick);
            document.addEventListener('keydown', onKey);
        });
    }

    function cardMediaUrl(noteId, kind) {
        return `/api/saved-lines/card-media?note_id=${encodeURIComponent(noteId)}&kind=${kind}&t=${Date.now()}`;
    }

    // Shows the latest card next to the saved line before replacing its media.
    function confirmEnrich(data, id) {
        const parts = enrichParts;
        const media = data.card_media || {};
        parts.warnings.replaceChildren(...(data.warnings || []).map((warning) => element('li', '', warning.message)));
        parts.cardWord.textContent = data.card_word || '';
        parts.cardSentence.textContent = data.card_sentence || '';
        parts.savedSentence.textContent = data.saved_sentence || '';
        parts.cardPicture.hidden = !media.picture;
        parts.cardPicture.src = media.picture ? cardMediaUrl(data.note_id, 'picture') : '';
        parts.cardAudio.hidden = !media.audio;
        parts.cardAudio.src = media.audio ? cardMediaUrl(data.note_id, 'audio') : '';
        parts.cardNoMedia.hidden = Boolean(media.audio || media.picture);
        parts.savedAudio.src = `/api/saved-lines/audio?id=${encodeURIComponent(id)}`;
        stopPlayback();
        render();
        return openModal($('enrichModal'));
    }

    async function enrichLatest(id, button, confirm = false) {
        button.disabled = true;
        try {
            const response = await fetch('/api/saved-lines/enrich', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, confirm }),
            });
            const data = await response.json().catch(() => ({}));
            if (response.status === 202) {
                showStatus('Enriching the latest card with this line. If the confirmation dialog is on, it opens on the desktop.');
                setTimeout(load, 5000);
                return;
            }
            if (response.status === 409) {
                if (!data.can_confirm) {
                    showStatus((data.warnings || []).map((warning) => warning.message).join('\n'), true);
                } else if (await confirmEnrich(data, id)) {
                    await enrichLatest(id, button, true);
                }
                return;
            }
            showStatus(data.error || `Enrich failed (HTTP ${response.status})`, true);
        } catch (error) {
            showStatus(`Enrich failed: ${error.message}`, true);
        } finally {
            button.disabled = false;
        }
    }

    async function trashItems(ids) {
        const chosen = items.filter((item) => ids.includes(item.id));
        if (!chosen.length) return;
        const bytes = chosen.reduce((sum, item) => sum + item.size_bytes, 0);
        $('trashModalTitle').textContent = chosen.length === 1 ? 'Move this line to the trash?' : `Move ${chosen.length} lines to the trash?`;
        $('trashModalMessage').textContent = `This frees ${formatBytes(bytes)}.`;
        const preview = chosen.slice(0, 8).map((item) => element('li', '', item.sentence.replace(/\s+/g, ' ')));
        if (chosen.length > 8) preview.push(element('li', '', `…and ${chosen.length - 8} more`));
        $('trashModalList').replaceChildren(...preview);
        if (!(await openModal($('trashModal')))) return;

        try {
            const response = await fetch('/api/saved-lines/trash', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: chosen.map((item) => item.id) }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                showStatus(data.error || `Delete failed (HTTP ${response.status})`, true);
                return;
            }
            if ((data.trashed || []).includes(playingId)) stopPlayback();
            (data.trashed || []).forEach((id) => selected.delete(id));
            const failed = data.failed || [];
            if (failed.length) {
                showStatus(`${failed.length} could not be moved to the trash:\n${failed.map((f) => f.error).join('\n')}`, true);
            } else {
                showStatus(chosen.length === 1 ? 'Moved to the trash.' : `Moved ${chosen.length} lines to the trash.`);
            }
        } catch (error) {
            showStatus(`Delete failed: ${error.message}`, true);
        }
        load();
    }

    // Remember whether the instructions were collapsed (per browser only).
    const help = $('savedHelp');
    try {
        if (localStorage.getItem('gsm-saved-help-collapsed') === '1') help.open = false;
    } catch (error) {
        // Storage can be unavailable; the instructions just stay open.
    }
    help.addEventListener('toggle', () => {
        try {
            localStorage.setItem('gsm-saved-help-collapsed', help.open ? '0' : '1');
        } catch (error) {
            // Ignore: remembering the choice is only a convenience.
        }
    });

    selectAll.addEventListener('change', () => {
        for (const item of shownItems()) {
            if (selectAll.checked) selected.add(item.id);
            else selected.delete(item.id);
        }
        render();
    });
    deleteSelected.addEventListener('click', () => trashItems([...selected]));
    search.addEventListener('input', render);
    sort.addEventListener('change', render);
    window.addEventListener('focus', load);
    load();
})();
