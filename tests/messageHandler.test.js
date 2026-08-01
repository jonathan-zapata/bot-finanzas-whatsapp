import test from 'node:test';
import assert from 'node:assert/strict';
import { manejarMensajeEntrante } from '../src/messageHandler.js';

// Estado en memoria + deps fakeadas: probamos la máquina de estados del handler
// sin simular Supabase ni la red (inyección de dependencias, la costura fakeable).
function crearEntorno({ pagosIniciales = [], pendientes = {} } = {}) {
    const state = {
        pagos: [...pagosIniciales],
        pendientes: new Map(Object.entries(pendientes)),
    };
    return state;
}

function hacerDeps(state, { extraccion, errorLLM = false } = {}) {
    return {
        yaFueProcesado: async (_s, messageId) => state.pagos.some((p) => p.message_id === messageId),
        extraerGasto: async () => {
            if (errorLLM) throw new Error('timeout');
            return extraccion;
        },
        buscarDuplicadoExacto: async (_s, { telefono, servicio, monto, divisa }) => {
            const matches = state.pagos.filter(
                (p) => p.telefono === telefono && p.servicio === servicio && p.monto === monto && p.divisa === divisa
            );
            return matches.length ? matches[matches.length - 1] : null;
        },
        guardarPago: async (_s, { telefono, messageId, datos }) => {
            if (state.pagos.some((p) => p.message_id === messageId)) return { duplicado: true };
            state.pagos.push({ telefono, message_id: messageId, ...datos });
            return { duplicado: false };
        },
        obtenerPendiente: async (_s, telefono) => state.pendientes.get(telefono) || null,
        guardarPendiente: async (_s, { telefono, payload, motivo }) => {
            state.pendientes.set(telefono, { telefono, payload, motivo, created_at: new Date().toISOString() });
        },
        borrarPendiente: async (_s, telefono) => {
            state.pendientes.delete(telefono);
        },
    };
}

function crearWhatsappFake() {
    const mensajes = [];
    return {
        mensajes,
        async enviarMensaje(destino, texto) {
            mensajes.push({ destino, texto });
        },
    };
}

const TEL = '59891111111';
const datosBase = {
    servicio: 'Antel',
    monto: 2000,
    divisa: 'UYU',
    metodo_pago: 'efectivo',
    cuotas: 1,
    categoria: 'Servicios',
    fecha_gasto: '2026-08-01',
};

function invocar(state, deps, { messageId = 'msg-nuevo', texto = 'Pagué 2000 de Antel' } = {}) {
    const whatsapp = crearWhatsappFake();
    return manejarMensajeEntrante({
        supabase: {},
        ai: {},
        whatsapp,
        numeroUsuario: TEL,
        messageId,
        textoUsuario: texto,
        deps,
    }).then(() => whatsapp);
}

test('idempotencia: ignora un message_id ya procesado sin escribir ni responder', async () => {
    const state = crearEntorno({ pagosIniciales: [{ telefono: TEL, message_id: 'msg-repetido', ...datosBase }] });
    const deps = hacerDeps(state, { extraccion: { esGasto: true, datos: datosBase } });
    const whatsapp = await invocar(state, deps, { messageId: 'msg-repetido' });

    assert.equal(state.pagos.length, 1);
    assert.equal(whatsapp.mensajes.length, 0);
});

test('mensaje que no es gasto → responde bienvenida', async () => {
    const state = crearEntorno();
    const deps = hacerDeps(state, { extraccion: { esGasto: false } });
    const whatsapp = await invocar(state, deps, { texto: 'Hola' });

    assert.equal(state.pagos.length, 0);
    assert.match(whatsapp.mensajes[0].texto, /asistente financiero/);
});

test('gasto sin duplicado → guarda y confirma', async () => {
    const state = crearEntorno();
    const deps = hacerDeps(state, { extraccion: { esGasto: true, datos: datosBase } });
    const whatsapp = await invocar(state, deps);

    assert.equal(state.pagos.length, 1);
    assert.match(whatsapp.mensajes[0].texto, /Anotado/);
});

