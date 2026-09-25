// Conflict-detection foundation: latest-state reads, baseline comparison, other writers,
// SillyTavern's debounced saves and editor rewrites, other tabs, and this adapter's own
// serialization.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorldbookErrorCode } from '../../src/index.js';
import { byCode, setup } from '../helpers/adapter-setup.js';

test('baseline: another script changed the same field -> CONFLICT with all versions, nothing written', async () => {
    const { st, adapter } = setup();
    const baseline = await adapter.getEntry('Main Book', 0);
    await st.editInPage('Main Book', (data) => { data.entries[0].content = 'changed by a script'; }, { immediately: true });
    const before = st.fileText('Main Book');

    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 'my edit' }, { baseline }), (error) => {
        assert.equal(error.code, WorldbookErrorCode.CONFLICT);
        assert.equal(error.details.baseline.content, baseline.content);
        assert.equal(error.details.current.content, 'changed by a script');
        assert.equal(error.details.attempted.content, 'my edit');
        assert.deepEqual(error.details.changedPaths, [['content']]);
        return true;
    });
    assert.equal(st.fileText('Main Book'), before);
});

test('baseline: another script changed a different field -> CONFLICT by default (PRODUCT_PLAN §44)', async () => {
    const { st, adapter } = setup();
    const baseline = await adapter.getEntry('Main Book', 0);
    await st.editInPage('Main Book', (data) => { data.entries[0].probability = 42; }, { immediately: true });
    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 'my edit' }, { baseline }), (error) => {
        assert.equal(error.code, WorldbookErrorCode.CONFLICT);
        assert.deepEqual(error.details.changedPaths, [['probability']]);
        return true;
    });
});

test('baseline with scope "fields": a change elsewhere is kept and reported', async () => {
    const { st, adapter } = setup();
    const baseline = await adapter.getEntry('Main Book', 0);
    await st.editInPage('Main Book', (data) => { data.entries[0].probability = 42; }, { immediately: true });
    const result = await adapter.updateEntry('Main Book', 0, { content: 'my edit' }, { baseline, conflictScope: 'fields' });
    assert.deepEqual(result.externalChanges, [['probability']]);
    const stored = st.readFile('Main Book').entries[0];
    assert.equal(stored.content, 'my edit');
    assert.equal(stored.probability, 42);
});

test('baseline: rewrites SillyTavern\'s editor made by itself are not conflicts', async () => {
    const { st, adapter } = setup();
    const baseline = await adapter.getEntry('Main Book', 9); // legacy entry, missing most fields
    // ST's editor displayed the book (template backfill, role/displayIndex/characterFilter) and saved it.
    await st.editInPage('Main Book', (data) => {
        data.entries[9] = { ...data.entries[9], selective: true, addMemo: false, position: 0, role: null, displayIndex: 9, characterFilter: { isExclude: false, names: [], tags: [] } };
        data.entries[0].comment = data.entries[0].comment.replace(/\r/g, '');
    }, { immediately: true });
    const result = await adapter.updateEntry('Main Book', 9, { content: 'edited in MieMie' }, { baseline });
    assert.equal(result.written, true);
    assert.equal(st.readFile('Main Book').entries[9].content, 'edited in MieMie');
});

test('baseline: entry deleted meanwhile -> CONFLICT (update) and delete refuses a changed entry', async () => {
    const { st, adapter } = setup();
    const baseline0 = await adapter.getEntry('Main Book', 0);
    const baseline1 = await adapter.getEntry('Main Book', 1);
    await st.editInPage('Main Book', (data) => {
        delete data.entries[0];
        data.entries[1].comment = 'renamed elsewhere';
    }, { immediately: true });
    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 'x' }, { baseline: baseline0 }), (error) => error.code === WorldbookErrorCode.CONFLICT && error.details.current === null);
    await assert.rejects(adapter.deleteEntry('Main Book', 1, { baseline: baseline1 }), byCode(WorldbookErrorCode.CONFLICT));
    assert.equal(st.readFile('Main Book').entries[1].comment, 'renamed elsewhere');
});

