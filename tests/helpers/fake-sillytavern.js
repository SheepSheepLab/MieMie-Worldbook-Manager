// Test double for the parts of SillyTavern 1.19.0 the adapter touches.
//
// It reproduces ST's actual World Info persistence behaviour, including the
// hazards the adapter has to defend against (source: SillyTavern 1.19.0,
// commit 7e8663cd9c184a550b37238218bdd32c6efc68e9):
// - worldInfoCache clones on get but stores by reference on set, and a cache
//   miss returns the live cached object (world-info.js:882, 2036-2059)
// - saveWorldInfo updates the cache first, then saves immediately or through ONE
//   debounce shared by all books; an immediate save cancels any pending
//   debounced save (world-info.js:83, 4151-4190)
// - _save never checks the HTTP status and always emits WORLDINFO_UPDATED
// - /api/worldinfo/get answers a missing file with a dummy { entries: {} }
// - /api/worldinfo/edit requires `entries` and writes JSON.stringify(data, null, 4)

const WORLDINFO_UPDATED = 'worldinfo_updated';

export class FakeSillyTavern {
    /**
     * @param {object} [options]
     * @param {Record<string, object>} [options.books] Initial files: name -> book object.
     * @param {number} [options.debounceMs] ST uses 1000 ms; tests use less.
     */
    constructor({ books = {}, debounceMs = 40 } = {}) {
        /** Server files: name -> JSON text exactly as the server wrote it. */
        this.files = new Map();
        for (const [name, data] of Object.entries(books)) {
            this.files.set(name, JSON.stringify(data, null, 4));
        }
        this.worldNames = [...this.files.keys()].sort((a, b) => a.localeCompare(b));
        this.cache = new Map();
        this.debounceMs = debounceMs;
        this.debounceTimer = null;
        this.pendingDebounced = null;
        this.listeners = new Map();

        /** Queued faults per route: 'network' | 'drop' | { status } | (body) => void */
        this.faults = { get: [], edit: [] };

        this.calls = { edit: 0, get: 0, reloadEditor: [], updateWorldInfoList: 0, saveMetadata: 0, saveChat: 0, generate: 0 };

        // Chat state that must never change through worldbook operations.
        this.chat = [
            { name: 'User', is_user: true, mes: 'Hello.' },
            { name: 'Char', is_user: false, mes: 'Hi there.' },
        ];
        this.chatMetadata = { world_info: 'Chat Book', note_prompt: 'keep me' };
        this.characters = [
            { name: 'Alice', avatar: 'Alice.png', data: { extensions: { world: 'Main Book' } } },
            { name: 'Bob', avatar: 'Bob.png', data: { extensions: { world: '' } } },
        ];
        this.characterId = '0';
        this.groupId = null;
        this.groups = [];
        this.powerUser = { persona_description_lorebook: '' };
        this.globalSelected = [];
        this.charLore = [{ name: 'Alice', extraBooks: ['Other Book'] }];
        this.editorSelected = null;

        this.fetch = this.fetch.bind(this);
        this.getContext = this.getContext.bind(this);
    }

    // ---------------------------------------------------------------- server

    async fetch(url, init = {}) {
        const body = init.body ? JSON.parse(init.body) : {};
        if (url === '/api/worldinfo/get') {
            this.calls.get++;
            const fault = this.faults.get.shift();
            if (fault === 'network') throw new TypeError('Failed to fetch');
            if (fault && typeof fault === 'object') return response(fault.status, 'error');
            if (!body.name) return response(400, 'Bad Request');
            const text = this.files.get(body.name);
            if (text === undefined) return response(200, { entries: {} });
            try {
                return response(200, JSON.parse(text));
            } catch {
                return response(500, 'Internal Server Error');
            }
        }
        if (url === '/api/worldinfo/edit') {
            this.calls.edit++;
            const fault = this.faults.edit.shift();
            if (fault === 'network') throw new TypeError('Failed to fetch');
            if (fault && typeof fault === 'object') return response(fault.status, 'error');
            if (typeof fault === 'function') fault(body);
            if (!body.name) return response(400, 'World file must have a name');
            if (!body.data || typeof body.data !== 'object' || !('entries' in body.data)) return response(400, 'Is not a valid world info file');
            if (fault !== 'drop') {
                this.files.set(body.name, JSON.stringify(body.data, null, 4));
            }
            return response(200, { ok: true });
        }
        if (url === '/version') {
            return response(200, { pkgVersion: '1.19.0', gitRevision: '7e8663cd', gitBranch: 'release' });
        }
        return response(404, 'Not Found');
    }

    // ---------------------------------------------------------------- client

    async loadWorldInfo(name) {
        if (!name) return undefined;
        if (this.cache.has(name)) return structuredClone(this.cache.get(name));
        const res = await this.fetch('/api/worldinfo/get', { method: 'POST', body: JSON.stringify({ name }) });
        if (res.ok) {
            const data = await res.json();
            this.cache.set(name, data);
            return data; // live cached object, as ST does on a cache miss
        }
        return null;
    }

