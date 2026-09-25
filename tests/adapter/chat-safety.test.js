// Issue #1 coverage: 15 (the formal AIRP chat is never touched)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup } from '../helpers/adapter-setup.js';

test('[15] a full round of reads and writes leaves chat, chat metadata and generation untouched', async () => {
    const { st, adapter } = setup({ withDom: true });
    st.chatMetadata.world_info = 'Deleted Book'; // dangling binding must not be "repaired"
    const before = st.chatState();
    const chatRef = st.chat;
    const metadataRef = st.chatMetadata;

    await adapter.listWorldbooks({ refresh: true });
    await adapter.getActiveWorldbooks();
    await adapter.getWorldbook('Chat Book');
    const created = await adapter.createEntry('Chat Book', { fields: { content: 'new' } });
    await adapter.updateEntry('Chat Book', created.uid, { content: 'edited' });
    await adapter.moveEntry('Chat Book', created.uid, 'bottom');
    await adapter.deleteEntry('Chat Book', created.uid);
    await adapter.describeHost();

    assert.equal(st.chatState(), before, 'chat messages, chat metadata and chat-save counters unchanged');
    assert.equal(st.chat, chatRef);
    assert.equal(st.chatMetadata, metadataRef);
    assert.equal(st.calls.saveMetadata, 0);
    assert.equal(st.calls.saveChat, 0);
    assert.equal(st.calls.generate, 0);
});

test('[15] the adapter only calls worldbook endpoints on the server', async () => {
    const { st, adapter } = setup();
    const urls = new Set();
    const originalFetch = st.fetch;
    st.fetch = async (url, init) => { urls.add(url); return originalFetch(url, init); };
    const { createSillyTavernWorldbookAdapter } = await import('../../src/index.js');
    const tracked = createSillyTavernWorldbookAdapter({ getContext: st.getContext, fetch: st.fetch, tavernHelper: null, document: null, settleTimeoutMs: 50 });
    await tracked.updateEntry('Main Book', 0, { content: 'x' });
    await tracked.getWorldbook('Other Book');
    void adapter;
    assert.deepEqual([...urls].sort(), ['/api/worldinfo/edit', '/api/worldinfo/get']);
});
