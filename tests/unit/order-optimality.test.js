// Cross-checks the Order planner against exhaustive search on small books:
// among all assignments that give the requested display order, keep the placed
// entry strictly between its neighbours and create no new ties, the planner's
// total movement of existing Order values must be the minimum. New values are
// integers in the range; any entry may also keep its current value.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NEW_ENTRY_UID, planOrderPlacement, readOrder, sortForDisplay } from '../../src/core/order.js';

function rng(seed) {
    return () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/** Movement cost: sum of |new - old| over existing entries other than the placed one. */
function cost(list, movingUid, assign) {
    let total = 0;
    for (const item of list) {
        if (item.uid === movingUid) continue;
        total += Math.abs(assign.get(item.uid) - readOrder(item.order));
    }
    return total;
}

function bruteForceMinimum(list, movingUid, isNew, sequence, range) {
    const ids = list.map((item) => item.uid);
    if (isNew) ids.push(NEW_ENTRY_UID);
    const placed = isNew ? NEW_ENTRY_UID : movingUid;
    const original = new Map(list.map((item) => [item.uid, readOrder(item.order)]));
    const domains = ids.map((uid) => {
        const values = new Set();
        for (let v = range.min; v <= range.max; v++) values.add(v);
        if (original.has(uid)) values.add(original.get(uid));
        return [...values];
    });
    let best = Infinity;
    const current = new Array(ids.length);
    const walk = (k) => {
        if (k === ids.length) {
            const assign = new Map(ids.map((uid, i) => [uid, current[i]]));
            const order = sortForDisplay(ids.map((uid) => ({ uid, order: assign.get(uid) }))).map((i) => i.uid);
            if (order.join() !== sequence.join()) return;
            const at = order.indexOf(placed);
            const value = (uid) => assign.get(uid);
            if (at > 0 && !(value(order[at - 1]) > value(placed))) return;
            if (at < order.length - 1 && !(value(order[at + 1]) < value(placed))) return;
            for (let i = 1; i < order.length; i++) {
                const a = order[i - 1];
                const b = order[i];
                if (a === placed || b === placed) continue;
                if (value(a) === value(b) && original.get(a) !== original.get(b)) return; // new tie
            }
            best = Math.min(best, cost(list, movingUid, assign));
            return;
        }
        for (const v of domains[k]) {
            current[k] = v;
            walk(k + 1);
        }
    };
    walk(0);
    return best;
}

test('planner movement is minimal on 200 exhaustively checked small books (integers, decimals, null)', () => {
    const random = rng(424242);
    const range = { min: 0, max: 9 };
    let checked = 0;
    for (let round = 0; round < 200; round++) {
        const size = 1 + Math.floor(random() * 4);
        const list = Array.from({ length: size }, (_, uid) => {
            const r = random();
            const order = r < 0.1 ? null : r < 0.35 ? Math.floor(random() * 28) / 4 : Math.floor(random() * 7);
            return { uid, order };
        });
        const isNew = random() < 0.3;
        const movingUid = isNew ? null : Math.floor(random() * size);
        const targetIndex = Math.floor(random() * ((isNew ? size : size - 1) + 1));
        const plan = planOrderPlacement(list, { movingUid, targetIndex, range });
        const assign = new Map(list.map((item) => [item.uid, readOrder(item.order)]));
        for (const change of plan.changes) assign.set(change.uid, change.to);
        const minimum = bruteForceMinimum(list, movingUid, isNew, plan.sequence, range);
        assert.equal(cost(list, movingUid, assign), minimum, JSON.stringify({ list, movingUid, targetIndex, plan }));
        checked++;
    }
    assert.equal(checked, 200);
});
