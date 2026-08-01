-- ============================================================================
-- Migration: short-term conversational memory to confirm duplicates.
--
-- Gives the bot a bit of "memory" between one message and the next: when it
-- detects an expense that might be a duplicate, it saves the extracted
-- expense here and asks the user over WhatsApp whether to log it or not.
-- That user's next message is interpreted as the answer.
--
-- One row per user at a time (telefono is the PK) — keeps the logic simple:
-- there can only be one pending question per number.
--
-- It's idempotent (everything uses IF NOT EXISTS): it can be run more than
-- once without breaking anything.
--
-- Table/column names stay in Spanish on purpose, matching the rest of the
-- live schema (see `pagos`).
-- ============================================================================

create table if not exists confirmaciones_pendientes (
    telefono    text primary key,
    payload     jsonb       not null,          -- the validated expense, waiting for confirmation
    motivo      text,                          -- why we asked (e.g. 'duplicate_same_date')
    created_at  timestamptz not null default now()
);

comment on table confirmaciones_pendientes is
    'Ephemeral conversational state: expenses awaiting duplicate confirmation. '
    'Expiration (TTL) is applied in the app logic: rows older than the '
    'configured window are ignored and overwritten by the next question.';

-- Index to speed up exact-duplicate detection on the `pagos` table
-- (same telefono + servicio + monto + divisa). Without this, every message
-- would do a full scan of `pagos` to look for matches.
create index if not exists idx_pagos_dup_check
    on pagos (telefono, servicio, monto, divisa);
