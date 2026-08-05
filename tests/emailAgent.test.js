import test from 'node:test';
import assert from 'node:assert/strict';
import { emailAgent } from '../src/emailAgent.js';

// Drives the email agent's entry points directly with faked seams (classifier,
// pending store, WhatsApp), asserting on the outbound reply and persisted
// pending state — external behavior, not internal call sequencing.

const PHONE = '59899999999';

function createFakeWhatsapp() {
    const messages = [];
    return {
        messages,
        last: () => messages[messages.length - 1]?.text ?? '',
        async sendMessage(recipient, text) {
            messages.push({ recipient, text });
        },
    };
}

function makeDeps({ action = 'unclear', pending = new Map() } = {}) {
    const saved = [];
    return {
        saved,
        pending,
        deps: {
            classifyEmailIntent: async () => action,
            savePending: async (_s, entry) => {
                saved.push(entry);
                pending.set(entry.phone, {
                    telefono: entry.phone,
                    payload: entry.payload,
                    motivo: entry.reason,
                    dominio: entry.domain,
                });
            },
            deletePending: async (_s, phone) => pending.delete(phone),
        },
    };
}

function handle({ deps, remainder }) {
    const whatsapp = createFakeWhatsapp();
    return emailAgent
        .handleMessage({ ai: {}, supabase: {}, whatsapp, userPhone: PHONE, remainder, model: 'm', deps })
        .then(() => whatsapp);
}

function reply({ deps, pending, userText }) {
    const whatsapp = createFakeWhatsapp();
    return emailAgent
        .handlePendingReply({ supabase: {}, whatsapp, userPhone: PHONE, userText, pending, deps })
        .then(() => whatsapp);
}

test('help action → replies with the functionality list (implemented end to end)', async () => {
    const env = makeDeps({ action: 'help' });
    const whatsapp = await handle({ deps: env.deps, remainder: '¿qué podés hacer?' });

    assert.match(whatsapp.last(), /Asistente de email/);
    assert.match(whatsapp.last(), /Resumen de tu bandeja/);
    assert.equal(env.saved.length, 0, 'help does not create a pending question');
});

test('a not-yet-built action classifies correctly and replies "coming soon"', async () => {
    const env = makeDeps({ action: 'summary' });
    const whatsapp = await handle({ deps: env.deps, remainder: 'dame un resumen' });

    assert.match(whatsapp.last(), /construcción/);
    assert.equal(env.saved.length, 0);
});

test('unclear → saves a numbered menu as a pending email question, runs no action', async () => {
    const env = makeDeps({ action: 'unclear' });
    const whatsapp = await handle({ deps: env.deps, remainder: 'no sé, hacé algo con mi correo' });

    assert.equal(env.saved.length, 1, 'exactly one pending question saved');
    const saved = env.saved[0];
    assert.equal(saved.domain, 'email');
    assert.equal(saved.payload.type, 'disambiguation');
    assert.ok(Array.isArray(saved.payload.options) && saved.payload.options.length > 0);
    assert.match(whatsapp.last(), /1\./, 'reply is a numbered menu');
    assert.doesNotMatch(whatsapp.last(), /construcción/, 'no action was run');
});

test('bare number reply to the menu resolves to that action and runs it', async () => {
    const pending = new Map([
        [
            PHONE,
            {
                telefono: PHONE,
                payload: { type: 'disambiguation', options: ['summary', 'xray', 'help'] },
                motivo: 'email_disambiguation',
                dominio: 'email',
            },
        ],
    ]);
    const env = makeDeps({ pending });
    // Option 3 = 'help' → the one action fully implemented, easy to assert on.
    const whatsapp = await reply({ deps: env.deps, pending: pending.get(PHONE), userText: '3' });

    assert.match(whatsapp.last(), /Asistente de email/, 'resolved to help and ran it');
    assert.ok(!pending.has(PHONE), 'pending question cleared after resolution');
});

test('a bare number reply resolves a coming-soon action too', async () => {
    const pending = new Map([
        [
            PHONE,
            {
                telefono: PHONE,
                payload: { type: 'disambiguation', options: ['summary', 'xray'] },
                motivo: 'email_disambiguation',
                dominio: 'email',
            },
        ],
    ]);
    const env = makeDeps({ pending });
    const whatsapp = await reply({ deps: env.deps, pending: pending.get(PHONE), userText: 'la 2' });

    assert.match(whatsapp.last(), /construcción/, 'resolved to xray (coming soon)');
    assert.ok(!pending.has(PHONE));
});

test('an unparseable menu reply re-asks and keeps the question pending', async () => {
    const pending = new Map([
        [
            PHONE,
            {
                telefono: PHONE,
                payload: { type: 'disambiguation', options: ['summary', 'xray'] },
                motivo: 'email_disambiguation',
                dominio: 'email',
            },
        ],
    ]);
    const env = makeDeps({ pending });
    const whatsapp = await reply({ deps: env.deps, pending: pending.get(PHONE), userText: 'ni idea' });

    assert.match(whatsapp.last(), /número/);
    assert.ok(pending.has(PHONE), 'question stays pending until answered with a valid number');
});

test('an out-of-range number re-asks (does not run a wrong action)', async () => {
    const pending = new Map([
        [
            PHONE,
            {
                telefono: PHONE,
                payload: { type: 'disambiguation', options: ['summary', 'xray'] },
                motivo: 'email_disambiguation',
                dominio: 'email',
            },
        ],
    ]);
    const env = makeDeps({ pending });
    const whatsapp = await reply({ deps: env.deps, pending: pending.get(PHONE), userText: '9' });

    assert.match(whatsapp.last(), /número/);
    assert.ok(pending.has(PHONE));
});
