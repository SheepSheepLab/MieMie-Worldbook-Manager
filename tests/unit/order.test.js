import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_ORDER_RANGE,
    NEW_ENTRY_UID,
    planOrderPlacement,
    readOrder,
    resolveTargetIndex,
    sortForDisplay,
} from '../../src/core/order.js';
import { WorldbookErrorCode } from '../../src/core/errors.js';

const items = (orders) => orders.map((order, uid) => ({ uid, order }));

/** Applies a plan and returns the resulting display order. */
function apply(list, plan, movingUid = null) {
    const byUid = new Map(list.map((item) => [item.uid, { ...item }]));
    for (const change of plan.changes) byUid.get(change.uid).order = change.to;
    const all = [...byUid.values()];
    if (movingUid === null) all.push({ uid: NEW_ENTRY_UID, order: plan.order });
    return { all, sequence: sortForDisplay(all).map((item) => item.uid) };
}

test('values are read as SillyTavern treats them: missing = 100, null / empty / non-numeric = 0', () => {
    assert.equal(readOrder(50), 50);
    assert.equal(readOrder('50'), 50);
    assert.equal(readOrder(-3.5), -3.5);
    assert.equal(readOrder(undefined), 100);
    assert.equal(readOrder(null), 0);
    assert.equal(readOrder(''), 0);
    assert.equal(readOrder('abc'), 0);
    assert.equal(readOrder(Number.NaN), 0);
    assert.equal(readOrder(true), 1);
});

test('display order: higher Order first, ties by UID', () => {
    const list = [
        { uid: 3, order: 10 }, { uid: 1, order: 50 }, { uid: 0, order: '50' },
        { uid: 4, order: null }, { uid: 2, order: 100 }, { uid: 5 }, { uid: 6, order: 'abc' }, { uid: 7, order: -1 },
    ];
    // 5 (missing → 100) ties with 2; 4 (null) and 6 ('abc') tie at 0
    assert.deepEqual(sortForDisplay(list).map((i) => i.uid), [2, 5, 0, 1, 3, 4, 6, 7]);
});

test('new entry at the top gets max + 1 and changes nothing else', () => {
    const plan = planOrderPlacement(items([100, 90]), { targetIndex: 0 });
    assert.equal(plan.order, 101);
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(plan.sequence, [NEW_ENTRY_UID, 0, 1]);
});

test('new entry in an empty book gets the SillyTavern default Order', () => {
    assert.equal(planOrderPlacement([], { targetIndex: 0 }).order, 100);
});

test('insert into a gap changes only the placed entry (midpoint)', () => {
    const plan = planOrderPlacement(items([100, 50]), { targetIndex: 1 });
    assert.equal(plan.order, 75);
    assert.deepEqual(plan.changes, []);
});

test('moving into a dense run pushes the shorter side by one', () => {
    // 10 9 8 7 6 | uid5 (3) moves between 9 and 8
    const list = items([10, 9, 8, 7, 6, 3]);
    const plan = planOrderPlacement(list, { movingUid: 5, targetIndex: 2 });
    assert.equal(plan.order, 9);
    assert.deepEqual(plan.changes.map((c) => [c.uid, c.from, c.to]).sort(), [[0, 10, 11], [1, 9, 10], [5, 3, 9]]);
    assert.deepEqual(apply(list, plan, 5).sequence, [0, 1, 5, 2, 3, 4]);
});

test('moving to the top when the top is already at 9999 pushes down, keeping values close', () => {
    const list = items([9999, 9998, 5]);
    const plan = planOrderPlacement(list, { movingUid: 2, targetIndex: 0 });
    assert.equal(plan.order, 9999);
    assert.deepEqual(plan.changes.map((c) => [c.uid, c.to]).sort(), [[0, 9998], [1, 9997], [2, 9999]]);
});

test('bottom at Order 0 pushes the run upward instead of going negative', () => {
    const plan = planOrderPlacement(items([2, 1, 0]), { targetIndex: 3 });
    assert.equal(plan.order, 0);
    assert.deepEqual(plan.changes.map((c) => [c.uid, c.to]).sort(), [[0, 3], [1, 2], [2, 1]]);
});

