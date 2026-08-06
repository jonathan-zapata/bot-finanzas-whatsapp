import { createEmailAuthService } from './microsoftAuth.js';
import { createGraphClient } from './graphClient.js';
import {
    getCache as getCacheReal,
    saveCache as saveCacheReal,
} from './metadataCacheRepo.js';
import {
    getTaxonomy as getTaxonomyReal,
    saveTaxonomy as saveTaxonomyReal,
} from './taxonomyRepo.js';

// Composes the email agent's runtime services into the single `emailServices`
// bundle the agent consumes: OAuth (connect / token) + a cached, metadata-only
// mailbox pull. Built once in index.js; faked wholesale in tests.
//
// `getMailboxData` is the one read path the mailbox actions share: serve the
// ~2h cache when fresh, otherwise pull metadata from Graph (unread set, folders,
// inbox, rules), cache it, and return it. `forceRefresh` (from `email refresh`)
// bypasses the cache.
export function createEmailServices({
    config,
    secretManager,
    fetchImpl = fetch,
    cacheTtlMinutes = 120,
    // Both the summary and the x-ray read the last N days of mail (read +
    // unread); the summary then narrows to UNREAD in the Inbox. The mailbox-wide
    // "total unread" headline comes from a separate $count, so it's exact
    // regardless of this window or the pull ceiling. Configurable; 30 days.
    recentWindowDays = 30,
    now = () => Date.now(),
    // Injectable seams (defaults are the real repos / clients).
    deps = {},
}) {
    const {
        getCache = getCacheReal,
        saveCache = saveCacheReal,
        getTaxonomy = getTaxonomyReal,
        saveTaxonomy = saveTaxonomyReal,
        makeGraphClient = createGraphClient,
    } = deps;

    const auth = createEmailAuthService({ config, secretManager, fetchImpl });

    async function getMailboxData(supabase, phone, { forceRefresh = false } = {}) {
        if (!forceRefresh) {
            const cached = await getCache(supabase, phone, cacheTtlMinutes);
            if (cached) return cached;
        }

        // A fresh pull needs a live connection; getAccessToken throws
        // NotConnectedError, which the agent turns into a reconnect prompt.
        const accessToken = await auth.getAccessToken();
        const graph = makeGraphClient({ getAccessToken: async () => accessToken, fetchImpl });

        const cutoffIso = new Date(now() - recentWindowDays * 24 * 60 * 60 * 1000).toISOString();

        const [messages, folders, inbox, rules, unreadTotal] = await Promise.all([
            graph.listRecentMessages(cutoffIso),
            graph.listMailFolders(),
            graph.getInboxFolder(),
            graph.listMessageRules(),
            // Best-effort: the exact unread headline is nice-to-have; on failure
            // the x-ray falls back to counting the fetched set.
            graph.countUnread().catch((error) => {
                console.warn('⚠️ Could not count total unread mail:', error?.message);
                return null;
            }),
        ]);

        // Best-effort: the disclaimer is nice-to-have, not worth failing the pull.
        let olderCount = null;
        try {
            olderCount = await graph.countMessagesOlderThan(cutoffIso);
        } catch (error) {
            console.warn('⚠️ Could not count older messages for the x-ray disclaimer:', error?.message);
        }

        const datos = { messages, folders, inbox, rules, cutoffIso, windowDays: recentWindowDays, olderCount, unreadTotal };
        await saveCache(supabase, phone, datos);
        return { ...datos, fromCache: false };
    }

    return {
        buildConsentUrl: auth.buildConsentUrl,
        handleCallback: auth.handleCallback,
        getAccessToken: auth.getAccessToken,
        getMailboxData,
        getTaxonomy: (supabase, phone) => getTaxonomy(supabase, phone),
        saveTaxonomy: (supabase, phone, categories) => saveTaxonomy(supabase, phone, categories),
    };
}
