import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySenders, buildSummaryPrompt } from '../src/summaryClassifier.js';

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

const categories = ['Software', 'Gobierno', 'Otros / Sin clasificar'];
const senders = [
    { address: 'gh@github.com', name: 'GitHub', subjects: ['PR merged'] },
    { address: 'gob@gub.uy', name: 'Gobierno', subjects: ['Trámite'] },
];

test('assigns senders to the categories the model returns', async () => {
    const content = JSON.stringify({
        assignments: [
            { sender: 'gh@github.com', category: 'Software' },
            { sender: 'gob@gub.uy', category: 'Gobierno' },
        ],
    });
    const result = await classifySenders(fakeAi(content), { senders, categories }, 'm');
    assert.deepEqual(result, [
        { sender: 'gh@github.com', category: 'Software' },
        { sender: 'gob@gub.uy', category: 'Gobierno' },
    ]);
});

test('a category outside the taxonomy is coerced to the standing Other', async () => {
    const content = JSON.stringify({ assignments: [{ sender: 'gh@github.com', category: 'Cryptomonedas' }] });
    const result = await classifySenders(fakeAi(content), { senders, categories }, 'm');
    assert.deepEqual(result, [{ sender: 'gh@github.com', category: 'Otros / Sin clasificar' }]);
});

test('malformed LLM output → empty assignments (everything falls back to Other), never throws', async () => {
    const result = await classifySenders(fakeAi('not json'), { senders, categories }, 'm');
    assert.deepEqual(result, []);
});

test('no senders → no LLM call, empty result', async () => {
    let called = false;
    const ai = fakeAi('{}', { capture: () => (called = true) });
    const result = await classifySenders(ai, { senders: [], categories }, 'm');
    assert.deepEqual(result, []);
    assert.equal(called, false);
});

test('the prompt carries sender metadata (name/address/subjects) but the caller never passes bodies', () => {
    const prompt = buildSummaryPrompt(senders, categories);
    assert.match(prompt, /github\.com/);
    assert.match(prompt, /PR merged/);
    assert.match(prompt, /Software/);
});
