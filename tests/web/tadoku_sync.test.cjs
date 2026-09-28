const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'GameSentenceMiner/web/static/js/shared.js'), 'utf8');
const template = fs.readFileSync(path.join(root, 'GameSentenceMiner/web/templates/components/tadoku-sync-card.html'), 'utf8');
const title = "Zero Escape: Virtue's Last Reward";
const editedTitle = `${title} 終わり`;

function setup(t) {
    const dom = new JSDOM(template);
    t.after(() => dom.window.close());
    const posts = [];
    const state = { previewFails: false, jobFails: false, confirm: true, confirmations: 0 };
    dom.window.confirm = () => {
        state.confirmations++;
        return state.confirm;
    };
    const context = vm.createContext({
        window: dom.window,
        document: dom.window.document,
        console,
        fetch: async (url, options) => {
            if (url.startsWith('/api/tadoku/preview')) {
                return {
                    ok: !state.previewFails,
                    json: async () => state.previewFails ? { error: 'Preview unavailable' } : {
                        configured: true, total_entries: 2, total_characters: 6, duplicates_excluded: 0,
                        entries: ['game-1', 'game-2'].map(game_key => ({
                            game_key, game_name: title, lines: 1, characters: 3,
                        })),
                    },
                };
            }
            if (url === '/api/tadoku/sync') {
                posts.push(JSON.parse(options.body));
                return { ok: true, json: async () => ({ job_id: 'job-1' }) };
            }
            if (url === '/api/tadoku/jobs/job-1') {
                return { ok: true, json: async () => state.jobFails
                    ? { status: 'failed', error: 'Remote failure' }
                    : { status: 'completed', result: { characters_sent: 6, entries_sent: 2 } } };
            }
            throw new Error(`Unexpected request: ${url}`);
        },
    });
    // Shared page initialization is separate from the manual sync interactions under test.
    const addEventListener = dom.window.document.addEventListener;
    dom.window.document.addEventListener = () => {};
    vm.runInContext(source, context);
    dom.window.document.addEventListener = addEventListener;
    const manager = vm.runInContext('Object.create(SettingsManager.prototype)', context);
    manager.initializeElements();
    function inputs() {
        return [...dom.window.document.querySelectorAll('#tadokuPreviewRows textarea')];
    }
    function edit(value) {
        assert.equal(inputs().length, 2, 'Each log should have an editable title');
        inputs()[0].value = value;
        inputs()[0].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    return { manager, inputs, edit, posts, state };
}

test('edited titles survive refresh and deduplication, send by game key, then reset after success', async t => {
    const { manager, inputs, edit, posts } = setup(t);
    await manager.loadTadokuPreview();
    edit(editedTitle);
    manager.tadokuManualSyncDeduplicateInput.checked = true;
    await manager.loadTadokuPreview();
    assert.equal(inputs()[0].value, editedTitle);
    assert.equal(inputs()[1].value, title);

    await manager.queueTadokuSync();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].deduplicate, true);
    assert.equal(posts[0].log_descriptions['game-1'], editedTitle);
    assert.equal(posts[0].log_descriptions['game-2'] ?? title, title);
    assert.equal(inputs()[0].value, title);
});

test('failed sync keeps edits available for retry', async t => {
    const { manager, inputs, edit, state } = setup(t);
    await manager.loadTadokuPreview();
    edit(editedTitle);
    state.jobFails = true;
    await manager.queueTadokuSync();
    assert.equal(inputs()[0].value, editedTitle);
    assert.equal(manager.tadokuSettingsError.textContent, 'Remote failure');
});

test('canceling manual sync keeps edits and sends nothing', async t => {
    const { manager, inputs, edit, posts, state } = setup(t);
    await manager.loadTadokuPreview();
    edit(editedTitle);
    state.confirm = false;
    await manager.queueTadokuSync();
    assert.equal(inputs()[0].value, editedTitle);
    assert.equal(posts.length, 0);
});

test('blank log titles prevent sending', async t => {
    const { manager, edit, posts, state } = setup(t);
    await manager.loadTadokuPreview();
    edit('  ');
    await manager.queueTadokuSync();
    assert.equal(posts.length, 0);
    assert.equal(state.confirmations, 0);
});

test('failed preview prevents sending', async t => {
    const { manager, posts, state } = setup(t);
    await manager.loadTadokuPreview();
    state.previewFails = true;
    await manager.queueTadokuSync();
    assert.equal(posts.length, 0);
    assert.equal(state.confirmations, 0);
});
