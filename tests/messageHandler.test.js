import test from 'node:test';
import assert from 'node:assert/strict';
import { manejarMensajeEntrante } from '../src/messageHandler.js';

function crearSupabaseFalso({ yaExiste = false, errorAlInsertar = null } = {}) {
    const inserts = [];
    return {
        inserts,
        from() {
            return {
                select() {
                    return {
                        eq() {
                            return {
                                async maybeSingle() {
                                    return { data: yaExiste ? { id: 1 } : null, error: null };
                                },
                            };
                        },
                    };
                },
                async insert(filas) {
                    inserts.push(...filas);
                    return { error: errorAlInsertar };
                },
            };
        },
    };
}

function crearAiFalso(respuestaJson) {
    return {
        chat: {
            completions: {
                async create() {
                    return { choices: [{ message: { content: JSON.stringify(respuestaJson) } }] };
                },
            },
        },
    };
}

function crearWhatsappFalso() {
    const mensajes = [];
    return {
        mensajes,
        async enviarMensaje(destino, texto) {
            mensajes.push({ destino, texto });
        },
    };
}

const datosGastoValido = {
    servicio: 'Antel',
    monto: 2000,
    divisa: 'UYU',
    metodo_pago: 'efectivo',
    cuotas: 1,
    categoria: 'Servicios',
    fecha_gasto: '2026-07-30',
};

test('ignora un mensaje ya procesado (idempotencia) sin llamar al LLM ni escribir', async () => {
    const supabase = crearSupabaseFalso({ yaExiste: true });
    const ai = crearAiFalso({});
    const whatsapp = crearWhatsappFalso();

    await manejarMensajeEntrante({
        supabase,
        ai,
        whatsapp,
        numeroUsuario: '123',
        messageId: 'wamid.repetido',
        textoUsuario: 'Pagué 100 UYU',
    });

    assert.equal(supabase.inserts.length, 0);
    assert.equal(whatsapp.mensajes.length, 0);
});

test('guarda un gasto válido y confirma al usuario', async () => {
    const supabase = crearSupabaseFalso();
    const ai = crearAiFalso(datosGastoValido);
    const whatsapp = crearWhatsappFalso();

    await manejarMensajeEntrante({
        supabase,
        ai,
        whatsapp,
        numeroUsuario: '123',
        messageId: 'wamid.nuevo',
        textoUsuario: 'Pagué 2000 de Antel en efectivo',
    });

    assert.equal(supabase.inserts.length, 1);
    assert.equal(supabase.inserts[0].message_id, 'wamid.nuevo');
    assert.match(whatsapp.mensajes[0].texto, /Anotado/);
});

test('responde con el mensaje de bienvenida si el mensaje no describe un gasto', async () => {
    const supabase = crearSupabaseFalso();
    const ai = crearAiFalso({});
    const whatsapp = crearWhatsappFalso();

    await manejarMensajeEntrante({
        supabase,
        ai,
        whatsapp,
        numeroUsuario: '123',
        messageId: 'wamid.saludo',
        textoUsuario: 'Hola',
    });

    assert.equal(supabase.inserts.length, 0);
    assert.match(whatsapp.mensajes[0].texto, /asistente financiero/);
});

test('avisa al usuario si falla la llamada al LLM, en vez de fallar en silencio', async () => {
    const supabase = crearSupabaseFalso();
    const ai = { chat: { completions: { async create() { throw new Error('timeout'); } } } };
    const whatsapp = crearWhatsappFalso();

    await manejarMensajeEntrante({
        supabase,
        ai,
        whatsapp,
        numeroUsuario: '123',
        messageId: 'wamid.error-llm',
        textoUsuario: 'Pagué 2000 de Antel',
    });

    assert.equal(supabase.inserts.length, 0);
    assert.equal(whatsapp.mensajes.length, 1);
    assert.match(whatsapp.mensajes[0].texto, /problema procesando/);
});

test('no duplica ni reenvía confirmación si el insert choca con la constraint única', async () => {
    const supabase = crearSupabaseFalso({ errorAlInsertar: { code: '23505', message: 'duplicate key' } });
    const ai = crearAiFalso(datosGastoValido);
    const whatsapp = crearWhatsappFalso();

    await manejarMensajeEntrante({
        supabase,
        ai,
        whatsapp,
        numeroUsuario: '123',
        messageId: 'wamid.carrera',
        textoUsuario: 'Pagué 2000 de Antel en efectivo',
    });

    assert.equal(whatsapp.mensajes.length, 0);
});
