import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUsageReport } from '../src/usageReport.js';

test('renders a per-agent breakdown with a total', () => {
    const summary = {
        byAgent: [
            { agent: 'expense', calls: 2, tokensIn: 900, tokensOut: 100, costUsd: 0.0005 },
            { agent: 'email', calls: 1, tokensIn: 1000, tokensOut: 200, costUsd: 0.001 },
        ],
        total: { calls: 3, tokensIn: 1900, tokensOut: 300, costUsd: 0.0015 },
    };
    const text = formatUsageReport(summary);

    assert.match(text, /Costos de la API/);
    assert.match(text, /Finanzas/);
    assert.match(text, /Email/);
    assert.match(text, /Total/);
    assert.match(text, /3 llamadas/);
});

test('sorts agents by cost, most expensive first', () => {
    const summary = {
        byAgent: [
            { agent: 'expense', calls: 1, tokensIn: 100, tokensOut: 10, costUsd: 0.0001 },
            { agent: 'email', calls: 1, tokensIn: 1000, tokensOut: 200, costUsd: 0.01 },
        ],
        total: { calls: 2, tokensIn: 1100, tokensOut: 210, costUsd: 0.0101 },
    };
    const text = formatUsageReport(summary);
    assert.ok(text.indexOf('Email') < text.indexOf('Finanzas'), 'email (pricier) listed first');
});

test('shows extra precision for sub-cent amounts', () => {
    const summary = {
        byAgent: [{ agent: 'expense', calls: 1, tokensIn: 500, tokensOut: 60, costUsd: 0.00034 }],
        total: { calls: 1, tokensIn: 500, tokensOut: 60, costUsd: 0.00034 },
    };
    const text = formatUsageReport(summary);
    assert.match(text, /US\$0\.0003/, 'sub-cent cost shows 4 decimals, not $0.00');
});

test('empty ledger → friendly "nothing recorded yet" message', () => {
    const summary = { byAgent: [], total: { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 } };
    assert.match(formatUsageReport(summary), /Todavía no registré/);
});

test('null summary (read error) → friendly error message', () => {
    assert.match(formatUsageReport(null), /No pude leer/);
});
