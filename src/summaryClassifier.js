import { z } from 'zod';
import { STANDING_OTHER } from './taxonomyBuilder.js';

// Classifies each *sender* of the Inbox's unread mail into one of the confirmed
// taxonomy categories, using the LLM. Only metadata is ever sent — the sender's
// name/address and the subjects of their mail — NEVER message bodies. Output is
// validated: any category the model returns that isn't in the confirmed
// taxonomy is coerced to the standing "Other/Uncategorized" bucket, so nothing
// is ever silently forced into a wrong (or invented) category.

const assignmentsSchema = z.object({
    assignments: z.array(z.object({ sender: z.string(), category: z.string() })),
});

// The prompt stays in Spanish (classifies mail for Spanish-speaking users).
export function buildSummaryPrompt(senders, categories) {
    const categoryList = categories.map((c) => `- ${c}`).join('\n');
    const senderList = senders
        .map((s, i) => {
            const subjects = (s.subjects ?? []).slice(0, 5).join(' | ');
            const who = [s.name, s.address].filter(Boolean).join(' ');
            return `${i + 1}. ${who}${subjects ? ` — asuntos: ${subjects}` : ''}`;
        })
        .join('\n');

    return `Sos un clasificador de remitentes de correo. Clasificá CADA remitente en UNA de estas categorías (y solo estas):
${categoryList}

Si un remitente no encaja claramente en ninguna, usá "${STANDING_OTHER}".
Clasificá por el remitente y el asunto — NO tenés el cuerpo de los correos.

Remitentes:
${senderList}

Respondé ÚNICAMENTE con este JSON exacto:
{"assignments": [{"sender": "<dirección de correo del remitente>", "category": "<una categoría de la lista>"}]}`;
}

// Returns an array of { sender (address), category }. On any failure — network,
// malformed output — it returns [] so the summary still renders (everything
// falls back to "Other"). Never throws.
export async function classifySenders(ai, { senders, categories }, model) {
    if (!senders?.length) return [];
    const allowed = new Set(categories.map((c) => c.toLowerCase()));

    let raw;
    try {
        const completion = await ai.chat.completions.create({
            messages: [{ role: 'user', content: buildSummaryPrompt(senders, categories) }],
            model,
            response_format: { type: 'json_object' },
            temperature: 0,
        });
        raw = JSON.parse(completion.choices[0].message.content);
    } catch (error) {
        console.warn('⚠️ Sender classification failed; everything falls back to Other:', error?.message);
        return [];
    }

    const parsed = assignmentsSchema.safeParse(raw);
    if (!parsed.success) {
        console.warn('⚠️ Sender classification returned an unexpected shape; falling back to Other.');
        return [];
    }

    // Coerce any out-of-taxonomy category to the standing Other bucket.
    return parsed.data.assignments.map(({ sender, category }) => ({
        sender,
        category: allowed.has(category?.toLowerCase()) ? category : STANDING_OTHER,
    }));
}
