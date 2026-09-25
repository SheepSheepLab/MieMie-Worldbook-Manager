import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, diffPaths, fingerprint, jsonEqual } from '../../src/core/json.js';
import { detectEntryConflict } from '../../src/core/entry-compare.js';
import { mainBook } from '../fixtures/worldbooks.js';

test('jsonEqual ignores key order and undefined members, not values', () => {
    assert.equal(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
    assert.equal(jsonEqual({ a: 1, c: undefined }, { a: 1 }), true);
    assert.equal(jsonEqual({ a: [1, 2] }, { a: [2, 1] }), false);
    assert.equal(jsonEqual({ a: null }, { a: 0 }), false);
    assert.equal(jsonEqual(undefined, null), false);
});

test('canonicalJson and fingerprint are stable across key order', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1},"b":1}');
    assert.equal(fingerprint({ b: 1, a: 2 }), fingerprint({ a: 2, b: 1 }));
    assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});

test('diffPaths walks objects and reports arrays whole', () => {
    const a = { x: 1, nested: { keep: 1, change: 1 }, list: [1, 2] };
    const b = { x: 1, nested: { keep: 1, change: 2, added: true }, list: [1, 3] };
    assert.deepEqual(diffPaths(a, b), [['list'], ['nested', 'added'], ['nested', 'change']]);
});

test('field-scoped conflict: only overlapping changes block', () => {
    const baseline = mainBook().entries[0];
    const current = { ...structuredClone(baseline), useProbability: false, content: 'someone else' };

    const onContent = detectEntryConflict({ baseline, current, writePaths: [['content']], scope: 'fields' });
    assert.equal(onContent.conflict, true);
    assert.deepEqual(onContent.overlappingPaths, [['content']]);

    const onOrder = detectEntryConflict({ baseline, current, writePaths: [['order']], scope: 'fields' });
    assert.equal(onOrder.conflict, false);
    assert.deepEqual(onOrder.changedPaths, [['content'], ['useProbability']]);
});

test('nested write paths overlap with parent and child changes', () => {
    const baseline = mainBook().entries[7];
    const current = structuredClone(baseline);
    current.characterFilter.tags = ['other'];
    assert.equal(detectEntryConflict({ baseline, current, writePaths: [['characterFilter']], scope: 'fields' }).conflict, true);
    assert.equal(detectEntryConflict({ baseline, current, writePaths: [['characterFilter', 'tags']], scope: 'fields' }).conflict, true);
    assert.equal(detectEntryConflict({ baseline, current, writePaths: [['characterFilter', 'names']], scope: 'fields' }).conflict, false);
});

test('entry scope blocks any change; a deleted entry always conflicts', () => {
    const baseline = mainBook().entries[0];
    const current = { ...structuredClone(baseline), displayIndex: 99 };
    assert.equal(detectEntryConflict({ baseline, current, scope: 'entry' }).conflict, true);
    assert.equal(detectEntryConflict({ baseline, current: structuredClone(baseline), scope: 'entry' }).conflict, false);
    const gone = detectEntryConflict({ baseline, current: null });
    assert.equal(gone.conflict, true);
    assert.equal(gone.deleted, true);
});

test('default scope is the whole entry; changes attributed to the host are ignored', () => {
    const baseline = mainBook().entries[0];
    const current = { ...structuredClone(baseline), probability: 42, role: 0 };
    const ignore = (field) => field === 'role';
    const check = detectEntryConflict({ baseline, current, writePaths: [['content']], ignore });
    assert.equal(check.conflict, true, 'probability changed elsewhere in the entry');
    assert.deepEqual(check.ignoredFields, ['role']);
    assert.deepEqual(check.overlappingPaths, [['probability']]);
    const onlyHost = detectEntryConflict({ baseline, current: { ...structuredClone(baseline), role: 0 }, ignore });
    assert.equal(onlyHost.conflict, false);
});
