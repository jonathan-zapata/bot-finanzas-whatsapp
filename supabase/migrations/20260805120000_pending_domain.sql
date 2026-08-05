-- ============================================================================
-- Migration: add a domain discriminator to pending questions.
--
-- The bot now has two agents (expense + email) behind a Level-1 router. A reply
-- to a pending question carries no prefix (the user just types "2" or "sí"), so
-- the router needs to know which agent asked in order to route the answer back
-- to it. `dominio` records that owner.
--
-- Defaulting to 'expense' keeps every pre-existing row valid: before this
-- migration the only agent that ever asked a question was the expense flow.
--
-- Idempotent (IF NOT EXISTS): safe to run more than once. Column name stays in
-- Spanish, matching the rest of the live schema (telefono, motivo).
-- ============================================================================

alter table confirmaciones_pendientes
    add column if not exists dominio text not null default 'expense';

comment on column confirmaciones_pendientes.dominio is
    'Which agent asked the pending question (e.g. ''expense'', ''email''), so a '
    'bare reply can be routed back to that agent. Defaults to ''expense''.';
