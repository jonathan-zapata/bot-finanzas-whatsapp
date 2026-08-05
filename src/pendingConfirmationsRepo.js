const TABLE = 'confirmaciones_pendientes';
const DEFAULT_WINDOW_MINUTES = 30;

// Table and column names below stay in Spanish: they're the live Supabase
// schema (see README / deploy notes), not just internal naming.

// Returns the user's pending confirmation if it exists and hasn't expired.
// The TTL is applied here (not in the database): a pending row older than the
// window is deleted and treated as nonexistent, so an unanswered question
// doesn't "trap" the user forever.
export async function getPending(supabase, phone, windowMinutes = DEFAULT_WINDOW_MINUTES) {
    const { data, error } = await supabase
        .from(TABLE)
        .select('*')
        .eq('telefono', phone)
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
// `domain` records which agent asked the question (column `dominio`) so a bare
// reply ("2", "sí") can be routed back to that agent. It defaults to the
// expense domain to stay backward-compatible with the original single-agent
// caller.
export async function savePending(supabase, { phone, payload, reason, domain = 'expense' }) {
    const { error } = await supabase
        .from(TABLE)
        .upsert(
            {
                telefono: phone,
                payload,
                motivo: reason,
                dominio: domain,
                created_at: new Date().toISOString(),
            },
            { onConflict: 'telefono' }
        );
    if (error) throw error;
}

export async function deletePending(supabase, phone) {
    const { error } = await supabase.from(TABLE).delete().eq('telefono', phone);
    if (error) {
        console.error('❌ Error deleting pending confirmation:', error);
    }
}
