// Several writers in one page, listeners that touch saved data, caller objects that
// are proxies or cyclic, reused uids, and odd arguments.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSillyTavernWorldbookAdapter, fingerprint, WorldbookErrorCode, isWorldbookError } from '../../src/index.js';
import { byCode, setup } from '../helpers/adapter-setup.js';

test('two adapters in one page share the per-book lock: neither write is lost', async () => {
    const { st, adapter: a, sharedState } = setup();
    const b = createSillyTavernWorldbookAdapter({ getContext: st.getContext, fetch: st.fetch, tavernHelper: null, document: null, sharedState, settleTimeoutMs: 150 });
    const originalFetch = st.fetch;
    st.fetch = async (url, init) => {
        if (url === '/api/worldinfo/edit' && init.body.includes('from B')) await new Promise((r) => setTimeout(r, 30));
        return originalFetch(url, init);
    };
    const results = await Promise.allSettled([
        a.updateEntry('Main Book', 0, { content: 'from A' }),
        b.updateEntry('Main Book', 1, { content: 'from B' }),
    ]);
    assert.ok(results.every((r) => r.status === 'fulfilled'));
    const file = st.readFile('Main Book');
    assert.equal(file.entries[0].content, 'from A');
    assert.equal(file.entries[1].content, 'from B');
});

test('an external save of the same book during an adapter save is still reported', async () => {
    const { st, adapter } = setup();
    const seen = [];
    const stop = adapter.watchWorldbooks((event) => seen.push(event.worldbook));
    const originalFetch = st.fetch;
    let external;
    st.fetch = async (url, init) => {
        if (url === '/api/worldinfo/edit' && !external && init.body.includes('"ours"')) {
            // Another script saves the same book while this save is still in flight.
            external = st.editInPage('Main Book', (d) => { d.entries[1].content = 'external'; }, { immediately: true });
            await external;
        }
        return originalFetch(url, init);
    };
    await adapter.updateEntry('Main Book', 0, { content: 'ours' });
    stop();
    assert.ok(external, 'the external save ran');
    assert.deepEqual(seen, ['Main Book']);
});

test('a WORLDINFO_UPDATED listener changing the saved object cannot fake a successful write', async () => {
    const { st, adapter } = setup();
    let busy = false;
    st.on('worldinfo_updated', async (name, data) => {
        if (busy || name !== 'Main Book') return;
        busy = true;
        data.entries[0].content = 'REWRITTEN BY LISTENER';
        await st.saveWorldInfo(name, data, true);
        busy = false;
    });
    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 'intended' }), byCode(WorldbookErrorCode.WRITE_NOT_CONFIRMED));
});

test('a listener that only marks the saved object does not turn a stored write into a failure', async () => {
    const { st, adapter } = setup();
    st.on('worldinfo_updated', (name, data) => { data.entries[0]._seen = true; });
    const result = await adapter.updateEntry('Main Book', 0, { content: 'x2' });
    assert.equal(result.verified, true);
    assert.equal(st.readFile('Main Book').entries[0].content, 'x2');
});

test('saveHostCopy never recreates a book deleted elsewhere', async () => {
    const { st, adapter } = setup();
    await st.loadWorldInfo('Other Book');
    st.files.delete('Other Book');
    await assert.rejects(adapter.saveHostCopy('Other Book'), byCode(WorldbookErrorCode.WORLDBOOK_NOT_FOUND));
    assert.equal(st.files.has('Other Book'), false);
});

