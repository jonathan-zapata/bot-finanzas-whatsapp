import test from 'node:test';
import assert from 'node:assert/strict';
import { splitForWhatsApp, createWhatsAppClient, WHATSAPP_MAX_CHARS } from '../src/whatsappClient.js';

test('short text is returned as a single chunk', () => {
    assert.deepEqual(splitForWhatsApp('hola'), ['hola']);
});

test('text at the limit is not split', () => {
    const text = 'a'.repeat(4000);
    assert.deepEqual(splitForWhatsApp(text), [text]);
});

test('every produced chunk stays within the limit', () => {
    const text = Array.from({ length: 500 }, (_, i) => `línea ${i} con algo de contenido`).join('\n');
    const chunks = splitForWhatsApp(text);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 4000, `chunk length ${c.length} exceeds limit`);
    // No chunk exceeds WhatsApp's hard cap either.
    for (const c of chunks) assert.ok(c.length <= WHATSAPP_MAX_CHARS);
});

test('splits on line boundaries, not mid-line', () => {
    const line = 'x'.repeat(1500);
    const text = [line, line, line].join('\n'); // 3 lines, ~4502 chars total
    const chunks = splitForWhatsApp(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], `${line}\n${line}`);
    assert.equal(chunks[1], line);
});

test('a single line longer than the limit is hard-split', () => {
    const text = 'y'.repeat(9000);
    const chunks = splitForWhatsApp(text);
    assert.equal(chunks.length, 3); // 4000 + 4000 + 1000
    assert.equal(chunks.join(''), text);
    for (const c of chunks) assert.ok(c.length <= 4000);
});

test('caps the number of chunks and marks truncation', () => {
    const text = Array.from({ length: 100 }, () => 'z'.repeat(3999)).join('\n');
    const chunks = splitForWhatsApp(text, { maxChunks: 3 });
    assert.equal(chunks.length, 3);
    assert.ok(chunks[2].endsWith('(mensaje recortado)'));
    for (const c of chunks) assert.ok(c.length <= 4000);
});

test('sendMessage sends one request for a short message', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        calls.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
    };
    const wa = createWhatsAppClient({ token: 't', phoneNumberId: 'p', fetchImpl });
    await wa.sendMessage('598123', 'hola');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text.body, 'hola');
});

test('sendMessage sends one request per chunk for a long message', async () => {
    const bodies = [];
    const fetchImpl = async (_url, opts) => {
        bodies.push(JSON.parse(opts.body).text.body);
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.x' }] }) };
    };
    const wa = createWhatsAppClient({ token: 't', phoneNumberId: 'p', fetchImpl });
    const long = Array.from({ length: 300 }, (_, i) => `línea ${i}`).join('\n').padEnd(9000, '.');
    await wa.sendMessage('598123', long);
    assert.ok(bodies.length >= 2);
    for (const b of bodies) assert.ok(b.length <= 4000);
});

test('sendMessage stops the burst when Meta rejects a chunk', async () => {
    let n = 0;
    const fetchImpl = async () => {
        n += 1;
        return { ok: false, json: async () => ({ error: { message: 'boom' } }) };
    };
    const wa = createWhatsAppClient({ token: 't', phoneNumberId: 'p', fetchImpl });
    await wa.sendMessage('598123', 'a'.repeat(12000)); // would be 3 chunks
    assert.equal(n, 1); // stopped after the first rejection
});
