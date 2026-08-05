import test from 'node:test';
import assert from 'node:assert/strict';
import { emailAgent } from '../src/emailAgent.js';
import { NotConnectedError } from '../src/microsoftAuth.js';

const DEFAULT_MAILBOX = {
    messages: [
        { parentFolderId: 'inbox-id', from: { name: 'A', address: 'a@x.com' }, subject: 's1', isRead: false, hasAttachments: false, receivedDateTime: '2026-08-01T10:00:00Z' },
        { parentFolderId: 'linkedin-id', from: { name: 'LinkedIn', address: 'jobs@linkedin.com' }, subject: 's2', isRead: false, hasAttachments: false, receivedDateTime: '2026-08-01T11:00:00Z' },
        { parentFolderId: 'linkedin-id', from: { name: 'LinkedIn', address: 'news@linkedin.com' }, subject: 's3', isRead: false, hasAttachments: false, receivedDateTime: '2026-08-01T12:00:00Z' },
    ],
    folders: [
        { id: 'inbox-id', displayName: 'Bandeja de entrada' },
        { id: 'linkedin-id', displayName: 'LinkedIn' },
    ],
    inbox: { id: 'inbox-id', displayName: 'Bandeja de entrada' },
    rules: [
        { displayName: 'LinkedIn', isEnabled: true, sequence: 1, conditions: { senderContains: ['linkedin.com'] }, actions: { moveToFolder: 'linkedin-id' } },
    ],
    fromCache: true,
};

// A fake email-services bundle. `connected: true` serves mailbox data;
// `connected: false` makes getMailboxData/getAccessToken throw
// NotConnectedError, exercising the reconnect path. `savedTaxonomies` records
// persisted taxonomies.
function fakeEmailServices({ connected = true, mailbox = DEFAULT_MAILBOX, taxonomy = null } = {}) {
    const savedTaxonomies = [];
    return {
        savedTaxonomies,
        buildConsentUrl: () => 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=abc',
        getAccessToken: async () => {
            if (!connected) throw new NotConnectedError();
            return 'access-token-123';
        },
        getMailboxData: async (_s, _p, { forceRefresh = false } = {}) => {
            if (!connected) throw new NotConnectedError();
            return { ...mailbox, fromCache: !forceRefresh };
        },
        getTaxonomy: async () => taxonomy,
        saveTaxonomy: async (_s, _p, categories) => {
            savedTaxonomies.push(categories);
            return categories;
        },
    };
}

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

