-- ============================================================================
-- Migration: confirmed category taxonomy for the email agent.
--
-- Stores the semantic categories the user confirmed once (built from their real
-- folders + rule names). Durable — it outlives the ~2h metadata cache and every
-- session — so inbox summaries are labeled consistently over time. `email
-- rebuild categories` overwrites it.
--
-- The stored list always includes a standing "Other/Uncategorized" bucket
-- (enforced in app logic) so sender classification always has a safe fallback.
--
-- One row per user (telefono is the PK). Idempotent (IF NOT EXISTS).
-- ============================================================================

create table if not exists email_taxonomia (
    telefono    text primary key,
    categorias  jsonb       not null,   -- ordered list of category names
    updated_at  timestamptz not null default now()
);

comment on table email_taxonomia is
    'Per-user confirmed category taxonomy for the email agent (durable). Always '
    'includes a standing Other/Uncategorized category.';
