-- ============================================================================
-- Migración: memoria conversacional de corto plazo para confirmar duplicados.
--
-- Da al bot un pedacito de "memoria" entre un mensaje y el siguiente: cuando
-- detecta un gasto que podría ser duplicado, guarda acá el gasto extraído y le
-- pregunta al usuario por WhatsApp si lo anota o no. El próximo mensaje de ese
-- usuario se interpreta como la respuesta.
--
-- Una fila por usuario a la vez (telefono es PK) — mantiene la lógica simple:
-- solo puede haber una pregunta pendiente por número.
--
-- Es idempotente (todo con IF NOT EXISTS): se puede correr más de una vez sin
-- romper nada.
-- ============================================================================

create table if not exists confirmaciones_pendientes (
    telefono    text primary key,
    payload     jsonb       not null,          -- el gasto validado, esperando confirmación
    motivo      text,                          -- por qué preguntamos (ej: 'duplicado_misma_fecha')
    created_at  timestamptz not null default now()
);

comment on table confirmaciones_pendientes is
    'Estado conversacional efímero: gastos a la espera de confirmación de duplicado. '
    'La expiración (TTL) se aplica en la lógica de la app: las filas más viejas que la '
    'ventana configurada se ignoran y se sobrescriben con la próxima pregunta.';

-- Índice para acelerar la detección de duplicados exactos en la tabla `pagos`
-- (mismo telefono + servicio + monto + divisa). Sin esto, cada mensaje haría un
-- scan completo de `pagos` para buscar coincidencias.
create index if not exists idx_pagos_dup_check
    on pagos (telefono, servicio, monto, divisa);
