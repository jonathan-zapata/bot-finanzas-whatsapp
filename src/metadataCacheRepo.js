const TABLE = 'email_metadata_cache';
const DEFAULT_TTL_MINUTES = 120; // ~2h, per spec

// Caches the last mailbox metadata pull per user so follow-up analytical
// questions ("break that down", "how many from Government") are answered
// cheaply without re-hitting Graph. Like the pending-confirmation TTL, freshness
// is enforced in app logic: a pull older than the window is treated as absent.
//
// IMPORTANT: only metadata is ever stored here — the `datos` blob holds the same
// normalized fields the Graph client returns (sender, subject, dates, flags,
// folder ids, rules), never message bodies. Caching must not weaken the
// content-privacy guarantee.

// Returns the cached pull if present and within the TTL, else null (deleting an
// expired row on the way out).
export async function getCache(supabase, phone, ttlMinutes = DEFAULT_TTL_MINUTES) {
    const { data, error } = await supabase.from(TABLE).select('*').eq('telefono', phone).maybeSingle();

    if (error) {
        console.error('❌ Error reading metadata cache (continuing without cache):', error);
        return null;
    }
    if (!data) return null;

    const ageMs = Date.now() - new Date(data.created_at).getTime();
    if (ageMs > ttlMinutes * 60_000) {
        await deleteCache(supabase, phone);
        return null;
    }
    return { ...data.datos, fromCache: true, cachedAt: data.created_at };
}

// Saves (replaces) the user's metadata pull. `datos` must contain metadata
// fields only.
export async function saveCache(supabase, phone, datos) {
    const { error } = await supabase
        .from(TABLE)
        .upsert(
            { telefono: phone, datos, created_at: new Date().toISOString() },
            { onConflict: 'telefono' }
        );
    if (error) throw error;
}

export async function deleteCache(supabase, phone) {
    const { error } = await supabase.from(TABLE).delete().eq('telefono', phone);
    if (error) {
        console.error('❌ Error deleting metadata cache:', error);
    }
}
