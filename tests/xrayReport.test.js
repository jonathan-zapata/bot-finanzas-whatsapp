import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderBreakdown, buildRulesReport, formatXrayReport } from '../src/xrayReport.js';

const inbox = { id: 'inbox-id', displayName: 'Bandeja de entrada' };
const folders = [
    inbox,
    { id: 'linkedin-id', displayName: 'LinkedIn' },
    { id: 'sales-id', displayName: 'Salesforce' },
];

function msg(parentFolderId, { isRead = false, receivedDateTime = '2026-08-01T10:00:00Z' } = {}) {
    return { parentFolderId, from: { name: 'x', address: 'x@y.com' }, subject: 's', isRead, receivedDateTime };
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

test('unread count is over unread mail, but the breakdown covers the recent window (read + unread)', () => {
    const cutoffIso = '2026-07-25T00:00:00Z';
    const text = formatXrayReport({
        messages: [
            msg('inbox-id', { isRead: false, receivedDateTime: '2026-08-01T00:00:00Z' }), // unread, recent
            msg('linkedin-id', { isRead: true, receivedDateTime: '2026-07-30T00:00:00Z' }), // read, recent → in breakdown
            msg('inbox-id', { isRead: false, receivedDateTime: '2026-06-01T00:00:00Z' }), // unread but OLD → not in breakdown
        ],
        folders,
        inbox,
        rules: [],
        cutoffIso,
        windowDays: 14,
        olderCount: 120,
    });
    assert.match(text, /sin leer: \*2\*/, 'two unread total (recent + old)');
    assert.match(text, /últimos 14 días/);
    assert.match(text, /Bandeja de entrada: 1/, 'only the recent inbox message is in the breakdown');
    assert.match(text, /LinkedIn: 1/, 'a READ recent message appears in the breakdown');
    assert.match(text, /~120 correos anteriores/, 'older-mail disclaimer');
});

test('empty mailbox renders gracefully', () => {
    const text = formatXrayReport({ messages: [], folders, inbox, rules: [] });
    assert.match(text, /sin leer: \*0\*/);
    assert.match(text, /no hay correo en ese período/);
    assert.match(text, /No encontré reglas/);
});
