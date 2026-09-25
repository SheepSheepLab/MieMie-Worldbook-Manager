import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyEntryPatch, normalizePatch } from '../../src/core/entry-patch.js';
import { WorldbookErrorCode } from '../../src/core/errors.js';
import { validateEntryField } from '../../src/adapters/sillytavern/st-schema.js';
import { mainBook } from '../fixtures/worldbooks.js';

const expectCode = (code) => (error) => error.code === code;

test('content patch changes only content and keeps key order, unknown and nested fields', () => {
    const original = mainBook().entries[2];
    const frozen = structuredClone(original);
    const { entry, changedPaths } = applyEntryPatch(original, { content: 'Updated.' });

    assert.deepEqual(changedPaths, [['content']]);
    assert.equal(entry.content, 'Updated.');
    assert.deepEqual(Object.keys(entry), Object.keys(original), 'no field added, dropped or reordered');
    assert.deepEqual({ ...entry, content: original.content }, original, 'every other field identical');
    assert.deepEqual(entry.miemieUnknownField, frozen.miemieUnknownField);
    assert.deepEqual(entry.extra, frozen.extra);
    assert.deepEqual(original, frozen, 'input object not mutated');
    assert.notEqual(entry.miemieUnknownField, original.miemieUnknownField, 'result does not alias the input');
});

test('patch on an entry missing template fields does not fill them in', () => {
    const legacy = mainBook().entries[9];
    const { entry } = applyEntryPatch(legacy, { content: 'new' });
    assert.deepEqual(entry, { uid: 9, key: ['legacy'], content: 'new', order: 10 });
});

test('deep path patch changes one nested value and keeps siblings', () => {
    const original = mainBook().entries[7];
    const { entry, changedPaths } = applyEntryPatch(original, [{ path: ['characterFilter', 'names'], value: ['Bob', 'Carol'] }]);
    assert.deepEqual(changedPaths, [['characterFilter', 'names']]);
    assert.deepEqual(entry.characterFilter, { isExclude: true, names: ['Bob', 'Carol'], tags: ['tag-1'] });
});

test('deep path into a missing object creates only that object', () => {
    const { entry } = applyEntryPatch({ uid: 1, content: 'x' }, [{ path: ['extensions', 'my_ext', 'level'], value: 2 }]);
    assert.deepEqual(entry, { uid: 1, content: 'x', extensions: { my_ext: { level: 2 } } });
});

test('unset removes exactly one field', () => {
    const original = mainBook().entries[2];
    const { entry, changedPaths } = applyEntryPatch(original, [{ op: 'unset', path: 'futureStField' }]);
    assert.deepEqual(changedPaths, [['futureStField']]);
    assert.equal('futureStField' in entry, false);
    assert.equal(Object.keys(entry).length, Object.keys(original).length - 1);
});

test('same-value patch reports no change', () => {
    const original = mainBook().entries[0];
    const { changedPaths } = applyEntryPatch(original, { order: 100, content: original.content });
    assert.deepEqual(changedPaths, []);
});

test('string path is one key even with dots', () => {
    const { entry } = applyEntryPatch({ uid: 1, 'a.b': 1 }, [{ path: 'a.b', value: 2 }]);
    assert.deepEqual(entry, { uid: 1, 'a.b': 2 });
});

test('uid cannot be patched', () => {
    assert.throws(() => applyEntryPatch({ uid: 1 }, { uid: 2 }), expectCode(WorldbookErrorCode.INVALID_PATCH));
});

test('undefined values, empty patches and prototype paths are rejected', () => {
    assert.throws(() => normalizePatch({ content: undefined }), expectCode(WorldbookErrorCode.INVALID_PATCH));
    assert.throws(() => normalizePatch({}), expectCode(WorldbookErrorCode.INVALID_PATCH));
    assert.throws(() => normalizePatch([{ path: ['__proto__', 'x'], value: 1 }]), expectCode(WorldbookErrorCode.INVALID_PATCH));
    assert.throws(() => normalizePatch([{ path: [], value: 1 }]), expectCode(WorldbookErrorCode.INVALID_PATCH));
    assert.throws(() => normalizePatch('content'), expectCode(WorldbookErrorCode.INVALID_PATCH));
    assert.equal(Object.prototype.x, undefined);
});

test('writing through a scalar is rejected', () => {
    assert.throws(() => applyEntryPatch({ uid: 1, content: 'x' }, [{ path: ['content', 'inner'], value: 1 }]), expectCode(WorldbookErrorCode.INVALID_PATCH));
});

