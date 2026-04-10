import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

dotenv.config();

const app = express();
app.use(express.json());

// 1. Agregamos WHATSAPP_TOKEN y PHONE_NUMBER_ID a las variables
const {
    PORT = 3000,
    WEBHOOK_VERIFY_TOKEN,
    LLM_API_KEY,
    LLM_BASE_URL,
    SUPABASE_URL,
    SUPABASE_KEY,
    WHATSAPP_TOKEN,
    PHONE_NUMBER_ID
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ai = new OpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL });

// ==========================================
// FUNCIÓN PARA ENVIAR MENSAJES (LA VOZ)
// ==========================================
async function enviarMensajeWhatsApp(telefonoDestino, texto) {
    try {
        const respuesta = await fetch(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    messaging_product: 'whatsapp',
                    to: telefonoDestino,
                    type: 'text',
                    text: { body: texto }
                })
            }
        );

        const data = await respuesta.json();
        console.log("✅ Mensaje enviado a Meta:", JSON.stringify(data));
        return data;
    } catch (error) {
        console.error("❌ Error enviando mensaje:", error);
    }
}

// ==========================================
// RUTA 1: VERIFICACIÓN DE META
// ==========================================
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// ==========================================
// RUTA 2: RECEPCIÓN DE MENSAJES
// ==========================================
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // Responder rápido a Meta

    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const message = changes?.value?.messages?.[0];

        if (!message || message.type !== 'text') return;

        const numeroUsuario = message.from;
        const textoUsuario = message.text.body;

        console.log(`Mensaje recibido de ${numeroUsuario}: ${textoUsuario}`);

        // PRUEBA DE FUEGO: Le contestamos inmediatamente
        await enviarMensajeWhatsApp(numeroUsuario, `🤖 ¡Hola! Recibí tu mensaje: "${textoUsuario}". Los cables de envío funcionan perfecto.`);

        /* NOTA TÉCNICA:
        Comento temporalmente la IA y la DB para que la llave falsa de OpenAI 
        no rompa la prueba de envío de WhatsApp. Lo activaremos en el próximo paso.
        */
        
        // const prompt = `Extrae...`;
        // const chatCompletion = await ai.chat...
        // const datos = ...
        // await supabase.from('pagos').insert([...]);

    } catch (error) {
        console.error('Error procesando webhook:', error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
});