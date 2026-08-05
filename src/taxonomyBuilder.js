// Builds the proposed category taxonomy from the account owner's actual mailbox
// — their existing folder names and rule names — so the categories reflect how
// they already organize mail rather than a generic list. Deterministic and
// pure: no LLM, no I/O, trivially testable.
//
// The taxonomy always carries a standing "Other/Uncategorized" bucket so that
// later sender classification (ticket 07) always has a safe fallback, and a
// growing "Other" signals it's time to rebuild.

// The standing fallback category. Spanish, matching the rest of the bot's copy.
export const STANDING_OTHER = 'Otros / Sin clasificar';

// Well-known system folders that aren't meaningful semantic categories. Compared
// case-insensitively against folder display names (English + Spanish variants).
const SYSTEM_FOLDERS = new Set(
    [
        'inbox', 'bandeja de entrada',
        'sent items', 'sent', 'elementos enviados', 'enviados',
        'drafts', 'borradores',
        'deleted items', 'elementos eliminados', 'eliminados', 'papelera',
        'junk email', 'junk', 'correo no deseado',
        'archive', 'archivo',
        'outbox', 'bandeja de salida',
        'conversation history', 'historial de conversaciones',
        'notes', 'notas',
        'rss feeds', 'rss subscriptions',
        'clutter', 'sync issues', 'server failures', 'local failures',
    ].map((s) => s.toLowerCase())
);

function isMeaningfulCategory(name) {
    const trimmed = (name ?? '').trim();
    if (trimmed.length < 2) return false;
    return !SYSTEM_FOLDERS.has(trimmed.toLowerCase());
}

// Ensures the standing "Other" category is present exactly once, at the end, and
// removes case-insensitive duplicates while preserving first-seen casing/order.
export function withStandingOther(categories) {
    const seen = new Set();
    const result = [];
    for (const c of categories ?? []) {
        const name = (c ?? '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        if (key === STANDING_OTHER.toLowerCase()) continue; // add it once, at the end
        seen.add(key);
        result.push(name);
    }
    result.push(STANDING_OTHER);
    return result;
}

// Proposes a taxonomy from the mailbox: folder names first (how mail is filed),
// then rule names (rule names are treated as category signals), de-duplicated,
// with the standing "Other" appended.
export function proposeTaxonomy({ folders = [], rules = [] } = {}) {
    const candidates = [];
    for (const f of folders) {
        if (isMeaningfulCategory(f.displayName)) candidates.push(f.displayName.trim());
    }
    for (const r of rules) {
        if (isMeaningfulCategory(r.displayName)) candidates.push(r.displayName.trim());
    }
    return withStandingOther(candidates);
}
