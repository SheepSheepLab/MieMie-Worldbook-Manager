// Issue #1 coverage: 11 (failed API calls are never reported as success), 13 (clear errors)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSillyTavernWorldbookAdapter, isWorldbookError, WorldbookErrorCode } from '../../src/index.js';
import { FakeSillyTavern } from '../helpers/fake-sillytavern.js';
import { byCode, setup } from '../helpers/adapter-setup.js';

test('[11] server rejects the save (HTTP 500): ST resolves, the adapter reports WRITE_NOT_CONFIRMED', async () => {
    const { st, adapter } = setup();
    const before = st.fileText('Main Book');
    st.faults.edit.push({ status: 500 });
    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 'lost' }), (error) => {
        assert.equal(error.code, WorldbookErrorCode.WRITE_NOT_CONFIRMED);
        assert.deepEqual(error.details.mismatchedEntries, ['0']);
        assert.equal(error.details.cacheRestored, true);
        return true;
    });
    assert.equal(st.fileText('Main Book'), before, 'file unchanged');
    const cached = await st.loadWorldInfo('Main Book');
    assert.deepEqual(cached, st.readFile('Main Book'), 'ST page cache no longer claims the unsaved change');
    assert.equal(st.calls.edit, 1, 'the page cache is restored without another write to the server');
});

test('[11] restoring ST\'s page copy never writes the file, so a later write from elsewhere survives', async () => {
    const { st, adapter } = setup();
    st.faults.edit.push({ status: 500 });
    const originalFetch = st.fetch;
    let reads = 0;
    const adapterFetch = async (url, init) => {
        // Another tab saves right after the restore step has read the file.
        if (url === '/api/worldinfo/get' && st.calls.edit === 1 && ++reads === 2) {
            const response = await originalFetch(url, init);
            const other = st.readFile('Other Book');
            other.entries[1].content = 'Edited on the phone';
            st.writeFromOtherTab('Other Book', other);
            return response;
        }
        return originalFetch(url, init);
    };
    const flaky = createSillyTavernWorldbookAdapter({ getContext: st.getContext, fetch: adapterFetch, tavernHelper: null, document: null, settleTimeoutMs: 50 });
    await assert.rejects(flaky.updateEntry('Other Book', 0, { content: 'mine' }), byCode(WorldbookErrorCode.WRITE_NOT_CONFIRMED));
    assert.equal(st.calls.edit, 1);
    assert.equal(st.readFile('Other Book').entries[1].content, 'Edited on the phone');
    assert.notEqual(st.readFile('Other Book').entries[0].content, 'mine');
});

test('[11] server answers 200 but does not store the data: still not reported as success', async () => {
    const { st, adapter } = setup();
    st.faults.edit.push('drop');
    await assert.rejects(adapter.createEntry('Main Book', { fields: { content: 'ghost' } }), byCode(WorldbookErrorCode.WRITE_NOT_CONFIRMED));
    assert.equal(Object.values(st.readFile('Main Book').entries).some((e) => e?.content === 'ghost'), false);
});

test('[11] network failure during save is WRITE_FAILED', async () => {
    const { st, adapter } = setup();
    st.faults.edit.push('network');
    await assert.rejects(adapter.deleteEntry('Main Book', 0), (error) => {
        assert.equal(error.code, WorldbookErrorCode.WRITE_FAILED);
        assert.match(error.details.saveError, /Failed to fetch/);
        return true;
    });
    assert.ok(st.readFile('Main Book').entries[0], 'entry still there');
});

test('[11] save could not be read back: WRITE_NOT_CONFIRMED, never success', async () => {
    const { st } = setup();
    // Reads during settle succeed; the read-back after saving fails.
    const originalFetch = st.fetch;
    const adapterWithFlakyRead = createSillyTavernWorldbookAdapter({
        getContext: st.getContext,
        fetch: async (url, init) => {
            if (url === '/api/worldinfo/get' && st.calls.edit > 0) throw new TypeError('Failed to fetch');
            return originalFetch(url, init);
        },
        tavernHelper: null,
        document: null,
        settleTimeoutMs: 50,
    });
    await assert.rejects(adapterWithFlakyRead.updateEntry('Main Book', 0, { content: 'x' }), byCode(WorldbookErrorCode.WRITE_NOT_CONFIRMED));
});