test('duplicado misma fecha → NO guarda, deja pendiente y pregunta', async () => {
    const state = crearEntorno({
        pagosIniciales: [{ telefono: TEL, message_id: 'seed', ...datosBase }],
    });
    const deps = hacerDeps(state, { extraccion: { esGasto: true, datos: datosBase } });
    const whatsapp = await invocar(state, deps, { messageId: 'msg-nuevo' });

    assert.equal(state.pagos.length, 1, 'no debe insertar el duplicado');
    assert.ok(state.pendientes.has(TEL), 'debe quedar una confirmación pendiente');
    assert.match(whatsapp.mensajes[0].texto, /Ya tenés anotado/);
});

test('duplicado de otra fecha → guarda igual y avisa (probable recurrente)', async () => {
    const previo = { telefono: TEL, message_id: 'seed', ...datosBase, fecha_gasto: '2026-07-01' };
    const state = crearEntorno({ pagosIniciales: [previo] });
    const deps = hacerDeps(state, { extraccion: { esGasto: true, datos: datosBase } });
    const whatsapp = await invocar(state, deps, { messageId: 'msg-nuevo' });

    assert.equal(state.pagos.length, 2, 'debe insertar el gasto nuevo');
    assert.match(whatsapp.mensajes[0].texto, /Anotado/);
    assert.match(whatsapp.mensajes[0].texto, /ya tenías un gasto igual/);
});

test('respuesta "sí" a una pendiente → inserta el gasto guardado y confirma', async () => {
    const state = crearEntorno({
        pendientes: {
            [TEL]: {
                telefono: TEL,
                payload: { messageId: 'orig', datos: datosBase },
                motivo: 'duplicado_misma_fecha',
                created_at: new Date().toISOString(),
            },
        },
    });
    const deps = hacerDeps(state, {});
    const whatsapp = await invocar(state, deps, { messageId: 'reply-si', texto: 'sí, dale' });

    assert.equal(state.pagos.length, 1);
    assert.equal(state.pagos[0].message_id, 'orig');
    assert.ok(!state.pendientes.has(TEL), 'la pendiente debe limpiarse');
    assert.match(whatsapp.mensajes[0].texto, /Anotado/);
});

test('respuesta "no" a una pendiente → descarta sin guardar', async () => {
    const state = crearEntorno({
        pendientes: {
            [TEL]: {
                telefono: TEL,
                payload: { messageId: 'orig', datos: datosBase },
                motivo: 'duplicado_misma_fecha',
                created_at: new Date().toISOString(),
            },
        },
    });
    const deps = hacerDeps(state, {});
    const whatsapp = await invocar(state, deps, { messageId: 'reply-no', texto: 'no, es el mismo' });

    assert.equal(state.pagos.length, 0);
    assert.ok(!state.pendientes.has(TEL));
    assert.match(whatsapp.mensajes[0].texto, /no lo anoto/);
});

test('respuesta ambigua a una pendiente → vuelve a preguntar y mantiene la pendiente', async () => {
    const state = crearEntorno({
        pendientes: {
            [TEL]: {
                telefono: TEL,
                payload: { messageId: 'orig', datos: datosBase },
                motivo: 'duplicado_misma_fecha',
                created_at: new Date().toISOString(),
            },
        },
    });
    const deps = hacerDeps(state, {});
    const whatsapp = await invocar(state, deps, { messageId: 'reply-eh', texto: 'ni idea' });

    assert.equal(state.pagos.length, 0);
    assert.ok(state.pendientes.has(TEL), 'la pendiente debe seguir viva');
    assert.match(whatsapp.mensajes[0].texto, /No te entendí/);
});

test('error del LLM → avisa al usuario en vez de fallar en silencio', async () => {
    const state = crearEntorno();
    const deps = hacerDeps(state, { errorLLM: true });
    const whatsapp = await invocar(state, deps);

    assert.equal(state.pagos.length, 0);
    assert.match(whatsapp.mensajes[0].texto, /problema procesando/);
});
