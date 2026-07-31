import crypto from 'node:crypto';

// ==========================================
// CLIENTE DE ENVÍO (LA VOZ DEL BOT)
// ==========================================
export function crearClienteWhatsApp({ token, phoneNumberId, fetchImpl = fetch }) {
    async function enviarMensaje(telefonoDestino, texto) {
        try {
            const respuesta = await fetchImpl(
                `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        messaging_product: 'whatsapp',
                        to: telefonoDestino,
                        type: 'text',
                        text: { body: texto },
                    }),
                }
            );

            const data = await respuesta.json();
            if (!respuesta.ok) {
                console.error('❌ Meta devolvió un error al enviar el mensaje:', JSON.stringify(data));
            } else {
                console.log('✅ Mensaje enviado a Meta:', JSON.stringify(data));
            }
            return data;
        } catch (error) {
            console.error('❌ Error enviando mensaje:', error);
            return null;
        }
    }

    return { enviarMensaje };
}

// ==========================================
// VERIFICACIÓN DE FIRMA (X-Hub-Signature-256)
// ==========================================
// Meta firma cada request con el App Secret. Sin esto, cualquiera que descubra
// la URL del webhook puede postear datos falsos como si vinieran de WhatsApp.
export function verificarFirmaWebhook(appSecret, rawBody, firmaHeader) {
    if (!firmaHeader || !firmaHeader.startsWith('sha256=') || !rawBody) return false;

    const firmaRecibida = firmaHeader.slice('sha256='.length);
    const firmaEsperada = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

    const bufRecibida = Buffer.from(firmaRecibida, 'hex');
    const bufEsperada = Buffer.from(firmaEsperada, 'hex');
    if (bufRecibida.length !== bufEsperada.length) return false;

    return crypto.timingSafeEqual(bufRecibida, bufEsperada);
}
