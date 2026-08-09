import { computeCost } from './llmPricing.js';

// Access to the `llm_usage` table: writes one row per LLM call and reads the
// aggregated per-agent summary the cost report renders.

const TABLE = 'llm_usage';

// Persists one LLM call's token usage plus its estimated USD cost, tagged by the
// agent that made the call. Called from the LLM-client wrapper (see index.js)
// after every completion.
//
// Best-effort by design (same discipline as idempotency and rate-limit logging):
// a failure here must never break the actual bot reply, so it swallows every
// error and simply skips the row. A call with no usage payload (e.g. a faked
// client in tests) is a no-op.
export async function recordUsage(supabase, { agent, model, usage } = {}) {
    if (!supabase || !usage) return;
    try {
        const row = {
            agent: agent ?? 'unknown',
            model: model ?? 'unknown',
            tokens_in: Number(usage.prompt_tokens) || 0,
            tokens_out: Number(usage.completion_tokens) || 0,
            cost_usd: computeCost(model, usage),
        };
        const { error } = await supabase.from(TABLE).insert([row]);
        if (error) console.error('❌ Error recording LLM usage (continuing):', error);
    } catch (error) {
        console.error('❌ Error recording LLM usage (continuing):', error);
    }
}

// Aggregates usage into per-agent totals plus a grand total, optionally limited
// to rows on/after `since` (an ISO timestamp). Aggregation is done in code: the
// Supabase JS client has no cheap group-by, and this table is tiny (one row per
// LLM call for a personal bot).
//
// Returns { since, byAgent: [{ agent, calls, tokensIn, tokensOut, costUsd }],
// total: { calls, tokensIn, tokensOut, costUsd } }, or null on a read error so
// the caller can show a friendly "couldn't read it" message.
export async function getUsageSummary(supabase, { since = null } = {}) {
    try {
        let query = supabase.from(TABLE).select('agent, tokens_in, tokens_out, cost_usd, created_at');
        if (since) query = query.gte('created_at', since);
        const { data, error } = await query;
        if (error) {
            console.error('❌ Error reading LLM usage summary:', error);
            return null;
        }

        const byAgent = new Map();
        const total = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };

        for (const row of data ?? []) {
            const key = row.agent ?? 'unknown';
            const acc = byAgent.get(key) ?? { agent: key, calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
            const inTokens = Number(row.tokens_in) || 0;
            const outTokens = Number(row.tokens_out) || 0;
            const cost = Number(row.cost_usd) || 0;

            acc.calls += 1;
            acc.tokensIn += inTokens;
            acc.tokensOut += outTokens;
            acc.costUsd += cost;
            byAgent.set(key, acc);

            total.calls += 1;
            total.tokensIn += inTokens;
            total.tokensOut += outTokens;
            total.costUsd += cost;
        }

        return { since, byAgent: [...byAgent.values()], total };
    } catch (error) {
        console.error('❌ Error reading LLM usage summary:', error);
        return null;
    }
}
