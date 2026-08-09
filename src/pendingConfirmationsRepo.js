const TABLE = 'pending_confirmations';
const DEFAULT_WINDOW_MINUTES = 30;

// Returns the user's pending confirmation if it exists and hasn't expired.
// The TTL is applied here (not in the database): a pending row older than the
// window is deleted and treated as nonexistent, so an unanswered question
// doesn't "trap" the user forever. The returned row carries `domain` (which
// agent asked), `reason`, and `payload`.
export async function getPending(supabase, phone, windowMinutes = DEFAULT_WINDOW_MINUTES) {
    const { data, error } = await supabase
        .from(TABLE)
        .select('*')
        .eq('phone', phone)
        .maybeSingle();

    if (error) {
        console.error('❌ Error reading pending confirmation (continuing without blocking):', error);
        return null;
    }
    if (!data) return null;

    const ageMs = Date.now() - new Date(data.created_at).getTime();
    if (ageMs > windowMinutes * 60_000) {
        await deletePending(supabase, phone);
        return null;
    }
    return data;
}

// Saves (or replaces) the user's pending confirmation. Upsert by phone: there
// can only be one open question per number (shared across agents — fine for a
// single-user bot), and saving a new one resets the TTL clock.
//
// `domain` records which agent asked the question so a bare reply ("2", "sí")
// can be routed back to that agent. It defaults to the expense domain to stay
// backward-compatible with the original single-agent caller.
export async function savePending(supabase, { phone, payload, reason, domain = 'expense' }) {
    const { error } = await supabase
        .from(TABLE)
        .upsert(
            {
                phone,
                payload,
                reason,
                domain,
                created_at: new Date().toISOString(),
            },
            { onConflict: 'phone' }
        );
    if (error) throw error;
}

export async function deletePending(supabase, phone) {
    const { error } = await supabase.from(TABLE).delete().eq('phone', phone);
    if (error) {
        console.error('❌ Error deleting pending confirmation:', error);
    }
}
