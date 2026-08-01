import crypto from 'node:crypto';

// ==========================================
// SENDING CLIENT (THE BOT'S VOICE)
// ==========================================
export function createWhatsAppClient({ token, phoneNumberId, fetchImpl = fetch }) {
    async function sendMessage(recipientPhone, text) {
        try {
            const response = await fetchImpl(
                `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        messaging_product: 'whatsapp',
                        to: recipientPhone,
                        type: 'text',
                        text: { body: text },
                    }),
                }
            );

            const data = await response.json();
            if (!response.ok) {
                console.error('❌ Meta returned an error sending the message:', JSON.stringify(data));
            } else {
                console.log('✅ Message sent to Meta:', JSON.stringify(data));
            }
            return data;
        } catch (error) {
            console.error('❌ Error sending message:', error);
            return null;
        }
    }

    return { sendMessage };
}

// ==========================================
// SIGNATURE VERIFICATION (X-Hub-Signature-256)
// ==========================================
// Meta signs every request with the App Secret. Without this, anyone who
// discovers the webhook URL could post fake data pretending it came from WhatsApp.
export function verifyWebhookSignature(appSecret, rawBody, signatureHeader) {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=') || !rawBody) return false;

    const receivedSignature = signatureHeader.slice('sha256='.length);
    const expectedSignature = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

    const receivedBuffer = Buffer.from(receivedSignature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    if (receivedBuffer.length !== expectedBuffer.length) return false;

    return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}
