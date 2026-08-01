const TABLA = 'confirmaciones_pendientes';
const VENTANA_MINUTOS_DEFAULT = 30;

// Devuelve la confirmación pendiente del usuario si existe y no expiró.
// El TTL se aplica acá (no en la base): una pendiente más vieja que la ventana se
// borra y se trata como inexistente, así una pregunta sin responder no queda
// "trabando" al usuario para siempre.
export async function obtenerPendiente(supabase, telefono, ventanaMinutos = VENTANA_MINUTOS_DEFAULT) {
    const { data, error } = await supabase
        .from(TABLA)
        .select('*')
        .eq('telefono', telefono)
        .maybeSingle();

    if (error) {
        console.error('❌ Error leyendo confirmación pendiente (se continúa sin bloquear):', error);
        return null;
    }
    if (!data) return null;

    const edadMs = Date.now() - new Date(data.created_at).getTime();
    if (edadMs > ventanaMinutos * 60_000) {
        await borrarPendiente(supabase, telefono);
        return null;
    }
    return data;
}

// Guarda (o reemplaza) la confirmación pendiente del usuario. Upsert por telefono:
// solo puede haber una pregunta abierta por número, y guardar una nueva reinicia
// el reloj del TTL.
export async function guardarPendiente(supabase, { telefono, payload, motivo }) {
    const { error } = await supabase
        .from(TABLA)
        .upsert(
            { telefono, payload, motivo, created_at: new Date().toISOString() },
            { onConflict: 'telefono' }
        );
    if (error) throw error;
}

export async function borrarPendiente(supabase, telefono) {
    const { error } = await supabase.from(TABLA).delete().eq('telefono', telefono);
    if (error) {
        console.error('❌ Error borrando confirmación pendiente:', error);
    }
}