test('SillyTavern field validation rejects wrong types for known fields only', () => {
    const entry = mainBook().entries[0];
    const bad = [
        { content: 42 },
        { order: 'high' },
        { order: Number.NaN },
        { disable: 'yes' },
        { key: 'Frieren' },
        { key: [/regex/] },
        { role: 5 },
        { selectiveLogic: 9 },
        { scanDepth: '3' },
        { caseSensitive: 'false' },
        { triggers: ['sometimes'] },
        { characterFilter: { names: 'Bob' } },
        { characterFilterNames: ['Bob'] },
        { delayUntilRecursion: 'soon' },
    ];
    for (const patch of bad) {
        assert.throws(() => applyEntryPatch(entry, patch, { validate: validateEntryField }), expectCode(WorldbookErrorCode.INVALID_PATCH), JSON.stringify(patch));
    }
    const good = [
        { content: 'ok' },
        { order: 5.5 },
        { role: null },
        { role: 2 },
        { scanDepth: null },
        { caseSensitive: false },
        { delayUntilRecursion: true },
        { delayUntilRecursion: 2 },
        { triggers: ['quiet'] },
        { key: ['/re/i', 'plain'] },
        { someUnknownField: { anything: [1, 'two'] } },
    ];
    for (const patch of good) {
        assert.doesNotThrow(() => applyEntryPatch(entry, patch, { validate: validateEntryField }), JSON.stringify(patch));
    }
});

test('values JSON cannot store unchanged are rejected', () => {
    const entry = mainBook().entries[2];
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, new Set(['a']), new Map(), new Date(0), /re/, [1, , 3], { nested: undefined }, () => 1]) {
        assert.throws(() => applyEntryPatch(entry, [{ path: 'myField', value }]), expectCode(WorldbookErrorCode.INVALID_PATCH), String(value));
    }
    assert.doesNotThrow(() => applyEntryPatch(entry, [{ path: 'myField', value: { a: [1, 'x', null, true], b: { c: 1.5 } } }]));
});

test('array paths accept only indexes inside or right after the array', () => {
    const entry = mainBook().entries[1];
    assert.deepEqual(applyEntryPatch(entry, [{ path: ['key', 2], value: 'carol' }]).entry.key, ['/Alice/ig', 'bob', 'carol']);
    assert.deepEqual(applyEntryPatch(entry, [{ path: ['key', '0'], value: 'x' }]).entry.key, ['x', 'bob']);
    for (const segment of ['01', '5', 'length', '-1']) {
        assert.throws(() => applyEntryPatch(entry, [{ path: ['key', segment], value: 'x' }]), expectCode(WorldbookErrorCode.INVALID_PATCH), segment);
    }
    assert.throws(() => applyEntryPatch(entry, [{ path: ['extensions', 'my_card_ext', 'list', 'meta'], value: 1 }]), expectCode(WorldbookErrorCode.INVALID_PATCH));
    const created = applyEntryPatch({ uid: 1 }, [{ path: ['newList', 0], value: 'first' }]).entry;
    assert.deepEqual(created.newList, ['first'], 'a missing container before an index becomes an array');
});

test('nested writes into known fields are validated like whole-field writes', () => {
    const e9 = mainBook().entries[9];
    const e7 = mainBook().entries[7];
    const opts = { validate: validateEntryField };
    assert.throws(() => applyEntryPatch(e9, [{ path: ['characterFilter', 'names', 0], value: 'Alice' }], opts), expectCode(WorldbookErrorCode.INVALID_PATCH), 'incomplete characterFilter');
    assert.throws(() => applyEntryPatch(e7, [{ path: ['key', 0], value: 'x' }, { path: ['triggers', 0], value: 'bogus' }], opts), expectCode(WorldbookErrorCode.INVALID_PATCH));
    assert.throws(() => applyEntryPatch(e7, [{ path: ['scanDepth', 'x'], value: 1 }], opts), expectCode(WorldbookErrorCode.INVALID_PATCH));
    assert.doesNotThrow(() => applyEntryPatch(e7, [{ path: ['characterFilter', 'names', 1], value: 'Carol' }], opts));
});

test('removing a SillyTavern field is refused, removing an unknown one is allowed', () => {
    const entry = mainBook().entries[2];
    const opts = { validate: validateEntryField };
    assert.throws(() => applyEntryPatch(entry, [{ op: 'unset', path: 'probability' }], opts), expectCode(WorldbookErrorCode.INVALID_PATCH));
    assert.doesNotThrow(() => applyEntryPatch(entry, [{ op: 'unset', path: 'futureStField' }], opts));
});
