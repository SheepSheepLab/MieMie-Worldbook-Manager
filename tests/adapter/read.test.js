// Issue #1 coverage: 1 (worldbook read), 2 (full entry read), 9 (Order read), 14 (no UI dependency)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSillyTavernWorldbookAdapter, WorldbookErrorCode } from '../../src/index.js';
import { mainBook, standardBooks } from '../fixtures/worldbooks.js';
import { FakeSillyTavern } from '../helpers/fake-sillytavern.js';
import { byCode, setup } from '../helpers/adapter-setup.js';

const TAVERN_HELPER_READERS = new Set(['getWorldbookNames', 'getGlobalWorldbookNames', 'getCharWorldbookNames', 'getTavernHelperVersion']);

/** Tavern Helper stand-in that records every function the adapter looks up; calling anything else throws. */
function recordingTavernHelper(readers) {
    const accessed = [];
    const th = new Proxy(readers, {
        get(target, prop) {
            if (typeof prop !== 'string') return undefined;
            accessed.push(prop);
            return prop in target ? target[prop] : () => { throw new Error(`Tavern Helper ${prop} must not be called`); };
        },
    });
    return { th, accessed };
}

test('[1] lists worldbooks and reads a book exactly as stored, book-level keys included', async () => {
    const { st, adapter } = setup();
    assert.deepEqual(await adapter.listWorldbooks(), ['Broken Book', 'Chat Book', 'Empty Book', 'Main Book', 'Other Book']);

    const snapshot = await adapter.getWorldbook('Main Book');
    assert.equal(snapshot.name, 'Main Book');
    assert.equal(snapshot.source, 'stored');
    assert.deepEqual(snapshot.data, st.readFile('Main Book'));
    assert.deepEqual(snapshot.data.originalData, mainBook().originalData);
    assert.deepEqual(snapshot.data.customTopLevel, { keep: [1, 2, 3] });
    assert.deepEqual(snapshot.anomalies, []);
    assert.equal(typeof snapshot.fingerprint, 'string');
});

test('[1] reading does not write anything', async () => {
    const { st, adapter } = setup();
    const before = st.fileText('Main Book');
    await adapter.getWorldbook('Main Book');
    await adapter.getWorldbook('Main Book', { source: 'cache' });
    assert.equal(st.calls.edit, 0);
    assert.equal(st.fileText('Main Book'), before);
});

test('[1] cache source returns ST\'s in-memory copy, as a private copy', async () => {
    const { st, adapter } = setup();
    await st.editInPage('Main Book', (data) => { data.entries[0].content = 'unsaved in page'; });
    const cached = await adapter.getWorldbook('Main Book', { source: 'cache' });
    const stored = await adapter.getWorldbook('Main Book');
    assert.equal(cached.data.entries[0].content, 'unsaved in page');
    assert.notEqual(stored.data.entries[0].content, 'unsaved in page');
    cached.data.entries[0].content = 'mutated by caller';
    assert.equal((await adapter.getWorldbook('Main Book', { source: 'cache' })).data.entries[0].content, 'unsaved in page');
    await st.flush();
});

test('[2] entries are the complete raw objects, unknown and nested fields included', async () => {
    const { adapter } = setup();
    const expected = mainBook().entries;
    for (const uid of [0, 1, 2, 5, 7, 9]) {
        assert.deepEqual(await adapter.getEntry('Main Book', uid), expected[uid], `entry ${uid}`);
    }
    const entry = await adapter.getEntry('Main Book', 2);
    assert.deepEqual(entry.miemieUnknownField, { nested: [1, { deep: 'value' }], flag: false });
    assert.equal(entry.futureStField, 'from a later SillyTavern release');
    assert.deepEqual(entry.extra, { tavernHelper: { tag: 'keep-me' } });
    assert.deepEqual((await adapter.getEntry('Main Book', 1)).extensions.my_card_ext, { foo: 1, list: ['a', 'b'] });
    assert.equal(await adapter.getEntry('Main Book', 42), null);
});

