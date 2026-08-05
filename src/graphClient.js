// Thin wrapper over the Microsoft Graph REST calls the email agent needs in
// phase 1. Two hard rules live here:
//
//   1. METADATA ONLY. Message reads use `$select` to pull sender, subject,
//      received date, read status, attachment flag and parent folder — and
//      NEVER `body`/`bodyPreview`. Email content therefore never leaves the
//      mailbox to our LLM. (Enforced by SELECT_FIELDS below.)
//   2. Read-only. Only GETs are issued; there is no code path that mutates the
//      mailbox (and the OAuth scopes wouldn't allow it anyway).
//
// Network access is injected (`fetchImpl`, `getAccessToken`, `sleep`) so tests
// drive it with a fake Graph and no live calls.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// The metadata fields we read for each message. Deliberately excludes body and
// bodyPreview — the content-privacy guarantee is this one line.
const SELECT_FIELDS = 'subject,receivedDateTime,isRead,hasAttachments,parentFolderId,from';
const FOLDER_SELECT = 'id,displayName,parentFolderId,childFolderCount';

// Safety ceiling, not a normal-operation cap: guards against a pathological
// mailbox with a huge unread backlog.
const DEFAULT_MAX_MESSAGES = 1000;
const PAGE_SIZE = 100;
const MAX_RETRIES = 4;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeMessage(m) {
    return {
        id: m.id,
        subject: m.subject ?? '',
        receivedDateTime: m.receivedDateTime ?? null,
        isRead: Boolean(m.isRead),
        hasAttachments: Boolean(m.hasAttachments),
        parentFolderId: m.parentFolderId ?? null,
        // Sender metadata only — name + address, never body.
        from: {
            name: m.from?.emailAddress?.name ?? '',
            address: m.from?.emailAddress?.address ?? '',
        },
    };
}

function normalizeFolder(f) {
    return {
        id: f.id,
        displayName: f.displayName ?? '',
        parentFolderId: f.parentFolderId ?? null,
        childFolderCount: f.childFolderCount ?? 0,
    };
}

export function createGraphClient({
    getAccessToken,
    fetchImpl = fetch,
    baseUrl = GRAPH_BASE,
    maxMessages = DEFAULT_MAX_MESSAGES,
    sleep = defaultSleep,
}) {
    // A single GET with 429 + Retry-After backoff. Graph throttles per-mailbox,
    // so this is the expected "slow down" signal, not an error.
    async function graphGet(url, attempt = 0) {
        const token = await getAccessToken();
        const response = await fetchImpl(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });

        if (response.status === 429 && attempt < MAX_RETRIES) {
            const retryAfter = Number(response.headers?.get?.('retry-after')) || 2 ** attempt;
            await sleep(retryAfter * 1000);
            return graphGet(url, attempt + 1);
        }
        if (!response.ok) {
            const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
            throw new Error(`Microsoft Graph GET ${url} failed: ${response.status} ${text}`);
        }
        return response.json();
    }

    // The full unread set (across the mailbox), capped at maxMessages. Paginated
    // via Graph's @odata.nextLink.
    async function listUnreadMessages() {
        const messages = [];
        const filter = encodeURIComponent('isRead eq false');
        let url = `${baseUrl}/me/messages?$filter=${filter}&$select=${SELECT_FIELDS}&$top=${PAGE_SIZE}`;
        while (url && messages.length < maxMessages) {
            const page = await graphGet(url);
            for (const m of page.value ?? []) {
                messages.push(normalizeMessage(m));
                if (messages.length >= maxMessages) break;
            }
            url = page['@odata.nextLink'] ?? null;
        }
        return messages;
    }

    // Every mail folder, walking child folders to arbitrary depth. Used to map a
    // message's parentFolderId to a human folder name for the x-ray.
    async function listMailFolders() {
        const folders = [];
        const queue = [`${baseUrl}/me/mailFolders?$select=${FOLDER_SELECT}&$top=${PAGE_SIZE}`];
        while (queue.length > 0) {
            const page = await graphGet(queue.shift());
            for (const f of page.value ?? []) {
                folders.push(normalizeFolder(f));
                if (f.childFolderCount > 0) {
                    queue.push(`${baseUrl}/me/mailFolders/${f.id}/childFolders?$select=${FOLDER_SELECT}&$top=${PAGE_SIZE}`);
                }
            }
            if (page['@odata.nextLink']) queue.push(page['@odata.nextLink']);
        }
        return folders;
    }

    // The well-known Inbox folder (id + name), so "unrouted mail → Inbox" and
    // the Inbox-only summary can be computed reliably regardless of localization.
    async function getInboxFolder() {
        const f = await graphGet(`${baseUrl}/me/mailFolders/inbox?$select=id,displayName`);
        return { id: f.id, displayName: f.displayName ?? 'Inbox' };
    }

    // The user's Inbox message rules (requires MailboxSettings.Read).
    async function listMessageRules() {
        const page = await graphGet(`${baseUrl}/me/mailFolders/inbox/messageRules`);
        return page.value ?? [];
    }

    return { listUnreadMessages, listMailFolders, getInboxFolder, listMessageRules };
}
