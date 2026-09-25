// Issue #1 coverage: 9 (Order read), 10 (Order changes follow SillyTavern's real semantics)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readOrder, sortForDisplay, WorldbookErrorCode } from '../../src/index.js';
import { stEditorEntry } from '../fixtures/worldbooks.js';
import { byCode, setup } from '../helpers/adapter-setup.js';

/** SillyTavern's prompt comparator (world-info.js:88): processes higher Order first; unshift puts it last. */
const stSortFn = (a, b) => b.order - a.order;

function bookWithOrders(orders) {
    return { entries: Object.fromEntries(orders.map((order, uid) => [uid, stEditorEntry({ uid, order, comment: `e${uid}`, group: '' })])) };
}

function displayUids(file) {
    return sortForDisplay(Object.values(file.entries)).map((e) => e.uid);
}

test('[10] move to top: Order becomes max + 1, only the moved entry changes', async () => {
    const { st, adapter } = setup({ books: { Book: bookWithOrders([100, 90, 80]) } });
    const result = await adapter.moveEntry('Book', 2, 'top');
    assert.equal(result.order, 101);
    assert.deepEqual(result.orderChanges, [{ uid: 2, from: 80, to: 101 }]);
    const file = st.readFile('Book');
    assert.deepEqual(displayUids(file), [2, 0, 1]);
    assert.deepEqual([file.entries[0].order, file.entries[1].order], [100, 90]);
});

test('[10] the MieMie top is what SillyTavern places last (closest to the end of context)', async () => {
    const { st, adapter } = setup({ books: { Book: bookWithOrders([100, 90, 80]) } });
    await adapter.moveEntry('Book', 2, 'top');
    const file = st.readFile('Book');
    // Reproduce ST prompt assembly for one position slot: sort by sortFn, then unshift.
    const slot = [];
    [...Object.values(file.entries)].sort(stSortFn).forEach((entry) => slot.unshift(entry.uid));
    assert.equal(slot.at(-1), 2, 'moved entry is last in the slot');
    assert.deepEqual(slot, [...displayUids(file)].reverse(), 'display order is prompt order reversed');
});

test('[10] move between two neighbours with a gap changes one entry', async () => {
    const { st, adapter } = setup({ books: { Book: bookWithOrders([100, 50, 10]) } });
    const result = await adapter.moveEntry('Book', 2, { aboveUid: 0, belowUid: 1 });
    assert.equal(result.order, 75);
    assert.equal(result.orderChanges.length, 1);
    assert.deepEqual(displayUids(st.readFile('Book')), [0, 2, 1]);
});

test('[10] no full renumber: a dense book only shifts the short side', async () => {
    const orders = [10, 9, 8, 7, 6, 3];
    const { st, adapter } = setup({ books: { Book: bookWithOrders(orders) } });
    const result = await adapter.moveEntry('Book', 5, { aboveUid: 1 });
    const file = st.readFile('Book');
    assert.deepEqual(displayUids(file), [0, 1, 5, 2, 3, 4]);
    assert.deepEqual(result.orderChanges.map((c) => c.uid).sort(), [0, 1, 5]);
    assert.deepEqual([2, 3, 4].map((uid) => file.entries[uid].order), [8, 7, 6], 'lower side untouched');
});

test('[10] placing into a tie never relies on the tie: moved entry is strictly between neighbours', async () => {
    const { st, adapter } = setup({ books: { Book: bookWithOrders([100, 100, 100, 100, 5]) } });
    await adapter.moveEntry('Book', 4, { aboveUid: 1, belowUid: 2 });
    const file = st.readFile('Book');
    assert.deepEqual(displayUids(file), [0, 1, 4, 2, 3]);
    assert.ok(file.entries[1].order > file.entries[4].order && file.entries[4].order > file.entries[2].order);
    assert.equal(file.entries[0].order, file.entries[1].order, 'the raised side keeps its tie');
});

