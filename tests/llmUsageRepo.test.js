import test from 'node:test';
import assert from 'node:assert/strict';
import { recordUsage, getUsageSummary } from '../src/llmUsageRepo.js';

// A minimal fake of the Supabase query builder covering the two shapes this repo
// uses: .from(t).insert([row]) and .from(t).select(...).gte(...).
function fakeSupabase({ rows = [], insertError = null, selectError = null } = {}) {
    const inserted = [];
    return {
        inserted,
        from() {
            return {
                insert(records) {
                    inserted.push(...records);
                    return Promise.resolve({ error: insertError });
                },
                select() {
                    // Both .gte() and awaiting directly must resolve to the data.
                    const result = { data: rows, error: selectError };
                    return {
                        gte() {
                            return Promise.resolve(result);
                        },
                        then(resolve) {
                            return Promise.resolve(result).then(resolve);
                        },
                    };
                },
            };
        },
    };
}

test('recordUsage inserts a row with computed cost and agent tag', async () => {
    const supabase = fakeSupabase();
    await recordUsage(supabase, {
        agent: 'expense',
        model: 'llama-3.3-70b-versatile',
        usage: { prompt_tokens: 500, completion_tokens: 60 },
    });

    assert.equal(supabase.inserted.length, 1);
    const row = supabase.inserted[0];
    assert.equal(row.agente, 'expense');
    assert.equal(row.modelo, 'llama-3.3-70b-versatile');
    assert.equal(row.tokens_entrada, 500);
    assert.equal(row.tokens_salida, 60);
    assert.ok(row.costo_usd > 0);
});

test('recordUsage is a no-op without a usage payload (e.g. faked clients)', async () => {
    const supabase = fakeSupabase();
    await recordUsage(supabase, { agent: 'email', model: 'x', usage: undefined });
    assert.equal(supabase.inserted.length, 0);
});

test('recordUsage never throws on an insert error', async () => {
    const supabase = fakeSupabase({ insertError: { message: 'boom' } });
    await recordUsage(supabase, { agent: 'email', model: 'llama-3.3-70b-versatile', usage: { prompt_tokens: 1, completion_tokens: 1 } });
    // No throw = pass.
});

test('unknown agent defaults to "unknown"', async () => {
    const supabase = fakeSupabase();
    await recordUsage(supabase, { model: 'llama-3.3-70b-versatile', usage: { prompt_tokens: 1, completion_tokens: 1 } });
    assert.equal(supabase.inserted[0].agente, 'unknown');
});

test('getUsageSummary aggregates per agent plus a grand total', async () => {
    const rows = [
        { agente: 'expense', tokens_entrada: 500, tokens_salida: 60, costo_usd: 0.0003 },
        { agente: 'expense', tokens_entrada: 400, tokens_salida: 40, costo_usd: 0.0002 },
        { agente: 'email', tokens_entrada: 1000, tokens_salida: 200, costo_usd: 0.001 },
    ];
    const summary = await getUsageSummary(fakeSupabase({ rows }));

    const expense = summary.byAgent.find((a) => a.agent === 'expense');
    const email = summary.byAgent.find((a) => a.agent === 'email');
    assert.equal(expense.calls, 2);
    assert.equal(expense.tokensIn, 900);
    assert.equal(expense.tokensOut, 100);
    assert.equal(email.calls, 1);

    assert.equal(summary.total.calls, 3);
    assert.equal(summary.total.tokensIn, 1900);
    assert.equal(summary.total.tokensOut, 300);
    assert.ok(Math.abs(summary.total.costUsd - 0.0015) < 1e-9);
});

test('getUsageSummary returns null on a read error', async () => {
    const summary = await getUsageSummary(fakeSupabase({ selectError: { message: 'nope' } }));
    assert.equal(summary, null);
});

test('getUsageSummary handles an empty ledger', async () => {
    const summary = await getUsageSummary(fakeSupabase({ rows: [] }));
    assert.equal(summary.total.calls, 0);
    assert.deepEqual(summary.byAgent, []);
});