test('[11] save response lost but the file was written: confirmed by read-back, reported as success', async () => {
    const { st, adapter } = setup();
    st.faults.edit.push((body) => { st.files.set(body.name, JSON.stringify(body.data, null, 4)); throw new TypeError('connection reset after write'); });
    const result = await adapter.updateEntry('Main Book', 0, { content: 'landed' });
    assert.equal(result.verified, true);
    assert.equal(st.readFile('Main Book').entries[0].content, 'landed');
});

test('[11] reading a book the server cannot parse is READ_FAILED', async () => {
    const { st, adapter } = setup();
    st.files.set('Main Book', '{ not json');
    await assert.rejects(adapter.getWorldbook('Main Book'), byCode(WorldbookErrorCode.READ_FAILED));
    await assert.rejects(adapter.updateEntry('Main Book', 0, { content: 'x' }), byCode(WorldbookErrorCode.READ_FAILED));
    assert.equal(st.fileText('Main Book'), '{ not json', 'broken file left alone');
});

test('[13] every failure is a WorldbookError with a stable code and details', async () => {
    const { adapter } = setup();
    const cases = [
        [() => adapter.getWorldbook(''), WorldbookErrorCode.INVALID_ARGUMENT],
        [() => adapter.getWorldbook('Nope'), WorldbookErrorCode.WORLDBOOK_NOT_FOUND],
        [() => adapter.getEntry('Main Book', -1), WorldbookErrorCode.INVALID_ARGUMENT],
        [() => adapter.getEntry('Main Book', 1.5), WorldbookErrorCode.INVALID_ARGUMENT],
        [() => adapter.updateEntry('Main Book', 404, { content: 'x' }), WorldbookErrorCode.ENTRY_NOT_FOUND],
        [() => adapter.updateEntry('Main Book', 0, {}), WorldbookErrorCode.INVALID_PATCH],
        [() => adapter.updateEntry('Main Book', 0, { order: 'high' }), WorldbookErrorCode.INVALID_PATCH],
        [() => adapter.deleteEntry('Main Book', 404), WorldbookErrorCode.ENTRY_NOT_FOUND],
        [() => adapter.updateEntry('Broken Book', 3, { content: 'x' }), WorldbookErrorCode.MALFORMED_DATA],
        [() => adapter.moveEntry('Main Book', 0, 'sideways'), WorldbookErrorCode.INVALID_ARGUMENT],
    ];
    for (const [call, code] of cases) {
        await assert.rejects(Promise.resolve().then(call), (error) => {
            assert.ok(isWorldbookError(error), `${code}: is a WorldbookError`);
            assert.equal(error.code, code);
            assert.equal(typeof error.message, 'string');
            assert.equal(typeof error.details, 'object');
            return true;
        });
    }
});

test('[13] missing host functions are reported up front', () => {
    const st = new FakeSillyTavern();
    assert.throws(() => createSillyTavernWorldbookAdapter({
        getContext: () => ({ ...st.getContext(), saveWorldInfo: undefined }),
        fetch: st.fetch,
        tavernHelper: null,
        document: null,
    }), byCode(WorldbookErrorCode.HOST_UNAVAILABLE));
    assert.throws(() => createSillyTavernWorldbookAdapter({
        getContext: () => { throw new Error('not ready'); },
        fetch: st.fetch,
        tavernHelper: null,
        document: null,
    }), byCode(WorldbookErrorCode.HOST_UNAVAILABLE));
});

test('[11] restoring ST\'s page copy after a failed save does not revert a write made meanwhile elsewhere', async () => {
    const { st, adapter } = setup();
    st.faults.edit.push((body) => {
        // Another tab saves while this save is being rejected.
        const other = JSON.parse(st.fileText(body.name));
        other.entries[1].content = 'Edited on the phone';
        st.writeFromOtherTab(body.name, other);
        throw new TypeError('Failed to fetch');
    });
    await assert.rejects(adapter.updateEntry('Other Book', 0, { content: 'mine' }), (error) => {
        assert.equal(error.code, WorldbookErrorCode.WRITE_FAILED);
        assert.equal(error.details.cacheRestored, true);
        return true;
    });
    assert.equal(st.readFile('Other Book').entries[1].content, 'Edited on the phone');
    assert.notEqual(st.readFile('Other Book').entries[0].content, 'mine');
});
