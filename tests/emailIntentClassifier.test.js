import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmailIntent, buildIntentPrompt } from '../src/emailIntentClassifier.js';

// Fakes the OpenAI-compatible client at the same seam the expense extractor
// uses: chat.completions.create returning a canned JSON string.
function fakeAi(content, { capture } = {}) {
    return {
        chat: {
            completions: {
                async create(args) {
                    if (capture) capture(args);
                    return { choices: [{ message: { content } }] };
                },
            },
        },
    };
}

test('maps a clear request to the right action', async () => {
    const action = await classifyEmailIntent(fakeAi('{"action":"summary"}'), 'dame un resumen', 'm');
    assert.equal(action, 'summary');
});

test('accepts every action in the closed enum', async () => {
    for (const id of ['xray', 'recommendations', 'setup_categories', 'refresh', 'connect', 'costs', 'help']) {
        const action = await classifyEmailIntent(fakeAi(`{"action":"${id}"}`), 'x', 'm');
        assert.equal(action, id);
    }
});

test('discards an out-of-enum action to unclear (Zod-discard, like the expense extractor)', async () => {
    const action = await classifyEmailIntent(fakeAi('{"action":"delete_all_mail"}'), 'borrá todo', 'm');
    assert.equal(action, 'unclear');
});

test('malformed JSON from the LLM → unclear (never throws)', async () => {
    const action = await classifyEmailIntent(fakeAi('not json at all'), 'algo', 'm');
    assert.equal(action, 'unclear');
});

test('a network/LLM error → unclear (never throws)', async () => {
    const throwingAi = {
        chat: { completions: { async create() { throw new Error('timeout'); } } },
    };
    const action = await classifyEmailIntent(throwingAi, 'algo', 'm');
    assert.equal(action, 'unclear');
});

test('requests temperature 0 (greedy decoding for stable routing)', async () => {
    let received;
    await classifyEmailIntent(fakeAi('{"action":"help"}', { capture: (a) => (received = a) }), 'ayuda', 'm');
    assert.equal(received.temperature, 0);
});

test('prompt embeds the user text', () => {
    assert.match(buildIntentPrompt('quiero conectar mi cuenta'), /quiero conectar mi cuenta/);
});
