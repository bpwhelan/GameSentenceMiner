(async () => {
    async function waitFor(find) {
        for (let i = 0; i < 150; i++) {
            const item = find();
            if (item) return item;
            await new Promise((resolve) => setTimeout(resolve, 60));
        }
        throw Error('Timed out waiting for mining settings: ' + find);
    }
    const pane = await waitFor(() => document.querySelector('.mining-editor'));
    const input = await waitFor(() => document.getElementById('mining-field-audio.enabled'));
    if (
        !pane.closest('.tab-panel.active') || pane.closest('[hidden]') ||
        !pane.querySelector('nav')
    ) {
        throw Error('Expected mining settings in the active desktop tab');
    }
    const ipc = window.ipcRenderer;
    const before = input.checked;
    input.click();
    document.getElementById('settings-category-desktop').click();
    await waitFor(() => pane.closest('[hidden]'));
    await ipc.invoke('settings.openGSMSettings');
    await waitFor(() => !pane.closest('[hidden]'));
    if (!pane.isConnected || input.checked === before) throw Error('Reopening lost the edit');
    await waitFor(() => !document.getElementById('mining-target').disabled);
    const read = () => ipc.invoke('settings.mining.read', {});
    const saved = await read();
    if (saved.fields.find((f) => f.path === 'audio.enabled')?.value !== !before)
        throw Error('Audio toggle did not persist');
    await ipc.invoke('settings.openGSMSettings', { rootTabKey: 'key_settings' });
    await waitFor(() => document.getElementById('mining-field-general.single_port'));
    if (!document.getElementById('mining-field-anki.sentence.name') ||
        document.getElementById('mining-target').value !== JSON.stringify(saved.active))
        throw Error('Key Settings lost the active profile or its Anki mapping');
    const page = pane.querySelector('.mining-page');
    const keyFields = ['general.native_language','general.target_language','general.use_websocket','general.use_clipboard','general.single_port','general.websocket_sources','anki.note_type','anki.word.name','anki.sentence.name','anki.sentence_audio.name','anki.picture.name','audio.beginning_offset','audio.end_offset','features.open_anki_edit','features.open_anki_in_browser'];
    if (keyFields.some(key => !document.getElementById('mining-field-'+key)))
        throw Error('A Qt Key Settings control is missing');
    if (page.scrollWidth > page.clientWidth + 1)
        throw Error('Key Settings overflows the desktop window: ' + [page.clientWidth,page.scrollWidth,page.clientHeight,page.scrollHeight].join(', '));
    const port = document.getElementById('mining-field-general.single_port');
    if (!port.getAttribute('aria-description') || !port.closest('.mining-row').querySelector('[data-tip]'))
        throw Error('Port help is missing');
    const portRow = port.closest('.mining-row');
    const portButton = portRow.querySelector('.mining-port-actions button');
    const icon = pane.querySelector('.mining-sidebar button svg');
    if (port.offsetWidth < 64 || port.getBoundingClientRect().bottom > portButton.getBoundingClientRect().top)
        throw Error('Port shortcuts crowd the input');
    if (getComputedStyle(icon).fill !== 'none' || getComputedStyle(icon).stroke === 'none')
        throw Error('Mining settings icons lost their visible strokes');
    await ipc.invoke('settings.openGSMSettings', {rootTabKey:'anki', subtabKey:'tags'});
    await waitFor(() => document.getElementById('mining-field-anki.custom_tags'));
    if (document.getElementById('mining-search').value) throw Error('Anki Tags opened as a search');
    const result = await ipc.invoke('settings.mining.apply', {
        op: 'createScene',
        name: 'Smoke Game',
        base: saved.active,
        follow: true,
    });
    await ipc.invoke('settings.mining.activate', { name: result.target });
    const game = await read();
    if (
        game.target !== result.target ||
        game.fields.find((f) => f.path === 'audio.enabled')?.value !== !before
    )
        throw Error('Game did not inherit the saved profile');
    const text = await ipc.invoke('textprocess.loadProfile');
    if (text.name !== result.target) throw Error('Text processing loaded the wrong game');
    await ipc.invoke('settings.mining.activate', { name: saved.active });
    const changed = await ipc.invoke('textprocess.saveProfile', {
        name: text.name,
        before: text.config,
        after: { ...text.config, remove_numbers: !text.config.remove_numbers },
    });
    if (!changed.success) throw Error('Text processing edit failed: ' + changed.error);
    const inactive = await ipc.invoke('settings.mining.read', { target: result.target });
    const edit = inactive.fields.find((f) => f.path === 'text_processing.remove_numbers');
    if (!edit?.pinned || edit.value === text.config.remove_numbers)
        throw Error('Delayed text edits did not stay with their game');
    return { editor: true, audio: !before, profile: saved.active, game: game.target };
})();
