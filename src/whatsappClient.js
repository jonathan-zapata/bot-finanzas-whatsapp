import crypto from 'node:crypto';

// WhatsApp rejects any text message whose body exceeds 4096 characters (Meta
// error code 100: "Param text.body must be at most 4096 characters long"), and
// when it does the user receives NOTHING — the send just fails. Long replies
// (e.g. the category-taxonomy proposal) hit this. We split under a margin below
// the hard cap, and never fan out past MAX_CHUNKS so a pathologically long
// message can't turn into an unbounded burst of sends.
export const WHATSAPP_MAX_CHARS = 4096;
const CHUNK_LIMIT = 4000;
const MAX_CHUNKS = 10;
const TRUNCATION_NOTICE = '\n…(mensaje recortado)';

// Splits `text` into WhatsApp-sized pieces, preferring line boundaries so we
// don't cut mid-line unless a single line is itself longer than the limit.
export function splitForWhatsApp(text, { limit = CHUNK_LIMIT, maxChunks = MAX_CHUNKS } = {}) {
    const str = typeof text === 'string' ? text : String(text ?? '');
    if (str.length <= limit) return [str];

    const chunks = [];
    let current = '';
    const flush = () => {
        if (current.length) {
            chunks.push(current);
            current = '';
        }
    };

    for (let line of str.split('\n')) {
        // A single line longer than the limit has no line boundary to break on,
        // so hard-split it into limit-sized slices.
        while (line.length > limit) {
            flush();
            chunks.push(line.slice(0, limit));
            line = line.slice(limit);
        }
        const candidate = current.length ? `${current}\n${line}` : line;
        if (candidate.length > limit) {
            flush();
            current = line;
        } else {
            current = candidate;
        }
    }
    flush();

    if (chunks.length > maxChunks) {
        const kept = chunks.slice(0, maxChunks);
        const last = kept[maxChunks - 1];
        kept[maxChunks - 1] =
            last.length + TRUNCATION_NOTICE.length <= limit
                ? last + TRUNCATION_NOTICE
                : last.slice(0, limit - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
        return kept;
    }
    return chunks;
}

// ==========================================
// SENDING CLIENT (THE BOT'S VOICE)
// ==========================================
export function createWhatsAppClient({ token, phoneNumberId, fetchImpl = fetch }) {
    async function sendChunk(recipientPhone, body) {
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
                    text: { body },
                }),
            }
        );

        const data = await response.json();
        if (!response.ok) {
            console.error('❌ Meta returned an error sending the message:', JSON.stringify(data));
        } else {
            console.log('✅ Message sent to Meta:', JSON.stringify(data));
        }
        return { ok: response.ok, data };
    }

    async function sendMessage(recipientPhone, text) {
        try {
            const chunks = splitForWhatsApp(text);
            let last = null;
            for (const chunk of chunks) {
                const { ok, data } = await sendChunk(recipientPhone, chunk);
                last = data;
                // Stop the burst on the first rejection so a bad send doesn't
                // spam the user with the remaining pieces.
                if (!ok) break;
            }
            return last;
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
