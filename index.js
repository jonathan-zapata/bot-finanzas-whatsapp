import express from 'express';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { config } from './src/config.js';
import { crearClienteWhatsApp, verificarFirmaWebhook } from './src/whatsappClient.js';
import { manejarMensajeEntrante } from './src/messageHandler.js';

const app = express();
// Guardamos el body crudo (rawBody) porque la verificación de firma de Meta se
// calcula sobre los bytes exactos recibidos, no sobre el JSON re-serializado.
app.use(
    express.json({
        verify: (req, _res, buf) => {
            req.rawBody = buf;
        },
    })
);

const supabase = createClient(config.supabaseUrl, config.supabaseKey);
const ai = new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl });
const whatsapp = crearClienteWhatsApp({ token: config.whatsappToken, phoneNumberId: config.phoneNumberId });

// ==========================================
// RUTA 1: VERIFICACIÓN DE META
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
// RUTA 2: RECEPCIÓN DE MENSAJES
// ==========================================
app.post('/webhook', async (req, res) => {
    const firma = req.get('x-hub-signature-256');
    if (!verificarFirmaWebhook(config.whatsappAppSecret, req.rawBody, firma)) {
        console.warn('⚠️ Firma de webhook inválida — request rechazado.');
        res.sendStatus(401);
        return;
    }

    // Procesamos ANTES de responder: en un host serverless (Cloud Run, Vercel) el
    // CPU se corta o se throttlea apenas se manda la respuesta, así que cualquier
    // trabajo async después de un sendStatus(200) temprano puede quedar cortado a
    // mitad de camino. Esto además cierra un gap de confiabilidad que existía en
    // cualquier host: si el proceso se caía entre el ack y el guardado, Meta ya
    // pensaba que estaba procesado y no reintentaba — el gasto se perdía en silencio.
    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const message = changes?.value?.messages?.[0];

        if (!message || message.type !== 'text') {
            res.sendStatus(200);
            return;
        }

        const numeroUsuario = message.from;
        const messageId = message.id;
        const textoUsuario = message.text.body;

        console.log(`Mensaje recibido de ${numeroUsuario}: ${textoUsuario}`);

        await manejarMensajeEntrante({
            supabase,
            ai,
            whatsapp,
            numeroUsuario,
            messageId,
            textoUsuario,
            modelo: config.llmModel,
            ventanaConfirmacionMin: config.ventanaConfirmacionMin,
        });
        res.sendStatus(200);
    } catch (error) {
        console.error('Error procesando webhook:', error);
        // 500 en vez de 200: dejamos que Meta reintente la entrega. La idempotencia
        // por message_id hace que un reintento sea seguro (no duplica nada).
        res.sendStatus(500);
    }
});

app.listen(config.port, () => {
    console.log(`Servidor activo en puerto ${config.port}`);
});
