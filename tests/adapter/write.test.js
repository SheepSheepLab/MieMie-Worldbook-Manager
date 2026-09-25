// Issue #1 coverage: 3 (unknown fields round-trip), 4 (content edit keeps other fields),
// 5 (single-field patch keeps the full object), 6 (create), 7 (update), 8 (delete),
// 12 (operations stay in the target book)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffPaths, newEntryTemplate, WorldbookErrorCode } from '../../src/index.js';
import { mainBook, stEditorEntry } from '../fixtures/worldbooks.js';
import { byCode, setup } from '../helpers/adapter-setup.js';

const withoutEntry = (book, uid) => {
    const copy = structuredClone(book);
    delete copy.entries[uid];
    return copy;
};

test('[3] unknown, third-party, newer-release and book-level fields survive a write unchanged', async () => {
    const { st, adapter } = setup();
    await adapter.updateEntry('Main Book', 2, { content: 'Rewritten.' });

    const after = st.readFile('Main Book');
    const before = mainBook();
    assert.deepEqual(withoutEntry(after, 2), withoutEntry(before, 2), 'every other entry and every book-level key identical');
    assert.deepEqual(after.entries[2].miemieUnknownField, before.entries[2].miemieUnknownField);
    assert.deepEqual(after.entries[2].extra, before.entries[2].extra);
    assert.equal(after.entries[2].futureStField, before.entries[2].futureStField);
    assert.deepEqual(after.originalData, before.originalData);
    assert.deepEqual(after.customTopLevel, before.customTopLevel);
});

test('[3] values other tools rewrite are kept exactly (delayUntilRecursion true, useProbability false, role null, sticky 0, regex keys, legacy entries)', async () => {
    const { st, adapter } = setup();
    await adapter.updateEntry('Main Book', 1, { comment: 'Alice (edited)' });
    await adapter.updateEntry('Main Book', 9, { content: 'legacy edited' });
    const after = st.readFile('Main Book');
    const e1 = after.entries[1];
    assert.equal(e1.delayUntilRecursion, true);
    assert.equal(e1.useProbability, false);
    assert.equal(e1.probability, 35);
    assert.equal(e1.role, null);
    assert.equal(e1.sticky, 0);
    assert.equal(e1.selective, false);
    assert.deepEqual(e1.key, ['/Alice/ig', 'bob']);
    assert.equal(e1.displayIndex, 17);
    assert.deepEqual(after.entries[9], { uid: 9, key: ['legacy'], content: 'legacy edited', order: 10 }, 'no template fields added to the legacy entry');
    assert.equal(after.entries[5].order, '50', 'untouched string Order stays a string');
    assert.equal(after.entries[5].position, 8, 'unknown position value untouched');
});

test('[3] untouched entries keep their exact key order (ST timed effects hash JSON.stringify(entry))', async () => {
    const { st, adapter } = setup();
    const before = st.readFile('Main Book');
    await adapter.updateEntry('Main Book', 0, { content: 'x' });
    const after = st.readFile('Main Book');
    for (const uid of [1, 2, 5, 7, 9]) {
        assert.equal(JSON.stringify(after.entries[uid]), JSON.stringify(before.entries[uid]), `entry ${uid}`);
    }
    assert.deepEqual(Object.keys(after.entries[0]), Object.keys(before.entries[0]));
});

test('[4] editing Content changes Content only', async () => {
    const { st, adapter } = setup();
    const before = st.readFile('Main Book').entries[0];
    const result = await adapter.updateEntry('Main Book', 0, { content: '新的内容' });
    const after = st.readFile('Main Book').entries[0];

    assert.deepEqual(diffPaths(before, after), [['content']]);
    assert.equal(after.content, '新的内容');
    assert.deepEqual(result.changedPaths, [['content']]);
    assert.equal(result.written, true);
    assert.equal(result.verified, true);
    assert.deepEqual(result.entry, after);
});

test('[5] a single-field patch never produces a reduced object', async () => {
    const { st, adapter } = setup();
    const cases = [
        [2, { order: 81 }, [['order']]],
        [7, [{ path: ['characterFilter', 'names'], value: ['Bob', 'Carol'] }], [['characterFilter', 'names']]],
        [1, [{ path: ['extensions', 'my_card_ext', 'foo'], value: 2 }], [['extensions', 'my_card_ext', 'foo']]],
        [0, { disable: true }, [['disable']]],
        [2, [{ op: 'unset', path: 'futureStField' }], [['futureStField']]],
    ];
    for (const [uid, patch, paths] of cases) {
        const before = st.readFile('Main Book').entries[uid];
        await adapter.updateEntry('Main Book', uid, patch);
        const after = st.readFile('Main Book').entries[uid];
        assert.deepEqual(diffPaths(before, after), paths, JSON.stringify(patch));
        const expectedKeys = Object.keys(before).filter((k) => !(paths[0][0] === 'futureStField' && k === 'futureStField'));
        assert.deepEqual(Object.keys(after), expectedKeys, `no field dropped or added: ${JSON.stringify(patch)}`);
    }
});

