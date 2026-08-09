// Groq (and OpenAI-compatible) token pricing, in USD per 1,000,000 tokens.
// Turns a completion's `usage` into a stored dollar cost at write time, so the
// figure saved in `uso_llm` stays stable even if Groq changes its rates later.
//
// Prices verified Aug 2026 from Groq's pricing page, keyed by the exact model
// id sent in LLM_MODEL. An unknown model resolves to ZERO cost (never NaN, never
// throws) so a missing entry can only ever UNDER-report — it can't inflate a
// cost report — and it warns once so the gap gets noticed and the price added.

// input / output = USD per 1,000,000 tokens.
export const PRICING = {
    'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
    'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
};

const warned = new Set();

// The per-1M price pair for a model, or null if we don't have it on file.
export function getPricing(model) {
    return PRICING[model] ?? null;
}

// USD cost of a single call from its token usage. Returns 0 for an unknown model
// or missing usage. Never throws, never returns NaN.
export function computeCost(model, usage) {
    const price = PRICING[model];
    if (!price) {
        if (model && !warned.has(model)) {
            warned.add(model);
            console.warn(
                `⚠️ No pricing on file for model "${model}"; recording its cost as $0. ` +
                    'Add it to src/llmPricing.js to track it.'
            );
        }
        return 0;
    }
    const inTokens = Number(usage?.prompt_tokens) || 0;
    const outTokens = Number(usage?.completion_tokens) || 0;
    return (inTokens * price.input + outTokens * price.output) / 1_000_000;
}
