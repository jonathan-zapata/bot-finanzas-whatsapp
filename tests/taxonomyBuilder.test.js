import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeTaxonomy, withStandingOther, STANDING_OTHER } from '../src/taxonomyBuilder.js';

test('proposes categories from folder names, excluding system folders', () => {
    const proposed = proposeTaxonomy({
        folders: [
            { displayName: 'Inbox' },
            { displayName: 'Bandeja de entrada' },
            { displayName: 'Sent Items' },
            { displayName: 'LinkedIn' },
            { displayName: 'Salud' },
        ],
        rules: [],
    });
    assert.deepEqual(proposed, ['LinkedIn', 'Salud', STANDING_OTHER]);
});

test('treats rule names as category signals and de-duplicates against folders', () => {
    const proposed = proposeTaxonomy({
        folders: [{ displayName: 'LinkedIn' }],
        rules: [{ displayName: 'LinkedIn' }, { displayName: 'Gobierno' }],
    });
    assert.deepEqual(proposed, ['LinkedIn', 'Gobierno', STANDING_OTHER]);
});

test('always appends the standing Other exactly once, at the end', () => {
    const proposed = proposeTaxonomy({ folders: [], rules: [] });
    assert.deepEqual(proposed, [STANDING_OTHER]);
});

test('withStandingOther de-dupes case-insensitively and keeps Other last', () => {
    const result = withStandingOther(['Salud', 'salud', 'Trabajo', STANDING_OTHER]);
    assert.deepEqual(result, ['Salud', 'Trabajo', STANDING_OTHER]);
});

test('ignores empty/too-short folder names', () => {
    const proposed = proposeTaxonomy({ folders: [{ displayName: '' }, { displayName: 'A' }, { displayName: 'Ok' }], rules: [] });
    assert.deepEqual(proposed, ['Ok', STANDING_OTHER]);
});
