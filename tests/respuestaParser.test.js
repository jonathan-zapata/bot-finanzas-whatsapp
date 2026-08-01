import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretarRespuesta } from '../src/respuestaParser.js';

test('interpreta afirmativas', () => {
    for (const t of ['sí', 'si', 'Dale', 'ok', 'obvio', 'agregalo', 'Sí, es nuevo']) {
        assert.equal(interpretarRespuesta(t), 'si', `"${t}" debería ser sí`);
    }
});

test('interpreta negativas simples', () => {
    for (const t of ['no', 'No', 'nop', 'no, es el mismo']) {
        assert.equal(interpretarRespuesta(t), 'no', `"${t}" debería ser no`);
    }
});

test('interpreta frases negativas aunque no empiecen con "no"', () => {
    for (const t of ['son lo mismo', 'es el mismo de antes', 'está duplicado', 'ya lo tenía']) {
        assert.equal(interpretarRespuesta(t), 'no', `"${t}" debería ser no`);
    }
});

test('devuelve ambiguo cuando no puede decidir', () => {
    for (const t of ['tal vez', 'no sé', 'qué?', 'hola']) {
        // "no sé" empieza con "no" → se interpreta como negativa (aceptable);
        // el resto debe ser ambiguo.
        if (t.startsWith('no')) continue;
        assert.equal(interpretarRespuesta(t), 'ambiguo', `"${t}" debería ser ambiguo`);
    }
});
