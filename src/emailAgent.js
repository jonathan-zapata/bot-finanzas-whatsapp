import { classifyEmailIntent as classifyEmailIntentReal } from './emailIntentClassifier.js';
import { NotConnectedError } from './microsoftAuth.js';
import { formatXrayReport } from './xrayReport.js';
import { proposeTaxonomy } from './taxonomyBuilder.js';
import { classifySenders as classifySendersReal } from './summaryClassifier.js';
import { collectSenders, formatSummaryReport } from './summaryReport.js';
import { parseResponse } from './responseParser.js';
import {
    savePending as savePendingReal,
    deletePending as deletePendingReal,
} from './pendingConfirmationsRepo.js';

// The email agent — the second agent behind the Level-1 router.
//
// Responsibilities (Level-2): take the free-text remainder of an `email ...`
// message, classify it into a closed action via the LLM, and either run that
// action or — when the intent is `unclear` — ask a numbered disambiguation
// question instead of guessing. A bare reply ("2") resolves the question.
//
// It satisfies the shared agent contract as a plain object with dependencies
// injected through `ctx.deps`, so tests fake the classifier / persistence with
// no network. User-facing copy stays in Spanish (Uruguayan users).

export const EMAIL_DOMAIN = 'email';

// Working-assumption prefix (see spec "Prefix wording"): a single lowercase
// token so the Level-1 match is a cheap, deterministic string check.
export const EMAIL_PREFIX = 'email';

// Post-prefix length cap. A longer request is rejected outright rather than
// truncated — a truncated request could re-parse as a *different* action than
// intended — and the cap bounds LLM consumption. Enforced before any LLM call.
export const MAX_REQUEST_CHARS = 1000;

// The user-facing action catalog, in menu order. Drives both the `help` reply
// and the numbered disambiguation menu, so the two never drift apart. `unclear`
// is deliberately absent — it's an outcome, not something a user picks.
const ACTION_CATALOG = [
    { id: 'summary', menu: 'Resumen de tu bandeja: quién te escribió, agrupado por categoría' },
    { id: 'xray', menu: 'Radiografía: a dónde va tu correo por carpeta y qué hacen tus reglas' },
    { id: 'recommendations', menu: 'Recomendaciones para reorganizar carpetas y revisar reglas' },
    { id: 'setup_categories', menu: 'Configurar o reconstruir tus categorías' },
    { id: 'connect', menu: 'Conectar tu cuenta de Microsoft (Outlook/Hotmail)' },
    { id: 'refresh', menu: 'Actualizar los datos (traer correo nuevo)' },
    { id: 'help', menu: 'Ver qué puedo hacer' },
];

const TOO_LONG_MESSAGE =
    '✂️ Tu consulta es demasiado larga. Acortala a menos de 1000 caracteres y probá de nuevo, así no corro riesgo de entender otra cosa.';

const COMING_SOON_MESSAGE =
    '🛠️ Esa función todavía está en construcción. Escribí *email ayuda* para ver lo que ya puedo hacer.';

const DISAMBIGUATION_UNRESOLVED_MESSAGE =
    '🤔 No entendí qué número elegiste. Respondé solo con el número de una de las opciones que te pasé.';

const RECONNECT_MESSAGE =
    '🔌 Todavía no conectaste tu casilla de Microsoft (o la conexión venció). Escribí *email conectar* y seguí el link para darme acceso de solo lectura.';

const CONNECT_UNAVAILABLE_MESSAGE =
    '⚠️ La conexión con Microsoft no está configurada en el servidor todavía. Avisá al administrador.';

// Actions that read the mailbox and therefore require a live connection. They
// gate on a valid access token first and reply with a reconnect prompt if there
// isn't one. `connect` and `help` are intentionally not here.
const MAILBOX_ACTIONS = new Set(['summary', 'xray', 'recommendations', 'setup_categories', 'refresh']);

