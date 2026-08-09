const TABLE = 'payments';
const UNIQUE_VIOLATION_CODE = '23505';

// The database schema is in English (the project's convention). The expense
// DOMAIN object, however, stays in Spanish on purpose: its keys are the exact
// JSON the LLM is prompted to return (see aiExtractor.js), so this repo is the
// anti-corruption layer that maps the Spanish domain shape to/from the English
// columns. The rest of the app never sees the column names.
//
// NOTE: message idempotency lives in `processedMessagesRepo` (domain-agnostic).
// The `message_id` UNIQUE constraint below stays as an expense-specific backstop
// against a race between the idempotency pre-check and the insert.

// Safety net for a race between the pre-check and the insert: if the
// message_id column has a UNIQUE constraint, a duplicate lands here instead
// of being inserted twice.
export async function savePayment(supabase, { phone, messageId, data }) {
    const { error } = await supabase.from(TABLE).insert([
        {
            phone,
            message_id: messageId,
            service: data.servicio,
            amount: data.monto,
            currency: data.divisa,
            payment_method: data.metodo_pago,
            installments: data.cuotas,
            category: data.categoria,
            expense_date: data.fecha_gasto,
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
// most recent match mapped back to the Spanish domain shape (or null). The
// caller compares fecha_gasto to decide whether it's a technical duplicate
// (same date → ask) or a legitimate recurring expense (different date → log it
// and note it).
export async function findExactDuplicate(supabase, { phone, servicio, monto, divisa }) {
    const { data, error } = await supabase
        .from(TABLE)
        .select('id, service, amount, currency, expense_date')
        .eq('phone', phone)
        .eq('service', servicio)
        .eq('amount', monto)
        .eq('currency', divisa)
        .order('id', { ascending: false })
        .limit(1);

    if (error) {
        console.error('❌ Error finding exact duplicate (continuing without blocking):', error);
        return null;
    }
    if (!data || data.length === 0) return null;

    // Map the English row back to the Spanish domain shape the agent expects.
    const row = data[0];
    return {
        id: row.id,
        servicio: row.service,
        monto: row.amount,
        divisa: row.currency,
        fecha_gasto: row.expense_date,
    };
}