    async saveWorldInfo(name, data, immediately = false) {
        if (!name || !data) return;
        this.cache.set(name, data);
        if (immediately) {
            return await this._save(name, data);
        }
        clearTimeout(this.debounceTimer);
        this.pendingDebounced = { name, data };
        this.debounceTimer = setTimeout(() => {
            const pending = this.pendingDebounced;
            this.pendingDebounced = null;
            this.debounceTimer = null;
            this._save(pending.name, pending.data);
        }, this.debounceMs);
    }

    async _save(name, data) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
        this.pendingDebounced = null;
        await this.fetch('/api/worldinfo/edit', { method: 'POST', body: JSON.stringify({ name, data }) });
        await this.emit(WORLDINFO_UPDATED, name, data);
    }

    async updateWorldInfoList() {
        this.calls.updateWorldInfoList++;
        this.worldNames = [...this.files.keys()].sort((a, b) => a.localeCompare(b));
    }

    reloadWorldInfoEditor(name, loadIfNotSelected = false) {
        this.calls.reloadEditor.push({ name, loadIfNotSelected });
    }

    async executeSlashCommandsWithOptions(command) {
        if (command === '/getglobalbooks') {
            return { pipe: JSON.stringify(this.globalSelected), isError: false };
        }
        const charBook = /^\/getcharbook type=additional(?: "([^"]+)")?$/.exec(command);
        if (charBook) {
            const avatar = charBook[1];
            if (this.groupId && !avatar) throw new Error('This command is not available in groups without providing a character name');
            const character = avatar ? this.characters.find((c) => c.avatar === avatar) : this.characters[this.characterId];
            if (!character) throw new Error('Character not found.');
            const lore = this.charLore.find((l) => `${l.name}.png` === character.avatar);
            return { pipe: JSON.stringify(lore ? lore.extraBooks : []), isError: false };
        }
        return { pipe: '', isError: true };
    }

    on(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
    }

    removeListener(type, fn) {
        const list = this.listeners.get(type) ?? [];
        const index = list.indexOf(fn);
        if (index !== -1) list.splice(index, 1);
    }

    async emit(type, ...args) {
        for (const fn of [...(this.listeners.get(type) ?? [])]) {
            try {
                await fn(...args);
            } catch (error) {
                console.error(error);
            }
        }
    }

    getContext() {
        return {
            loadWorldInfo: (name) => this.loadWorldInfo(name),
            saveWorldInfo: (name, data, immediately) => this.saveWorldInfo(name, data, immediately),
            reloadWorldInfoEditor: (name, load) => this.reloadWorldInfoEditor(name, load),
            updateWorldInfoList: () => this.updateWorldInfoList(),
            getWorldInfoNames: () => [...this.worldNames],
            getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' }),
            executeSlashCommandsWithOptions: (cmd, opts) => this.executeSlashCommandsWithOptions(cmd, opts),
            eventSource: { on: (t, f) => this.on(t, f), removeListener: (t, f) => this.removeListener(t, f), emit: (t, ...a) => this.emit(t, ...a) },
            eventTypes: { WORLDINFO_UPDATED },
            chat: this.chat,
            chatMetadata: this.chatMetadata,
            characters: this.characters,
            characterId: this.characterId,
            groupId: this.groupId,
            groups: this.groups,
            powerUserSettings: this.powerUser,
            saveMetadata: async () => { this.calls.saveMetadata++; },
            saveChat: async () => { this.calls.saveChat++; },
            generate: async () => { this.calls.generate++; },
        };
    }

    /** Minimal DOM with the ST editor's book selector. */
    document() {
        const fake = this;
        return {
            getElementById(id) {
                if (id !== 'world_editor_select') return null;
                const index = fake.editorSelected === null ? -1 : fake.worldNames.indexOf(fake.editorSelected);
                return {
                    value: index === -1 ? '' : String(index),
                    selectedOptions: index === -1 ? [] : [{ textContent: fake.editorSelected }],
                };
            },
        };
    }

    // ------------------------------------------------------- test utilities

    /** Parsed content of a stored file. */
    readFile(name) {
        const text = this.files.get(name);
        return text === undefined ? undefined : JSON.parse(text);
    }

    /** Raw text of a stored file (byte-level comparison). */
    fileText(name) {
        return this.files.get(name);
    }

    /** Another tab or device writes the file directly; this page's cache is not told. */
    writeFromOtherTab(name, data) {
        this.files.set(name, JSON.stringify(data, null, 4));
    }

    /** An in-page script (ST editor, Tavern Helper, ...) changes a book and saves it the debounced way. */
    async editInPage(name, mutate, { immediately = false } = {}) {
        const data = await this.loadWorldInfo(name);
        mutate(data);
        await this.saveWorldInfo(name, data, immediately);
    }

    /** Waits until any debounced save has run. */
    async flush() {
        await new Promise((resolve) => setTimeout(resolve, this.debounceMs * 2 + 10));
    }

    /** Snapshot of everything chat-related, to prove it did not change. */
    chatState() {
        return JSON.stringify({ chat: this.chat, chatMetadata: this.chatMetadata, calls: [this.calls.saveMetadata, this.calls.saveChat, this.calls.generate] });
    }
}

function response(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return JSON.parse(text);
        },
        async text() {
            return text;
        },
    };
}
