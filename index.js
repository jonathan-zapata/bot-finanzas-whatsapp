import express from 'express';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { config } from './src/config.js';
import { createWhatsAppClient, verifyWebhookSignature } from './src/whatsappClient.js';
import { handleIncomingMessage } from './src/messageHandler.js';
import { createSecretManager } from './src/secretManager.js';
import { createEmailServices } from './src/emailServices.js';

const app = express();
// We keep the raw body (rawBody) because Meta's signature verification is
// computed over the exact bytes received, not over the re-serialized JSON.
app.use(
    express.json({
        verify: (req, _res, buf) => {
            req.rawBody = buf;
        },
    })
);

const supabase = createClient(config.supabaseUrl, config.supabaseKey);
const ai = new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl });
const whatsapp = createWhatsAppClient({ token: config.whatsappToken, phoneNumberId: config.phoneNumberId });

// Email-agent services. The refresh token lives in Secret Manager (runtime
// read/write because it rotates); the auth service is built even when Microsoft
// isn't configured yet — it only reaches for Secret Manager when an email
// request actually needs the mailbox.
const secretManager = createSecretManager({ projectId: config.gcpProjectId });
const emailServices = createEmailServices({ config: config.microsoft, secretManager });

// ==========================================
// ROUTE 1: META VERIFICATION
// ==========================================
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.webhookVerifyToken) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// ==========================================
// ROUTE 3: MICROSOFT OAUTH CALLBACK
// ==========================================
// Mirrors the Meta webhook-verification route: a simple GET the identity
// provider redirects to. Microsoft sends back an authorization `code`; we
// exchange it for tokens and store the refresh token in Secret Manager. Nothing
// here can write to the mailbox — only read scopes were consented.
app.get('/oauth/microsoft/callback', async (req, res) => {
    const { code, error, error_description: errorDescription } = req.query;
    if (error) {
        console.warn('⚠️ Microsoft OAuth returned an error:', error, errorDescription);
        res.status(400).send(`No se pudo conectar: ${errorDescription || error}`);
        return;
    }
    if (!code) {
        res.status(400).send('Falta el parámetro "code".');
        return;
    }
    try {
        await emailServices.handleCallback(code);
        res.status(200).send('✅ ¡Casilla conectada! Ya podés volver a WhatsApp y pedirme lo que quieras.');
    } catch (err) {
        console.error('❌ Error handling Microsoft OAuth callback:', err);
        res.status(500).send('Hubo un error conectando tu casilla. Probá de nuevo.');
    }
});

// ==========================================
// ROUTE 2: MESSAGE RECEPTION
// ==========================================
app.post('/webhook', async (req, res) => {
    const signature = req.get('x-hub-signature-256');
    if (!verifyWebhookSignature(config.whatsappAppSecret, req.rawBody, signature)) {
        console.warn('⚠️ Invalid webhook signature — request rejected.');
        res.sendStatus(401);
        return;
    }

    // We process BEFORE responding: on a serverless host (Cloud Run, Vercel)
    // the CPU is cut or throttled as soon as the response is sent, so any
    // async work after an early sendStatus(200) can get cut off mid-flight.
    // This also closes a reliability gap that existed on any host: if the
    // process crashed between the ack and the save, Meta would already think
    // it was processed and wouldn't retry — the expense would be silently lost.
    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const message = changes?.value?.messages?.[0];

        if (!message || message.type !== 'text') {
            res.sendStatus(200);
            return;
        }

        const userPhone = message.from;
        const messageId = message.id;
        const userText = message.text.body;

        console.log(`Message received from ${userPhone}: ${userText}`);

        await handleIncomingMessage({
            supabase,
            ai,
            whatsapp,
            userPhone,
            messageId,
            userText,
            model: config.llmModel,
            confirmationWindowMinutes: config.confirmationWindowMinutes,
            emailServices,
        });
        res.sendStatus(200);
    } catch (error) {
        console.error('Error processing webhook:', error);
        // 500 instead of 200: we let Meta retry delivery. Idempotency by
        // message_id makes a retry safe (it won't duplicate anything).
        res.sendStatus(500);
    }
});

app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
});
