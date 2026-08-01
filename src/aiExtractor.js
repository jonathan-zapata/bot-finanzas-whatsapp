import { z } from 'zod';

const CURRENCIES = ['USD', 'UYU'];
const PAYMENT_METHODS = ['credito', 'debito', 'efectivo'];
const CATEGORIES = ['Vivienda', 'Alimentación', 'Transporte', 'Servicios', 'Salud', 'Educación', 'Ocio', 'Otros'];

const normalize = (transform) => (v) => (typeof v === 'string' ? transform(v.trim()) : v);

// What we trust the LLM to return before touching the database. An LLM can
// hallucinate types or values outside the expected enums; this rejects those
// cases instead of inserting them as-is.
//
// Field names and enum values stay in Spanish on purpose: they mirror the
// `pagos` table columns and the exact JSON shape the prompt below asks the
// LLM for — changing them would mean a live schema migration, not just a
// code-style rename.
export const expenseSchema = z.object({
    servicio: z.string().trim().min(1),
    monto: z.coerce.number().positive(),
    divisa: z.preprocess(normalize((s) => s.toUpperCase()), z.enum(CURRENCIES)),
    metodo_pago: z.preprocess(normalize((s) => s.toLowerCase()), z.enum(PAYMENT_METHODS)),
    cuotas: z.coerce.number().int().positive().default(1),
    categoria: z.preprocess(normalize((s) => s), z.enum(CATEGORIES)),
    fecha_gasto: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid date format'),
});

function buildDateContext() {
    const today = new Date();
    const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    let context = `Hoy es ${dayNames[today.getDay()]} ${today.toISOString().split('T')[0]}.\nCalendario de referencia de los últimos 7 días:\n`;
    for (let i = 1; i <= 7; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);
        context += `- ${dayNames[date.getDay()]}: ${date.toISOString().split('T')[0]}\n`;
    }
    return context;
}

// The prompt itself stays in Spanish: it's sent straight to the LLM to parse
// messages from Spanish-speaking users, so translating it would change the
// bot's actual behavior, not just its code.
export function buildPrompt(userText, { dateContext = buildDateContext() } = {}) {
    return `Actúa como un asistente financiero en Uruguay.
${dateContext}
Analiza el siguiente mensaje: "${userText}".

Extrae los datos en este formato JSON exacto:
- servicio: nombre del gasto.
- monto: número.
- divisa: SOLO "USD" o "UYU".
- metodo_pago: SOLO "credito", "debito", o "efectivo".
- cuotas: número entero. Si no especifica, es 1.
- categoria: SOLO una de estas: [${CATEGORIES.join(', ')}].
- fecha_gasto: Formato YYYY-MM-DD. Usa el calendario de referencia provisto arriba para hacer coincidir días relativos (como "ayer", "el lunes", "el martes pasado") con su fecha exacta. Si no especifica fecha, usa la de Hoy.
- Si el mensaje NO describe un gasto (ej: un saludo o una pregunta), respondé con {}.

Responde ÚNICAMENTE con el objeto JSON.`;
}

// Calls the LLM and validates its output against expenseSchema. Never returns
// unvalidated data: if the message doesn't describe an expense, or the LLM
// gets the format wrong, isExpense comes back false and the caller decides
// how to respond.
export async function extractExpense(ai, userText, model = 'llama-3.1-8b-instant') {
    const prompt = buildPrompt(userText);
    const completion = await ai.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model,
        response_format: { type: 'json_object' },
    });

    const raw = JSON.parse(completion.choices[0].message.content);
    const parseResult = expenseSchema.safeParse(raw);
    if (!parseResult.success) {
        return { isExpense: false, errors: parseResult.error.issues };
    }
    return { isExpense: true, data: parseResult.data };
}
