import test from 'node:test';
import assert from 'node:assert/strict';
import { handleIncomingMessage } from '../src/messageHandler.js';

// Level-1 router tests: prefix present → email agent; absent/unknown → expense
// agent (unchanged); over-length → rejection; pending reply → routed to the
// agent that asked. These assert on *which seam fired* (expense extractor vs.
// email classifier) rather than exact copy, so they stay stable as the agents'
// wording evolves. Same fake-seams style as messageHandler.test.js.

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

// Records which agent's seams were touched. `emailAction` is what the fake
// email classifier returns; `expenseExtraction` is what the fake expense
// extractor returns.
function makeSpyDeps(state = {}, { emailAction = 'help', expenseExtraction = { isExpense: false } } = {}) {
    const calls = { extractExpense: 0, classifyEmailIntent: 0, savePayment: 0, markProcessed: 0 };
    const pending = state.pending ?? new Map();
    const processed = state.processed ?? new Set();
    return {
        calls,
        pending,
        processed,
        deps: {
            wasProcessed: async (_s, messageId) => processed.has(messageId),
            markProcessed: async (_s, messageId) => {
                calls.markProcessed += 1;
                processed.add(messageId);
            },
            getPending: async (_s, phone) => pending.get(phone) ?? null,
            // Expense seams
            extractExpense: async () => {
                calls.extractExpense += 1;
                return expenseExtraction;
            },
            findExactDuplicate: async () => null,
            savePayment: async () => {
                calls.savePayment += 1;
                return { duplicate: false };
            },
            // Email seams
            classifyEmailIntent: async () => {
                calls.classifyEmailIntent += 1;
                return emailAction;
            },
            // Shared pending store
            savePending: async (_s, { phone, payload, reason, domain }) => {
                pending.set(phone, { phone, payload, reason, domain });
            },
            deletePending: async (_s, phone) => {
                pending.delete(phone);
            },
        },
    };
}

// Connected fake so email mailbox actions (e.g. resolving a menu choice to
// xray) proceed instead of prompting to reconnect.
const connectedEmailServices = {
    buildConsentUrl: () => 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
    getAccessToken: async () => 'access-token',
    getMailboxData: async () => ({
        messages: [{ parentFolderId: 'inbox-id', from: { name: 'A', address: 'a@x.com' } }],
        folders: [{ id: 'inbox-id', displayName: 'Bandeja de entrada' }],
        inbox: { id: 'inbox-id', displayName: 'Bandeja de entrada' },
        rules: [],
        fromCache: true,
    }),
};

function invoke({ deps, text, messageId = 'm1' }) {
    const whatsapp = createFakeWhatsapp();
    return handleIncomingMessage({
        supabase: {},
        ai: {},
        whatsapp,
        userPhone: PHONE,
        messageId,
        userText: text,
        emailServices: connectedEmailServices,
        deps,
    }).then(() => whatsapp);
}

test('prefixed message → email agent classifier fires, expense extractor does not', async () => {
    const env = makeSpyDeps();
    const whatsapp = await invoke({ deps: env.deps, text: 'email dame un resumen' });

    assert.equal(env.calls.classifyEmailIntent, 1);
    assert.equal(env.calls.extractExpense, 0, 'an email request must never hit the expense LLM');
    assert.ok(whatsapp.messages.length >= 1);
    assert.equal(env.calls.markProcessed, 1, 'the handled message is recorded for idempotency');
});

test('idempotency covers email messages: a retried email message_id is a no-op', async () => {
    const env = makeSpyDeps({ processed: new Set(['dup-email']) });
    const whatsapp = await invoke({ deps: env.deps, text: 'email dame un resumen', messageId: 'dup-email' });

    assert.equal(env.calls.classifyEmailIntent, 0, 'a retry must not re-run the email action');
    assert.equal(whatsapp.messages.length, 0, 'a retry must not re-send a reply');
});

test('email prefix is case-insensitive and tolerates leading whitespace', async () => {
    const env = makeSpyDeps();
    await invoke({ deps: env.deps, text: '  EMAIL resumen' });
    assert.equal(env.calls.classifyEmailIntent, 1);
    assert.equal(env.calls.extractExpense, 0);
});

test('no prefix → expense agent, unchanged (extractor runs, classifier does not)', async () => {
    const env = makeSpyDeps({}, { expenseExtraction: { isExpense: true, data: baseData } });
    const whatsapp = await invoke({ deps: env.deps, text: 'Pagué 2000 de Antel' });

    assert.equal(env.calls.extractExpense, 1);
    assert.equal(env.calls.classifyEmailIntent, 0);
    assert.equal(env.calls.savePayment, 1);
    assert.match(whatsapp.messages[0].text, /Anotado/);
});

test('unknown/lookalike prefix ("emails …") → expense agent, not email', async () => {
    const env = makeSpyDeps({}, { expenseExtraction: { isExpense: false } });
    await invoke({ deps: env.deps, text: 'emails viejos que tengo' });

    assert.equal(env.calls.extractExpense, 1, '"emails" is not the prefix — must go to expense');
    assert.equal(env.calls.classifyEmailIntent, 0);
});

test('over-length request (post-prefix > 1000 chars) → rejected before any LLM call', async () => {
    const env = makeSpyDeps();
    const whatsapp = await invoke({ deps: env.deps, text: `email ${'a'.repeat(1001)}` });

    assert.match(whatsapp.messages[0].text, /demasiado larga/);
    assert.equal(env.calls.classifyEmailIntent, 0, 'no classifier call on an over-length request');
    assert.equal(env.calls.extractExpense, 0);
});

test('a request exactly at the 1000-char cap is accepted (classifier runs)', async () => {
    const env = makeSpyDeps();
    await invoke({ deps: env.deps, text: `email ${'a'.repeat(1000)}` });
    assert.equal(env.calls.classifyEmailIntent, 1);
});

test('pending reply is routed to the email agent when the email domain asked', async () => {
    const pending = new Map([
        [
            PHONE,
            {
                phone: PHONE,
                payload: { type: 'disambiguation', options: ['summary', 'xray'] },
                reason: 'email_disambiguation',
                domain: 'email',
            },
        ],
    ]);
    const env = makeSpyDeps({ pending });
    const whatsapp = await invoke({ deps: env.deps, text: '2' });

    assert.equal(env.calls.savePayment, 0, 'must not be treated as an expense confirmation');
    assert.ok(whatsapp.messages.length >= 1, 'email agent produced a reply');
    assert.ok(!pending.has(PHONE), 'resolved choice cleared the pending question');
});

test('pending reply with no/expense domain still goes to the expense agent', async () => {
    const pending = new Map([
        [PHONE, { phone: PHONE, payload: { messageId: 'orig', data: baseData }, reason: 'duplicate_same_date' }],
    ]);
    const env = makeSpyDeps({ pending });
    const whatsapp = await invoke({ deps: env.deps, text: 'sí, dale' });

    assert.equal(env.calls.savePayment, 1, 'expense agent inserted the waiting expense');
    assert.match(whatsapp.messages[0].text, /Anotado/);
});
