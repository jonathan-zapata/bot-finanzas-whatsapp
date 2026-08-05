import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphClient } from '../src/graphClient.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

const getAccessToken = async () => 'tok';
const noSleep = async () => {};

test('message reads request metadata via $select and NEVER body/bodyPreview', async () => {
    let seenUrl;
    const client = createGraphClient({
        getAccessToken,
        fetchImpl: async (url) => {
            seenUrl = url;
            return jsonResponse({ value: [] });
        },
    });
    await client.listUnreadMessages();

    assert.match(seenUrl, /\$select=subject,receivedDateTime,isRead,hasAttachments,parentFolderId,from/);
    assert.doesNotMatch(seenUrl, /body/i, 'must never request message bodies');
    assert.match(seenUrl, /isRead%20eq%20false/, 'pulls the unread set');
});

test('unread pull normalizes metadata and follows pagination', async () => {
    const page1 = {
        value: [
            { id: '1', subject: 'a', isRead: false, hasAttachments: false, parentFolderId: 'f1', from: { emailAddress: { name: 'A', address: 'a@x.com' } } },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next',
    };
    const page2 = { value: [{ id: '2', subject: 'b', isRead: false, parentFolderId: 'f2', from: { emailAddress: { address: 'b@x.com' } } }] };

    let calls = 0;
    const client = createGraphClient({
        getAccessToken,
        fetchImpl: async () => jsonResponse(calls++ === 0 ? page1 : page2),
    });
    const messages = await client.listUnreadMessages();

    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0].from, { name: 'A', address: 'a@x.com' });
    assert.equal(messages[1].from.name, '', 'missing name normalizes to empty string');
    assert.equal(messages[0].parentFolderId, 'f1');
});

test('unread pull respects the safety ceiling (maxMessages)', async () => {
    const page = {
        value: [
            { id: '1', from: { emailAddress: {} } },
            { id: '2', from: { emailAddress: {} } },
            { id: '3', from: { emailAddress: {} } },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next',
    };
    const client = createGraphClient({
        getAccessToken,
        maxMessages: 2,
        fetchImpl: async () => jsonResponse(page),
    });
    const messages = await client.listUnreadMessages();
    assert.equal(messages.length, 2, 'stops at the ceiling');
});

test('429 is retried after Retry-After, then succeeds', async () => {
    let calls = 0;
    const client = createGraphClient({
        getAccessToken,
        sleep: noSleep,
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return jsonResponse({ error: 'throttled' }, { status: 429, headers: { 'retry-after': '0' } });
            return jsonResponse({ value: [] });
        },
    });
    const messages = await client.listUnreadMessages();
    assert.equal(messages.length, 0);
    assert.equal(calls, 2, 'retried once after the 429');
});

test('mail folders are walked recursively into child folders', async () => {
    const top = {
        value: [
            { id: 'inbox-id', displayName: 'Inbox', parentFolderId: null, childFolderCount: 1 },
            { id: 'leaf-id', displayName: 'Leaf', parentFolderId: null, childFolderCount: 0 },
        ],
    };
    const children = { value: [{ id: 'child-id', displayName: 'Child', parentFolderId: 'inbox-id', childFolderCount: 0 }] };

    const client = createGraphClient({
        getAccessToken,
        fetchImpl: async (url) => jsonResponse(url.includes('/childFolders') ? children : top),
    });
    const folders = await client.listMailFolders();
    const names = folders.map((f) => f.displayName).sort();
    assert.deepEqual(names, ['Child', 'Inbox', 'Leaf']);
});

test('listMessageRules returns the inbox rules array', async () => {
    const client = createGraphClient({
        getAccessToken,
        fetchImpl: async (url) => {
            assert.match(url, /\/me\/mailFolders\/inbox\/messageRules/);
            return jsonResponse({ value: [{ id: 'r1', displayName: 'LinkedIn' }] });
        },
    });
    const rules = await client.listMessageRules();
    assert.equal(rules[0].displayName, 'LinkedIn');
});