test('[6] create: SillyTavern template, lowest free uid, top of the list (max Order + 1)', async () => {
    const { st, adapter } = setup();
    const before = st.readFile('Main Book');
    const result = await adapter.createEntry('Main Book', { fields: { comment: '新条目', content: 'From a message.', key: ['new'] } });

    assert.equal(result.uid, 3, 'uids 0,1,2 are taken; 3 is the lowest free one');
    assert.equal(result.entry.order, 101);
    assert.deepEqual(result.orderChanges, []);
    const stored = st.readFile('Main Book').entries[3];
    assert.deepEqual(stored, { uid: 3, ...newEntryTemplate(), comment: '新条目', content: 'From a message.', key: ['new'], order: 101 });
    assert.deepEqual(withoutEntry(st.readFile('Main Book'), 3), before, 'nothing else changed');
    assert.equal((await adapter.getWorldbook('Main Book')).entries[0].uid, 3, 'shown at the top');
});

test('[6] create with an explicit Order or placement, and in an empty book', async () => {
    const { st, adapter } = setup();
    const explicit = await adapter.createEntry('Main Book', { fields: { order: 7 } });
    assert.equal(st.readFile('Main Book').entries[explicit.uid].order, 7);

    const between = await adapter.createEntry('Main Book', { placement: { aboveUid: 0, belowUid: 1 } });
    assert.equal(between.entry.order, 95);

    const empty = await adapter.createEntry('Empty Book');
    assert.equal(empty.uid, 0);
    assert.equal(empty.entry.order, 100);

    await assert.rejects(adapter.createEntry('Main Book', { fields: { order: 1 }, placement: 'top' }), byCode(WorldbookErrorCode.INVALID_ARGUMENT));
    await assert.rejects(adapter.createEntry('Main Book', { fields: { uid: 99 } }), byCode(WorldbookErrorCode.INVALID_PATCH));
});

test('[6] create never reuses a uid that exists only in ST\'s page copy', async () => {
    const { st, adapter } = setup();
    await st.editInPage('Other Book', (data) => { data.entries[2] = { uid: 2, content: 'unsaved in page', order: 1 }; });
    st.faults.edit.push('drop'); // ST's debounced save of that edit silently fails
    await st.flush();
    await assert.rejects(adapter.createEntry('Other Book'), byCode(WorldbookErrorCode.HOST_UNSAVED_CHANGES));
    const created = await adapter.createEntry('Other Book', { onHostDrift: 'use-stored' });
    assert.equal(created.uid, 3);
    assert.equal(created.hostChangesDiscarded, true);
});

test('[6] create at the top of a book whose Order is above 9999 does not rewrite existing entries', async () => {
    const book = { entries: { 0: stEditorEntry({ uid: 0, order: 20000, group: '' }), 1: stEditorEntry({ uid: 1, order: 15000, group: '' }) } };
    const { st, adapter } = setup({ books: { Book: book } });
    const created = await adapter.createEntry('Book');
    assert.equal(created.entry.order, 20001);
    assert.deepEqual(created.orderChanges, []);
    assert.equal(st.readFile('Book').entries[0].order, 20000);
});

test('[6] a failed write to an empty book leaves no phantom entry in ST\'s page copy', async () => {
    const { st, adapter } = setup({ withDom: true });
    st.editorSelected = 'Empty Book';
    st.faults.edit.push({ status: 500 });
    await assert.rejects(adapter.createEntry('Empty Book', { fields: { comment: 'phantom' } }), (error) => {
        assert.equal(error.code, WorldbookErrorCode.WRITE_NOT_CONFIRMED);
        assert.equal(error.details.cacheRestored, true);
        return true;
    });
    assert.deepEqual(await st.loadWorldInfo('Empty Book'), { entries: {} });
    await st.editInPage('Empty Book', () => {}, { immediately: true }); // a later ST save of the book
    assert.deepEqual(st.readFile('Empty Book'), { entries: {} });
});

test('keys that are not canonical integers are anomalies and never written', async () => {
    const book = { entries: {
        1: stEditorEntry({ uid: 1, order: 50, group: '' }),
        5: stEditorEntry({ uid: 5, order: 10, group: '' }),
        '05': stEditorEntry({ uid: '05', order: 9999, group: '' }),
    } };
    const { st, adapter } = setup({ books: { D: book } });
    const snapshot = await adapter.getWorldbook('D');
    assert.deepEqual(snapshot.anomalies.map((a) => a.key), ['05']);
    await adapter.moveEntry('D', 1, 'top');
    const file = st.readFile('D');
    assert.equal(file.entries[5].order, 10, 'entry "5" untouched');
    assert.equal(file.entries['05'].order, 9999, 'entry "05" untouched');
});

test('[7] update several fields at once; a no-op update does not save', async () => {
    const { st, adapter } = setup();
    const result = await adapter.updateEntry('Main Book', 0, { comment: 'Frieren', probability: 50, useProbability: true });
    assert.deepEqual(result.changedPaths, [['comment'], ['probability']]);
    const edits = st.calls.edit;
    const noop = await adapter.updateEntry('Main Book', 0, { comment: 'Frieren' });
    assert.equal(noop.written, false);
    assert.equal(st.calls.edit, edits, 'no save for a no-op');
});

