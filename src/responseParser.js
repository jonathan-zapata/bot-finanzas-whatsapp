// Interprets the user's answer to a confirmation question (yes/no).
//
// Keyword matching on purpose: cheap, predictable, and no latency. If it
// can't decide, it returns 'ambiguous' and the handler asks again instead of
// guessing. If this ever becomes a problem, it can be swapped for an
// LLM-based classification in this one spot, without touching the rest of
// the flow.
//
// The keyword lists below stay in Spanish: they must match what real
// Spanish-speaking users actually type.

function normalize(text) {
    return text
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // strips accents: "sí" -> "si"
        .replace(/[^a-z0-9\s]/g, ' ') // strips punctuation: "no, son distintos" -> "no  son..."
        .replace(/\s+/g, ' ')
        .trim();
}

const AFFIRMATIVE = new Set([
    'si', 'sip', 'sipi', 'dale', 'ok', 'oka', 'okay', 'obvio', 'claro',
    'confirmo', 'yes', 'agregalo', 'agregala', 'agrega', 'anotalo', 'anota',
]);

const NEGATIVE = new Set(['no', 'nop', 'nel', 'nah', 'negativo']);

const NEGATIVE_PHRASES = [
    'son lo mismo', 'es lo mismo', 'el mismo', 'la misma', 'ya lo tenia',
    'ya esta', 'esta repetido', 'es repetido', 'es duplicado', 'duplicado',
    'repetido',
];

// Returns 'yes' | 'no' | 'ambiguous'.
export function parseResponse(text) {
    const normalized = normalize(text);
    const firstWord = normalized.split(' ')[0];

    if (NEGATIVE.has(firstWord)) return 'no';
    if (NEGATIVE_PHRASES.some((phrase) => normalized.includes(phrase))) return 'no';
    if (AFFIRMATIVE.has(firstWord)) return 'yes';
    return 'ambiguous';
}
