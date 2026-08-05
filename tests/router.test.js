import test from 'node:test';
import assert from 'node:assert/strict';
import { handleIncomingMessage } from '../src/messageHandler.js';

// Level-1 router tests: prefix present → email agent; absent/unknown → expense
// agent (unchanged); over-length → rejection; pending reply → routed to the
// agent that asked. Same fake-seams style as messageHandler.test.js: no
// Supabase, no network, no credentials.

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

function createFakeWhatsapp() {
    const messages = [];
    return {
        messages,
        async sendMessage(recipient, text) {
            messages.push({ recipient, text });
        },
    };
}

// A deps object that records whether the expense/LLM seams were touched, so we
// can assert an email message never falls through to the expense extractor.
function makeSpyDeps(state = {}, { extraction = { isExpense: false } } = {}) {
    const calls = { extractExpense: 0, savePayment: 0, savePending: 0 };
    const pending = state.pending ?? new Map();
    return {
        calls,
        pending,
        deps: {
            wasAlreadyProcessed: async () => false,
            getPending: async (_s, phone) => pending.get(phone) ?? null,
            extractExpense: async () => {
                calls.extractExpense += 1;
                return extraction;
            },
            findExactDuplicate: async () => null,
            savePayment: async () => {
                calls.savePayment += 1;
                return { duplicate: false };
            },
            savePending: async (_s, { phone, payload, reason, domain }) => {
                calls.savePending += 1;
                pending.set(phone, { telefono: phone, payload, motivo: reason, dominio: domain });
            },
            deletePending: async (_s, phone) => {
                pending.delete(phone);
            },
        },
    };
}

function invoke({ deps, text, messageId = 'm1' }) {
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

test('prefixed message → reaches the email agent (coming soon), never the expense extractor', async () => {
    const env = makeSpyDeps();
    const whatsapp = await invoke({ deps: env.deps, text: 'email dame un resumen' });

    assert.match(whatsapp.messages[0].text, /construcción/);
    assert.equal(env.calls.extractExpense, 0, 'an email request must not hit the expense LLM');
    assert.equal(env.calls.savePayment, 0);
});

test('email prefix is case-insensitive and tolerates leading whitespace', async () => {
    const env = makeSpyDeps();
    const whatsapp = await invoke({ deps: env.deps, text: '  EMAIL resumen' });
    assert.match(whatsapp.messages[0].text, /construcción/);
    assert.equal(env.calls.extractExpense, 0);
});

test('no prefix → expense agent, unchanged (extractor runs)', async () => {
    const env = makeSpyDeps({}, { extraction: { isExpense: true, data: baseData } });
    const whatsapp = await invoke({ deps: env.deps, text: 'Pagué 2000 de Antel' });

    assert.equal(env.calls.extractExpense, 1);
    assert.equal(env.calls.savePayment, 1);
    assert.match(whatsapp.messages[0].text, /Anotado/);
});

test('unknown/lookalike prefix ("emails …") → expense agent, not email', async () => {
    const env = makeSpyDeps({}, { extraction: { isExpense: false } });
    const whatsapp = await invoke({ deps: env.deps, text: 'emails viejos que tengo' });

    assert.equal(env.calls.extractExpense, 1, '"emails" is not the prefix — must go to expense');
    assert.doesNotMatch(whatsapp.messages[0].text, /construcción/);
});

test('over-length request (post-prefix > 1000 chars) → rejected, before any LLM call', async () => {
    const env = makeSpyDeps();
    const longBody = 'a'.repeat(1001);
    const whatsapp = await invoke({ deps: env.deps, text: `email ${longBody}` });

    assert.match(whatsapp.messages[0].text, /demasiado larga/);
    assert.equal(env.calls.extractExpense, 0, 'no LLM call on an over-length request');
});

test('a request exactly at the 1000-char cap is accepted (coming soon)', async () => {
    const env = makeSpyDeps();
    const whatsapp = await invoke({ deps: env.deps, text: `email ${'a'.repeat(1000)}` });
    assert.match(whatsapp.messages[0].text, /construcción/);
});

test('pending reply is routed to the email agent when the email domain asked', async () => {
    const pending = new Map([
        [PHONE, { telefono: PHONE, payload: {}, motivo: 'disambiguation', dominio: 'email' }],
    ]);
    const env = makeSpyDeps({ pending });
    const whatsapp = await invoke({ deps: env.deps, text: '2' });

    assert.match(whatsapp.messages[0].text, /construcción/, 'email agent handled the reply');
    assert.equal(env.calls.savePayment, 0, 'must not be treated as an expense confirmation');
});

test('pending reply with no/expense domain still goes to the expense agent', async () => {
    const pending = new Map([
        [PHONE, { telefono: PHONE, payload: { messageId: 'orig', data: baseData }, motivo: 'duplicate_same_date' }],
    ]);
    const env = makeSpyDeps({ pending });
    const whatsapp = await invoke({ deps: env.deps, text: 'sí, dale' });

    assert.equal(env.calls.savePayment, 1, 'expense agent inserted the waiting expense');
    assert.match(whatsapp.messages[0].text, /Anotado/);
});
