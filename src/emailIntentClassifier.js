import { z } from 'zod';

// Level-2 task classifier for the email agent. It maps the free-text remainder
// of a prefixed message ("email dame un resumen") into one action from a
// closed set. This mirrors the expense extractor's discipline: the LLM's output
// is strictly validated against a Zod schema and anything outside the closed
// enum is discarded to `unclear` rather than trusted — the agent never guesses
// its way into running the wrong analysis.

// The closed action enum. `unclear` is the explicit "I couldn't decide" outcome
// that triggers disambiguation; every real action lives alongside it.
export const EMAIL_ACTIONS = [
    'summary',
    'xray',
    'recommendations',
    'setup_categories',
    'refresh',
    'connect',
    'costs',
    'help',
    'unclear',
];

const intentSchema = z.object({
    action: z.enum(EMAIL_ACTIONS),
});

// The prompt stays in Spanish — it classifies requests from Spanish-speaking
// users, so it's part of the bot's behavior, not just code.
export function buildIntentPrompt(userText) {
    return `Sos el clasificador de intenciones de un asistente de email por WhatsApp.
El usuario escribió: "${userText}".

Elegí UNA sola acción de esta lista cerrada según lo que pide:
- "summary": quiere un resumen de su bandeja de entrada / quién le escribió / qué llegó.
- "xray": quiere ver a dónde va su correo, sus carpetas o qué hacen sus reglas/filtros.
- "recommendations": quiere sugerencias para reorganizar carpetas o revisar reglas.
- "setup_categories": quiere configurar, armar o reconstruir sus categorías.
- "refresh": quiere actualizar / recargar los datos (traer correo nuevo).
- "connect": quiere conectar, vincular o dar acceso a su cuenta de Microsoft/Outlook/Hotmail.
- "costs": quiere saber el costo, gasto o consumo de la API / de los agentes / cuánto se lleva gastado.
- "help": pregunta qué podés hacer, pide ayuda o la lista de funciones.
- "unclear": no está claro cuál de las acciones anteriores quiere, o pide algo fuera de esta lista.

Respondé ÚNICAMENTE con un objeto JSON de esta forma exacta: {"action": "<una de las opciones>"}.`;
}

// Calls the LLM and validates its output. Never returns an out-of-enum value:
// malformed JSON, a missing field, or an action outside the closed set all
// collapse to `unclear`, which the agent turns into a disambiguation question.
export async function classifyEmailIntent(ai, userText, model) {
    let raw;
    try {
        const completion = await ai.chat.completions.create({
            messages: [{ role: 'user', content: buildIntentPrompt(userText) }],
            model,
            // Attribution for the usage/cost ledger (email agent's domain).
            // Stripped by the client wrapper before the request is sent.
            _agentTag: 'email',
            response_format: { type: 'json_object' },
            // Classification, not creative writing: greedy decoding for stable,
            // reproducible routing (same rationale as the expense extractor).
            temperature: 0,
        });
        raw = JSON.parse(completion.choices[0].message.content);
    } catch (error) {
        // A network error, a non-JSON response, or a malformed payload are all
        // indistinguishable from "couldn't classify" at this layer.
        console.warn('⚠️ Email intent classification failed, falling back to unclear:', error?.message);
        return 'unclear';
    }

    const parsed = intentSchema.safeParse(raw);
    if (!parsed.success) {
        console.warn('⚠️ LLM returned an out-of-enum email action, discarding to unclear:', JSON.stringify(raw));
        return 'unclear';
    }
    return parsed.data.action;
}