test('[10] only the Order field of re-valued entries changes', async () => {
    const { st, adapter } = setup({ books: { Book: bookWithOrders([10, 9, 8]) } });
    const before = st.readFile('Book');
    await adapter.moveEntry('Book', 2, { aboveUid: 0 });
    const after = st.readFile('Book');
    for (const uid of [0, 1, 2]) {
        assert.deepEqual({ ...after.entries[uid], order: 0 }, { ...before.entries[uid], order: 0 }, `entry ${uid}`);
        assert.deepEqual(Object.keys(after.entries[uid]), Object.keys(before.entries[uid]));
    }
    assert.equal(after.entries[0].displayIndex, before.entries[0].displayIndex, 'displayIndex (ST custom sort) untouched');
});

test('[10] a move that changes nothing does not save', async () => {
    const { st, adapter } = setup({ books: { Book: bookWithOrders([100, 50, 10]) } });
    const result = await adapter.moveEntry('Book', 1, { aboveUid: 0 });
    assert.equal(result.written, false);
    assert.equal(st.calls.edit, 0);
});

test('[10] new values stay inside the SillyTavern editor range 0..9999', async () => {
    const { st, adapter } = setup({ books: { Book: bookWithOrders([9999, 9998, 1]) } });
    await adapter.moveEntry('Book', 2, 'top');
    const orders = Object.values(st.readFile('Book').entries).map((e) => e.order);
    assert.ok(orders.every((o) => o >= 0 && o <= 9999));
    assert.deepEqual(displayUids(st.readFile('Book')), [2, 0, 1]);
});

test('[10] the caller\'s view of the list is checked before moving', async () => {
    const { st, adapter } = setup({ books: { Book: bookWithOrders([100, 50, 10]) } });
    const seen = (await adapter.getWorldbook('Book')).entries.map((e) => e.uid);
    st.writeFromOtherTab('Book', { entries: { ...st.readFile('Book').entries, 1: { ...st.readFile('Book').entries[1], order: 200 } } });
    await assert.rejects(adapter.moveEntry('Book', 2, { aboveUid: 0 }, { expectedSequence: seen }), byCode(WorldbookErrorCode.CONFLICT));
});

test('[9] Order values the adapter did not plan to change are kept verbatim (strings, decimals, negatives)', async () => {
    const book = { entries: {
        0: stEditorEntry({ uid: 0, order: '300', group: '' }),
        1: stEditorEntry({ uid: 1, order: 12.5, group: '' }),
        2: stEditorEntry({ uid: 2, order: -4, group: '' }),
        3: stEditorEntry({ uid: 3, order: 1, group: '' }),
    } };
    const { st, adapter } = setup({ books: { Book: book } });
    assert.deepEqual((await adapter.getWorldbook('Book')).entries.map((e) => e.uid), [0, 1, 3, 2]);
    await adapter.moveEntry('Book', 3, 'top');
    const file = st.readFile('Book');
    assert.equal(file.entries[0].order, '300');
    assert.equal(file.entries[1].order, 12.5);
    assert.equal(file.entries[2].order, -4);
    assert.equal(readOrder(file.entries[3].order), 301);
});

test('[10] moving an unknown entry or to an unknown neighbour fails clearly', async () => {
    const { adapter } = setup({ books: { Book: bookWithOrders([100, 50]) } });
    await assert.rejects(adapter.moveEntry('Book', 9, 'top'), byCode(WorldbookErrorCode.ENTRY_NOT_FOUND));
    await assert.rejects(adapter.moveEntry('Book', 0, { aboveUid: 9 }), byCode(WorldbookErrorCode.ENTRY_NOT_FOUND));
    await assert.rejects(adapter.moveEntry('Book', 0, { aboveUid: 0 }), byCode(WorldbookErrorCode.INVALID_ARGUMENT));
    await assert.rejects(adapter.moveEntry('Book', 0, { index: 7 }), byCode(WorldbookErrorCode.INVALID_ARGUMENT));
});

test('[10] decimal Order values that already fit are left alone', async () => {
    const { st, adapter } = setup({ books: { Book: bookWithOrders([5.8, 5.5, 5]) } });
    const result = await adapter.moveEntry('Book', 1, { aboveUid: 0, belowUid: 2 });
    assert.equal(result.written, false);
    assert.equal(st.calls.edit, 0);
});
