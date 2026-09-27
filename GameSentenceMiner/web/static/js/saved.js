// Saved lines page: list lines saved for later, play their audio, enrich the latest Anki card, trash them.
(() => {
    const list = document.getElementById('savedList');
    const status = document.getElementById('savedStatus');
    const search = document.getElementById('savedSearch');
    const count = document.getElementById('savedCount');
    const empty = document.getElementById('savedEmpty');
    const player = new Audio();
    const modal = document.getElementById('enrichModal');
    const modalParts = {
        warnings: document.getElementById('enrichWarnings'),
        cardWord: document.getElementById('enrichCardWord'),
        cardSentence: document.getElementById('enrichCardSentence'),
        cardPicture: document.getElementById('enrichCardPicture'),
        cardAudio: document.getElementById('enrichCardAudio'),
        cardNoMedia: document.getElementById('enrichCardNoMedia'),
        savedSentence: document.getElementById('enrichSavedSentence'),
        savedAudio: document.getElementById('enrichSavedAudio'),
        confirm: document.getElementById('enrichConfirm'),
    };
    let items = [];
    let playingId = '';

    function showStatus(message, isError = false) {
        status.textContent = message;
        status.classList.toggle('is-error', isError);
        status.hidden = !message;
        if (message) status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

    function renderItem(item) {
        const card = element('article', 'saved-item');
        const before = item.lines.filter((line) => line.role === 'previous').map((line) => line.text).join('\n');
        const after = item.lines.filter((line) => line.role === 'next').map((line) => line.text).join('\n');
        if (before) card.append(element('p', 'saved-context', before));
        const sentence = element('p', 'saved-sentence', item.sentence);
        sentence.lang = 'ja';
        card.append(sentence);
        if (after) card.append(element('p', 'saved-context', after));

        const meta = element('div', 'saved-meta');
        if (item.game) meta.append(element('span', '', item.game));
        meta.append(element('span', '', formatTime(item.line_time)));
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
        enrich.title = 'Add this line\'s audio and screenshot to the card you added to Anki most recently';
        enrich.addEventListener('click', () => enrichLatest(item.id, enrich));
        const trash = element('button', 'saved-delete', '🗑 Delete');
        trash.title = 'Move to the trash (can be restored from there)';
        trash.addEventListener('click', () => trashItem(item.id));
        actions.append(play, enrich, trash);
        card.append(actions);
        return card;
    }

    function render() {
        const query = search.value.trim().toLowerCase();
        const shown = items.filter(
            (item) => !query || item.sentence.toLowerCase().includes(query) || item.game.toLowerCase().includes(query)
        );
        list.replaceChildren();
        let currentDay = '';
        for (const item of shown) {
            const day = formatDay(item.line_time);
            if (day !== currentDay) {
                list.append(element('h2', 'saved-day', day));
                currentDay = day;
            }
            list.append(renderItem(item));
        }
        count.textContent = items.length ? `${shown.length} of ${items.length}` : '';
        empty.hidden = items.length > 0;
    }

    async function load() {
        try {
            const response = await fetch('/api/saved-lines', { cache: 'no-store' });
            const data = await response.json();
            items = data.saved_lines || [];
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

    function cardMediaUrl(noteId, kind) {
        return `/api/saved-lines/card-media?note_id=${encodeURIComponent(noteId)}&kind=${kind}&t=${Date.now()}`;
    }

    // Shows the latest card next to the saved line; resolves true when the user chooses to enrich.
    function confirmEnrich(data, id) {
        const parts = modalParts;
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
        player.pause();
        playingId = '';
        render();
        modal.classList.add('show');
        parts.confirm.focus();

        return new Promise((resolve) => {
            const close = (result) => {
                modal.classList.remove('show');
                parts.cardAudio.pause();
                parts.savedAudio.pause();
                modal.removeEventListener('click', onClick);
                document.removeEventListener('keydown', onKey);
                resolve(result);
            };
            const onClick = (event) => {
                if (event.target === modal || event.target.closest('[data-enrich-close]')) close(false);
                else if (event.target === parts.confirm) close(true);
            };
            const onKey = (event) => {
                if (event.key === 'Escape') close(false);
            };
            modal.addEventListener('click', onClick);
            document.addEventListener('keydown', onKey);
        });
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

    async function trashItem(id) {
        if (!window.confirm('Move this saved line to the trash? You can restore it from the trash later.')) return;
        const response = await fetch(`/api/saved-lines?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            showStatus(data.error || `Delete failed (HTTP ${response.status})`, true);
            return;
        }
        if (playingId === id) {
            player.pause();
            playingId = '';
        }
        items = items.filter((item) => item.id !== id);
        render();
    }

    search.addEventListener('input', render);
    window.addEventListener('focus', load);
    load();
})();
