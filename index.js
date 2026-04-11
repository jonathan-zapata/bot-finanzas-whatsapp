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
// ==========================================
// RUTA 2: RECEPCIÓN DE MENSAJES Y GUARDADO EN BD
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

        // 1. EXTRAER DATOS CON IA (AHORA CON PLAN DE PAGOS)
        const prompt = `Actúa como un asistente financiero en Uruguay. Extrae servicio, monto, divisa, metodo_pago y cuotas del siguiente mensaje: "${textoUsuario}". 
                Reglas: 
                - Divisa: Si menciona dólares/usd usa "USD". Si menciona pesos/$ o no especifica, usa "UYU".
                - metodo_pago: Si menciona tarjeta de crédito, mastercard, visa o cuotas, usa "credito". Si menciona débito, usa "debito". Por defecto usa "efectivo".
                - cuotas: Número entero. Si dice "en 6 cuotas" es 6. Si no menciona cuotas, es 1.
                Responde ÚNICAMENTE con un objeto JSON válido con las claves: "servicio" (texto), "monto" (número), "divisa" (texto), "metodo_pago" (texto) y "cuotas" (número). Si no hay monto, pon 0.`;
                        
        const chatCompletion = await ai.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama-3.1-8b-instant',
            response_format: { type: "json_object" }
        });

        const datos = JSON.parse(chatCompletion.choices[0].message.content);
        console.log("🧠 IA extrajo:", datos);

        // 2. LÓGICA DE NEGOCIO Y PERSISTENCIA
        if (datos.monto > 0 && datos.servicio) {
            
            // Insertamos en Supabase (ahora con divisa)
            const { error } = await supabase
                .from('pagos')
                .insert([
                    { 
                        telefono: numeroUsuario, 
                        servicio: datos.servicio, 
                        monto: datos.monto,
                        divisa: datos.divisa,
                        metodo_pago: datos.metodo_pago, // <--- NUEVO
                        cuotas: datos.cuotas            // <--- NUEVO
                    }
                ]);

            if (error) {
                console.error("❌ Error guardando en Supabase:", error);
                await enviarMensajeWhatsApp(numeroUsuario, "Hubo un error al guardar tu pago. Intentá de nuevo.");
            } else {
                // Mensaje de confirmación dinámico
                let mensajeConfirmacion = `✅ ¡Anotado!\nGuardé un pago de *${datos.monto} ${datos.divisa}* para *${datos.servicio}*.`;

                if (datos.cuotas > 1) {
                    mensajeConfirmacion += `\n💳 Registrado en *${datos.cuotas} cuotas*.`;
                }
                await enviarMensajeWhatsApp(numeroUsuario, mensajeConfirmacion);
            }

        } else {
            // Si el monto es 0 o no hay servicio (Ej: Dijo "Hola")
            await enviarMensajeWhatsApp(numeroUsuario, "¡Hola! 👋 Soy tu asistente financiero. Contame qué pagaste hoy (ej: 'Pagué 2000 de Antel') y te lo anoto en tu registro.");
        }

    } catch (error) {
        console.error('Error procesando webhook:', error);
    }
});

app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
});