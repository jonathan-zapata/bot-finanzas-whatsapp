// Interpreta la respuesta del usuario a una pregunta de confirmación (sí/no).
//
// Keyword matching a propósito: barato, predecible y sin latencia. Si no logra
// decidir, devuelve 'ambiguo' y el handler vuelve a preguntar en vez de adivinar.
// El día que moleste, se reemplaza por una clasificación con el LLM en este único
// lugar, sin tocar el resto del flujo.

function normalizar(texto) {
    return texto
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // saca acentos: "sí" -> "si"
        .replace(/[^a-z0-9\s]/g, ' ') // saca puntuación: "no, son distintos" -> "no  son..."
        .replace(/\s+/g, ' ')
        .trim();
}

const AFIRMATIVAS = new Set([
    'si', 'sip', 'sipi', 'dale', 'ok', 'oka', 'okay', 'obvio', 'claro',
    'confirmo', 'yes', 'agregalo', 'agregala', 'agrega', 'anotalo', 'anota',
]);

const NEGATIVAS = new Set(['no', 'nop', 'nel', 'nah', 'negativo']);

const FRASES_NEGATIVAS = [
    'son lo mismo', 'es lo mismo', 'el mismo', 'la misma', 'ya lo tenia',
    'ya esta', 'esta repetido', 'es repetido', 'es duplicado', 'duplicado',
    'repetido',
];

// Devuelve 'si' | 'no' | 'ambiguo'.
export function interpretarRespuesta(texto) {
    const t = normalizar(texto);
    const primeraPalabra = t.split(' ')[0];

    if (NEGATIVAS.has(primeraPalabra)) return 'no';
    if (FRASES_NEGATIVAS.some((frase) => t.includes(frase))) return 'no';
    if (AFIRMATIVAS.has(primeraPalabra)) return 'si';
    return 'ambiguo';
}