test('a pending debounced ST save of the same book is waited for, not overwritten', async () => {
    const { st, adapter } = setup({ settleTimeoutMs: 500 });
    // ST editor / Tavern Helper style edit: cache now, file in ~40 ms.
    await st.editInPage('Main Book', (data) => { data.entries[1].content = 'typed in the ST editor'; });
    assert.notEqual(st.readFile('Main Book').entries[1].content, 'typed in the ST editor', 'not on disk yet');

    const result = await adapter.updateEntry('Main Book', 0, { content: 'MieMie edit' });
    const stored = st.readFile('Main Book');
    assert.equal(stored.entries[0].content, 'MieMie edit');
    assert.equal(stored.entries[1].content, 'typed in the ST editor', 'the pending edit survived');
    assert.equal(result.hostDrift, 'none');
});

test('a pending edit to the same field is detected as a conflict after it lands', async () => {
    const { st, adapter } = setup({ settleTimeoutMs: 500 });
    const baseline = await adapter.getEntry('Main Book', 0);
    await st.editInPage('Main Book', (data) => { data.entries[0].content = 'debounced edit'; });
    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 'mine' }, { baseline }), byCode(WorldbookErrorCode.CONFLICT));
    await st.flush();
    assert.equal(st.readFile('Main Book').entries[0].content, 'debounced edit');
});

test('a pending save of the book open in ST\'s editor is not cancelled by a write to another book', async () => {
    const { st, adapter } = setup({ withDom: true, settleTimeoutMs: 500 });
    st.editorSelected = 'Other Book';
    await st.editInPage('Other Book', (data) => { data.entries[0].content = 'typed in the ST editor'; });
    const result = await adapter.updateEntry('Main Book', 0, { content: 'MieMie edit' });
    await st.flush();
    assert.equal(st.readFile('Other Book').entries[0].content, 'typed in the ST editor', 'the other book\'s pending save reached the file');
    assert.deepEqual(result.hostUnsavedBooks, []);
});

test('another tab wrote the file (ST page cache is stale): refused by default, "use-stored" keeps their change', async () => {
    const { st, adapter } = setup({ settleTimeoutMs: 100 });
    await st.loadWorldInfo('Main Book'); // page cache warmed with the old version
    const fromOtherTab = st.readFile('Main Book');
    fromOtherTab.entries[1].content = 'written on the phone';
    st.writeFromOtherTab('Main Book', fromOtherTab);

    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 'written on the PC' }), (error) => {
        assert.equal(error.code, WorldbookErrorCode.HOST_UNSAVED_CHANGES);
        assert.deepEqual(error.details.entries, [{ uid: 1, fields: ['content'] }]);
        return true;
    });
    assert.equal(st.readFile('Main Book').entries[1].content, 'written on the phone');

    const result = await adapter.updateEntry('Main Book', 0, { content: 'written on the PC' }, { onHostDrift: 'use-stored' });
    const stored = st.readFile('Main Book');
    assert.equal(stored.entries[0].content, 'written on the PC');
    assert.equal(stored.entries[1].content, 'written on the phone');
    assert.equal(result.hostDrift, 'substantive');
    assert.equal(result.hostChangesDiscarded, true);
    assert.equal((await st.loadWorldInfo('Main Book')).entries[1].content, 'written on the phone', 'ST page cache now matches the file');
});

test('unsaved changes in the page: refused by default, saveHostCopy keeps SillyTavern\'s version', async () => {
    const { st, adapter } = setup({ settleTimeoutMs: 100 });
    await st.editInPage('Other Book', (data) => { data.entries[1].content = 'edit ST could not save'; });
    st.faults.edit.push({ status: 500 }); // ST's debounced save fails silently
    await st.flush();

    await assert.rejects(adapter.updateEntry('Other Book', 0, { content: 'x' }), byCode(WorldbookErrorCode.HOST_UNSAVED_CHANGES));
    const saved = await adapter.saveHostCopy('Other Book');
    assert.equal(saved.written, true);
    assert.equal(st.readFile('Other Book').entries[1].content, 'edit ST could not save');

    const result = await adapter.updateEntry('Other Book', 0, { content: 'x' });
    assert.equal(result.hostDrift, 'none');
});

