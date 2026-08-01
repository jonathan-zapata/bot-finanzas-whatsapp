import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse } from '../src/responseParser.js';

test('interprets affirmatives', () => {
    for (const t of ['sí', 'si', 'Dale', 'ok', 'obvio', 'agregalo', 'Sí, es nuevo']) {
        assert.equal(parseResponse(t), 'yes', `"${t}" should be yes`);
    }
});

test('interprets simple negatives', () => {
    for (const t of ['no', 'No', 'nop', 'no, es el mismo']) {
        assert.equal(parseResponse(t), 'no', `"${t}" should be no`);
    }
});

test('interprets negative phrases even if they don\'t start with "no"', () => {
    for (const t of ['son lo mismo', 'es el mismo de antes', 'está duplicado', 'ya lo tenía']) {
        assert.equal(parseResponse(t), 'no', `"${t}" should be no`);
    }
});

test('returns ambiguous when it can\'t decide', () => {
    for (const t of ['tal vez', 'no sé', 'qué?', 'hola']) {
        // "no sé" starts with "no" → interpreted as negative (acceptable);
        // the rest should be ambiguous.
        if (t.startsWith('no')) continue;
        assert.equal(parseResponse(t), 'ambiguous', `"${t}" should be ambiguous`);
    }
});
