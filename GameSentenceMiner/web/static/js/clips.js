// Clips to mine page: list clips, play their audio, enrich the latest Anki card, trash them.
(() => {
    const $ = (id) => document.getElementById(id);
    const list = $('clipsList');
    const status = $('clipsStatus');
    const search = $('clipsSearch');
    const sort = $('clipsSort');
    const count = $('clipsCount');
    const empty = $('clipsEmpty');
    const noResults = $('clipsNoResults');
    const selectAll = $('clipsSelectAll');
    const deleteSelected = $('clipsDeleteSelected');
    const player = new Audio();
    const enrichParts = {
        warnings: $('enrichWarnings'),
        cardWord: $('enrichCardWord'),
        cardSentence: $('enrichCardSentence'),
        cardPicture: $('enrichCardPicture'),
        cardAudio: $('enrichCardAudio'),
        cardNoMedia: $('enrichCardNoMedia'),
        clipsSentence: $('enrichSavedSentence'),
        clipsAudio: $('enrichSavedAudio'),
    };
    let items = [];
    let disk = { clips: 0, total: null, used: null, free: null };
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

    // Same format as the Search page's result dates.
    function formatDate(iso) {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${date.toTimeString().split(' ')[0]}`;
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

    function metadataItem(label, value, title) {
        const node = element('div', 'metadata-item');
        node.append(element('span', 'metadata-label', label), element('span', 'metadata-value', value));
        if (title) node.title = title;
        return node;
    }

    // Laid out like a Search page result: checkbox, sentence, then a metadata row.
    function renderItem(item) {
        const card = element('div', 'search-result clips-result');
        card.classList.toggle('is-selected', selected.has(item.id));
        const pick = element('input', 'line-checkbox');
        pick.type = 'checkbox';
        pick.checked = selected.has(item.id);
        pick.setAttribute('aria-label', 'Select this clip');
        pick.addEventListener('change', () => {
            if (pick.checked) selected.add(item.id);
            else selected.delete(item.id);
            render();
        });

        const content = element('div', 'clips-result-content');
        const before = item.lines.filter((line) => line.role === 'previous').map((line) => line.text).join('\n');
        const after = item.lines.filter((line) => line.role === 'next').map((line) => line.text).join('\n');
        if (before) content.append(element('p', 'clips-context', before));
        const sentence = element('div', 'result-sentence', item.sentence);
        sentence.lang = 'ja';
        content.append(sentence);
        if (after) content.append(element('p', 'clips-context', after));

        const meta = element('div', 'result-metadata');
        if (item.game) {
            const game = element('div', 'metadata-item');
            game.append(element('span', 'game-tag', item.game));
            meta.append(game);
        }
        meta.append(metadataItem('📅', formatDate(item.line_time)));
        meta.append(metadataItem('💾', formatBytes(item.size_bytes), 'Disk space used by this clip'));
        if (item.cards.length) {
            const words = item.cards.map((c) => c.word).filter(Boolean).join(', ');
            meta.append(metadataItem('🃏', item.cards.length === 1 ? '1 card' : `${item.cards.length} cards`, words));
        }
        content.append(meta);

        const actions = element('div', 'clips-actions');
        const play = element('button', 'action-btn', playingId === item.id ? '⏹ Stop' : '▶ Play');
        play.addEventListener('click', () => togglePlay(item.id));
        const enrich = element('button', 'action-btn primary', '✨ Enrich latest card');
        enrich.title = "Add this clip's audio and screenshot to the card you added to Anki most recently";
        enrich.addEventListener('click', () => enrichLatest(item.id, enrich));
        const trash = element('button', 'action-btn danger clips-delete', '🗑 Delete');
        trash.title = 'Move to the trash (can be restored from there)';
        trash.addEventListener('click', () => trashItems([item.id]));
        actions.append(play, enrich, trash);
        content.append(actions);

        card.append(pick, content);
        return card;
    }

    function renderDisk() {
        const box = $('clipsDisk');
        if (!Number.isFinite(disk.total) || disk.total <= 0) {
            box.hidden = true;
            return;
        }
        box.hidden = false;
        const other = Math.max(0, (disk.used || 0) - disk.clips);
        $('clipsDiskShare').style.width = `${(disk.clips / disk.total) * 100}%`;
        $('clipsDiskShare').hidden = disk.clips === 0;
        $('clipsDiskOther').style.width = `${(other / disk.total) * 100}%`;
        $('clipsDiskShareLabel').textContent = `Clips ${formatBytes(disk.clips)}`;
        $('clipsDiskOtherLabel').textContent = `Other files ${formatBytes(other)}`;
        $('clipsDiskFreeLabel').textContent = `Free ${formatBytes(disk.free)} of ${formatBytes(disk.total)}`;
        $('clipsDiskBar').setAttribute(
            'aria-label',
            `Clips use ${formatBytes(disk.clips)}; ${formatBytes(disk.free)} of ${formatBytes(disk.total)} free`
        );
    }

    function render() {
        const shown = shownItems();
        list.replaceChildren(...shown.map(renderItem));

        for (const id of [...selected]) if (!items.some((item) => item.id === id)) selected.delete(id);
        const shownSelected = shown.filter((item) => selected.has(item.id)).length;
        selectAll.disabled = shown.length === 0;
        selectAll.textContent = shown.length > 0 && shownSelected === shown.length ? 'Deselect All' : 'Select All';
        const selectedBytes = items.filter((item) => selected.has(item.id)).reduce((sum, item) => sum + item.size_bytes, 0);
        deleteSelected.disabled = selected.size === 0;
        deleteSelected.textContent = selected.size
            ? `Delete Selected (${selected.size} · ${formatBytes(selectedBytes)})`
            : 'Delete Selected';

        const noun = items.length === 1 ? 'clip' : 'clips';
        count.textContent = items.length
            ? shown.length === items.length
                ? `${items.length} ${noun}`
                : `${shown.length} of ${items.length} ${noun}`
            : 'No clips';
        empty.hidden = items.length > 0;
        noResults.hidden = items.length === 0 || shown.length > 0;
        renderDisk();
    }

    async function load() {
        try {
            const response = await fetch('/api/clips', { cache: 'no-store' });
            const data = await response.json();
            items = data.clips || [];
            const number = (value) => (Number.isFinite(value) ? value : null);
            disk = {
                clips: data.total_bytes || 0,
                total: number(data.disk_total_bytes),
                used: number(data.disk_used_bytes),
                free: number(data.disk_free_bytes),
            };
            if (data.error) showStatus(data.error, true);
            render();
        } catch (error) {
            showStatus(`Could not load clips: ${error.message}`, true);
        }
    }

    function togglePlay(id) {
        if (playingId === id) {
            player.pause();
            playingId = '';
        } else {
            player.src = `/api/clips/audio?id=${encodeURIComponent(id)}`;
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
        return `/api/clips/card-media?note_id=${encodeURIComponent(noteId)}&kind=${kind}&t=${Date.now()}`;
    }

    // Shows the latest card next to the clip before replacing its media.
    function confirmEnrich(data, id) {
        const parts = enrichParts;
        const media = data.card_media || {};
        parts.warnings.replaceChildren(...(data.warnings || []).map((warning) => element('li', '', warning.message)));
        parts.cardWord.textContent = data.card_word || '';
        parts.cardSentence.textContent = data.card_sentence || '';
        parts.clipsSentence.textContent = data.saved_sentence || '';
        parts.cardPicture.hidden = !media.picture;
        parts.cardPicture.src = media.picture ? cardMediaUrl(data.note_id, 'picture') : '';
        parts.cardAudio.hidden = !media.audio;
        parts.cardAudio.src = media.audio ? cardMediaUrl(data.note_id, 'audio') : '';
        parts.cardNoMedia.hidden = Boolean(media.audio || media.picture);
        parts.clipsAudio.src = `/api/clips/audio?id=${encodeURIComponent(id)}`;
        stopPlayback();
        render();
        return openModal($('enrichModal'));
    }

    async function enrichLatest(id, button, confirm = false) {
        button.disabled = true;
        try {
            const response = await fetch('/api/clips/enrich', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, confirm }),
            });
            const data = await response.json().catch(() => ({}));
            if (response.status === 202) {
                showStatus('Enriching the latest card with this clip. If the confirmation dialog is on, it opens on the desktop.');
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
        $('trashModalTitle').textContent = chosen.length === 1 ? 'Move this clip to the trash?' : `Move ${chosen.length} clips to the trash?`;
        $('trashModalMessage').textContent = `This frees ${formatBytes(bytes)}.`;
        const preview = chosen.slice(0, 8).map((item) => element('li', '', item.sentence.replace(/\s+/g, ' ')));
        if (chosen.length > 8) preview.push(element('li', '', `…and ${chosen.length - 8} more`));
        $('trashModalList').replaceChildren(...preview);
        if (!(await openModal($('trashModal')))) return;

        try {
            const response = await fetch('/api/clips/trash', {
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
                showStatus(chosen.length === 1 ? 'Moved to the trash.' : `Moved ${chosen.length} clips to the trash.`);
            }
        } catch (error) {
            showStatus(`Delete failed: ${error.message}`, true);
        }
        load();
    }

    selectAll.addEventListener('click', () => {
        const shown = shownItems();
        const allSelected = shown.every((item) => selected.has(item.id));
        for (const item of shown) {
            if (allSelected) selected.delete(item.id);
            else selected.add(item.id);
        }
        render();
    });
    deleteSelected.addEventListener('click', () => trashItems([...selected]));
    search.addEventListener('input', render);
    sort.addEventListener('change', render);
    window.addEventListener('focus', load);
    load();
})();
