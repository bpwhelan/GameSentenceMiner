(() => {
    'use strict';

    const button = document.getElementById('generateCharacterSummary');
    const input = document.getElementById('editCharacterSummary');
    const status = document.getElementById('characterSummaryStatus');
    if (!button || !input || !status) return;

    let gameId;
    let pending;

    window.setCharacterSummaryGame = (id) => {
        pending?.abort();
        pending = undefined;
        gameId = id;
        button.disabled = !gameId;
        status.textContent = '';
    };

    button.addEventListener('click', async () => {
        if (!gameId || pending) return;
        const original = input.value;
        if (original.trim() && !window.confirm('Replace the current draft with a generated summary?')) return;

        const request = new AbortController();
        pending = request;
        button.disabled = true;
        status.textContent = 'Generating character summary…';
        try {
            const response = await fetch('/ai/game-character-summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ game_id: gameId }),
                signal: request.signal,
            });
            const reply = await response.json().catch(() => null);
            if (pending !== request) return;
            if (!response.ok || typeof reply?.summary !== 'string' || !reply.summary.trim()) {
                throw new Error(reply?.error || 'Could not generate a character summary.');
            }
            if (input.value !== original) {
                status.textContent = 'Your edits were kept. Generate again to replace the draft.';
                return;
            }
            input.value = reply.summary;
            status.textContent = 'Review the draft, then save the game to keep it.';
        } catch (error) {
            if (pending === request) status.textContent = error.message || 'Could not generate a character summary.';
        } finally {
            if (pending === request) {
                pending = undefined;
                button.disabled = false;
            }
        }
    });
})();
