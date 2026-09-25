const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

process.env.TZ = 'America/New_York';
const context = vm.createContext({
    Date, Intl, console, Event,
    navigator: { language: 'en-US' },
    document: { addEventListener() {} },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../GameSentenceMiner/web/static/js/goals.js'), 'utf8'), context);
const utils = vm.runInContext('GoalsUtils', context);
const manager = vm.runInContext('CustomGoalsManager', context);
const input = () => ({ value: '', dataset: {}, dispatchEvent() {} });

test('date-only ranges remain inclusive local days', () => {
    const end = utils.goalDateBoundary('2025-06-02', true);
    assert.equal(end.getTime(), new Date(2025, 5, 3).getTime());
    assert.equal(utils.parseLocalDate('2025-06-02').getHours(), 0);
});

test('timed values display and save in local time without shifting the instant', () => {
    const field = input();
    utils.setGoalDateInput(field, '2025-06-02T16:35:00Z');
    assert.equal(field.value, '2025-06-02T12:35');
    assert.equal(utils.readGoalDateInput(field), '2025-06-02T16:35:00Z');
    field.value = '2025-06-02T12:36';
    assert.equal(utils.readGoalDateInput(field), '2025-06-02T16:36:00.000Z');
});

test('editing a legacy goal preserves whole-day dates until the field changes', () => {
    const start = input();
    const end = input();
    utils.setGoalDateInput(start, '2025-06-01');
    utils.setGoalDateInput(end, '2025-06-02', true);
    assert.equal(start.value, '2025-06-01T00:00');
    assert.equal(end.value, '2025-06-02T23:59');
    assert.equal(utils.readGoalDateInput(start), '2025-06-01');
    assert.equal(utils.readGoalDateInput(end), '2025-06-02');
});

test('24 hour helper adds elapsed hours across daylight saving changes', () => {
    const start = input();
    const end = input();
    const now = new Date('2025-03-08T12:34:56-05:00');
    utils.setDateTimeShortcut(start, 0, now);
    utils.setDateTimeShortcut(end, 24, now);
    assert.equal(start.value, '2025-03-08T12:34');
    assert.equal(end.value, '2025-03-09T13:34');
    assert.equal(new Date(utils.readGoalDateInput(end)) - new Date(utils.readGoalDateInput(start)), 86400000);
});

test('Now preserves the second occurrence of an hour when clocks go back', () => {
    const field = input();
    const now = new Date('2025-11-02T01:34:56-05:00');
    utils.setDateTimeShortcut(field, 0, now);
    assert.equal(field.value, '2025-11-02T01:34');
    assert.equal(utils.readGoalDateInput(field), '2025-11-02T06:34:00.000Z');
});

test('validation compares actual instants, including equal or reversed times', () => {
    const goal = { name: 'Read', metricType: 'characters', targetValue: 100,
        startDate: '2025-06-02T12:30:00-04:00', endDate: '2025-06-02T17:00:00Z' };
    assert.equal(manager.validate(goal).length, 0);
    assert.ok(manager.validate({ ...goal, endDate: '2025-06-02T16:30:00Z' }).length > 0);
    assert.ok(manager.validate({ ...goal, endDate: '2025-06-02T16:29:00Z' }).length > 0);
});

test('goal lists expire and start at the selected minute', async () => {
    const now = Date.now();
    const goals = [
        { id: 'active', startDate: new Date(now - 60000).toISOString(), endDate: new Date(now + 60000).toISOString() },
        { id: 'expired', startDate: new Date(now - 120000).toISOString(), endDate: new Date(now - 60000).toISOString() },
        { id: 'future', startDate: new Date(now + 60000).toISOString(), endDate: new Date(now + 120000).toISOString() },
    ];
    manager.getAll = async () => goals;
    assert.deepEqual((await manager.getActive()).map(goal => goal.id), ['active', 'future']);
    assert.deepEqual((await manager.getInProgress()).map(goal => goal.id), ['active']);
    assert.deepEqual((await manager.getExpired()).map(goal => goal.id), ['expired']);
});

test('goal labels include the selected time', () => {
    assert.match(utils.formatGoalDate('2025-06-02T16:35:00Z'), /12:35/);
    assert.doesNotMatch(utils.formatGoalDate('2025-06-02'), /:/);
});
