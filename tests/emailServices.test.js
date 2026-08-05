import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailServices } from '../src/emailServices.js';
import { NotConnectedError } from '../src/microsoftAuth.js';

const config = {
    clientId: 'cid',
    clientSecret: 'sec',
    redirectUri: 'https://x/cb',
    tenant: 'consumers',
    refreshTokenSecret: 'ms-refresh-token',
};

// Auth succeeds when the secret store has a refresh token and the token endpoint
// returns an access token.
function connectedAuthPlumbing() {
    return {
        secretManager: {
            readSecret: async () => 'refresh-token',
            writeSecretVersion: async () => {},
        },
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) }),
    };
}

const fakeMailbox = {
    messages: [{ id: 'm1', from: { name: 'A', address: 'a@x.com' }, parentFolderId: 'inbox-id', subject: 's' }],
    folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
    inbox: { id: 'inbox-id', displayName: 'Inbox' },
    rules: [{ displayName: 'R', actions: {} }],
};

function fakeGraphFactory() {
    let built = 0;
    const makeGraphClient = () => {
        built += 1;
        return {
            listUnreadOrRecentMessages: async () => fakeMailbox.messages,
            countMessagesOlderThan: async () => 7,
            listMailFolders: async () => fakeMailbox.folders,
            getInboxFolder: async () => fakeMailbox.inbox,
            listMessageRules: async () => fakeMailbox.rules,
        };
    };
    return { makeGraphClient, builtCount: () => built };
}

function cacheStore(initial = null) {
    let stored = initial; // { datos, ageMs } shape simplified
    const saves = [];
    return {
        saves,
        getCache: async () => stored,
        saveCache: async (_s, _p, datos) => {
            saves.push(datos);
            stored = { ...datos, fromCache: true };
        },
    };
}

test('serves the cache when fresh, without hitting Graph', async () => {
    const graph = fakeGraphFactory();
    const cache = cacheStore({ ...fakeMailbox, fromCache: true });
    const svc = createEmailServices({
        config,
        ...connectedAuthPlumbing(),
        deps: { ...cache, makeGraphClient: graph.makeGraphClient },
    });

    const data = await svc.getMailboxData({}, '598', {});
    assert.equal(data.fromCache, true);
    assert.equal(graph.builtCount(), 0, 'no Graph client built on a cache hit');
    assert.equal(cache.saves.length, 0);
});

test('on a cache miss, pulls from Graph, stores metadata, returns fromCache:false', async () => {
    const graph = fakeGraphFactory();
    const cache = cacheStore(null);
    const svc = createEmailServices({
        config,
        ...connectedAuthPlumbing(),
        deps: { ...cache, makeGraphClient: graph.makeGraphClient },
    });

    const data = await svc.getMailboxData({}, '598', {});
    assert.equal(data.fromCache, false);
    assert.equal(graph.builtCount(), 1);
    assert.equal(cache.saves.length, 1);
    // Only metadata keys are cached — no bodies anywhere.
    assert.deepEqual(
        Object.keys(cache.saves[0]).sort(),
        ['cutoffIso', 'folders', 'inbox', 'messages', 'olderCount', 'rules', 'windowDays']
    );
    assert.equal(cache.saves[0].olderCount, 7, 'older-mail count captured for the disclaimer');
    assert.equal(cache.saves[0].windowDays, 14);
    assert.doesNotMatch(JSON.stringify(cache.saves[0]), /"body"/i);
});

test('forceRefresh bypasses the cache even when fresh data exists', async () => {
    const graph = fakeGraphFactory();
    const cache = cacheStore({ ...fakeMailbox, fromCache: true });
    let getCacheCalled = false;
    const svc = createEmailServices({
        config,
        ...connectedAuthPlumbing(),
        deps: {
            getCache: async () => {
                getCacheCalled = true;
                return { ...fakeMailbox, fromCache: true };
            },
            saveCache: cache.saveCache,
            makeGraphClient: graph.makeGraphClient,
        },
    });

    const data = await svc.getMailboxData({}, '598', { forceRefresh: true });
    assert.equal(getCacheCalled, false, 'must not consult the cache on forceRefresh');
    assert.equal(data.fromCache, false);
    assert.equal(graph.builtCount(), 1);
});

test('a fresh pull with no connection surfaces NotConnectedError', async () => {
    const graph = fakeGraphFactory();
    const cache = cacheStore(null);
    const svc = createEmailServices({
        config,
        secretManager: { readSecret: async () => null, writeSecretVersion: async () => {} },
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        deps: { ...cache, makeGraphClient: graph.makeGraphClient },
    });

    await assert.rejects(() => svc.getMailboxData({}, '598', {}), NotConnectedError);
});