function buildHelpMessage() {
    const lines = ACTION_CATALOG.map((a) => `• ${a.menu}`).join('\n');
    return (
        '📬 *Asistente de email* — esto es lo que puedo hacer (todo de solo lectura, no toco nada de tu casilla):\n\n' +
        lines +
        '\n\nEscribime siempre empezando con *email* seguido de lo que querés. Por ejemplo: *email dame un resumen*.'
    );
}

function buildDisambiguationMessage(options) {
    const lines = options.map((id, i) => {
        const entry = ACTION_CATALOG.find((a) => a.id === id);
        return `${i + 1}. ${entry.menu}`;
    });
    return (
        '🤔 No me quedó claro qué necesitás. Respondé con el número de una opción:\n\n' +
        lines.join('\n')
    );
}

// Level-1 claim check. Returns whether this agent owns the message and, if so,
// the free-text remainder after the prefix. The prefix must be a standalone
// leading token so words like "emails" don't route here by accident.
export function matchPrefix(userText) {
    const trimmed = (userText ?? '').trimStart();
    const lower = trimmed.toLowerCase();
    if (lower === EMAIL_PREFIX) {
        return { matched: true, remainder: '' };
    }
    if (lower.startsWith(EMAIL_PREFIX) && /\s/.test(trimmed.charAt(EMAIL_PREFIX.length))) {
        return { matched: true, remainder: trimmed.slice(EMAIL_PREFIX.length).trim() };
    }
    return { matched: false, remainder: '' };
}

// Runs a resolved action. `help` and `connect` are implemented; `xray` and
// `refresh` are implemented here (ticket 05). The remaining mailbox actions
// (summary → 07, recommendations → 08, setup_categories → 06) load the mailbox
// data the same way and answer "coming soon" until their ticket lands.
async function runEmailAction(action, ctx) {
    const { whatsapp, userPhone } = ctx;

    if (action === 'help') {
        await whatsapp.sendMessage(userPhone, buildHelpMessage());
        return;
    }

    if (action === 'connect') {
        await handleConnect(ctx);
        return;
    }

    if (MAILBOX_ACTIONS.has(action)) {
        // `email refresh` bypasses the ~2h cache; everything else serves it.
        const data = await loadMailbox(ctx, { forceRefresh: action === 'refresh' });
        if (data === null) return; // reconnect / misconfig prompt already sent

        switch (action) {
            case 'xray':
                await whatsapp.sendMessage(userPhone, formatXrayReport(data));
                return;
            case 'refresh':
                await whatsapp.sendMessage(userPhone, buildRefreshMessage(data));
                return;
            case 'setup_categories':
                await handleSetupCategories(data, ctx);
                return;
            case 'summary':
                await handleSummary(data, ctx);
                return;
            default:
                // recommendations — ticket 08.
                await whatsapp.sendMessage(userPhone, COMING_SOON_MESSAGE);
                return;
        }
    }

    // Defensive default (the classifier's enum shouldn't produce anything else).
    await whatsapp.sendMessage(userPhone, COMING_SOON_MESSAGE);
}

// Replies with the Microsoft consent URL so the user can grant read-only access.
async function handleConnect(ctx) {
    const { whatsapp, userPhone, emailServices } = ctx;
    if (!emailServices?.buildConsentUrl) {
        await whatsapp.sendMessage(userPhone, CONNECT_UNAVAILABLE_MESSAGE);
        return;
    }
    const url = emailServices.buildConsentUrl();
    await whatsapp.sendMessage(
        userPhone,
        '🔗 Para conectar tu casilla de Microsoft (solo lectura), abrí este link e iniciá sesión:\n\n' +
            url +
            '\n\nCuando termines, volvé y pedime lo que quieras.'
    );
}

