import { extraerGasto as extraerGastoReal } from './aiExtractor.js';
import {
    yaFueProcesado as yaFueProcesadoReal,
    guardarPago as guardarPagoReal,
    buscarDuplicadoExacto as buscarDuplicadoExactoReal,
} from './pagosRepo.js';
import {
    obtenerPendiente as obtenerPendienteReal,
    guardarPendiente as guardarPendienteReal,
    borrarPendiente as borrarPendienteReal,
} from './confirmacionesRepo.js';
import { interpretarRespuesta } from './respuestaParser.js';

const MENSAJE_BIENVENIDA =
    "¡Hola! 👋 Soy tu asistente financiero. Contame qué pagaste hoy (ej: 'Pagué 2000 de Antel en efectivo') y te lo anoto en tu registro.";
const MENSAJE_ERROR_LLM = 'Hubo un problema procesando tu mensaje. Probá de nuevo en un momento 🙏';
const MENSAJE_ERROR_GUARDADO = 'Hubo un error al guardar tu pago. Intentá de nuevo.';
const MENSAJE_NO_ENTENDI =
    '🤔 No te entendí. Respondé *sí* para anotar el gasto igual, o *no* si es el mismo que ya tenías.';
const MENSAJE_DESCARTADO = '👍 Listo, no lo anoto entonces.';

function formatearConfirmacion(datos) {
    let mensaje = `✅ ¡Anotado!\nGuardé un pago de *${datos.monto} ${datos.divisa}* para *${datos.servicio}*.\n📂 Rubro: ${datos.categoria}\n📅 Fecha: ${datos.fecha_gasto}`;
    if (datos.cuotas > 1) {
        mensaje += `\n💳 Registrado en *${datos.cuotas} cuotas*.`;
    }
    return mensaje;
}

function preguntaDuplicado(datos, existente) {
    return `🤔 Ya tenés anotado un gasto de *${datos.monto} ${datos.divisa}* en *${datos.servicio}* con fecha *${existente.fecha_gasto}*.\n¿Es un gasto nuevo? Respondé *sí* y lo anoto, o *no* si es el mismo de antes.`;
}

function avisoRecurrente(existente) {
    return `\n\nℹ️ Ojo: ya tenías un gasto igual del *${existente.fecha_gasto}*. Como este es de otra fecha lo anoté igual; si era repetido, avisame.`;
}

