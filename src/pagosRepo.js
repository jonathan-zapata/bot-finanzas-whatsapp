const TABLA = 'pagos';
const CODIGO_VIOLACION_UNIQUE = '23505';

// Chequeo previo por message_id: evita gastar una llamada al LLM y una escritura
// cuando WhatsApp reintenta la entrega de un mensaje ya procesado.
// Requiere una columna `message_id` (idealmente única) en la tabla `pagos` —
// ver README / notas de despliegue.
export async function yaFueProcesado(supabase, messageId) {
    const { data, error } = await supabase
        .from(TABLA)
        .select('id')
        .eq('message_id', messageId)
        .maybeSingle();

    if (error) {
        console.error('❌ Error chequeando idempotencia (se continúa sin bloquear):', error);
        return false;
    }
    return Boolean(data);
}

// Red de seguridad ante una carrera entre el chequeo previo y el insert: si la
// columna message_id tiene una constraint UNIQUE, un duplicado cae acá en vez de
// insertarse dos veces.
export async function guardarPago(supabase, { telefono, messageId, datos }) {
    const { error } = await supabase.from(TABLA).insert([
        {
            telefono,
            message_id: messageId,
            servicio: datos.servicio,
            monto: datos.monto,
            divisa: datos.divisa,
            metodo_pago: datos.metodo_pago,
            cuotas: datos.cuotas,
            categoria: datos.categoria,
            fecha_gasto: datos.fecha_gasto,
        },
    ]);

    if (error) {
        if (error.code === CODIGO_VIOLACION_UNIQUE) {
            return { duplicado: true };
        }
        throw error;
    }
    return { duplicado: false };
}
