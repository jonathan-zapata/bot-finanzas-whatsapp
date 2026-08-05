import { extractExpense as extractExpenseReal } from './aiExtractor.js';
import {
    savePayment as savePaymentReal,
    findExactDuplicate as findExactDuplicateReal,
} from './paymentsRepo.js';
import {
    savePending as savePendingReal,
    deletePending as deletePendingReal,
} from './pendingConfirmationsRepo.js';
import { parseResponse } from './responseParser.js';

// The expense agent — the bot's original behavior, refactored to sit behind
// the Level-1 router as "just another agent". It's the default/fallback agent:
// any message without a recognized prefix lands here, so its behavior is
// unchanged from before the router existed and its tests stay green.
//
// It satisfies the shared contract `{ domain, handleMessage, handlePendingReply }`
// as plain functions with dependencies injected through `ctx.deps` (real
// implementations as defaults), so tests fake each seam with no network.

export const EXPENSE_DOMAIN = 'expense';

const WELCOME_MESSAGE =
    "¡Hola! 👋 Soy tu asistente financiero. Contame qué pagaste hoy (ej: 'Pagué 2000 de Antel en efectivo') y te lo anoto en tu registro.";
const LLM_ERROR_MESSAGE = 'Hubo un problema procesando tu mensaje. Probá de nuevo en un momento 🙏';
const SAVE_ERROR_MESSAGE = 'Hubo un error al guardar tu pago. Intentá de nuevo.';
const DIDNT_UNDERSTAND_MESSAGE =
    '🤔 No te entendí. Respondé *sí* para anotar el gasto igual, o *no* si es el mismo que ya tenías.';
const DISCARDED_MESSAGE = '👍 Listo, no lo anoto entonces.';

function formatConfirmation(data) {
    let message = `✅ ¡Anotado!\nGuardé un pago de *${data.monto} ${data.divisa}* para *${data.servicio}*.\n📂 Rubro: ${data.categoria}\n📅 Fecha: ${data.fecha_gasto}`;
    if (data.cuotas > 1) {
        message += `\n💳 Registrado en *${data.cuotas} cuotas*.`;
    }
    return message;
}

function duplicateQuestion(data, existing) {
    return `🤔 Ya tenés anotado un gasto de *${data.monto} ${data.divisa}* en *${data.servicio}* con fecha *${existing.fecha_gasto}*.\n¿Es un gasto nuevo? Respondé *sí* y lo anoto, o *no* si es el mismo de antes.`;
}

function recurringNotice(existing) {
    return `\n\nℹ️ Ojo: ya tenías un gasto igual del *${existing.fecha_gasto}*. Como este es de otra fecha lo anoté igual; si era repetido, avisame.`;
}

// Normal flow for a fresh (non-prefixed) message:
//   extract expense → detect exact duplicate →
//     - same date  → ASK (save pending, don't insert yet)
//     - other date → INSERT + notify (probably recurring)
//     - no match   → INSERT normally
export async function handleMessage(ctx) {
    const { supabase, ai, whatsapp, userPhone, messageId, userText, model, deps = {} } = ctx;
    const {
        extractExpense = extractExpenseReal,
        findExactDuplicate = findExactDuplicateReal,
        savePayment = savePaymentReal,
        savePending = savePendingReal,
    } = deps;

    let extraction;
    try {
        extraction = await extractExpense(ai, userText, model);
    } catch (error) {
        console.error('❌ Error querying the LLM:', error);
        await whatsapp.sendMessage(userPhone, LLM_ERROR_MESSAGE);
        return;
    }

    if (!extraction.isExpense) {
        await whatsapp.sendMessage(userPhone, WELCOME_MESSAGE);
        return;
    }

    const data = extraction.data;
    console.log('🧠 AI extracted:', data);

    // Is there an expense that matches exactly (phone + item + amount + currency)?
    let existing = null;
    try {
        existing = await findExactDuplicate(supabase, {
            phone: userPhone,
            servicio: data.servicio,
            monto: data.monto,
            divisa: data.divisa,
        });
    } catch (error) {
        console.error('❌ Error looking up duplicate (continuing and inserting):', error);
    }

    // Same date → suspected technical duplicate → ask, DON'T insert.
    if (existing && existing.fecha_gasto === data.fecha_gasto) {
        try {
            await savePending(supabase, {
                phone: userPhone,
                domain: EXPENSE_DOMAIN,
                payload: { messageId, data },
                reason: 'duplicate_same_date',
            });
        } catch (error) {
            console.error('❌ Error saving pending confirmation:', error);
            await whatsapp.sendMessage(userPhone, SAVE_ERROR_MESSAGE);
            return;
        }
        await whatsapp.sendMessage(userPhone, duplicateQuestion(data, existing));
        return;
    }

    // No match, or a different date (likely recurring) → insert.
    try {
        const { duplicate } = await savePayment(supabase, {
            phone: userPhone,
            messageId,
            data,
        });
        if (duplicate) {
            console.log(`Duplicate insert detected for ${messageId}; already saved.`);
            return;
        }
    } catch (error) {
        console.error('❌ Error saving to Supabase:', error);
        await whatsapp.sendMessage(userPhone, SAVE_ERROR_MESSAGE);
        return;
    }

    let message = formatConfirmation(data);
    if (existing) message += recurringNotice(existing);
    await whatsapp.sendMessage(userPhone, message);
}

// Interprets the user's reply to a pending duplicate question and acts on it.
export async function handlePendingReply(ctx) {
    const { supabase, whatsapp, userPhone, userText, pending, deps = {} } = ctx;
    const { savePayment = savePaymentReal, deletePending = deletePendingReal } = deps;

    const decision = parseResponse(userText);

    if (decision === 'ambiguous') {
        // We didn't understand: leave the pending confirmation intact and ask again.
        await whatsapp.sendMessage(userPhone, DIDNT_UNDERSTAND_MESSAGE);
        return;
    }

    if (decision === 'no') {
        await deletePending(supabase, userPhone);
        await whatsapp.sendMessage(userPhone, DISCARDED_MESSAGE);
        return;
    }

    // decision === 'yes' → insert the expense that was left waiting.
    const { messageId, data } = pending.payload;
    try {
        await savePayment(supabase, { phone: userPhone, messageId, data });
    } catch (error) {
        console.error('❌ Error saving the confirmed payment:', error);
        // We don't delete the pending confirmation: the user can retry by answering again.
        await whatsapp.sendMessage(userPhone, SAVE_ERROR_MESSAGE);
        return;
    }
    await deletePending(supabase, userPhone);
    await whatsapp.sendMessage(userPhone, formatConfirmation(data));
}

export const expenseAgent = {
    domain: EXPENSE_DOMAIN,
    handleMessage,
    handlePendingReply,
};
