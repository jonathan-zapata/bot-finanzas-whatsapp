// Thin wrapper over GCP Secret Manager for the one credential that must be
// read AND written at runtime: the Microsoft refresh token (it rotates, so the
// app has to persist the newly issued value back). The bot's *static* secrets
// don't go through here — those are mounted into Cloud Run as env vars
// (ticket 02) and read via process.env unchanged.
//
// The real Google client is imported lazily so that (a) tests never load it —
// they fake this module's small surface, `{ readSecret, writeSecretVersion }` —
// and (b) a deployment that hasn't configured Secret Manager only fails when it
// actually reaches for the token, not at boot.

export function createSecretManager({ projectId, clientFactory } = {}) {
    let client;

    async function getClient() {
        if (client) return client;
        if (clientFactory) {
            client = clientFactory();
        } else {
            const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
            client = new SecretManagerServiceClient();
        }
        return client;
    }

    // Reads the latest version of a secret. Returns null when the secret exists
    // but has no versions yet, or doesn't exist — i.e. "not connected", which
    // the caller treats as a reconnect condition rather than an error.
    async function readSecret(secretId) {
        const c = await getClient();
        const name = `projects/${projectId}/secrets/${secretId}/versions/latest`;
        try {
            const [version] = await c.accessSecretVersion({ name });
            const data = version?.payload?.data;
            if (!data) return null;
            return Buffer.from(data).toString('utf8');
        } catch (error) {
            // gRPC NOT_FOUND (5) / FAILED_PRECONDITION (9, no enabled versions).
            if (error?.code === 5 || error?.code === 9) return null;
            throw error;
        }
    }

    // Adds a new version (Secret Manager is append-only/versioned). Used to
    // persist Microsoft's rotated refresh token.
    async function writeSecretVersion(secretId, value) {
        const c = await getClient();
        const parent = `projects/${projectId}/secrets/${secretId}`;
        await c.addSecretVersion({
            parent,
            payload: { data: Buffer.from(value, 'utf8') },
        });
    }

    return { readSecret, writeSecretVersion };
}
