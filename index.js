import express from 'express';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { config } from './src/config.js';
import { createWhatsAppClient, verifyWebhookSignature } from './src/whatsappClient.js';
import { handleIncomingMessage } from './src/messageHandler.js';

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
