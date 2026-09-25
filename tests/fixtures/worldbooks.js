// Worldbook fixtures shaped like SillyTavern 1.19.0 files (data/<user>/worlds/<name>.json).
// Each call returns a fresh object.

/** A full entry as ST's editor saves it: every template field, plus displayIndex and characterFilter. */
export function stEditorEntry(overrides = {}) {
    return {
        uid: 0,
        key: ['Frieren', '芙莉莲'],
        keysecondary: [],
        comment: '芙莉莲人物资料',
        content: '千年以上寿命的精灵魔法使。\n曾与勇者一行人一同讨伐魔王。',
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        outletName: '',
        group: 'mages, elves',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: null,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
        displayIndex: 0,
        characterFilter: { isExclude: false, names: [], tags: [] },
        ...overrides,
    };
}

export function mainBook() {
    return {
        entries: {
            0: stEditorEntry(),
            // Imported from a character card: carries `extensions`, legacy flags and
            // values that Tavern Helper's converters would rewrite.
            1: stEditorEntry({
                uid: 1,
                key: ['/Alice/ig', 'bob'],
                keysecondary: ['x'],
                comment: 'Alice',
                content: 'Alice is a knight.',
                selective: false,
                order: 90,
                position: 1,
                delayUntilRecursion: true,
                useProbability: false,
                probability: 35,
                role: null,
                sticky: 0,
                cooldown: 0,
                delay: 0,
                displayIndex: 17,
                extensions: { position: 1, display_index: 17, depth: 4, my_card_ext: { foo: 1, list: ['a', 'b'] } },
            }),
            // Third-party and newer-than-1.19.0 fields.
            2: stEditorEntry({
                uid: 2,
                key: ['memory'],
                comment: 'Memory outlet',
                content: 'Things remembered.',
                order: 80,
                position: 7,
                outletName: 'Memory',
                displayIndex: 2,
                extra: { tavernHelper: { tag: 'keep-me' } },
                miemieUnknownField: { nested: [1, { deep: 'value' }], flag: false },
                futureStField: 'from a later SillyTavern release',
            }),
            // Order stored as a numeric string, a position value this project does not know.
            5: stEditorEntry({
                uid: 5,
                key: ['string order'],
                comment: 'String order',
                order: '50',
                position: 8,
                triggers: ['normal', 'swipe'],
                displayIndex: 5,
            }),
            // Tied with uid 5 on Order 50.
            7: stEditorEntry({
                uid: 7,
                key: [],
                comment: 'Constant tie',
                constant: true,
                order: 50,
                displayIndex: 7,
                characterFilter: { isExclude: true, names: ['Bob'], tags: ['tag-1'] },
            }),
            // Legacy entry missing most template fields.
            9: { uid: 9, key: ['legacy'], content: 'old entry', order: 10 },
        },
        originalData: {
            name: 'Card lorebook',
            description: 'embedded character_book',
            scan_depth: 3,
            entries: [
                { id: 0, keys: ['Frieren'], content: 'card copy', insertion_order: 100, enabled: true, extensions: { position: 0 } },
            ],
        },
        name: 'Main Book',
        extensions: { miemie_test: true },
        customTopLevel: { keep: [1, 2, 3] },
    };
}

export function otherBook() {
    return {
        entries: {
            0: stEditorEntry({ uid: 0, key: ['Himmel'], comment: 'Himmel', content: 'The hero.', order: 100, group: '' }),
            1: stEditorEntry({ uid: 1, key: ['Heiter'], comment: 'Heiter', content: 'The priest.', order: 100, group: '' }),
        },
    };
}

export function chatBook() {
    return {
        entries: {
            0: stEditorEntry({ uid: 0, key: ['chat'], comment: 'Chat note', content: 'Bound to the chat.', order: 100, group: '' }),
        },
    };
}

/** Stored data that breaks ST invariants; must be readable and left untouched. */
export function brokenBook() {
    return {
        entries: {
            0: stEditorEntry({ uid: 0, comment: 'fine', group: '' }),
            3: stEditorEntry({ uid: 4, comment: 'key/uid mismatch', group: '' }),
            6: null,
        },
    };
}

export function standardBooks() {
    return {
        'Main Book': mainBook(),
        'Other Book': otherBook(),
        'Chat Book': chatBook(),
        'Broken Book': brokenBook(),
        'Empty Book': { entries: {} },
    };
}
