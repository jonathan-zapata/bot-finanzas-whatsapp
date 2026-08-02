import { z } from 'zod';

const CURRENCIES = ['USD', 'UYU'];
const PAYMENT_METHODS = ['credito', 'debito', 'efectivo'];
const CATEGORIES = ['Vivienda', 'Alimentación', 'Transporte', 'Servicios', 'Salud', 'Educación', 'Ocio', 'Otros'];

const normalize = (transform) => (v) => (typeof v === 'string' ? transform(v.trim()) : v);

// Uruguayan users write amounts with a comma as the decimal separator (and
// sometimes a dot as the thousands separator, e.g. "2.813,31") — JS's Number()
// only understands a dot as decimal, so "2813,31" parses as NaN. The LLM
// doesn't reliably normalize this on its own (seen in production: it echoed
// the user's comma verbatim), so we normalize in code instead of trusting the
// model to always get it right.
function parseAmount(value) {
    if (typeof value !== 'string') return value; // let zod's own type check handle non-strings
    let s = value.trim();
    if (s.includes(',')) {
        s = s.replace(/\./g, '').replace(',', '.'); // "2.813,31" -> "2813.31"
    }
    const n = Number(s);
    return Number.isNaN(n) ? value : n; // if still unparsable, let zod reject the original value
}

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
    monto: z.preprocess(parseAmount, z.coerce.number().positive()),
    divisa: z.preprocess(normalize((s) => s.toUpperCase()), z.enum(CURRENCIES)),
    metodo_pago: z.preprocess(normalize((s) => s.toLowerCase()), z.enum(PAYMENT_METHODS)),
    cuotas: z.coerce.number().int().positive().default(1),
    categoria: z.preprocess(normalize((s) => s), z.enum(CATEGORIES)),
    fecha_gasto: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid date format'),
});

// This bot only serves Uruguay ("Actúa como un asistente financiero en
// Uruguay" below), so dates are computed in Uruguay's calendar, not the
// container's. Cloud Run containers run in UTC — using the container's local
// time here would put "today" a day ahead of Uruguay for the ~3 evening hours
// (21:00-23:59 local) after UTC has already crossed midnight but Uruguay
// hasn't. Intl.DateTimeFormat handles this correctly (Uruguay has been fixed
// at UTC-3 with no DST since 2015).
const TIMEZONE = 'America/Montevideo';
const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function isoDateInTimezone(date, timeZone = TIMEZONE) {
    // en-CA formats as YYYY-MM-DD directly, already in the target timezone.
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

function dayNameForIsoDate(isoDate) {
    // Parsed as UTC midnight: safe for a weekday lookup since the weekday of a
    // calendar date doesn't depend on time-of-day.
    return DAY_NAMES[new Date(`${isoDate}T00:00:00Z`).getUTCDay()];
}

function buildDateContext(now) {
    const todayIso = isoDateInTimezone(now);
    let context = `Hoy es ${dayNameForIsoDate(todayIso)} ${todayIso}.\nCalendario de referencia de los últimos 7 días:\n`;
    for (let i = 1; i <= 7; i++) {
        const pastIso = isoDateInTimezone(new Date(now.getTime() - i * 86_400_000));
        context += `- ${dayNameForIsoDate(pastIso)}: ${pastIso}\n`;
    }
    return { context, todayIso };
}

// The prompt itself stays in Spanish: it's sent straight to the LLM to parse
// messages from Spanish-speaking users, so translating it would change the
// bot's actual behavior, not just its code.
export function buildPrompt(userText, { today = new Date() } = {}) {
    const { context: dateContext, todayIso } = buildDateContext(today);
    return `Actúa como un asistente financiero en Uruguay.
${dateContext}
Analiza el siguiente mensaje: "${userText}".

Extrae los datos en este formato JSON exacto:
- servicio: nombre del gasto.
- monto: número usando punto como separador decimal (ej: 2813.31), nunca coma, aunque el usuario lo haya escrito con coma.
- divisa: SOLO "USD" o "UYU".
- metodo_pago: SOLO "credito", "debito", o "efectivo".
- cuotas: número entero. Si no especifica, es 1.
- categoria: SOLO una de estas: [${CATEGORIES.join(', ')}].
- fecha_gasto: Formato YYYY-MM-DD. Regla estricta: si el mensaje menciona explícitamente un día relativo ("ayer", "el lunes", "el martes pasado", etc.), usá el calendario de arriba para calcular esa fecha exacta. Si el mensaje NO menciona ningún día, fecha_gasto DEBE ser exactamente "${todayIso}" — no elijas ninguna otra fecha del calendario en ese caso.
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
