import test from 'node:test';
import assert from 'node:assert/strict';
import { gastoSchema } from '../src/aiExtractor.js';

test('acepta un gasto válido y normaliza mayúsculas/minúsculas', () => {
    const resultado = gastoSchema.safeParse({
        servicio: 'Antel',
        monto: 2000,
        divisa: 'uyu',
        metodo_pago: 'EFECTIVO',
        categoria: 'Servicios',
        fecha_gasto: '2026-07-30',
    });
    assert.equal(resultado.success, true);
    assert.equal(resultado.data.divisa, 'UYU');
    assert.equal(resultado.data.metodo_pago, 'efectivo');
    assert.equal(resultado.data.cuotas, 1); // default cuando no viene
});

test('acepta monto como string numérico (coerción)', () => {
    const resultado = gastoSchema.safeParse({
        servicio: 'Antel',
        monto: '2000',
        divisa: 'UYU',
        metodo_pago: 'efectivo',
        categoria: 'Servicios',
        fecha_gasto: '2026-07-30',
    });
    assert.equal(resultado.success, true);
    assert.equal(resultado.data.monto, 2000);
});

test('rechaza monto negativo o cero', () => {
    const resultado = gastoSchema.safeParse({
        servicio: 'Antel',
        monto: 0,
        divisa: 'UYU',
        metodo_pago: 'efectivo',
        categoria: 'Servicios',
        fecha_gasto: '2026-07-30',
    });
    assert.equal(resultado.success, false);
});

test('rechaza una divisa fuera del enum', () => {
    const resultado = gastoSchema.safeParse({
        servicio: 'Antel',
        monto: 100,
        divisa: 'ARS',
        metodo_pago: 'efectivo',
        categoria: 'Servicios',
        fecha_gasto: '2026-07-30',
    });
    assert.equal(resultado.success, false);
});

test('rechaza una fecha con formato inválido', () => {
    const resultado = gastoSchema.safeParse({
        servicio: 'Antel',
        monto: 100,
        divisa: 'UYU',
        metodo_pago: 'efectivo',
        categoria: 'Servicios',
        fecha_gasto: '30/07/2026',
    });
    assert.equal(resultado.success, false);
});

test('rechaza un objeto vacío (mensaje sin gasto, ej. un saludo)', () => {
    const resultado = gastoSchema.safeParse({});
    assert.equal(resultado.success, false);
});
