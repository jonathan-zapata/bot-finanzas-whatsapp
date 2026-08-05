import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildConsentUrl,
    exchangeCodeForTokens,
    createEmailAuthService,
    NotConnectedError,
    SCOPES,
} from '../src/microsoftAuth.js';

// An in-memory Secret Manager: readSecret returns the latest written value (or
// null when nothing's been stored — the "not connected" condition).
function fakeSecretManager(initial = {}) {
    const store = new Map(Object.entries(initial));
    const writes = [];
    return {
        writes,
        store,
        readSecret: async (id) => (store.has(id) ? store.get(id) : null),
        writeSecretVersion: async (id, value) => {
            store.set(id, value);
            writes.push({ id, value });
        },
    };
}

// A fake fetch for the token endpoint that returns a canned token payload and
// records the form body it was called with.
function fakeFetch(payload, { ok = true, status = 200, capture } = {}) {
    return async (url, opts) => {
        if (capture) capture({ url, body: opts?.body });
        return {
            ok,
            status,
            json: async () => payload,
        };
    };
}

const config = {
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
    redirectUri: 'https://bot.example.com/oauth/microsoft/callback',
    tenant: 'consumers',
    refreshTokenSecret: 'ms-refresh-token',
};

test('consent URL requests only read scopes (no write scope) and the core params', () => {
    const url = buildConsentUrl({ clientId: 'cid', redirectUri: 'https://x/cb', state: 's1' });
    assert.match(url, /login\.microsoftonline\.com\/consumers\/oauth2\/v2\.0\/authorize/);
    assert.match(url, /client_id=cid/);
    assert.match(url, /response_type=code/);
    assert.match(url, /state=s1/);
    // Read-only enforced by Microsoft: the requested scopes are exactly these.
    assert.deepEqual(SCOPES, ['offline_access', 'Mail.Read', 'MailboxSettings.Read']);
    assert.doesNotMatch(decodeURIComponent(url), /Mail\.ReadWrite/);
});

test('exchangeCodeForTokens posts an authorization_code grant and returns the tokens', async () => {
    let seen;
    const tokens = await exchangeCodeForTokens(
        { ...config, code: 'auth-code-1' },
        { fetchImpl: fakeFetch({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }, { capture: (c) => (seen = c) }) }
    );
    assert.equal(tokens.refresh_token, 'rt');
    assert.match(seen.body, /grant_type=authorization_code/);
    assert.match(seen.body, /code=auth-code-1/);
});

test('handleCallback exchanges the code and stores the refresh token in Secret Manager', async () => {
    const sm = fakeSecretManager();
    const svc = createEmailAuthService({
        config,
        secretManager: sm,
        fetchImpl: fakeFetch({ access_token: 'at', refresh_token: 'rt-initial', expires_in: 3600 }),
    });
    await svc.handleCallback('code-1');
    assert.equal(sm.store.get('ms-refresh-token'), 'rt-initial');
});

test('getAccessToken with no stored refresh token → NotConnectedError', async () => {
    const svc = createEmailAuthService({
        config,
        secretManager: fakeSecretManager(),
        fetchImpl: fakeFetch({}),
    });
    await assert.rejects(() => svc.getAccessToken(), NotConnectedError);
});

test('getAccessToken refreshes and persists the ROTATED refresh token', async () => {
    const sm = fakeSecretManager({ 'ms-refresh-token': 'rt-old' });
    const svc = createEmailAuthService({
        config,
        secretManager: sm,
        fetchImpl: fakeFetch({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }),
    });
    const token = await svc.getAccessToken();
    assert.equal(token, 'at-new');
    assert.equal(sm.store.get('ms-refresh-token'), 'rt-new', 'rotated refresh token persisted');
    assert.equal(sm.writes.length, 1);
});

test('getAccessToken does NOT rewrite the secret when the refresh token is unchanged', async () => {
    const sm = fakeSecretManager({ 'ms-refresh-token': 'rt-same' });
    const svc = createEmailAuthService({
        config,
        secretManager: sm,
        fetchImpl: fakeFetch({ access_token: 'at', refresh_token: 'rt-same', expires_in: 3600 }),
    });
    await svc.getAccessToken();
    assert.equal(sm.writes.length, 0, 'no rotation → no write');
});

test('getAccessToken caches the access token (no second refresh within its TTL)', async () => {
    let calls = 0;
    const svc = createEmailAuthService({
        config,
        secretManager: fakeSecretManager({ 'ms-refresh-token': 'rt' }),
        fetchImpl: async () => {
            calls += 1;
            return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
        },
        now: () => 1_000_000,
    });
    await svc.getAccessToken();
    await svc.getAccessToken();
    assert.equal(calls, 1, 'second call served from the in-memory cache');
});

test('getAccessToken maps a failed refresh (revoked/expired) to NotConnectedError', async () => {
    const svc = createEmailAuthService({
        config,
        secretManager: fakeSecretManager({ 'ms-refresh-token': 'rt-dead' }),
        fetchImpl: fakeFetch({ error: 'invalid_grant', error_description: 'expired' }, { ok: false, status: 400 }),
    });
    await assert.rejects(() => svc.getAccessToken(), NotConnectedError);
});