// Loads the (cached or fresh) mailbox metadata for a mailbox action, returning
// the data or null. On null it has already sent the right prompt (reconnect, or
// a server-misconfig notice), so the caller just returns.
async function loadMailbox(ctx, { forceRefresh = false } = {}) {
    const { supabase, whatsapp, userPhone, emailServices } = ctx;
    if (!emailServices?.getMailboxData) {
        await whatsapp.sendMessage(userPhone, CONNECT_UNAVAILABLE_MESSAGE);
        return null;
    }
    try {
        return await emailServices.getMailboxData(supabase, userPhone, { forceRefresh });
    } catch (error) {
        if (error instanceof NotConnectedError) {
            await whatsapp.sendMessage(userPhone, RECONNECT_MESSAGE);
            return null;
        }
        throw error;
    }
}

function buildRefreshMessage(data) {
    const count = data.messages?.length ?? 0;
    return (
        `🔄 Listo, actualicé los datos de tu casilla. Tenés *${count}* correos sin leer.\n` +
        'Pedime *email radiografía* para ver a dónde va tu correo, o *email resumen* para agruparlos por categoría.'
    );
}

// Proposes a taxonomy from the mailbox and asks for a one-time confirmation via
// the pending-question mechanism. Nothing is stored until the user confirms.
async function handleSetupCategories(data, ctx) {
    const { supabase, whatsapp, userPhone, deps = {} } = ctx;
    const { savePending = savePendingReal } = deps;

    const proposed = proposeTaxonomy({ folders: data.folders, rules: data.rules });
    await savePending(supabase, {
        phone: userPhone,
        domain: EMAIL_DOMAIN,
        payload: { type: 'taxonomy_confirmation', proposed },
        reason: 'taxonomy_confirmation',
    });
    await whatsapp.sendMessage(userPhone, buildTaxonomyProposalMessage(proposed));
}

const NEEDS_TAXONOMY_MESSAGE =
    '🗂️ Antes de armarte un resumen necesito tus categorías. Escribí *email configurar categorías* y confirmalas una vez; después te agrupo la bandeja por categoría.';

// The semantic "who / what": unread count over the Inbox specifically, senders
// grouped into the CONFIRMED taxonomy via the LLM (sender-level, metadata only),
// with an "appears to need action" highlight. Reuses the ~2h-cached metadata, so
// follow-up questions are cheap. Requires a confirmed taxonomy first.
async function handleSummary(data, ctx) {
    const { ai, whatsapp, userPhone, supabase, model, emailServices, deps = {} } = ctx;
    const { classifySenders = classifySendersReal } = deps;

    const taxonomy = emailServices?.getTaxonomy ? await emailServices.getTaxonomy(supabase, userPhone) : null;
    if (!taxonomy || taxonomy.length === 0) {
        await whatsapp.sendMessage(userPhone, NEEDS_TAXONOMY_MESSAGE);
        return;
    }

    // Inbox contents specifically — the mail the user actually sees.
    const inboxId = data.inbox?.id;
    const inboxMessages = (data.messages ?? []).filter((m) => m.parentFolderId === inboxId);

    const senders = collectSenders(inboxMessages);
    const assignments = await classifySenders(ai, { senders, categories: taxonomy }, model);

    await whatsapp.sendMessage(
        userPhone,
        formatSummaryReport({ messages: inboxMessages, taxonomy, assignments })
    );
}

function buildTaxonomyProposalMessage(categories) {
    const list = categories.map((c) => `• ${c}`).join('\n');
    return (
        '🗂️ Armé estas categorías a partir de tus carpetas y reglas actuales:\n\n' +
        list +
        '\n\n¿Las guardo así? Respondé *sí* para confirmarlas, o *no* para descartarlas. ' +
        '(Podés reconstruirlas cuando quieras con *email reconstruir categorías*.)'
    );
}

