import { extraerGasto } from './aiExtractor.js';
import { yaFueProcesado, guardarPago } from './pagosRepo.js';

const MENSAJE_BIENVENIDA =
    "¡Hola! 👋 Soy tu asistente financiero. Contame qué pagaste hoy (ej: 'Pagué 2000 de Antel en efectivo') y te lo anoto en tu registro.";
const MENSAJE_ERROR_LLM = 'Hubo un problema procesando tu mensaje. Probá de nuevo en un momento 🙏';
const MENSAJE_ERROR_GUARDADO = 'Hubo un error al guardar tu pago. Intentá de nuevo.';

function formatearConfirmacion(datos) {
    let mensaje = `✅ ¡Anotado!\nGuardé un pago de *${datos.monto} ${datos.divisa}* para *${datos.servicio}*.\n📂 Rubro: ${datos.categoria}\n📅 Fecha: ${datos.fecha_gasto}`;
    if (datos.cuotas > 1) {
        mensaje += `\n💳 Registrado en *${datos.cuotas} cuotas*.`;
    }
    return mensaje;
}

// El punto único de entrada para un mensaje de texto entrante ya autenticado
// (firma de Meta verificada en index.js). Hoy solo hay un camino real (registrar
// gasto vs. saludo); queda como el lugar natural para sumar más intenciones
// (ej. consultas) más adelante.
export async function manejarMensajeEntrante({
    supabase,
    ai,
    whatsapp,
    numeroUsuario,
    messageId,
    textoUsuario,
    modelo,
}) {
    if (await yaFueProcesado(supabase, messageId)) {
        console.log(`Mensaje ${messageId} ya procesado, ignorando reintento de WhatsApp.`);
        return;
    }

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

    console.log('🧠 IA extrajo:', extraccion.datos);

    try {
        const { duplicado } = await guardarPago(supabase, {
            telefono: numeroUsuario,
            messageId,
            datos: extraccion.datos,
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

    await whatsapp.enviarMensaje(numeroUsuario, formatearConfirmacion(extraccion.datos));
}
