import { createSillyTavernWorldbookAdapter } from '../../src/index.js';
import { FakeSillyTavern } from './fake-sillytavern.js';
import { standardBooks } from '../fixtures/worldbooks.js';

/**
 * Adapter wired to a fake SillyTavern 1.19.0 page. No DOM and no Tavern Helper
 * unless asked for: the adapter must work without any UI.
 */
export function setup({ books = standardBooks(), withDom = false, tavernHelper = null, settleTimeoutMs = 150, sharedState = { tails: new Map(), ownSaves: new WeakSet() } } = {}) {
    const st = new FakeSillyTavern({ books });
    const adapter = createSillyTavernWorldbookAdapter({
        getContext: st.getContext,
        fetch: st.fetch,
        tavernHelper,
        document: withDom ? st.document() : null,
        settleTimeoutMs,
        sharedState,
    });
    return { st, adapter, sharedState };
}

export const byCode = (code) => (error) => {
    if (error?.code !== code) {
        throw new Error(`expected ${code}, got ${error?.code}: ${error?.message}`);
    }
    return true;
};