function makeDeps({ action = 'unclear', pending = new Map(), assignments = [] } = {}) {
    const saved = [];
    return {
        saved,
        pending,
        deps: {
            classifyEmailIntent: async () => action,
            classifySenders: async () => assignments,
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

function handle({ deps, remainder, emailServices = fakeEmailServices() }) {
    const whatsapp = createFakeWhatsapp();
    return emailAgent
        .handleMessage({ ai: {}, supabase: {}, whatsapp, userPhone: PHONE, remainder, model: 'm', emailServices, deps })
        .then(() => whatsapp);
}

function reply({ deps, pending, userText, emailServices = fakeEmailServices() }) {
    const whatsapp = createFakeWhatsapp();
    return emailAgent
        .handlePendingReply({ supabase: {}, whatsapp, userPhone: PHONE, userText, pending, emailServices, deps })
        .then(() => whatsapp);
}

test('help action → replies with the functionality list (implemented end to end)', async () => {
    const env = makeDeps({ action: 'help' });
    const whatsapp = await handle({ deps: env.deps, remainder: '¿qué podés hacer?' });

    assert.match(whatsapp.last(), /Asistente de email/);
    assert.match(whatsapp.last(), /Resumen de tu bandeja/);
    assert.equal(env.saved.length, 0, 'help does not create a pending question');
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

test('a bare number reply resolves a mailbox action and runs it', async () => {
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

    assert.match(whatsapp.last(), /Radiografía/, 'resolved to xray and ran it');
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

test('connect action → replies with a Microsoft consent URL (no token required)', async () => {
    const env = makeDeps({ action: 'connect' });
    const whatsapp = await handle({ deps: env.deps, remainder: 'conectá mi cuenta' });

    assert.match(whatsapp.last(), /login\.microsoftonline\.com/);
    assert.match(whatsapp.last(), /authorize/);
});

test('a mailbox action with no connection → reconnect prompt, no "coming soon"', async () => {
    const env = makeDeps({ action: 'xray' });
    const whatsapp = await handle({
        deps: env.deps,
        remainder: 'a dónde va mi correo',
        emailServices: fakeEmailServices({ connected: false }),
    });

    assert.match(whatsapp.last(), /conectaste tu casilla|conexión venció/);
    assert.doesNotMatch(whatsapp.last(), /construcción/, 'must not proceed to the action when not connected');
});

test('xray action WITH a connection → deterministic report (unread count, folders, rules)', async () => {
    const env = makeDeps({ action: 'xray' });
    const whatsapp = await handle({
        deps: env.deps,
        remainder: 'a dónde va mi correo',
        emailServices: fakeEmailServices({ connected: true }),
    });

    const text = whatsapp.last();
    assert.match(text, /Radiografía/);
    assert.match(text, /sin leer: \*3\*/, 'unread count');
    assert.match(text, /LinkedIn: 2/, 'folder breakdown');
    assert.match(text, /Bandeja de entrada: 1/, 'unrouted inbox mail counted under Inbox');
    assert.match(text, /\*LinkedIn\*/, 'rule listed');
});

test('refresh action forces a fresh pull and confirms the unread count', async () => {
    const env = makeDeps({ action: 'refresh' });
    let sawForceRefresh = false;
    const services = fakeEmailServices({ connected: true });
    const wrapped = {
        ...services,
        getMailboxData: async (s, p, opts) => {
            sawForceRefresh = opts?.forceRefresh === true;
            return services.getMailboxData(s, p, opts);
        },
    };
    const whatsapp = await handle({ deps: env.deps, remainder: 'actualizá', emailServices: wrapped });

    assert.ok(sawForceRefresh, 'refresh must bypass the cache');
    assert.match(whatsapp.last(), /actualicé/);
    assert.match(whatsapp.last(), /\*3\*/);
});

test('setup_categories proposes a taxonomy from folders+rules and asks to confirm (nothing stored yet)', async () => {
    const services = fakeEmailServices({ connected: true });
    const env = makeDeps({ action: 'setup_categories' });
    const whatsapp = await handle({ deps: env.deps, remainder: 'armá mis categorías', emailServices: services });

    assert.equal(env.saved.length, 1, 'a pending confirmation was saved');
    assert.equal(env.saved[0].domain, 'email');
    assert.equal(env.saved[0].payload.type, 'taxonomy_confirmation');
    // "Bandeja de entrada" (system) is excluded; "LinkedIn" (folder + rule) kept once.
    assert.deepEqual(env.saved[0].payload.proposed, ['LinkedIn', 'Otros / Sin clasificar']);
    assert.equal(services.savedTaxonomies.length, 0, 'nothing persisted before confirmation');
    assert.match(whatsapp.last(), /LinkedIn/);
});

test('confirming the taxonomy ("sí") persists it (with standing Other) and clears the question', async () => {
    const proposed = ['Software', 'Salud', 'Otros / Sin clasificar'];
    const pending = new Map([
        [PHONE, { telefono: PHONE, payload: { type: 'taxonomy_confirmation', proposed }, motivo: 'taxonomy_confirmation', dominio: 'email' }],
    ]);
    const env = makeDeps({ pending });
    const services = fakeEmailServices();
    const whatsapp = await reply({ deps: env.deps, pending: pending.get(PHONE), userText: 'sí, dale', emailServices: services });

    assert.equal(services.savedTaxonomies.length, 1);
    assert.deepEqual(services.savedTaxonomies[0], proposed);
    assert.ok(!pending.has(PHONE), 'confirmation cleared');
    assert.match(whatsapp.last(), /Guardé/);
});

test('rejecting the taxonomy ("no") stores nothing and clears the question', async () => {
    const pending = new Map([
        [PHONE, { telefono: PHONE, payload: { type: 'taxonomy_confirmation', proposed: ['X', 'Otros / Sin clasificar'] }, motivo: 'taxonomy_confirmation', dominio: 'email' }],
    ]);
    const env = makeDeps({ pending });
    const services = fakeEmailServices();
    const whatsapp = await reply({ deps: env.deps, pending: pending.get(PHONE), userText: 'no', emailServices: services });

    assert.equal(services.savedTaxonomies.length, 0);
    assert.ok(!pending.has(PHONE));
    assert.match(whatsapp.last(), /no guardo/);
});

test('an ambiguous answer to the taxonomy confirmation re-asks and keeps it pending', async () => {
    const pending = new Map([
        [PHONE, { telefono: PHONE, payload: { type: 'taxonomy_confirmation', proposed: ['X', 'Otros / Sin clasificar'] }, motivo: 'taxonomy_confirmation', dominio: 'email' }],
    ]);
    const env = makeDeps({ pending });
    const services = fakeEmailServices();
    const whatsapp = await reply({ deps: env.deps, pending: pending.get(PHONE), userText: 'mmm no sé', emailServices: services });

    assert.equal(services.savedTaxonomies.length, 0);
    assert.ok(pending.has(PHONE), 'stays pending until a clear yes/no');
    assert.match(whatsapp.last(), /sí.*no|guardar/i);
});

test('summary without a confirmed taxonomy → prompts to configure categories first', async () => {
    const env = makeDeps({ action: 'summary' });
    const services = fakeEmailServices({ connected: true, taxonomy: null });
    const whatsapp = await handle({ deps: env.deps, remainder: 'dame un resumen', emailServices: services });

    assert.match(whatsapp.last(), /configurar categorías/);
});

test('summary groups Inbox senders into the confirmed taxonomy (metadata only)', async () => {
    const mailbox = {
        messages: [
            { parentFolderId: 'inbox-id', from: { name: 'GitHub', address: 'noreply@github.com' }, subject: 'PR', isRead: false, hasAttachments: false },
            { parentFolderId: 'inbox-id', from: { name: 'ANV', address: 'anv@gub.uy' }, subject: 'Trámite', isRead: false, hasAttachments: true },
            // This one is in another folder, so it must NOT count in the summary.
            { parentFolderId: 'linkedin-id', from: { name: 'LinkedIn', address: 'x@linkedin.com' }, subject: 'Jobs', isRead: false, hasAttachments: false },
        ],
        folders: [{ id: 'inbox-id', displayName: 'Bandeja de entrada' }, { id: 'linkedin-id', displayName: 'LinkedIn' }],
        inbox: { id: 'inbox-id', displayName: 'Bandeja de entrada' },
        rules: [],
    };
    const taxonomy = ['Software', 'Gobierno', 'Otros / Sin clasificar'];
    const assignments = [
        { sender: 'noreply@github.com', category: 'Software' },
        { sender: 'anv@gub.uy', category: 'Gobierno' },
    ];
    const env = makeDeps({ action: 'summary', assignments });
    const services = fakeEmailServices({ connected: true, taxonomy, mailbox });
    const whatsapp = await handle({ deps: env.deps, remainder: 'resumen', emailServices: services });

    const text = whatsapp.last();
    assert.match(text, /Sin leer en la bandeja: \*2\*/, 'Inbox-only count (LinkedIn folder excluded)');
    assert.match(text, /\*Software\*: 1/);
    assert.match(text, /\*Gobierno\*: 1/);
    assert.doesNotMatch(text, /LinkedIn/, 'mail already filed away is not in the Inbox summary');
    assert.match(text, /Parecen necesitar acción/);
    assert.match(text, /Trámite/, 'the attachment mail is flagged as needing action');
});

test('summary sends only sender metadata to the classifier (never bodies)', async () => {
    const mailbox = {
        messages: [{ parentFolderId: 'inbox-id', from: { name: 'A', address: 'a@x.com' }, subject: 'Hola', isRead: false }],
        folders: [{ id: 'inbox-id', displayName: 'Inbox' }],
        inbox: { id: 'inbox-id', displayName: 'Inbox' },
        rules: [],
    };
    let received;
    const env = {
        saved: [],
        pending: new Map(),
        deps: {
            classifyEmailIntent: async () => 'summary',
            classifySenders: async (_ai, arg) => {
                received = arg;
                return [{ sender: 'a@x.com', category: 'Otros / Sin clasificar' }];
            },
        },
    };
    const services = fakeEmailServices({ connected: true, taxonomy: ['Otros / Sin clasificar'], mailbox });
    await handle({ deps: env.deps, remainder: 'resumen', emailServices: services });

    assert.deepEqual(received.senders[0], { address: 'a@x.com', name: 'A', subjects: ['Hola'] });
    assert.equal(JSON.stringify(received).includes('body'), false, 'no body field is ever passed');
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
