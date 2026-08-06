import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRateLimitLog, attachRateLimitLogging } from '../src/llmRateLimitLog.js';

test('formats a line from Fetch Headers', () => {
    const headers = new Headers({
        'x-ratelimit-remaining-requests': '997',
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-tokens': '11800',
        'x-ratelimit-limit-tokens': '12000',
        'x-ratelimit-reset-requests': '2m59s',
    });
    const line = formatRateLimitLog(headers);
    assert.match(line, /requests: 997\/1000 restantes/);
    assert.match(line, /tokens: 11800\/12000 restantes/);
    assert.match(line, /reset 2m59s/);
});

test('works with a plain object of headers', () => {
    const line = formatRateLimitLog({
        'x-ratelimit-remaining-requests': '5',
        'x-ratelimit-remaining-tokens': '900',
    });
    assert.match(line, /requests: 5\/n\/d restantes/);
    assert.match(line, /tokens: 900\/n\/d restantes/);
});

test('returns null when no rate-limit headers are present', () => {
    assert.equal(formatRateLimitLog(new Headers({})), null);
    assert.equal(formatRateLimitLog(undefined), null);
});

test('attachRateLimitLogging logs headers and returns just the completion', async () => {
    const completion = { choices: [{ message: { content: '{}' } }] };
    const headers = new Headers({ 'x-ratelimit-remaining-requests': '999' });
    const fakeClient = {
        chat: {
            completions: {
                create() {
                    // Mimic the OpenAI SDK's APIPromise.withResponse().
                    return { withResponse: async () => ({ data: completion, response: { headers } }) };
                },
            },
        },
    };
    const logged = [];
    attachRateLimitLogging(fakeClient, (line) => logged.push(line));
    const result = await fakeClient.chat.completions.create({ model: 'x', messages: [] });
    assert.equal(result, completion); // callers still get the completion
    assert.equal(logged.length, 1);
    assert.match(logged[0], /requests: 999/);
});

test('attachRateLimitLogging never throws if logging fails', async () => {
    const completion = { choices: [] };
    const fakeClient = {
        chat: {
            completions: {
                create() {
                    return { withResponse: async () => ({ data: completion, response: { headers: new Headers({ 'x-ratelimit-remaining-requests': '1' }) } }) };
                },
            },
        },
    };
    attachRateLimitLogging(fakeClient, () => {
        throw new Error('log sink exploded');
    });
    const result = await fakeClient.chat.completions.create({});
    assert.equal(result, completion);
});
