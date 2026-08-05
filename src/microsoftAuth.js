// Microsoft OAuth for the email agent (phase 1: read-only).
//
// The account owner connects their personal Microsoft mailbox once through a
// normal sign-in + consent page. We request ONLY read scopes, so "read-only"
// is enforced by Microsoft — the bot literally cannot be granted write access
// in this phase. The refresh token lives in GCP Secret Manager and is used
// silently afterwards; Microsoft rotates it, so each refresh persists the newly
// issued value back.
//
// All network + Secret Manager access is injected (`fetchImpl`, `secretManager`)
// so tests drive the whole flow with no live Microsoft/Google calls.

// Only read scopes. `offline_access` is what makes Microsoft issue a refresh
// token at all; there is deliberately no `Mail.ReadWrite` here.
export const SCOPES = ['offline_access', 'Mail.Read', 'MailboxSettings.Read'];

// Personal Microsoft accounts (Hotmail/Outlook) live under the "consumers"
// authority; an Azure app of type "Personal accounts only" matches this.
const DEFAULT_TENANT = 'consumers';

// Refresh a bit before the real expiry so an in-flight request never races the
// token going stale.
const EXPIRY_SKEW_MS = 60_000;

// Raised when there's no usable connection (no stored refresh token, or the
// stored one no longer works). The agent turns this into a "please reconnect"
// reply rather than a crash.
export class NotConnectedError extends Error {
    constructor(message = 'Microsoft mailbox is not connected') {
        super(message);
        this.name = 'NotConnectedError';
    }
}

function authorizeEndpoint(tenant) {
    return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

function tokenEndpoint(tenant) {
    return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

// Builds the consent URL the user opens to grant access.
export function buildConsentUrl({ clientId, redirectUri, state, tenant = DEFAULT_TENANT }) {
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: SCOPES.join(' '),
    });
    if (state) params.set('state', state);
    return `${authorizeEndpoint(tenant)}?${params.toString()}`;
}

async function postToken(url, form, fetchImpl) {
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
    });
    const data = await response.json();
    if (!response.ok) {
        const detail = data?.error_description || data?.error || `HTTP ${response.status}`;
        throw new Error(`Microsoft token endpoint error: ${detail}`);
    }
    return data;
}

// Exchanges the authorization code (from the callback) for the first token set.
export async function exchangeCodeForTokens(
    { clientId, clientSecret, redirectUri, code, tenant = DEFAULT_TENANT },
    { fetchImpl = fetch } = {}
) {
    return postToken(
        tokenEndpoint(tenant),
        {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            scope: SCOPES.join(' '),
            code,
        },
        fetchImpl
    );
}

// Trades a refresh token for a fresh access token (and usually a rotated
// refresh token).
export async function refreshAccessToken(
    { clientId, clientSecret, refreshToken, tenant = DEFAULT_TENANT },
    { fetchImpl = fetch } = {}
) {
    return postToken(
        tokenEndpoint(tenant),
        {
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
            scope: SCOPES.join(' '),
            refresh_token: refreshToken,
        },
        fetchImpl
    );
}

// Builds the auth service the rest of the app uses. `config` carries the Azure
// app credentials + the Secret Manager id under which the refresh token lives.
//
// Returned surface:
//   - buildConsentUrl(state?) → the consent URL (no token needed)
//   - handleCallback(code)    → exchange the code and store the refresh token
//   - getAccessToken()        → a valid access token, refreshing + persisting
//                               the rotated refresh token as needed; throws
//                               NotConnectedError when there's no usable token
export function createEmailAuthService({ config, secretManager, fetchImpl = fetch, now = () => Date.now() }) {
    const { clientId, clientSecret, redirectUri, tenant = DEFAULT_TENANT, refreshTokenSecret } = config;

    // In-memory access-token cache so we don't refresh on every request.
    let cachedAccessToken = null;
    let cachedExpiresAt = 0;

    async function handleCallback(code) {
        const tokens = await exchangeCodeForTokens(
            { clientId, clientSecret, redirectUri, code, tenant },
            { fetchImpl }
        );
        if (!tokens.refresh_token) {
            throw new Error('Microsoft did not return a refresh token (is offline_access requested?)');
        }
        await secretManager.writeSecretVersion(refreshTokenSecret, tokens.refresh_token);
        cachedAccessToken = tokens.access_token ?? null;
        cachedExpiresAt = tokens.expires_in ? now() + tokens.expires_in * 1000 : 0;
    }

    async function getAccessToken() {
        if (cachedAccessToken && now() < cachedExpiresAt - EXPIRY_SKEW_MS) {
            return cachedAccessToken;
        }

        const refreshToken = await secretManager.readSecret(refreshTokenSecret);
        if (!refreshToken) {
            throw new NotConnectedError();
        }

        let tokens;
        try {
            tokens = await refreshAccessToken({ clientId, clientSecret, refreshToken, tenant }, { fetchImpl });
        } catch (error) {
            // A revoked/expired refresh token is a reconnect condition, not a
            // transient failure.
            throw new NotConnectedError(`refresh failed: ${error.message}`);
        }

        // Persist the rotated refresh token if Microsoft issued a new one.
        if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
            await secretManager.writeSecretVersion(refreshTokenSecret, tokens.refresh_token);
        }

        cachedAccessToken = tokens.access_token;
        cachedExpiresAt = now() + (tokens.expires_in ?? 0) * 1000;
        return cachedAccessToken;
    }

    return {
        buildConsentUrl: (state) => buildConsentUrl({ clientId, redirectUri, state, tenant }),
        handleCallback,
        getAccessToken,
    };
}
