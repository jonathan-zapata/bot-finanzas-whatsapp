import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSenders, buildCategoryCounts, collectActionItems, formatSummaryReport } from '../src/summaryReport.js';

const taxonomy = ['Software', 'Gobierno', 'Otros / Sin clasificar'];

function m(address, name, subject, hasAttachments = false) {
    return { from: { address, name }, subject, hasAttachments, parentFolderId: 'inbox-id' };
}

test('collectSenders de-dupes by address and gathers their subjects', () => {
    const senders = collectSenders([
        m('a@x.com', 'A', 'uno'),
        m('a@x.com', 'A', 'dos'),
        m('b@y.com', 'B', 'tres'),
    ]);
    assert.equal(senders.length, 2);
    assert.deepEqual(senders.find((s) => s.address === 'a@x.com').subjects, ['uno', 'dos']);
});

test('buildCategoryCounts groups by the sender→category assignment, taxonomy-ordered', () => {
    const messages = [m('gh@github.com', 'GitHub', 'x'), m('gob@gub.uy', 'Gov', 'y'), m('gh@github.com', 'GitHub', 'z')];
    const assignments = [
        { sender: 'gh@github.com', category: 'Software' },
        { sender: 'gob@gub.uy', category: 'Gobierno' },
    ];
    const counts = buildCategoryCounts({ messages, taxonomy, assignments });
    assert.deepEqual(counts.map((c) => [c.category, c.count]), [
        ['Software', 2],
        ['Gobierno', 1],
    ]);
});

test('unassigned senders fall into the standing Other bucket', () => {
    const messages = [m('weird@nowhere.com', 'W', 'x')];
    const counts = buildCategoryCounts({ messages, taxonomy, assignments: [] });
    assert.deepEqual(counts, [{ category: 'Otros / Sin clasificar', count: 1, senders: ['W'] }]);
});

test('collectActionItems flags mail with attachments (metadata-only heuristic)', () => {
    const items = collectActionItems([m('a@x.com', 'A', 'sin adj', false), m('b@y.com', 'B', 'con adj', true)]);
    assert.deepEqual(items, [{ subject: 'con adj', sender: 'B' }]);
});

test('formatSummaryReport shows Inbox count, category grouping and action highlight', () => {
    const messages = [m('gh@github.com', 'GitHub', 'PR', false), m('gob@gub.uy', 'ANV', 'Trámite', true)];
    const assignments = [
        { sender: 'gh@github.com', category: 'Software' },
        { sender: 'gob@gub.uy', category: 'Gobierno' },
    ];
    const text = formatSummaryReport({ messages, taxonomy, assignments });
    assert.match(text, /Sin leer en la bandeja: \*2\*/);
    assert.match(text, /\*Software\*: 1/);
    assert.match(text, /\*Gobierno\*: 1/);
    assert.match(text, /Trámite/);
});