test('placing inside a tie group re-values the smaller side as one group and keeps its tie', () => {
    const list = Array.from({ length: 50 }, (_, uid) => ({ uid, order: 100 }));
    const plan = planOrderPlacement(list, { movingUid: 30, targetIndex: 11 });
    assert.equal(plan.order, 101);
    const raised = plan.changes.filter((c) => c.uid !== 30);
    assert.equal(raised.length, 11);
    assert.ok(raised.every((c) => c.to === 102), 'upper side stays tied at one value');
    assert.deepEqual(raised.map((c) => c.uid).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('a move that already fits changes nothing', () => {
    const plan = planOrderPlacement(items([100, 50, 10]), { movingUid: 1, targetIndex: 1 });
    assert.deepEqual(plan.changes, []);
    assert.equal(plan.order, 50);
});

test('a null Order counts as 0, as in SillyTavern: nothing is placed on a tie with it', () => {
    const list = [{ uid: 0, order: 100 }, { uid: 5, order: null }, { uid: 9, order: 50 }];
    assert.deepEqual(sortForDisplay(list).map((i) => i.uid), [0, 9, 5]);
    const plan = planOrderPlacement(list, { targetIndex: 3 });
    assert.equal(plan.order, 0);
    assert.deepEqual(plan.changes, [{ uid: 5, from: null, to: 1 }]);
});

test('a missing Order counts as 100 (SillyTavern fills it in)', () => {
    const list = [{ uid: 0, order: 100 }, { uid: 1 }, { uid: 2, order: 90 }];
    assert.deepEqual(sortForDisplay(list).map((i) => i.uid), [0, 1, 2]);
    const plan = planOrderPlacement(list, { targetIndex: 2 });
    assert.deepEqual(plan.sequence, [0, 1, NEW_ENTRY_UID, 2]);
    assert.equal(plan.order, 95);
    assert.deepEqual(plan.changes, []);
});

test('decimal Order values that already fit are not touched', () => {
    let plan = planOrderPlacement(items([50.7, 50.5, 50.2]), { movingUid: 1, targetIndex: 1 });
    assert.deepEqual(plan.changes, []);
    plan = planOrderPlacement(items([51, 49.5]), { targetIndex: 1 });
    assert.equal(plan.order, 50);
    assert.deepEqual(plan.changes, []);
    plan = planOrderPlacement(items([100.5, 99.5]), { targetIndex: 1 });
    assert.equal(plan.order, 100);
    assert.deepEqual(plan.changes, []);
});

test('an Order outside the range is not pulled back into it by a neighbouring placement', () => {
    const plan = planOrderPlacement(items([20000, 15000, 100]), { targetIndex: 0 });
    assert.equal(plan.order, 20001);
    assert.deepEqual(plan.changes, []);
    const moved = planOrderPlacement(items([5, -1, -1]), { movingUid: 2, targetIndex: 2 });
    assert.equal(moved.changes.length, 1, 'keeps -1 for the moved entry, lifts its tie partner');
});

test('kept numeric-string Order values are not rewritten', () => {
    const plan = planOrderPlacement([{ uid: 0, order: '100' }, { uid: 1, order: 90 }], { targetIndex: 0 });
    assert.equal(plan.order, 101);
    assert.deepEqual(plan.changes, []);
});

test('custom range is respected and exhaustion is reported', () => {
    const plan = planOrderPlacement(items([5, 4]), { targetIndex: 0, range: { min: 0, max: 5 } });
    assert.ok(plan.order <= 5);
    assert.throws(
        () => planOrderPlacement(items([1, 0]), { targetIndex: 1, range: { min: 0, max: 1 } }),
        (error) => error.code === WorldbookErrorCode.ORDER_SPACE_EXHAUSTED,
    );
});

test('placement resolution by neighbours', () => {
    const list = items([100, 90, 80]);
    assert.equal(resolveTargetIndex(list, 2, 'top'), 0);
    assert.equal(resolveTargetIndex(list, 2, 'bottom'), 2);
    assert.equal(resolveTargetIndex(list, null, 'bottom'), 3);
    assert.equal(resolveTargetIndex(list, 2, { aboveUid: 0 }), 1);
    assert.equal(resolveTargetIndex(list, 2, { belowUid: 1 }), 1);
    assert.equal(resolveTargetIndex(list, 2, { aboveUid: 0, belowUid: 1 }), 1);
    assert.throws(() => resolveTargetIndex(list, 2, { aboveUid: 1, belowUid: 0 }), (e) => e.code === WorldbookErrorCode.INVALID_ARGUMENT);
    assert.throws(() => resolveTargetIndex(list, 2, { aboveUid: 2 }), (e) => e.code === WorldbookErrorCode.INVALID_ARGUMENT);
    assert.throws(() => resolveTargetIndex(list, 2, { aboveUid: 42 }), (e) => e.code === WorldbookErrorCode.ENTRY_NOT_FOUND);
    assert.throws(() => planOrderPlacement(list, { movingUid: 2, targetIndex: 5 }), (e) => e.code === WorldbookErrorCode.INVALID_ARGUMENT);
});

test('large dense book stays fast and touches one side only', () => {
    const list = Array.from({ length: 5000 }, (_, uid) => ({ uid, order: 5000 - uid }));
    const started = performance.now();
    const plan = planOrderPlacement(list, { movingUid: 4999, targetIndex: 2500 });
    assert.ok(performance.now() - started < 500);
    assert.equal(plan.changes.length, 2500);
});

// Randomized invariants with a fixed seed (mulberry32), so failures reproduce.
function rng(seed) {
    return () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

test('randomized placements keep every invariant', () => {
    const random = rng(20260925);
    const range = { min: 0, max: 60 };
    for (let round = 0; round < 3000; round++) {
        const size = 1 + Math.floor(random() * 12);
        const list = Array.from({ length: size }, (_, uid) => {
            const r = random();
            if (r < 0.04) return { uid };
            const order = r < 0.1 ? null
                : r < 0.15 ? String(Math.floor(random() * 50))
                    : r < 0.3 ? Math.floor(random() * 200) / 4
                        : Math.floor(random() * (r < 0.65 ? 8 : 50));
            return { uid, order };
        });
        const isNew = random() < 0.3;
        const movingUid = isNew ? null : Math.floor(random() * size);
        const othersCount = isNew ? size : size - 1;
        const targetIndex = Math.floor(random() * (othersCount + 1));

        let plan;
        try {
            plan = planOrderPlacement(list, { movingUid, targetIndex, range });
        } catch (error) {
            assert.equal(error.code, WorldbookErrorCode.ORDER_SPACE_EXHAUSTED, `round ${round}`);
            continue;
        }
        const context = `round ${round}: ${JSON.stringify({ list, movingUid, targetIndex, plan })}`;
        const { all, sequence } = apply(list, plan, movingUid);

        // 1. The resulting display order is exactly the requested one.
        assert.deepEqual(sequence, plan.sequence, context);
        // 2. The placed entry is strictly between its neighbours.
        const placedUid = isNew ? NEW_ENTRY_UID : movingUid;
        const at = sequence.indexOf(placedUid);
        const orderOf = (uid) => readOrder(all.find((i) => i.uid === uid).order);
        if (at > 0) assert.ok(orderOf(sequence[at - 1]) > orderOf(placedUid), context);
        if (at < sequence.length - 1) assert.ok(orderOf(sequence[at + 1]) < orderOf(placedUid), context);
        // 3. Assigned values are integers inside the range, widened by one step past existing out-of-range values.
        const existing = list.map((i) => readOrder(i.order));
        const lo = Math.min(range.min, ...existing.filter((v) => v < range.min).map((v) => Math.floor(v) - 1));
        const hi = Math.max(range.max, ...existing.filter((v) => v > range.max).map((v) => Math.ceil(v) + 1));
        for (const change of plan.changes) {
            assert.ok(Number.isInteger(change.to) && change.to >= lo && change.to <= hi, context);
        }
        assert.ok(Number.isInteger(plan.order) || plan.order === readOrder(list.find((i) => i.uid === movingUid)?.order), context);
        // 4. Only a contiguous run around the insertion point changes.
        const changed = new Set(plan.changes.map((c) => c.uid));
        changed.add(placedUid);
        const positions = sequence.map((uid, i) => (changed.has(uid) ? i : -1)).filter((i) => i >= 0);
        if (positions.length > 1) {
            assert.equal(positions[positions.length - 1] - positions[0] + 1, positions.length, `changes not contiguous: ${context}`);
        }
        // 5. Changes list real changes only.
        for (const change of plan.changes) {
            assert.notEqual(readOrder(change.from), change.to, context);
        }
        // 6. No new ties among existing entries; entries tied on the same side of the
        //    insertion point stay tied (a tie the insertion point splits must break).
        const others = sequence.filter((uid) => uid !== placedUid);
        const valueBefore = (uid) => readOrder(list.find((i) => i.uid === uid).order);
        const above = (uid) => sequence.indexOf(uid) < at;
        for (let i = 0; i < others.length; i++) {
            for (let j = i + 1; j < others.length; j++) {
                const [a, b] = [others[i], others[j]];
                const tiedAfter = orderOf(a) === orderOf(b);
                if (valueBefore(a) !== valueBefore(b)) {
                    assert.ok(!tiedAfter, `new tie ${a}/${b}: ${context}`);
                } else if (above(a) === above(b)) {
                    assert.ok(tiedAfter, `tie split ${a}/${b}: ${context}`);
                }
            }
        }
    }
});

test('default range matches the SillyTavern editor input', () => {
    assert.deepEqual(DEFAULT_ORDER_RANGE, { min: 0, max: 9999 });
});