test('[7] update rejects values SillyTavern cannot use', async () => {
    const { st, adapter } = setup();
    const before = st.fileText('Main Book');
    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 5 }), byCode(WorldbookErrorCode.INVALID_PATCH));
    await assert.rejects(adapter.updateEntry('Main Book', 0, { triggers: ['never'] }), byCode(WorldbookErrorCode.INVALID_PATCH));
    await assert.rejects(adapter.updateEntry('Main Book', 0, { uid: 3 }), byCode(WorldbookErrorCode.INVALID_PATCH));
    assert.equal(st.fileText('Main Book'), before);
});

test('[8] delete removes one entry and nothing else (originalData left as stored)', async () => {
    const { st, adapter } = setup();
    const before = st.readFile('Main Book');
    const result = await adapter.deleteEntry('Main Book', 1);
    assert.deepEqual(result.deleted, before.entries[1]);
    assert.deepEqual(st.readFile('Main Book'), withoutEntry(before, 1));
    await assert.rejects(adapter.deleteEntry('Main Book', 1), byCode(WorldbookErrorCode.ENTRY_NOT_FOUND));
});

test('[12] writes stay in the named book: other files are byte-identical', async () => {
    const { st, adapter } = setup();
    const others = ['Other Book', 'Chat Book', 'Broken Book', 'Empty Book'].map((n) => [n, st.fileText(n)]);
    await adapter.createEntry('Main Book', { fields: { content: 'a' } });
    await adapter.updateEntry('Main Book', 0, { content: 'b' });
    await adapter.moveEntry('Main Book', 9, 'top');
    await adapter.deleteEntry('Main Book', 7);
    for (const [name, text] of others) {
        assert.equal(st.fileText(name), text, name);
    }
    assert.deepEqual([...st.files.keys()].sort(), ['Broken Book', 'Chat Book', 'Empty Book', 'Main Book', 'Other Book']);
});

test('[12] a missing book is never created by a write', async () => {
    const { st, adapter } = setup();
    await assert.rejects(adapter.createEntry('Typo Book'), byCode(WorldbookErrorCode.WORLDBOOK_NOT_FOUND));
    await assert.rejects(adapter.updateEntry('Typo Book', 0, { content: 'x' }), byCode(WorldbookErrorCode.WORLDBOOK_NOT_FOUND));
    assert.equal(st.files.has('Typo Book'), false);
    assert.equal(st.calls.edit, 0);
});

test('[12] a book deleted in another tab is not recreated by a write', async () => {
    const { st, adapter } = setup();
    st.files.delete('Other Book');
    await assert.rejects(adapter.updateEntry('Other Book', 0, { content: 'x' }), byCode(WorldbookErrorCode.WORLDBOOK_NOT_FOUND));
    assert.equal(st.files.has('Other Book'), false);
});

test('[12] handles route every call to their own book', async () => {
    const { st, adapter } = setup();
    const main = adapter.worldbook('Main Book');
    const other = adapter.worldbook('Other Book');
    await other.updateEntry(0, { content: 'only in Other Book' });
    assert.equal(st.readFile('Other Book').entries[0].content, 'only in Other Book');
    assert.notEqual(st.readFile('Main Book').entries[0].content, 'only in Other Book');
    const created = await main.createEntry({ fields: { content: 'main' } });
    assert.ok(st.readFile('Main Book').entries[created.uid]);
    assert.equal(st.readFile('Other Book').entries[created.uid], undefined);
});

test('malformed entries are refused for writing and never changed', async () => {
    const { st, adapter } = setup();
    const before = st.fileText('Broken Book');
    await assert.rejects(adapter.updateEntry('Broken Book', 3, { content: 'x' }), byCode(WorldbookErrorCode.MALFORMED_DATA));
    await assert.rejects(adapter.deleteEntry('Broken Book', 6), byCode(WorldbookErrorCode.MALFORMED_DATA));
    assert.equal(st.fileText('Broken Book'), before);
    await adapter.updateEntry('Broken Book', 0, { content: 'fine to edit' });
    const after = st.readFile('Broken Book');
    assert.equal(after.entries[6], null, 'null entry kept as stored');
    assert.equal(after.entries[3].uid, 4, 'mismatched entry kept as stored');
});

test('after a write, the ST editor is reloaded only when it shows that book', async () => {
    const { st, adapter } = setup({ withDom: true });
    st.editorSelected = 'Main Book';
    await adapter.updateEntry('Main Book', 0, { content: 'x' });
    assert.deepEqual(st.calls.reloadEditor, [{ name: 'Main Book', loadIfNotSelected: false }]);

    st.editorSelected = 'Other Book';
    await adapter.updateEntry('Main Book', 0, { content: 'y' });
    st.editorSelected = null; // no book open: ST's reloadEditor would open world_names[0]
    await adapter.updateEntry('Broken Book', 0, { content: 'z' });
    assert.equal(st.calls.reloadEditor.length, 1);
});
