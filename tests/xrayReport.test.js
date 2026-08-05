import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderBreakdown, buildRulesReport, formatXrayReport } from '../src/xrayReport.js';

const inbox = { id: 'inbox-id', displayName: 'Bandeja de entrada' };
const folders = [
    inbox,
    { id: 'linkedin-id', displayName: 'LinkedIn' },
    { id: 'sales-id', displayName: 'Salesforce' },
];

function msg(parentFolderId) {
    return { parentFolderId, from: { name: 'x', address: 'x@y.com' }, subject: 's', isRead: false };
}

test('folder breakdown counts by folder, sorted by count desc', () => {
    const breakdown = buildFolderBreakdown({
        messages: [msg('linkedin-id'), msg('linkedin-id'), msg('sales-id'), msg('inbox-id')],
        folders,
        inbox,
    });
    assert.deepEqual(breakdown, [
        { name: 'LinkedIn', count: 2 },
        { name: 'Bandeja de entrada', count: 1 },
        { name: 'Salesforce', count: 1 },
    ]);
});

test('unrouted mail (unknown parent folder) is counted under the Inbox, not a synthetic bucket', () => {
    const breakdown = buildFolderBreakdown({
        messages: [msg('some-unknown-folder'), msg('inbox-id')],
        folders,
        inbox,
    });
    assert.deepEqual(breakdown, [{ name: 'Bandeja de entrada', count: 2 }]);
});

test('rules report resolves the destination folder and describes conditions/actions', () => {
    const rules = [
        {
            displayName: 'LinkedIn',
            isEnabled: true,
            sequence: 1,
            conditions: { senderContains: ['linkedin.com'] },
            actions: { moveToFolder: 'linkedin-id' },
        },
        {
            displayName: 'Vieja',
            isEnabled: false,
            sequence: 2,
            conditions: { subjectContains: ['promo'] },
            actions: { delete: true },
        },
    ];
    const report = buildRulesReport({ rules, folders });
    assert.equal(report[0].name, 'LinkedIn');
    assert.equal(report[0].destinationFolder, 'LinkedIn');
    assert.match(report[0].conditions, /linkedin\.com/);
    assert.match(report[0].actions, /mueve a "LinkedIn"/);
    assert.equal(report[1].enabled, false);
    assert.match(report[1].actions, /borra/);
});

test('rules are ordered by their sequence', () => {
    const rules = [
        { displayName: 'B', sequence: 5, actions: {} },
        { displayName: 'A', sequence: 1, actions: {} },
    ];
    const report = buildRulesReport({ rules, folders });
    assert.deepEqual(report.map((r) => r.name), ['A', 'B']);
});

test('formatXrayReport renders count, breakdown and rules; states it changed nothing', () => {
    const text = formatXrayReport({
        messages: [msg('linkedin-id'), msg('inbox-id')],
        folders,
        inbox,
        rules: [
            { displayName: 'LinkedIn', isEnabled: true, sequence: 1, conditions: { senderContains: ['linkedin.com'] }, actions: { moveToFolder: 'linkedin-id' } },
        ],
    });
    assert.match(text, /Radiografía/);
    assert.match(text, /no toqué nada/);
    assert.match(text, /sin leer: \*2\*/);
    assert.match(text, /LinkedIn: 1/);
    assert.match(text, /Bandeja de entrada: 1/);
    assert.match(text, /\*LinkedIn\*/);
});

test('empty mailbox renders gracefully', () => {
    const text = formatXrayReport({ messages: [], folders, inbox, rules: [] });
    assert.match(text, /sin leer: \*0\*/);
    assert.match(text, /no hay correo sin leer/);
    assert.match(text, /No encontré reglas/);
});
