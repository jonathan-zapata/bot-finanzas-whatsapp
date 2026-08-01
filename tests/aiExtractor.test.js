import test from 'node:test';
import assert from 'node:assert/strict';
import { expenseSchema } from '../src/aiExtractor.js';

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
