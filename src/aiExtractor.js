import { z } from 'zod';

const DIVISAS = ['USD', 'UYU'];
const METODOS_PAGO = ['credito', 'debito', 'efectivo'];
const CATEGORIAS = ['Vivienda', 'Alimentación', 'Transporte', 'Servicios', 'Salud', 'Educación', 'Ocio', 'Otros'];

const normalizar = (transform) => (v) => (typeof v === 'string' ? transform(v.trim()) : v);

// Lo que confiamos que el LLM devuelva antes de tocar la base de datos. Un LLM
// puede alucinar tipos o valores fuera de los enums esperados; esto rechaza esos
// casos en vez de insertarlos tal cual.
export const gastoSchema = z.object({
    servicio: z.string().trim().min(1),
    monto: z.coerce.number().positive(),
    divisa: z.preprocess(normalizar((s) => s.toUpperCase()), z.enum(DIVISAS)),
    metodo_pago: z.preprocess(normalizar((s) => s.toLowerCase()), z.enum(METODOS_PAGO)),
    cuotas: z.coerce.number().int().positive().default(1),
    categoria: z.preprocess(normalizar((s) => s), z.enum(CATEGORIAS)),
    fecha_gasto: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato de fecha inválido'),
});

function construirContextoFechas() {
    const hoy = new Date();
    const diasSemana = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    let contexto = `Hoy es ${diasSemana[hoy.getDay()]} ${hoy.toISOString().split('T')[0]}.\nCalendario de referencia de los últimos 7 días:\n`;
    for (let i = 1; i <= 7; i++) {
        const fecha = new Date(hoy);
        fecha.setDate(hoy.getDate() - i);
        contexto += `- ${diasSemana[fecha.getDay()]}: ${fecha.toISOString().split('T')[0]}\n`;
    }
    return contexto;
}

export function construirPrompt(textoUsuario, { contextoFechas = construirContextoFechas() } = {}) {
    return `Actúa como un asistente financiero en Uruguay.
${contextoFechas}
Analiza el siguiente mensaje: "${textoUsuario}".

Extrae los datos en este formato JSON exacto:
- servicio: nombre del gasto.
- monto: número.
- divisa: SOLO "USD" o "UYU".
- metodo_pago: SOLO "credito", "debito", o "efectivo".
- cuotas: número entero. Si no especifica, es 1.
- categoria: SOLO una de estas: [${CATEGORIAS.join(', ')}].
- fecha_gasto: Formato YYYY-MM-DD. Usa el calendario de referencia provisto arriba para hacer coincidir días relativos (como "ayer", "el lunes", "el martes pasado") con su fecha exacta. Si no especifica fecha, usa la de Hoy.
- Si el mensaje NO describe un gasto (ej: un saludo o una pregunta), respondé con {}.

Responde ÚNICAMENTE con el objeto JSON.`;
}

// Llama al LLM y valida su salida contra gastoSchema. Nunca devuelve datos sin
// validar: si el mensaje no describe un gasto, o el LLM se equivoca de formato,
// esGasto viene en false y el caller decide qué responder.
export async function extraerGasto(ai, textoUsuario, modelo = 'llama-3.1-8b-instant') {
    const prompt = construirPrompt(textoUsuario);
    const completion = await ai.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: modelo,
        response_format: { type: 'json_object' },
    });

    const crudo = JSON.parse(completion.choices[0].message.content);
    const resultado = gastoSchema.safeParse(crudo);
    if (!resultado.success) {
        return { esGasto: false, errores: resultado.error.issues };
    }
    return { esGasto: true, datos: resultado.data };
}