test('[9] entries come in display order: Order high to low, ties by UID, numeric strings compared as numbers', async () => {
    const { adapter } = setup();
    const snapshot = await adapter.getWorldbook('Main Book');
    assert.deepEqual(snapshot.entries.map((e) => e.uid), [0, 1, 2, 5, 7, 9]);
    assert.deepEqual(snapshot.entries.map((e) => e.order), [100, 90, 80, '50', 50, 10]);
});

test('[1] malformed entries are reported and kept in data untouched', async () => {
    const { adapter } = setup();
    const snapshot = await adapter.getWorldbook('Broken Book');
    assert.deepEqual(snapshot.entries.map((e) => e.uid), [0]);
    assert.deepEqual(snapshot.anomalies.map((a) => a.key).sort(), ['3', '6']);
    assert.equal(snapshot.data.entries[6], null);
    assert.equal(snapshot.data.entries[3].uid, 4);
});

test('[1] a book that does not exist is an error, not an empty book', async () => {
    const { st, adapter } = setup();
    await assert.rejects(adapter.getWorldbook('No Such Book'), byCode(WorldbookErrorCode.WORLDBOOK_NOT_FOUND));
    assert.equal(st.calls.updateWorldInfoList, 1, 'the list was refreshed once before giving up');
});

test('[1] a book deleted in another tab is detected despite the server dummy answer', async () => {
    const { st, adapter } = setup();
    st.files.delete('Other Book');
    await assert.rejects(adapter.getWorldbook('Other Book'), byCode(WorldbookErrorCode.WORLDBOOK_NOT_FOUND));
});

test('[1] a book created in another tab is found after a list refresh', async () => {
    const { st, adapter } = setup();
    st.writeFromOtherTab('New Tab Book', { entries: { 0: { uid: 0, content: 'x', order: 1 } } });
    const snapshot = await adapter.getWorldbook('New Tab Book');
    assert.equal(snapshot.entries.length, 1);
    assert.ok((await adapter.listWorldbooks()).includes('New Tab Book'));
});

test('[switching] active books are read from ST without side effects', async () => {
    const { st, adapter } = setup({ withDom: true });
    st.globalSelected = ['Other Book'];
    st.powerUser.persona_description_lorebook = 'Other Book';
    st.editorSelected = 'Main Book';
    const chatBefore = st.chatState();

    const active = await adapter.getActiveWorldbooks();
    assert.deepEqual(active.global, { names: ['Other Book'], source: 'slash-command' });
    assert.deepEqual(active.character, { primary: 'Main Book', additional: ['Other Book'], source: 'context+slash-command' });
    assert.equal(active.groupMembers, null);
    assert.deepEqual(active.chat, { name: 'Chat Book', dangling: false, source: 'context' });
    assert.deepEqual(active.persona, { name: 'Other Book', source: 'context' });
    assert.deepEqual(active.editor, { name: 'Main Book', source: 'dom' });
    assert.deepEqual(active.missing, []);
    assert.equal(st.chatState(), chatBefore);
    assert.equal(st.calls.edit, 0);
});

test('[switching] dangling chat binding is reported, not repaired', async () => {
    const { st, adapter } = setup();
    st.chatMetadata.world_info = 'Deleted Book';
    const active = await adapter.getActiveWorldbooks();
    assert.deepEqual(active.chat, { name: 'Deleted Book', dangling: true, source: 'context' });
    assert.deepEqual(active.missing, ['Deleted Book']);
    assert.equal(st.chatMetadata.world_info, 'Deleted Book', 'binding left as is');
});

