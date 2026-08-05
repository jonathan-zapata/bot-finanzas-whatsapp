const TABLE = 'mensajes_procesados';
const UNIQUE_VIOLATION_CODE = '23505';

// Domain-agnostic idempotency: records every WhatsApp message the bot has fully
// handled, keyed by `message_id`, so a webhook retry from Meta is a no-op no
// matter which agent handled it. This is deliberately NOT tied to the `pagos`
// table — an email request never produces a payment, so parking idempotency in
// `pagos` silently left the email agent unprotected. The `pagos.message_id`
// UNIQUE constraint still stands as an expense-specific backstop against races.

// Has this message already been fully processed?
export async function wasProcessed(supabase, messageId) {
    const { data, error } = await supabase
        .from(TABLE)
        .select('message_id')
        .eq('message_id', messageId)
        .maybeSingle();

    if (error) {
        console.error('❌ Error checking processed message (continuing without blocking):', error);
        return false;
    }
    return Boolean(data);
}

// Records a message as processed. Best-effort: on failure it logs and returns
// rather than throwing, because it's called AFTER the reply was already sent —
// throwing here would make the webhook 500 and Meta retry an already-answered
// message (a duplicate reply), which is worse than a rare un-recorded id.
export async function markProcessed(supabase, messageId, phone) {
    const { error } = await supabase.from(TABLE).insert([{ message_id: messageId, telefono: phone }]);
    if (error) {
        // A concurrent retry that got there first is expected, not an error.
        if (error.code === UNIQUE_VIOLATION_CODE) return;
        console.error('❌ Error marking message as processed (continuing):', error);
    }
}
