import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isHostNormalization, newEntryTemplate, readStrategy, strategyPatch, validateEntryField } from '../../src/adapters/sillytavern/st-schema.js';
import { stEditorEntry } from '../fixtures/worldbooks.js';

const ok = (field, value) => assert.equal(validateEntryField([field], value), null, `${field}=${JSON.stringify(value)} should pass`);
const bad = (field, value) => assert.equal(typeof validateEntryField([field], value), 'string', `${field}=${JSON.stringify(value)} should fail`);

test('field values must be usable by SillyTavern 1.19.0', () => {
    ok('position', 7); bad('position', 8); bad('position', 1.5);
    ok('depth', 0); ok('depth', 10000); bad('depth', -1); bad('depth', 2.5); bad('depth', 10001);
    ok('scanDepth', null); ok('scanDepth', 1000); bad('scanDepth', -5); bad('scanDepth', 1001);
    ok('probability', 0); ok('probability', 100); bad('probability', -10); bad('probability', 101);
    ok('groupWeight', 1); bad('groupWeight', 0); bad('groupWeight', 10001);
    ok('sticky', null); ok('sticky', 0); bad('sticky', -3); bad('sticky', 1.5);
    ok('delayUntilRecursion', true); ok('delayUntilRecursion', 2); bad('delayUntilRecursion', -1);
    ok('order', -5.5); bad('order', Number.POSITIVE_INFINITY);
    ok('characterFilter', { isExclude: false, names: [], tags: [] });
    bad('characterFilter', { names: ['Bob'] });
    ok('someThirdPartyField', { anything: [1, 'two'] });
});

test('removing a SillyTavern field is refused; removing other fields is allowed', () => {
    assert.equal(typeof validateEntryField(['probability'], undefined), 'string');
    assert.equal(typeof validateEntryField(['position'], undefined), 'string');
    assert.equal(validateEntryField(['futureStField'], undefined), null);
    assert.equal(validateEntryField(['characterFilter'], undefined), null);
});

const norm = (field, before, after, extra = {}) => {
    const entryAfter = { ...stEditorEntry(), [field]: after, ...extra.entry };
    return isHostNormalization(field, before, after, {
        hadBefore: before !== undefined, hasAfter: after !== undefined, entryAfter, knownCharacters: extra.known,
    });
};

test('SillyTavern editor rewrites are recognised', () => {
    const template = newEntryTemplate();
    assert.ok(norm('selective', undefined, template.selective), 'template backfill');
    assert.ok(norm('displayIndex', undefined, 0, { entry: { uid: 0 } }), 'displayIndex = uid');
    assert.ok(norm('comment', 'a\r\nb', 'a\nb'));
    assert.ok(norm('order', '50', 50));
    assert.ok(norm('order', null, 0));
    assert.ok(norm('probability', null, 0));
    assert.ok(norm('probability', 150, 100));
    assert.ok(norm('role', 0, null, { entry: { position: 1 } }));
    assert.ok(norm('role', null, 0, { entry: { position: 4 } }));
    assert.ok(norm('useProbability', false, true));
    assert.ok(norm('addMemo', false, true));
    assert.ok(norm('sticky', null, 0));
    assert.ok(norm('groupWeight', null, 1));
    assert.ok(norm('group', ' a, b ', 'a, b'));
    assert.ok(norm('triggers', ['normal', 'bogus'], ['normal']));
    assert.ok(norm('caseSensitive', 'false', true), 'string "false" is truthy for the tri-state select');
    assert.ok(norm('delayUntilRecursion', 0, false));
    assert.ok(norm('delayUntilRecursion', '3', 3));
    assert.ok(norm('vectorized', true, false, { entry: { constant: true } }));
    assert.ok(norm('characterFilter', { isExclude: false, names: ['Gone', 'Bob'], tags: [] }, { isExclude: false, names: ['Bob'], tags: [] }, { known: new Set(['Bob']) }));
});

test('deliberate edits are not mistaken for editor rewrites', () => {
    assert.ok(!norm('order', 100, 101));
    assert.ok(!norm('probability', 100, 50));
    assert.ok(!norm('content', 'a', 'b'));
    assert.ok(!norm('constant', false, true));
    assert.ok(!norm('vectorized', false, true, { entry: { constant: false } }));
    assert.ok(!norm('vectorized', true, false, { entry: { constant: false } }), 'switching vectorized → normal');
    assert.ok(!norm('disable', false, true));
    assert.ok(!norm('matchScenario', true, false));
    assert.ok(!norm('caseSensitive', null, false));
    assert.ok(!norm('triggers', ['normal', 'swipe'], ['normal']), 'removing a known trigger');
    assert.ok(!norm('delayUntilRecursion', 2, false));
    assert.ok(!norm('role', 0, 2, { entry: { position: 4 } }));
    assert.ok(!norm('extensions', undefined, { any: 1 }), 'new non-template field');
    const filterBefore = { isExclude: false, names: ['Alice', 'Bob'], tags: [] };
    const filterAfter = { isExclude: false, names: ['Alice'], tags: [] };
    assert.ok(!norm('characterFilter', filterBefore, filterAfter, { known: new Set(['Alice', 'Bob']) }), 'Bob is installed: a person removed him');
    assert.ok(!norm('characterFilter', filterBefore, filterAfter), 'without the character list a removal counts as an edit');
});

test('strategy helpers follow the ST tri-state', () => {
    assert.equal(readStrategy({ constant: true, vectorized: true }), 'constant');
    assert.equal(readStrategy({ constant: 1, vectorized: true }), 'vectorized');
    assert.equal(readStrategy({}), 'normal');
    assert.deepEqual(strategyPatch('vectorized'), { constant: false, vectorized: true });
    assert.throws(() => strategyPatch('selective'), TypeError);
});