test('[switching] group chats list each member\'s books through read-only slash commands', async () => {
    const { th, accessed } = recordingTavernHelper({ getCharWorldbookNames: () => ({ primary: null, additional: ['Wrong'] }) });
    const { st, adapter } = setup({ tavernHelper: th });
    st.groupId = 'g1';
    st.characterId = undefined;
    st.groups = [{ id: 'g1', members: ['Alice.png', 'Bob.png'] }];
    const active = await adapter.getActiveWorldbooks();
    assert.equal(active.character, null);
    assert.deepEqual(active.groupMembers, [
        { avatar: 'Alice.png', name: 'Alice', primary: 'Main Book', additional: ['Other Book'] },
        { avatar: 'Bob.png', name: 'Bob', primary: null, additional: [] },
    ]);
    assert.ok(!accessed.includes('getCharWorldbookNames'), 'installed members need no Tavern Helper');
});

test('[switching] a group member that is not installed is looked up through Tavern Helper only', async () => {
    const asked = [];
    const { th, accessed } = recordingTavernHelper({
        getCharWorldbookNames: (who) => { asked.push(who); return { primary: null, additional: ['Other Book'] }; },
    });
    const { st, adapter } = setup({ tavernHelper: th });
    st.groupId = 'g1';
    st.characterId = undefined;
    st.groups = [{ id: 'g1', members: ['Alice.png', 'Ghost.png'] }];
    const active = await adapter.getActiveWorldbooks();
    assert.deepEqual(active.groupMembers[1], { avatar: 'Ghost.png', name: null, primary: null, additional: ['Other Book'] });
    assert.deepEqual(asked, ['Ghost.png']);
    assert.ok(accessed.every((name) => TAVERN_HELPER_READERS.has(name)), accessed.join());
});

test('[switching] without getWorldInfoNames and slash commands, names and bindings come from Tavern Helper, which is only read', async () => {
    const st = new FakeSillyTavern({ books: standardBooks() });
    const { th, accessed } = recordingTavernHelper({
        getWorldbookNames: () => st.getContext().getWorldInfoNames(),
        getGlobalWorldbookNames: () => ['Other Book'],
        getCharWorldbookNames: (who) => (who === 'current' ? { primary: 'Main Book', additional: ['Chat Book'] } : null),
    });
    const adapter = createSillyTavernWorldbookAdapter({
        getContext: () => ({ ...st.getContext(), getWorldInfoNames: undefined, executeSlashCommandsWithOptions: undefined }),
        fetch: st.fetch,
        tavernHelper: th,
        document: null,
        settleTimeoutMs: 50,
    });
    assert.deepEqual(await adapter.listWorldbooks(), st.getContext().getWorldInfoNames());
    const active = await adapter.getActiveWorldbooks();
    assert.deepEqual(active.global, { names: ['Other Book'], source: 'tavern-helper' });
    assert.deepEqual(active.character, { primary: 'Main Book', additional: ['Chat Book'], source: 'context+tavern-helper' });
    const created = await adapter.createEntry('Other Book', { fields: { content: 'via fallbacks' } });
    assert.equal(created.verified, true);
    assert.ok(accessed.every((name) => TAVERN_HELPER_READERS.has(name)), accessed.join());
});

test('[14] everything works without DOM, UI or Tavern Helper', async () => {
    const { adapter } = setup({ withDom: false, tavernHelper: null });
    const active = await adapter.getActiveWorldbooks();
    assert.deepEqual(active.editor, { name: null, source: 'unavailable' });
    const created = await adapter.createEntry('Other Book', { fields: { content: 'no UI needed' } });
    assert.equal(created.verified, true);
    const host = await adapter.describeHost();
    assert.equal(host.sillyTavernVersion, '1.19.0');
    assert.equal(host.editorDom, false);
    assert.equal(host.tavernHelperVersion, null);
});

test('[switching] a handle is bound to one book', async () => {
    const { adapter } = setup();
    const handle = adapter.worldbook('Other Book');
    assert.equal(handle.name, 'Other Book');
    assert.throws(() => { handle.name = 'Main Book'; }, TypeError);
    const snapshot = await handle.read();
    assert.equal(snapshot.name, 'Other Book');
    assert.deepEqual(await handle.saveHostCopy(), { worldbook: 'Other Book', written: false, verified: true });
    assert.throws(() => adapter.worldbook(''), byCode(WorldbookErrorCode.INVALID_ARGUMENT));
});
