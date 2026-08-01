const TABLE = 'pagos';
const UNIQUE_VIOLATION_CODE = '23505';

// Table and column names below stay in Spanish: they're the live Supabase
// schema (see README / deploy notes), not just internal naming.

// Pre-check by message_id: avoids spending an LLM call and a write when
// WhatsApp retries delivery of an already-processed message.
// Requires a `message_id` column (ideally unique) on the `pagos` table — see
// README / deployment notes.
export async function wasAlreadyProcessed(supabase, messageId) {
    const { data, error } = await supabase
        .from(TABLE)
        .select('id')
        .eq('message_id', messageId)
        .maybeSingle();

    if (error) {
        console.error('❌ Error checking idempotency (continuing without blocking):', error);
        return false;
    }
    return Boolean(data);
}

// Safety net for a race between the pre-check and the insert: if the
// message_id column has a UNIQUE constraint, a duplicate lands here instead
// of being inserted twice.
export async function savePayment(supabase, { phone, messageId, data }) {
    const { error } = await supabase.from(TABLE).insert([
        {
            telefono: phone,
            message_id: messageId,
            servicio: data.servicio,
            monto: data.monto,
            divisa: data.divisa,
            metodo_pago: data.metodo_pago,
            cuotas: data.cuotas,
            categoria: data.categoria,
            fecha_gasto: data.fecha_gasto,
        },
    ]);

    if (error) {
        if (error.code === UNIQUE_VIOLATION_CODE) {
            return { duplicate: true };
        }
        throw error;
    }
    return { duplicate: false };
}

// Looks for an already-saved payment that matches EXACTLY on phone + item +
// amount + currency (the definition of "duplicate" we chose). Returns the
// most recent match, or null. The caller compares fecha_gasto to decide
// whether it's a technical duplicate (same date → ask) or a legitimate
// recurring expense (different date → log it and note it).
export async function findExactDuplicate(supabase, { phone, servicio, monto, divisa }) {
    const { data, error } = await supabase
        .from(TABLE)
        .select('id, servicio, monto, divisa, fecha_gasto')
        .eq('telefono', phone)
        .eq('servicio', servicio)
        .eq('monto', monto)
        .eq('divisa', divisa)
        .order('id', { ascending: false })
        .limit(1);

    if (error) {
        console.error('❌ Error finding exact duplicate (continuing without blocking):', error);
        return null;
    }
    return data && data.length > 0 ? data[0] : null;
}