// Fresh prefixed message: length cap → classify → run, or ask to disambiguate.
export async function handleMessage(ctx) {
    const { ai, whatsapp, userPhone, remainder, model, supabase, deps = {} } = ctx;
    const {
        classifyEmailIntent = classifyEmailIntentReal,
        savePending = savePendingReal,
    } = deps;

    if (remainder.length > MAX_REQUEST_CHARS) {
        await whatsapp.sendMessage(userPhone, TOO_LONG_MESSAGE);
        return;
    }

    const action = await classifyEmailIntent(ai, remainder, model);

    if (action === 'unclear') {
        // Don't guess: save a numbered menu as a pending question (email domain)
        // and let the user's next bare reply resolve it.
        const options = ACTION_CATALOG.map((a) => a.id);
        await savePending(supabase, {
            phone: userPhone,
            domain: EMAIL_DOMAIN,
            payload: { type: 'disambiguation', options },
            reason: 'email_disambiguation',
        });
        await whatsapp.sendMessage(userPhone, buildDisambiguationMessage(options));
        return;
    }

    await runEmailAction(action, ctx);
}

// Reply to a pending question the email agent asked. Currently the only kind is
// disambiguation: a bare number selects one of the menu options and runs it. An
// unparseable answer re-asks without clearing the question. (Ticket 06 adds a
// taxonomy-confirmation kind here.)
export async function handlePendingReply(ctx) {
    const { supabase, whatsapp, userPhone, userText, pending, deps = {} } = ctx;
    const { deletePending = deletePendingReal } = deps;

    const payload = pending.payload ?? {};

    if (payload.type === 'disambiguation') {
        const choice = parseMenuChoice(userText, payload.options.length);
        if (choice === null) {
            await whatsapp.sendMessage(userPhone, DISAMBIGUATION_UNRESOLVED_MESSAGE);
            return;
        }
        const action = payload.options[choice - 1];
        await deletePending(supabase, userPhone);
        await runEmailAction(action, ctx);
        return;
    }

    if (payload.type === 'taxonomy_confirmation') {
        await handleTaxonomyConfirmation(payload, ctx);
        return;
    }

    // Unknown pending kind (shouldn't happen): clear it and re-offer help.
    await deletePending(supabase, userPhone);
    await whatsapp.sendMessage(userPhone, buildHelpMessage());
}

// Resolves the one-time taxonomy confirmation (a yes/no reply). On "sí" the
// proposed taxonomy is persisted (with the standing "Other"); on "no" it's
// discarded; an ambiguous answer re-asks without losing the proposal.
async function handleTaxonomyConfirmation(payload, ctx) {
    const { supabase, whatsapp, userPhone, userText, emailServices, deps = {} } = ctx;
    const { deletePending = deletePendingReal } = deps;

    const decision = parseResponse(userText);

    if (decision === 'ambiguous') {
        await whatsapp.sendMessage(
            userPhone,
            '🤔 No te entendí. Respondé *sí* para guardar esas categorías, o *no* para descartarlas.'
        );
        return;
    }

    if (decision === 'no') {
        await deletePending(supabase, userPhone);
        await whatsapp.sendMessage(
            userPhone,
            '👍 Listo, no guardo esas categorías. Cuando quieras, pedime *email configurar categorías* de nuevo.'
        );
        return;
    }

    // decision === 'yes'
    if (!emailServices?.saveTaxonomy) {
        await whatsapp.sendMessage(userPhone, CONNECT_UNAVAILABLE_MESSAGE);
        return;
    }
    const saved = await emailServices.saveTaxonomy(supabase, userPhone, payload.proposed);
    await deletePending(supabase, userPhone);
    await whatsapp.sendMessage(
        userPhone,
        `✅ Guardé tus ${saved.length} categorías. Ya las voy a usar cuando te arme un *resumen* de la bandeja.`
    );
}

// Parses a 1-based menu choice from a bare reply ("2", "el 2", "opción 3").
// Returns the number within [1, max], or null if there's no valid choice.
function parseMenuChoice(userText, max) {
    const match = (userText ?? '').match(/\d+/);
    if (!match) return null;
    const n = Number(match[0]);
    if (!Number.isInteger(n) || n < 1 || n > max) return null;
    return n;
}

export const emailAgent = {
    domain: EMAIL_DOMAIN,
    matchPrefix,
    handleMessage,
    handlePendingReply,
};
