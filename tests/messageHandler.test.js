import test from 'node:test';
import assert from 'node:assert/strict';
import { handleIncomingMessage } from '../src/messageHandler.js';

// In-memory state + faked deps: we test the handler's state machine without
// simulating Supabase or the network (dependency injection, the fakeable seam).
function createEnvironment({ initialPayments = [], pending = {}, processed = [] } = {}) {
    const state = {
        payments: [...initialPayments],
        pending: new Map(Object.entries(pending)),
        processed: new Set(processed),
    };
    return state;
}

function makeDeps(state, { extraction, llmError = false } = {}) {
    return {
        wasProcessed: async (_s, messageId) => state.processed.has(messageId),
        markProcessed: async (_s, messageId) => state.processed.add(messageId),
        extractExpense: async () => {
            if (llmError) throw new Error('timeout');
            return extraction;
        },
        findExactDuplicate: async (_s, { phone, servicio, monto, divisa }) => {
            const matches = state.payments.filter(
                (p) => p.telefono === phone && p.servicio === servicio && p.monto === monto && p.divisa === divisa
            );
            return matches.length ? matches[matches.length - 1] : null;
        },
        savePayment: async (_s, { phone, messageId, data }) => {
            if (state.payments.some((p) => p.message_id === messageId)) return { duplicate: true };
            state.payments.push({ telefono: phone, message_id: messageId, ...data });
            return { duplicate: false };
        },
        getPending: async (_s, phone) => state.pending.get(phone) || null,
        savePending: async (_s, { phone, payload, reason }) => {
            state.pending.set(phone, { telefono: phone, payload, motivo: reason, created_at: new Date().toISOString() });
        },
        deletePending: async (_s, phone) => {
            state.pending.delete(phone);
        },
    };
}

function createFakeWhatsapp() {
    const messages = [];
    return {
        messages,
        async sendMessage(recipient, text) {
            messages.push({ recipient, text });
        },
    };
}

const PHONE = '59891111111';
const baseData = {
    servicio: 'Antel',
    monto: 2000,
    divisa: 'UYU',
    metodo_pago: 'efectivo',
    cuotas: 1,
    categoria: 'Servicios',
    fecha_gasto: '2026-08-01',
};

function invoke(state, deps, { messageId = 'msg-new', text = 'Pagué 2000 de Antel' } = {}) {
    const whatsapp = createFakeWhatsapp();
    return handleIncomingMessage({
        supabase: {},
        ai: {},
        whatsapp,
        userPhone: PHONE,
        messageId,
        userText: text,
        deps,
    }).then(() => whatsapp);
}

test('idempotency: ignores an already-processed message_id without writing or replying', async () => {
    const state = createEnvironment({ processed: ['msg-repeated'] });
    const deps = makeDeps(state, { extraction: { isExpense: true, data: baseData } });
    const whatsapp = await invoke(state, deps, { messageId: 'msg-repeated' });

    assert.equal(state.payments.length, 0);
    assert.equal(whatsapp.messages.length, 0);
});

test('message that is not an expense → replies with welcome', async () => {
    const state = createEnvironment();
    const deps = makeDeps(state, { extraction: { isExpense: false } });
    const whatsapp = await invoke(state, deps, { text: 'Hola' });

    assert.equal(state.payments.length, 0);
    assert.match(whatsapp.messages[0].text, /asistente financiero/);
});

test('expense without duplicate → saves and confirms', async () => {
    const state = createEnvironment();
    const deps = makeDeps(state, { extraction: { isExpense: true, data: baseData } });
    const whatsapp = await invoke(state, deps);

    assert.equal(state.payments.length, 1);
    assert.match(whatsapp.messages[0].text, /Anotado/);
});

test('duplicate same date → does NOT save, leaves it pending and asks', async () => {
    const state = createEnvironment({
        initialPayments: [{ telefono: PHONE, message_id: 'seed', ...baseData }],
    });
    const deps = makeDeps(state, { extraction: { isExpense: true, data: baseData } });
    const whatsapp = await invoke(state, deps, { messageId: 'msg-new' });

    assert.equal(state.payments.length, 1, 'must not insert the duplicate');
    assert.ok(state.pending.has(PHONE), 'must leave a pending confirmation');
    assert.match(whatsapp.messages[0].text, /Ya tenés anotado/);
});

test('duplicate on a different date → saves anyway and notifies (probably recurring)', async () => {
    const previous = { telefono: PHONE, message_id: 'seed', ...baseData, fecha_gasto: '2026-07-01' };
    const state = createEnvironment({ initialPayments: [previous] });
    const deps = makeDeps(state, { extraction: { isExpense: true, data: baseData } });
    const whatsapp = await invoke(state, deps, { messageId: 'msg-new' });

    assert.equal(state.payments.length, 2, 'must insert the new expense');
    assert.match(whatsapp.messages[0].text, /Anotado/);
    assert.match(whatsapp.messages[0].text, /ya tenías un gasto igual/);
});

test('"yes" reply to a pending confirmation → inserts the saved expense and confirms', async () => {
    const state = createEnvironment({
        pending: {
            [PHONE]: {
                telefono: PHONE,
                payload: { messageId: 'orig', data: baseData },
                motivo: 'duplicate_same_date',
                created_at: new Date().toISOString(),
            },
        },
    });
    const deps = makeDeps(state, {});
    const whatsapp = await invoke(state, deps, { messageId: 'reply-yes', text: 'sí, dale' });

    assert.equal(state.payments.length, 1);
    assert.equal(state.payments[0].message_id, 'orig');
    assert.ok(!state.pending.has(PHONE), 'the pending confirmation must be cleared');
    assert.match(whatsapp.messages[0].text, /Anotado/);
});

test('"no" reply to a pending confirmation → discards without saving', async () => {
    const state = createEnvironment({
        pending: {
            [PHONE]: {
                telefono: PHONE,
                payload: { messageId: 'orig', data: baseData },
                motivo: 'duplicate_same_date',
                created_at: new Date().toISOString(),
            },
        },
    });
    const deps = makeDeps(state, {});
    const whatsapp = await invoke(state, deps, { messageId: 'reply-no', text: 'no, es el mismo' });

    assert.equal(state.payments.length, 0);
    assert.ok(!state.pending.has(PHONE));
    assert.match(whatsapp.messages[0].text, /no lo anoto/);
});

test('ambiguous reply to a pending confirmation → asks again and keeps it pending', async () => {
    const state = createEnvironment({
        pending: {
            [PHONE]: {
                telefono: PHONE,
                payload: { messageId: 'orig', data: baseData },
                motivo: 'duplicate_same_date',
                created_at: new Date().toISOString(),
            },
        },
    });
    const deps = makeDeps(state, {});
    const whatsapp = await invoke(state, deps, { messageId: 'reply-eh', text: 'ni idea' });

    assert.equal(state.payments.length, 0);
    assert.ok(state.pending.has(PHONE), 'the pending confirmation must still be alive');
    assert.match(whatsapp.messages[0].text, /No te entendí/);
});

test('LLM error → notifies the user instead of failing silently', async () => {
    const state = createEnvironment();
    const deps = makeDeps(state, { llmError: true });
    const whatsapp = await invoke(state, deps);

    assert.equal(state.payments.length, 0);
    assert.match(whatsapp.messages[0].text, /problema procesando/);
});
