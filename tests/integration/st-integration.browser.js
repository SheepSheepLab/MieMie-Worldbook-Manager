// Integration test against a real SillyTavern page (run in the browser console).
// See docs/testing.md for setup. Use a test user profile: the script
// creates, edits and finally deletes worldbooks whose names start with PREFIX,
// and never touches other books or chats.
//
//   const m = await import('/scripts/extensions/third-party/MieMie-Worldbook-Manager/tests/integration/st-integration.browser.js');
//   const report = await m.runIntegration();
//   console.table(report.results);
//
// Also runs inside a Tavern Helper script iframe: host-page objects (fetch used by
// SillyTavern, the World Info editor DOM) are then taken from the parent window,
// and checks that need SillyTavern's own ES modules are skipped.

import * as lib from '../../src/index.js';
import { mainBook, otherBook } from '../fixtures/worldbooks.js';

const PREFIX = 'MieMie IT';
const MAIN = `${PREFIX} Main`;
const OTHER = `${PREFIX} Other`;
const SCRATCH = `${PREFIX} Scratch`;
const TH_BOOK = `${PREFIX} TavernHelper`;
// Unique per run: B15 needs a book this page has never cached.
const NORM = `${PREFIX} Normalized ${Date.now().toString(36)}`;
const ST_DEBOUNCE_WAIT = 1600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runIntegration({ includeTavernHelper = true, includeEditor = true } = {}) {
    const ctx = () => SillyTavern.getContext();
    const inIframe = window.parent !== window && Boolean(window.parent.SillyTavern);
    const hostWindow = inIframe ? window.parent : window;
    const results = [];
    const skip = (id, title, reason) => results.push({ id, title, result: 'SKIP', detail: reason });
    const record = async (id, title, fn) => {
        try {
            const detail = await fn();
            results.push({ id, title, result: 'PASS', detail: detail ?? '' });
        } catch (error) {
            results.push({ id, title, result: 'FAIL', detail: `${error?.code ?? ''} ${error?.message ?? error}` });
        }
    };
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };

    const readDisk = async (name) => {
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name }), cache: 'no-cache',
        });
        return response.json();
    };
    const writeDiskRaw = async (name, data) => {
        const response = await fetch('/api/worldinfo/edit', {
            method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name, data }),
        });
        assert(response.ok, `raw write of ${name} failed`);
    };
    const deleteBook = async (name) => {
        assert(name.startsWith(PREFIX), 'refusing to delete a book the test did not create');
        await fetch('/api/worldinfo/delete', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name }) });
    };
    const createBook = async (name, data) => {
        await ctx().saveWorldInfo(name, structuredClone(data), true);
        await ctx().updateWorldInfoList();
    };
    // SillyTavern's own saves use the host page's fetch, so failures are injected there.
    const withFailingEdit = async (status, fn) => {
        const original = hostWindow.fetch;
        hostWindow.fetch = (url, init) => (String(url).includes('/api/worldinfo/edit') ? Promise.resolve(new Response('injected failure', { status })) : original(url, init));
        try {
            return await fn();
        } finally {
            hostWindow.fetch = original;
        }
    };
    // Importing SillyTavern's modules from an iframe would start a second copy of its frontend.
    const stWorldInfoModule = () => (inIframe ? null : import('/scripts/world-info.js'));

    const chatBefore = JSON.stringify({ chat: ctx().chat, meta: ctx().chatMetadata });
    const namesBefore = ctx().getWorldInfoNames().filter((n) => !n.startsWith(PREFIX));

    for (const name of ctx().getWorldInfoNames().filter((n) => n.startsWith(PREFIX))) await deleteBook(name);
    await ctx().updateWorldInfoList();
    await createBook(MAIN, mainBook());
    await createBook(OTHER, otherBook());

    const adapter = lib.createSillyTavernWorldbookAdapter();
    const host = await adapter.describeHost();

    // ---------------------------------------------------------------- A. host behaviour evidence

    await record('A1', 'saveWorldInfo resolves on HTTP 500 and still updates the page cache', async () => {
        const before = await readDisk(OTHER);
        const data = structuredClone(before);
        data.entries[0].content = 'A1 unsaved';
        let resolved = false;
        await withFailingEdit(500, async () => { await ctx().saveWorldInfo(OTHER, data, true); resolved = true; });
        const disk = await readDisk(OTHER);
        const cached = await ctx().loadWorldInfo(OTHER);
        assert(resolved, 'did not resolve');
        assert(disk.entries[0].content !== 'A1 unsaved', 'file changed');
        assert(cached.entries[0].content === 'A1 unsaved', 'cache not updated');
        await ctx().saveWorldInfo(OTHER, before, true); // put page cache back
        return 'resolved=true, file unchanged, cache holds unsaved data';
    });

    await record('A2', 'an immediate save of book B cancels the pending debounced save of book A', async () => {
        await createBook(SCRATCH, { entries: { 0: { uid: 0, content: 'scratch', order: 1 } } });
        const a = structuredClone(await readDisk(OTHER));
        a.entries[1].content = 'A2 debounced';
        await ctx().saveWorldInfo(OTHER, a); // debounced (1000 ms)
        await ctx().saveWorldInfo(SCRATCH, await readDisk(SCRATCH), true);
        await sleep(ST_DEBOUNCE_WAIT);
        const disk = await readDisk(OTHER);
        const lost = disk.entries[1].content !== 'A2 debounced';
        await ctx().saveWorldInfo(OTHER, await readDisk(OTHER), true); // put page cache back
        assert(lost, 'debounced save was not cancelled (ST behaviour differs from 1.19.0 source)');
        return 'pending save of the other book never reached the file';
    });

    await record('A3', 'loadWorldInfo on a cache miss returns the live cached object', async () => {
        const name = `${PREFIX} Alias`;
        await writeDiskRaw(name, { entries: { 0: { uid: 0, content: 'original', order: 1 } } });
        await ctx().updateWorldInfoList();
        const first = await ctx().loadWorldInfo(name);
        first.entries[0].content = 'mutated by caller';
        const second = await ctx().loadWorldInfo(name);
        await deleteBook(name);
        await ctx().updateWorldInfoList();
        assert(second.entries[0].content === 'mutated by caller', 'cache was not aliased');
        return 'caller mutation leaked into ST cache';
    });

    await record('A4', '/api/worldinfo/get answers a missing book with an empty dummy', async () => {
        const data = await readDisk(`${PREFIX} does not exist`);
        assert(JSON.stringify(data) === '{"entries":{}}', JSON.stringify(data));
        return '{"entries":{}} with HTTP 200';
    });

    if (inIframe) skip('A5', 'st-schema template and field definition match the running SillyTavern', 'needs SillyTavern ES modules (main window only)');
    else await record('A5', 'st-schema template and field definition match the running SillyTavern', async () => {
        const wi = await stWorldInfoModule();
        const stTemplate = wi.newWorldInfoEntryTemplate;
        assert(lib.jsonEqual(lib.newEntryTemplate(), stTemplate), `template differs: ${JSON.stringify(lib.diffPaths(lib.newEntryTemplate(), stTemplate))}`);
        const stDefinition = Object.fromEntries(Object.entries(wi.newWorldInfoEntryDefinition).map(([k, v]) => [k, { default: v.default, type: v.type }]));
        const ours = Object.fromEntries(Object.entries(lib.ENTRY_FIELD_DEFINITION).map(([k, v]) => [k, { default: v.default, type: v.type }]));
        assert(lib.jsonEqual(ours, stDefinition), `definition differs: ${JSON.stringify(lib.diffPaths(ours, stDefinition))}`);
        assert(lib.jsonEqual(lib.WORLD_INFO_POSITION, wi.world_info_position), 'position enum differs');
        assert(lib.jsonEqual(lib.WORLD_INFO_LOGIC, wi.world_info_logic), 'logic enum differs');
        return `${Object.keys(stTemplate).length} template fields identical`;
    });

    if (includeTavernHelper && window.TavernHelper) {
        await record('A6', 'Tavern Helper getWorldbook fails on an entry without keysecondary (legacy entry)', async () => {
            await createBook(TH_BOOK, mainBook());
            let failure = null;
            try {
                await window.TavernHelper.getWorldbook(TH_BOOK);
            } catch (error) {
                failure = String(error?.message ?? error);
            }
            assert(failure, 'Tavern Helper read the legacy entry (behaviour changed?)');
            return failure;
        });

        await record('A7', 'Tavern Helper updateWorldbookWith(identity) is lossy', async () => {
            const original = mainBook();
            delete original.entries[9]; // Tavern Helper cannot read it at all (A6)
            await createBook(TH_BOOK, original);
            await window.TavernHelper.updateWorldbookWith(TH_BOOK, (entries) => entries);
            await sleep(ST_DEBOUNCE_WAIT);
            const after = await readDisk(TH_BOOK);
            const droppedBookKeys = Object.keys(original).filter((k) => !(k in after));
            const e1 = after.entries[1];
            const e2 = after.entries[2];
            const findings = {
                droppedBookKeys,
                entry2DroppedFields: ['miemieUnknownField', 'futureStField'].filter((k) => !(k in e2)),
                entry1ExtensionsDropped: !('extensions' in e1),
                delayUntilRecursion: `${original.entries[1].delayUntilRecursion} -> ${e1.delayUntilRecursion}`,
                useProbability: `${original.entries[1].useProbability}/${original.entries[1].probability} -> ${e1.useProbability}/${e1.probability}`,
                selective: `${original.entries[1].selective} -> ${e1.selective}`,
                key: `${JSON.stringify(original.entries[1].key)} -> ${JSON.stringify(e1.key)}`,
                displayIndex: `${original.entries[1].displayIndex} -> ${e1.displayIndex}`,
                unknownPosition: `${original.entries[5].position} -> ${after.entries[5].position}`,
            };
            assert(droppedBookKeys.length > 0 || findings.entry2DroppedFields.length > 0, 'no loss observed (Tavern Helper behaviour changed?)');
            return JSON.stringify(findings);
        });
    }

    // ---------------------------------------------------------------- B. adapter

    await record('B1', 'getWorldbook returns the stored book exactly', async () => {
        const snapshot = await adapter.getWorldbook(MAIN);
        const disk = await readDisk(MAIN);
        assert(lib.jsonEqual(snapshot.data, disk), 'differs from file');
        assert(lib.jsonEqual(disk, mainBook()), 'file differs from fixture');
        assert(snapshot.entries.map((e) => e.uid).join() === '0,1,2,5,7,9', snapshot.entries.map((e) => e.uid).join());
        return `entries in display order: ${snapshot.entries.map((e) => `${e.uid}:${e.order}`).join(' ')}`;
    });

    await record('B2', 'updateEntry(content) changes only content; other entries byte-identical', async () => {
        const before = await readDisk(MAIN);
        const result = await adapter.updateEntry(MAIN, 2, { content: 'B2 edited' });
        const after = await readDisk(MAIN);
        assert(JSON.stringify(lib.diffPaths(before, after)) === JSON.stringify([['entries', '2', 'content']]), JSON.stringify(lib.diffPaths(before, after)));
        for (const uid of ['0', '1', '5', '7', '9']) {
            assert(JSON.stringify(after.entries[uid]) === JSON.stringify(before.entries[uid]), `entry ${uid} JSON changed`);
        }
        assert(result.verified, 'not verified');
        return 'diff = entries.2.content; unknown fields, originalData and key order kept';
    });

    await record('B3', 'createEntry uses the ST template, lowest free uid, max Order + 1', async () => {
        const result = await adapter.createEntry(MAIN, { fields: { comment: 'B3', content: 'created' } });
        const disk = await readDisk(MAIN);
        const wi = await stWorldInfoModule();
        const template = wi ? structuredClone(wi.newWorldInfoEntryTemplate) : lib.newEntryTemplate();
        const expected = { uid: result.uid, ...template, comment: 'B3', content: 'created', order: 101 };
        assert(result.uid === 3, `uid ${result.uid}`);
        assert(lib.jsonEqual(disk.entries[result.uid], expected), JSON.stringify(lib.diffPaths(disk.entries[result.uid], expected)));
        return `uid ${result.uid}, order ${disk.entries[result.uid].order}`;
    });

    await record('B4', 'moveEntry follows ST Order semantics with minimal changes', async () => {
        const result = await adapter.moveEntry(MAIN, 9, { aboveUid: 0, belowUid: 1 });
        const disk = await readDisk(MAIN);
        const valid = Object.values(disk.entries).filter((e) => e && typeof e === 'object');
        const display = lib.sortForDisplay(valid).map((e) => e.uid);
        assert(display.indexOf(9) === display.indexOf(0) + 1, `display ${display}`);
        assert(disk.entries[0].order > disk.entries[9].order && disk.entries[9].order > disk.entries[1].order, 'not strictly between');
        // ST prompt assembly: sort by (a,b)=>b.order-a.order, then unshift -> ascending text order.
        const slot = [];
        [...valid].sort((a, b) => b.order - a.order).forEach((e) => slot.unshift(e.uid));
        assert(slot.join() === [...display].reverse().join(), 'display is not prompt order reversed');
        assert(result.orderChanges.length === 1 && result.orderChanges[0].uid === 9, JSON.stringify(result.orderChanges));
        return `order ${result.order}, changed ${result.orderChanges.length} entr${result.orderChanges.length === 1 ? 'y' : 'ies'}`;
    });

    await record('B5', 'deleteEntry removes one entry; originalData untouched', async () => {
        const before = await readDisk(MAIN);
        await adapter.deleteEntry(MAIN, 3);
        const after = await readDisk(MAIN);
        assert(!('3' in after.entries), 'still there');
        assert(lib.jsonEqual(after.originalData, before.originalData), 'originalData changed');
        assert(Object.keys(before.entries).length - 1 === Object.keys(after.entries).length, 'other entries changed');
        return 'ok';
    });

    await record('B6', 'server failure is reported, file untouched, ST cache restored', async () => {
        const before = await readDisk(MAIN);
        let code = null;
        await withFailingEdit(500, async () => {
            try {
                await adapter.updateEntry(MAIN, 0, { content: 'B6 must not stick' });
            } catch (error) {
                code = error.code;
            }
        });
        const after = await readDisk(MAIN);
        const cached = await ctx().loadWorldInfo(MAIN);
        assert(code === 'WRITE_NOT_CONFIRMED', `code ${code}`);
        assert(lib.jsonEqual(before, after), 'file changed');
        assert(lib.jsonEqual(cached, after), 'ST cache still differs from file');
        return 'WRITE_NOT_CONFIRMED';
    });

    await record('B7', 'a pending debounced ST save of the same book is kept', async () => {
        const data = structuredClone(await ctx().loadWorldInfo(MAIN));
        data.entries[1].comment = 'B7 debounced by ST';
        await ctx().saveWorldInfo(MAIN, data); // debounced like ST's editor
        await adapter.updateEntry(MAIN, 0, { comment: 'B7 adapter' });
        const disk = await readDisk(MAIN);
        assert(disk.entries[1].comment === 'B7 debounced by ST', 'pending save lost');
        assert(disk.entries[0].comment === 'B7 adapter', 'adapter write missing');
        return 'both changes on disk';
    });

    await record('B8', 'a write from another tab (stale ST cache): refused by default, "use-stored" keeps that write', async () => {
        const other = await readDisk(MAIN);
        other.entries[7].comment = 'B8 other tab';
        await writeDiskRaw(MAIN, other);
        let code = null;
        try {
            await adapter.updateEntry(MAIN, 0, { comment: 'B8 this tab' });
        } catch (error) {
            code = error.code;
        }
        assert(code === 'HOST_UNSAVED_CHANGES', `code ${code}`);
        const result = await adapter.updateEntry(MAIN, 0, { comment: 'B8 this tab' }, { onHostDrift: 'use-stored' });
        const disk = await readDisk(MAIN);
        assert(disk.entries[7].comment === 'B8 other tab', 'other tab change lost');
        assert(disk.entries[0].comment === 'B8 this tab', 'adapter write missing');
        assert(result.hostChangesDiscarded === true, 'discarded page changes not reported');
        return 'HOST_UNSAVED_CHANGES, then written with hostChangesDiscarded=true';
    });

    await record('B9', 'baseline conflict on the same field is refused', async () => {
        const baseline = await adapter.getEntry(MAIN, 5);
        const other = await readDisk(MAIN);
        other.entries[5].content = 'B9 other writer';
        await writeDiskRaw(MAIN, other);
        let code = null;
        try {
            await adapter.updateEntry(MAIN, 5, { content: 'B9 mine' }, { baseline });
        } catch (error) {
            code = error.code;
        }
        assert(code === 'CONFLICT', `code ${code}`);
        assert((await readDisk(MAIN)).entries[5].content === 'B9 other writer', 'overwritten');
        return 'CONFLICT';
    });

    await record('B17', 'saveHostCopy stores ST\'s copy only if the file is still the one that was reported', async () => {
        const cachedBefore = structuredClone(await ctx().loadWorldInfo(MAIN));
        const other = await readDisk(MAIN);
        other.entries[7].comment = 'B17 other tab';
        await writeDiskRaw(MAIN, other);
        let reported = null;
        try {
            await adapter.updateEntry(MAIN, 0, { comment: 'B17' });
        } catch (error) {
            reported = error;
        }
        assert(reported?.code === 'HOST_UNSAVED_CHANGES', `code ${reported?.code}`);
        const again = await readDisk(MAIN);
        again.entries[7].comment = 'B17 other tab, second edit';
        await writeDiskRaw(MAIN, again);
        let code = null;
        try {
            await adapter.saveHostCopy(MAIN, { expectedStoredFingerprint: reported.details.storedFingerprint });
        } catch (error) {
            code = error.code;
        }
        assert(code === 'CONFLICT', `stale fingerprint: code ${code}`);
        assert((await readDisk(MAIN)).entries[7].comment === 'B17 other tab, second edit', 'file overwritten despite CONFLICT');
        const fresh = await adapter.getWorldbook(MAIN);
        const saved = await adapter.saveHostCopy(MAIN, { expectedStoredFingerprint: fresh.fingerprint });
        const disk = await readDisk(MAIN);
        assert(saved.written && saved.verified, JSON.stringify(saved));
        assert(lib.jsonEqual(disk, cachedBefore), 'file is not ST\'s copy');
        assert(lib.jsonEqual(await ctx().loadWorldInfo(MAIN), disk), 'ST cache differs from file');
        return 'CONFLICT on a stale fingerprint; then ST\'s copy stored and verified';
    });

    if (includeEditor) {
        await record('B10', 'ST World Info editor does not write its stale copy over an adapter write', async () => {
            ctx().reloadWorldInfoEditor(OTHER, true); // open OTHER in the ST editor
            await sleep(800);
            assert((await adapter.getActiveWorldbooks()).editor.name === OTHER, 'editor did not open the book');
            await adapter.updateEntry(OTHER, 0, { content: 'B10 adapter' });
            await sleep(800);
            const comment = hostWindow.document.querySelector('#world_popup_entries_list .world_entry[uid="1"] textarea[name="comment"]');
            assert(comment, 'editor entry not rendered');
            hostWindow.$(comment).val('B10 typed in ST editor').trigger('input');
            await sleep(ST_DEBOUNCE_WAIT);
            const disk = await readDisk(OTHER);
            assert(disk.entries[1].comment === 'B10 typed in ST editor', 'ST editor edit not saved');
            assert(disk.entries[0].content === 'B10 adapter', 'adapter write reverted by ST editor');
            return 'both edits on disk';
        });

        await record('B15', 'rewrites the real ST editor makes when it displays a book are not reported as unsaved changes', async () => {
            // Written without going through ST's cache, so the editor's first load gets ST's
            // live cached object and its render-time rewrites land in the cache itself.
            const entry = (uid, extra) => ({ uid, ...lib.newEntryTemplate(), comment: `n${uid}`, content: `entry ${uid}`, key: [`k${uid}`], ...extra });
            await writeDiskRaw(NORM, { entries: { 0: entry(0), 1: entry(1, { position: 4, role: null, depth: 2 }), 2: { uid: 2, key: ['legacy'], content: 'legacy', order: 10 } } });
            await ctx().updateWorldInfoList();
            ctx().reloadWorldInfoEditor(NORM, true);
            await sleep(800);
            for (const uid of [0, 1, 2]) {
                hostWindow.$(hostWindow.document.querySelector(`#world_popup_entries_list .world_entry[uid="${uid}"] .inline-drawer-toggle`)).trigger('click');
            }
            await sleep(800);
            const rewritten = lib.diffPaths(await readDisk(NORM), await ctx().loadWorldInfo(NORM)).map((path) => path.join('.'));
            assert(rewritten.length > 0, 'ST editor did not rewrite anything (drawers not opened?)');
            const cacheBefore = await ctx().loadWorldInfo(NORM);
            const expectedUntouched = JSON.stringify([cacheBefore.entries[1], cacheBefore.entries[2]]);
            const result = await adapter.updateEntry(NORM, 0, { content: 'entry 0 edited' });
            assert(result.hostDrift === 'normalized', `hostDrift ${result.hostDrift}`);
            const cacheAfter = await ctx().loadWorldInfo(NORM);
            assert(JSON.stringify([cacheAfter.entries[1], cacheAfter.entries[2]]) === expectedUntouched, 'untouched entries changed in ST\'s page copy');
            return `ST rewrote in memory: ${rewritten.join(', ')}`;
        });

        await record('B16', 'rewrites the real ST editor saves into the file are not reported as conflicts', async () => {
            const baselines = await Promise.all([0, 1, 2].map((uid) => adapter.getEntry(NORM, uid)));
            ctx().reloadWorldInfoEditor(NORM, true);
            await sleep(800);
            for (const uid of [0, 1, 2]) {
                hostWindow.$(hostWindow.document.querySelector(`#world_popup_entries_list .world_entry[uid="${uid}"] .inline-drawer-toggle`)).trigger('click');
            }
            await sleep(500);
            // An edit in the ST editor makes ST save the whole book, rewrites included.
            hostWindow.$(hostWindow.document.querySelector('#world_popup_entries_list .world_entry[uid="2"] textarea[name="comment"]')).val('saved by ST').trigger('input');
            await sleep(ST_DEBOUNCE_WAIT);
            const disk = await readDisk(NORM);
            const changed = [0, 1].map((uid) => lib.diffPaths(baselines[uid], disk.entries[uid]).map((path) => path.join('.')));
            assert(changed.some((paths) => paths.length > 0), 'ST saved no rewrites for entries 0 and 1');
            for (const uid of [0, 1]) {
                const written = await adapter.updateEntry(NORM, uid, { content: `entry ${uid} edited again` }, { baseline: baselines[uid] });
                assert(written.written, `entry ${uid}`);
            }
            return `ST saved rewrites: 0 → ${changed[0].join(', ')}; 1 → ${changed[1].join(', ')}`;
        });
    }

    await record('B11', 'active worldbooks are read without side effects', async () => {
        const readSettings = async () => (await hostWindow.fetch('/api/settings/get', { method: 'POST', headers: ctx().getRequestHeaders(), body: '{}' })).json();
        const settingsBefore = (await readSettings()).settings;
        const chatBefore11 = JSON.stringify({ chat: ctx().chat, meta: ctx().chatMetadata });
        const active = await adapter.getActiveWorldbooks();
        assert(active.global.source === 'slash-command' && Array.isArray(active.global.names), `global ${JSON.stringify(active.global)}`);
        assert(active.character?.source === 'context+slash-command' && active.character.primary === ctx().characters[ctx().characterId].data.extensions.world, `character ${JSON.stringify(active.character)}`);
        assert(active.chat.source === 'context' && active.persona.source === 'context', 'chat / persona source');
        assert(active.editor.source === 'dom', `editor ${JSON.stringify(active.editor)}`);
        await sleep(ST_DEBOUNCE_WAIT);
        assert((await readSettings()).settings === settingsBefore, 'settings changed');
        assert(JSON.stringify({ chat: ctx().chat, meta: ctx().chatMetadata }) === chatBefore11, 'chat changed');
        return JSON.stringify({ global: active.global, chat: active.chat, persona: active.persona, editor: active.editor, character: active.character });
    });

    await record('B12', 'missing book: error, and no file is created', async () => {
        let code = null;
        try {
            await adapter.updateEntry(`${PREFIX} Missing`, 0, { content: 'x' });
        } catch (error) {
            code = error.code;
        }
        await ctx().updateWorldInfoList();
        assert(code === 'WORLDBOOK_NOT_FOUND', `code ${code}`);
        assert(!ctx().getWorldInfoNames().includes(`${PREFIX} Missing`), 'file created');
        return code;
    });

    await record('B13', 'watchWorldbooks reports other in-page saves only', async () => {
        const seen = [];
        const stop = adapter.watchWorldbooks((event) => seen.push(event.worldbook));
        await adapter.updateEntry(OTHER, 1, { content: 'B13 adapter' });
        await ctx().saveWorldInfo(OTHER, await readDisk(OTHER), true);
        stop();
        assert(seen.join() === OTHER, `seen ${seen}`);
        return 'ok';
    });

    // ---------------------------------------------------------------- cleanup + chat check

    for (const name of ctx().getWorldInfoNames().filter((n) => n.startsWith(PREFIX))) await deleteBook(name);
    await ctx().updateWorldInfoList();

    await record('B14', 'chat and chat metadata unchanged; other books untouched', async () => {
        const chatAfter = JSON.stringify({ chat: ctx().chat, meta: ctx().chatMetadata });
        assert(chatAfter === chatBefore, 'chat state changed');
        const namesAfter = ctx().getWorldInfoNames().filter((n) => !n.startsWith(PREFIX));
        assert(JSON.stringify(namesAfter) === JSON.stringify(namesBefore), 'book list changed');
        return `chat messages: ${ctx().chat.length}`;
    });

    return { host, inIframe, results, passed: results.every((r) => r.result !== 'FAIL') };
}