// El punto único de entrada para un mensaje de texto entrante ya autenticado
// (firma de Meta verificada en index.js). Es una máquina de estados chica:
//
//   1. ¿Ya procesamos este message_id? (idempotencia ante reintentos del webhook)
//   2. ¿El usuario tiene una confirmación pendiente? → este mensaje es su respuesta
//   3. Si no, flujo normal: extraer gasto → detectar duplicado exacto →
//        - misma fecha  → PREGUNTAR (guardar pendiente, no insertar aún)
//        - otra fecha   → INSERTAR + avisar (probable recurrente)
//        - sin match    → INSERTAR normal
//
// Las dependencias de datos/IA se inyectan (deps) con default a las reales, así
// los tests fakean cada costura sin simular Supabase ni la red.
export async function manejarMensajeEntrante(args) {
    const {
        supabase,
        ai,
        whatsapp,
        numeroUsuario,
        messageId,
        textoUsuario,
        modelo,
        ventanaConfirmacionMin,
        deps = {},
    } = args;

    const {
        yaFueProcesado = yaFueProcesadoReal,
        extraerGasto = extraerGastoReal,
        buscarDuplicadoExacto = buscarDuplicadoExactoReal,
        guardarPago = guardarPagoReal,
        obtenerPendiente = obtenerPendienteReal,
        guardarPendiente = guardarPendienteReal,
        borrarPendiente = borrarPendienteReal,
    } = deps;

    // 1. Idempotencia: reintento del webhook sobre un mensaje ya procesado.
    if (await yaFueProcesado(supabase, messageId)) {
        console.log(`Mensaje ${messageId} ya procesado, ignorando reintento de WhatsApp.`);
        return;
    }

    // 2. ¿Este mensaje es la respuesta a una pregunta de confirmación pendiente?
    const pendiente = await obtenerPendiente(supabase, numeroUsuario, ventanaConfirmacionMin);
    if (pendiente) {
        await manejarRespuestaConfirmacion({
            whatsapp,
            supabase,
            numeroUsuario,
            textoUsuario,
            pendiente,
            guardarPago,
            borrarPendiente,
        });
        return;
    }

    // 3. Flujo normal: extraer el gasto del texto.
    let extraccion;
    try {
        extraccion = await extraerGasto(ai, textoUsuario, modelo);
    } catch (error) {
        console.error('❌ Error consultando al LLM:', error);
        await whatsapp.enviarMensaje(numeroUsuario, MENSAJE_ERROR_LLM);
        return;
    }

    if (!extraccion.esGasto) {
        await whatsapp.enviarMensaje(numeroUsuario, MENSAJE_BIENVENIDA);
        return;
    }

    const datos = extraccion.datos;
    console.log('🧠 IA extrajo:', datos);

    // 3a. ¿Existe un gasto que coincide exactamente (tel + servicio + monto + divisa)?
    let existente = null;
    try {
        existente = await buscarDuplicadoExacto(supabase, {
            telefono: numeroUsuario,
            servicio: datos.servicio,
            monto: datos.monto,
            divisa: datos.divisa,
        });
    } catch (error) {
        console.error('❌ Error buscando duplicado (se continúa e inserta):', error);
    }

    // 3b. Misma fecha → sospechoso de duplicado técnico → preguntar, NO insertar.
    if (existente && existente.fecha_gasto === datos.fecha_gasto) {
        try {
            await guardarPendiente(supabase, {
                telefono: numeroUsuario,
                payload: { messageId, datos },
                motivo: 'duplicado_misma_fecha',
            });
        } catch (error) {
            console.error('❌ Error guardando confirmación pendiente:', error);
            await whatsapp.enviarMensaje(numeroUsuario, MENSAJE_ERROR_GUARDADO);
            return;
        }
        await whatsapp.enviarMensaje(numeroUsuario, preguntaDuplicado(datos, existente));
        return;
    }

    // 3c. Sin match, u otra fecha (probable recurrente) → insertar.
    try {
        const { duplicado } = await guardarPago(supabase, {
            telefono: numeroUsuario,
            messageId,
            datos,
        });
        if (duplicado) {
            console.log(`Insert duplicado detectado para ${messageId}; ya estaba guardado.`);
            return;
        }
    } catch (error) {
        console.error('❌ Error guardando en Supabase:', error);
        await whatsapp.enviarMensaje(numeroUsuario, MENSAJE_ERROR_GUARDADO);
        return;
    }

    let mensaje = formatearConfirmacion(datos);
    if (existente) mensaje += avisoRecurrente(existente);
    await whatsapp.enviarMensaje(numeroUsuario, mensaje);
}

// Interpreta la respuesta del usuario a una pregunta de duplicado y actúa.
async function manejarRespuestaConfirmacion({
    whatsapp,
    supabase,
    numeroUsuario,
    textoUsuario,
    pendiente,
    guardarPago,
    borrarPendiente,
}) {
    const decision = interpretarRespuesta(textoUsuario);

    if (decision === 'ambiguo') {
        // No entendimos: dejamos la pendiente intacta y volvemos a preguntar.
        await whatsapp.enviarMensaje(numeroUsuario, MENSAJE_NO_ENTENDI);
        return;
    }

    if (decision === 'no') {
        await borrarPendiente(supabase, numeroUsuario);
        await whatsapp.enviarMensaje(numeroUsuario, MENSAJE_DESCARTADO);
        return;
    }

    // decision === 'si' → insertar el gasto que había quedado en espera.
    const { messageId, datos } = pendiente.payload;
    try {
        await guardarPago(supabase, { telefono: numeroUsuario, messageId, datos });
    } catch (error) {
        console.error('❌ Error guardando el pago confirmado:', error);
        // No borramos la pendiente: el usuario puede reintentar respondiendo de nuevo.
        await whatsapp.enviarMensaje(numeroUsuario, MENSAJE_ERROR_GUARDADO);
        return;
    }
    await borrarPendiente(supabase, numeroUsuario);
    await whatsapp.enviarMensaje(numeroUsuario, formatearConfirmacion(datos));
}
