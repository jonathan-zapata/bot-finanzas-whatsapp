import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCost, getPricing, PRICING } from '../src/llmPricing.js';

test('computes cost from prompt/completion tokens at the model price', () => {
    const cost = computeCost('llama-3.3-70b-versatile', { prompt_tokens: 1_000_000, completion_tokens: 0 });
    assert.equal(cost, PRICING['llama-3.3-70b-versatile'].input);

    const outCost = computeCost('llama-3.3-70b-versatile', { prompt_tokens: 0, completion_tokens: 1_000_000 });
    assert.equal(outCost, PRICING['llama-3.3-70b-versatile'].output);
});

test('blends input and output correctly for a small call', () => {
    // 500 in @ $0.59/M + 60 out @ $0.79/M
    const cost = computeCost('llama-3.3-70b-versatile', { prompt_tokens: 500, completion_tokens: 60 });
    const expected = (500 * 0.59 + 60 * 0.79) / 1_000_000;
    assert.ok(Math.abs(cost - expected) < 1e-12);
});

test('unknown model → 0 cost, never NaN', () => {
    assert.equal(computeCost('some-model-we-dont-price', { prompt_tokens: 100, completion_tokens: 100 }), 0);
});

test('missing / malformed usage → 0 cost, never NaN', () => {
    assert.equal(computeCost('llama-3.3-70b-versatile', undefined), 0);
    assert.equal(computeCost('llama-3.3-70b-versatile', {}), 0);
    assert.equal(computeCost('llama-3.3-70b-versatile', { prompt_tokens: 'x', completion_tokens: null }), 0);
});

test('getPricing returns the pair for a known model and null otherwise', () => {
    assert.deepEqual(getPricing('llama-3.1-8b-instant'), PRICING['llama-3.1-8b-instant']);
    assert.equal(getPricing('nope'), null);
});
