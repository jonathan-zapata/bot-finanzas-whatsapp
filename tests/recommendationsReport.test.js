import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRules, buildFolderProposal, formatRecommendationsReport } from '../src/recommendationsReport.js';

const folders = [
    { id: 'inbox-id', displayName: 'Bandeja de entrada' },
    { id: 'linkedin-id', displayName: 'LinkedIn' },
    { id: 'work-id', displayName: 'Trabajo' },
];

test('a rule routing LinkedIn to a folder is flagged as usefully reducing noise', () => {
    const [verdict] = classifyRules({
        rules: [{ displayName: 'LinkedIn', conditions: { senderContains: ['linkedin.com'] }, actions: { moveToFolder: 'linkedin-id' } }],
        folders,
    });
    assert.equal(verdict.verdict, 'noise');
    assert.match(verdict.reason, /ruido/);
});

test('a rule moving a non-noise sender out and marking read is flagged as hiding important mail', () => {
    const [verdict] = classifyRules({
        rules: [{ displayName: 'Jefe', conditions: { senderContains: ['jefe@empresa.com'] }, actions: { moveToFolder: 'work-id', markAsRead: true } }],
        folders,
    });
    assert.equal(verdict.verdict, 'hides');
    assert.match(verdict.reason, /nunca/);
});

test('a rule that auto-deletes non-noise mail is flagged as hiding important mail', () => {
    const [verdict] = classifyRules({
        rules: [{ displayName: 'Borrar viejos', conditions: { subjectContains: ['factura'] }, actions: { delete: true } }],
        folders,
    });
    assert.equal(verdict.verdict, 'hides');
});

test('a rule that does not move mail out of the inbox is neutral', () => {
    const [verdict] = classifyRules({
        rules: [{ displayName: 'Marcar', conditions: { senderContains: ['x@y.com'] }, actions: { markImportance: 'high' } }],
        folders,
    });
    assert.equal(verdict.verdict, 'neutral');
});

test('folder proposal prefers the confirmed taxonomy (minus Other)', () => {
    const proposal = buildFolderProposal({ folders, taxonomy: ['Software', 'Salud', 'Otros / Sin clasificar'] });
    assert.equal(proposal.basis, 'taxonomy');
    assert.deepEqual(proposal.folders, ['Software', 'Salud']);
});

test('report proposes structure, flags rules both ways, and states nothing was/will be changed', () => {
    const text = formatRecommendationsReport({
        folders,
        taxonomy: ['Software', 'Otros / Sin clasificar'],
        rules: [
            { displayName: 'LinkedIn', conditions: { senderContains: ['linkedin.com'] }, actions: { moveToFolder: 'linkedin-id' } },
            { displayName: 'Jefe', conditions: { senderContains: ['jefe@empresa.com'] }, actions: { moveToFolder: 'work-id', markAsRead: true } },
        ],
    });
    assert.match(text, /Estructura de carpetas propuesta/);
    assert.match(text, /esconderte correo importante/);
    assert.match(text, /\*Jefe\*/);
    assert.match(text, /reducen ruido/);
    assert.match(text, /\*LinkedIn\*/);
    // The explicit "nothing changed / will change" guarantee.
    assert.match(text, /NO cambié ni voy a cambiar nada/);
});
