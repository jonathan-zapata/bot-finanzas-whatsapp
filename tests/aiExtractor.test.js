import test from 'node:test';
import assert from 'node:assert/strict';
import { expenseSchema, buildPrompt } from '../src/aiExtractor.js';

test('accepts a valid expense and normalizes upper/lower case', () => {
    const result = expenseSchema.safeParse({
        servicio: 'Antel',
        monto: 2000,
        divisa: 'uyu',
        metodo_pago: 'EFECTIVO',
        categoria: 'Servicios',
        fecha_gasto: '2026-07-30',
    });
    assert.equal(result.success, true);
    assert.equal(result.data.divisa, 'UYU');
    assert.equal(result.data.metodo_pago, 'efectivo');
    assert.equal(result.data.cuotas, 1); // default when not provided
});

test('accepts amount as a numeric string (coercion)', () => {
    const result = expenseSchema.safeParse({
        servicio: 'Antel',
        monto: '2000',
        divisa: 'UYU',
        metodo_pago: 'efectivo',
        categoria: 'Servicios',
        fecha_gasto: '2026-07-30',
    });
    assert.equal(result.success, true);
    assert.equal(result.data.monto, 2000);
});

test('rejects a negative or zero amount', () => {
    const result = expenseSchema.safeParse({
        servicio: 'Antel',
        monto: 0,
        divisa: 'UYU',
        metodo_pago: 'efectivo',
        categoria: 'Servicios',
        fecha_gasto: '2026-07-30',
    });
    assert.equal(result.success, false);
});

test('rejects a currency outside the enum', () => {
    const result = expenseSchema.safeParse({
        servicio: 'Antel',
        monto: 100,
        divisa: 'ARS',
        metodo_pago: 'efectivo',
        categoria: 'Servicios',
        fecha_gasto: '2026-07-30',
    });
    assert.equal(result.success, false);
});

test('rejects a date with invalid format', () => {
    const result = expenseSchema.safeParse({
        servicio: 'Antel',
        monto: 100,
        divisa: 'UYU',
        metodo_pago: 'efectivo',
        categoria: 'Servicios',
        fecha_gasto: '30/07/2026',
    });
    assert.equal(result.success, false);
});

test('rejects an empty object (message with no expense, e.g. a greeting)', () => {
    const result = expenseSchema.safeParse({});
    assert.equal(result.success, false);
});

// Regression test for the production bug: a message sent in the evening in
// Uruguay (UTC-3) can land at a UTC timestamp that has already rolled over to
// the next calendar day. "today" for the prompt must follow Uruguay's
// calendar, not the container's (UTC).
test('buildPrompt uses Uruguay\'s calendar date, not UTC, in the evening rollover window', () => {
    // 2026-08-02T01:50:00Z = 2026-08-01 22:50 in Montevideo (UTC-3):
    // still "today" in Uruguay, already "tomorrow" per raw UTC.
    const rolledOverInUtc = new Date('2026-08-02T01:50:00Z');
    const prompt = buildPrompt('Pagué 500 de supermercado', { today: rolledOverInUtc });

    assert.match(prompt, /Hoy es Sábado 2026-08-01/);
    assert.match(prompt, /fecha_gasto DEBE ser exactamente "2026-08-01"/);
    assert.doesNotMatch(prompt, /2026-08-02/);
});

test('buildPrompt matches UTC when Uruguay and UTC agree on the date', () => {
    // 2026-08-01T15:00:00Z = 2026-08-01 12:00 in Montevideo: same calendar day
    // in both, so this should behave the same regardless of timezone handling.
    const midday = new Date('2026-08-01T15:00:00Z');
    const prompt = buildPrompt('Pagué 500 de supermercado', { today: midday });

    assert.match(prompt, /Hoy es Sábado 2026-08-01/);
    assert.match(prompt, /fecha_gasto DEBE ser exactamente "2026-08-01"/);
});