test('saveHostCopy refuses when the file changed after the difference was reported', async () => {
    const { st, adapter } = setup({ settleTimeoutMs: 50 });
    await st.loadWorldInfo('Main Book');
    const tab = st.readFile('Main Book');
    tab.entries[1].content = 'phone edit 1';
    st.writeFromOtherTab('Main Book', tab);
    let reported;
    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 'x' }), (error) => {
        reported = error.details.storedFingerprint;
        return error.code === WorldbookErrorCode.HOST_UNSAVED_CHANGES;
    });
    assert.equal(reported, fingerprint(st.readFile('Main Book')));
    const again = st.readFile('Main Book');
    again.entries[2].content = 'phone edit 2';
    st.writeFromOtherTab('Main Book', again);
    await assert.rejects(adapter.saveHostCopy('Main Book', { expectedStoredFingerprint: reported }), byCode(WorldbookErrorCode.CONFLICT));
    assert.equal(st.readFile('Main Book').entries[2].content, 'phone edit 2');
});

test('reactive (Proxy) baselines and values work; cyclic values are INVALID_PATCH', async () => {
    const { st, adapter } = setup();
    const baseline = new Proxy(await adapter.getEntry('Main Book', 0), {});
    await st.editInPage('Main Book', (d) => { d.entries[0].content = 'changed'; }, { immediately: true });
    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 'mine' }, { baseline }), byCode(WorldbookErrorCode.CONFLICT));

    const result = await adapter.updateEntry('Main Book', 1, { myExt: new Proxy({ a: 1 }, {}) });
    assert.deepEqual(st.readFile('Main Book').entries[1].myExt, { a: 1 });
    assert.equal(result.verified, true);

    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    await assert.rejects(adapter.updateEntry('Main Book', 1, { myExt: cyclic }), byCode(WorldbookErrorCode.INVALID_PATCH));
});

test('"fields" scope still refuses when the uid now belongs to a different entry', async () => {
    const { st, adapter } = setup();
    const baseline = await adapter.getEntry('Main Book', 0);
    await st.editInPage('Main Book', (d) => {
        d.entries[0] = { ...d.entries[0], comment: 'Different entry', key: ['Bob'], content: 'Bob' };
    }, { immediately: true });
    await assert.rejects(adapter.updateEntry('Main Book', 0, { disable: true }, { baseline, conflictScope: 'fields' }), byCode(WorldbookErrorCode.CONFLICT));
    assert.equal(st.readFile('Main Book').entries[0].disable, false);
});

test('null options behave like no options; bad option values are INVALID_ARGUMENT', async () => {
    const { adapter } = setup();
    assert.ok((await adapter.getWorldbook('Main Book', null)).entries.length > 0);
    assert.ok(Array.isArray(await adapter.listWorldbooks(null)));
    const result = await adapter.updateEntry('Main Book', 0, { content: 'q' }, null);
    assert.equal(result.written, true);
    for (const call of [
        () => adapter.getWorldbook('Main Book', { source: 'disk' }),
        () => adapter.updateEntry('Main Book', 0, { content: 'r' }, { conflictScope: 'all' }),
        () => adapter.updateEntry('Main Book', 0, { content: 'r' }, { onHostDrift: 'overwrite' }),
    ]) {
        await assert.rejects(Promise.resolve().then(call), (error) => isWorldbookError(error) && error.code === WorldbookErrorCode.INVALID_ARGUMENT);
    }
});

test('waiting for the ST editor\'s book happens before the target is read', async () => {
    const { st, adapter } = setup({ withDom: true, settleTimeoutMs: 300 });
    st.editorSelected = 'Other Book';
    // The editor book differs from its file (stale page copy), so the adapter waits for it.
    await st.loadWorldInfo('Other Book');
    const other = st.readFile('Other Book');
    other.entries[0].content = 'changed on the phone';
    st.writeFromOtherTab('Other Book', other);

    const write = adapter.updateEntry('Main Book', 0, { content: 'MieMie' });
    await new Promise((r) => setTimeout(r, 100));
    const main = st.readFile('Main Book');
    main.entries[1].content = 'written during the wait';
    st.writeFromOtherTab('Main Book', main);
    const result = await write;

    assert.equal(st.readFile('Main Book').entries[1].content, 'written during the wait');
    assert.equal(st.readFile('Main Book').entries[0].content, 'MieMie');
    assert.deepEqual(result.hostUnsavedBooks, ['Other Book']);
});