test('a difference that is only SillyTavern editor normalization needs no wait and is not an error', async () => {
    const { st, adapter } = setup({ settleTimeoutMs: 300 });
    // On a cache miss ST hands out its live cached object; its editor then rewrites it in place.
    const live = await st.loadWorldInfo('Other Book');
    live.entries[0].role = null;
    live.entries[0].delayUntilRecursion = false;
    live.entries[1].useProbability = true;
    const started = Date.now();
    const result = await adapter.updateEntry('Other Book', 0, { content: 'first' });
    assert.ok(Date.now() - started < 200, 'no settle wait');
    assert.equal(result.hostDrift, 'normalized');
    const stored = st.readFile('Other Book').entries[0];
    assert.equal(stored.role, null, 'untouched in the file');
    assert.equal(stored.delayUntilRecursion, 0, 'the file keeps its value; ST\'s in-memory rewrite is not persisted by this write');
});

test('a lasting substantive difference is waited for once, then remembered', async () => {
    const { st, adapter } = setup({ settleTimeoutMs: 150 });
    const live = await st.loadWorldInfo('Other Book');
    live.entries[0].content = 'only in ST memory';

    let started = Date.now();
    await assert.rejects(adapter.updateEntry('Other Book', 1, { content: 'x' }), byCode(WorldbookErrorCode.HOST_UNSAVED_CHANGES));
    assert.ok(Date.now() - started >= 140, 'first attempt waited for a possible pending save');

    started = Date.now();
    await assert.rejects(adapter.updateEntry('Other Book', 1, { content: 'x' }), byCode(WorldbookErrorCode.HOST_UNSAVED_CHANGES));
    assert.ok(Date.now() - started < 100, 'same difference is not waited for again');
});

test('another tab changed the same entry: baseline check against the file catches it', async () => {
    const { st, adapter } = setup();
    const baseline = await adapter.getEntry('Main Book', 0);
    const fromOtherTab = st.readFile('Main Book');
    fromOtherTab.entries[0].content = 'phone edit';
    st.writeFromOtherTab('Main Book', fromOtherTab);
    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 'pc edit' }, { baseline }), byCode(WorldbookErrorCode.CONFLICT));
    assert.equal(st.readFile('Main Book').entries[0].content, 'phone edit');
});

test('concurrent calls on one book are serialized; none is lost', async () => {
    const { st, adapter } = setup();
    await Promise.all([
        adapter.updateEntry('Main Book', 0, { content: 'a' }),
        adapter.updateEntry('Main Book', 1, { content: 'b' }),
        adapter.createEntry('Main Book', { fields: { content: 'c' } }),
        adapter.moveEntry('Main Book', 9, 'top'),
        adapter.updateEntry('Other Book', 0, { content: 'd' }),
    ]);
    const main = st.readFile('Main Book');
    assert.equal(main.entries[0].content, 'a');
    assert.equal(main.entries[1].content, 'b');
    assert.ok(Object.values(main.entries).some((e) => e?.content === 'c'));
    assert.ok(main.entries[9].order > 100);
    assert.equal(st.readFile('Other Book').entries[0].content, 'd');
});

test('watchWorldbooks reports saves by others in the page, not our own', async () => {
    const { st, adapter } = setup();
    const events = [];
    const stop = adapter.watchWorldbooks((event) => events.push(event.worldbook));
    await adapter.updateEntry('Main Book', 0, { content: 'ours' });
    await st.editInPage('Other Book', (data) => { data.entries[0].content = 'theirs'; }, { immediately: true });
    stop();
    await st.editInPage('Chat Book', (data) => { data.entries[0].content = 'after stop'; }, { immediately: true });
    assert.deepEqual(events, ['Other Book']);
});
