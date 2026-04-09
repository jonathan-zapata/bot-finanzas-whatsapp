import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

dotenv.config();

const app = express();
app.use(express.json());

// Variables de entorno (Las configuraremos en Railway)
const {
    PORT = 3000,
    WEBHOOK_VERIFY_TOKEN,
    LLM_API_KEY,
    LLM_BASE_URL,
    SUPABASE_URL,
    SUPABASE_KEY
} = process.env;

// Inicializamos clientes
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ai = new OpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL });

// ==========================================
// RUTA 1: VERIFICACIÓN DE META (Obligatoria)
// ==========================================
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
        console.log('Webhook verificado por Meta!');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// ==========================================
// RUTA 2: RECEPCIÓN DE MENSAJES (El Motor)
// ==========================================
app.post('/webhook', async (req, res) => {
    // 1. Responder a Meta INMEDIATAMENTE con 200 OK para evitar bloqueos
    res.sendStatus(200);

    try {
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const message = changes?.value?.messages?.[0];

        // Solo procesamos si es un mensaje de texto real
        if (!message || message.type !== 'text') return;

        const numeroUsuario = message.from;
        const textoUsuario = message.text.body;

        console.log(`Mensaje de ${numeroUsuario}: ${textoUsuario}`);

        // 2. Extraer datos con LLM (Rápido y barato)
        const prompt = `Extrae servicio y monto del texto: "${textoUsuario}". Responde SOLO un JSON con "servicio" (string) y "monto" (número).`;
        
        const chatCompletion = await ai.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama3-8b-8192', // Cambiar según el proveedor que elijas
            response_format: { type: "json_object" }
        });

        const datos = JSON.parse(chatCompletion.choices[0].message.content);

        // 3. Guardar en Supabase
        const { error } = await supabase.from('pagos').insert([
            { telefono: numeroUsuario, servicio: datos.servicio, monto: datos.monto }
        ]);

        if (error) console.error("Error en DB:", error);
        else console.log("Guardado exitoso:", datos);

        // Acá iría el POST a la API de WhatsApp para avisarte que se guardó.
        // Lo dejamos comentado hasta que configures tu Meta Developer App.

    } catch (error) {
        console.error('Error procesando webhook:', error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
});