-- ============================================================================
-- Migration: domain-agnostic message idempotency.
--
-- Records every WhatsApp message the bot has fully handled, keyed by
-- message_id, so a webhook retry from Meta is a no-op regardless of which agent
-- handled it (expense OR email). Before this, idempotency was inferred from the
-- `pagos` table, which meant email-agent messages — that never create a payment
-- — were not protected against retries.
--
-- The `pagos.message_id` UNIQUE constraint remains as an expense-specific
-- backstop against races. One row per handled message. Idempotent (IF NOT
-- EXISTS). Column names in Spanish, matching the rest of the live schema.
-- ============================================================================

create table if not exists mensajes_procesados (
    message_id  text primary key,
    telefono    text,
    created_at  timestamptz not null default now()
);

comment on table mensajes_procesados is
    'Idempotency ledger: every WhatsApp message_id the bot has fully handled, '
    'across all agents. A retry of a recorded id is ignored.';
