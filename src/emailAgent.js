// The email agent — the second agent behind the Level-1 router.
//
// Phase 1, ticket 01: this is a deliberately thin stub. It knows how to claim
// a message (the `email ...` prefix) and enforces the post-prefix length cap,
// but every real action still answers "coming soon". Later tickets replace the
// body of `handleMessage` with the Level-2 task classifier (03) and the actual
// read-only mailbox actions (04–08).
//
// It satisfies the same small contract as the expense agent — a plain object
// with `{ domain, matchPrefix, handleMessage, handlePendingReply }`, its
// dependencies injected through the call `ctx` exactly like the expense flow —
// so the router treats it as "just another agent", with no base class in sight.
//
// User-facing copy stays in Spanish, matching the rest of the bot (Uruguayan
// users).

export const EMAIL_DOMAIN = 'email';

// Working-assumption prefix (see spec "Prefix wording"). Kept as a single
// lowercase token so the match is a cheap, deterministic string check — the
// high-stakes agent boundary must never be an LLM guess.
export const EMAIL_PREFIX = 'email';

// Post-prefix length cap. A request longer than this is rejected outright
// rather than truncated: a truncated request could re-parse as a *different*
// action than the user intended, and the cap also bounds LLM consumption.
export const MAX_REQUEST_CHARS = 1000;

const COMING_SOON_MESSAGE =
    '📬 El asistente de email está en construcción. Pronto vas a poder pedirme un resumen de tu bandeja, ver a dónde va tu correo y más. ¡Gracias por la paciencia! 🛠️';
const TOO_LONG_MESSAGE =
    '✂️ Tu consulta es demasiado larga. Acortala a menos de 1000 caracteres y probá de nuevo, así no corro riesgo de entender otra cosa.';

// Level-1 claim check. Returns whether this agent owns the message and, if so,
// the free-text remainder after the prefix (trimmed). Matching requires the
// prefix to be a standalone leading token ("email" alone, or "email " + rest)
// so that words like "emails" don't accidentally route here.
export function matchPrefix(userText) {
    const trimmed = (userText ?? '').trimStart();
    const lower = trimmed.toLowerCase();
    if (lower === EMAIL_PREFIX) {
        return { matched: true, remainder: '' };
    }
    // A whitespace boundary right after the prefix token.
    if (lower.startsWith(EMAIL_PREFIX) && /\s/.test(trimmed.charAt(EMAIL_PREFIX.length))) {
        return { matched: true, remainder: trimmed.slice(EMAIL_PREFIX.length).trim() };
    }
    return { matched: false, remainder: '' };
}

// Fresh prefixed message. The length cap runs first, before any (future) LLM
// call. In ticket 01 every accepted request answers "coming soon".
export async function handleMessage(ctx) {
    const { whatsapp, userPhone, remainder } = ctx;

    if (remainder.length > MAX_REQUEST_CHARS) {
        await whatsapp.sendMessage(userPhone, TOO_LONG_MESSAGE);
        return;
    }

    await whatsapp.sendMessage(userPhone, COMING_SOON_MESSAGE);
}

// Reply to a pending question the email agent asked. Ticket 01 never *creates*
// an email-domain pending question, so in practice this isn't reached yet; it
// exists so the contract is complete and the router can dispatch pending
// replies by domain. Ticket 03 gives it real disambiguation behavior.
export async function handlePendingReply(ctx) {
    const { whatsapp, userPhone } = ctx;
    await whatsapp.sendMessage(userPhone, COMING_SOON_MESSAGE);
}

export const emailAgent = {
    domain: EMAIL_DOMAIN,
    matchPrefix,
    handleMessage,
    handlePendingReply,
};
