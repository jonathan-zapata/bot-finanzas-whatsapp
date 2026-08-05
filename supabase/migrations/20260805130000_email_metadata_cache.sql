-- ============================================================================
-- Migration: metadata cache for the email agent.
--
-- Stores the last mailbox metadata pull per user (~2h TTL, applied in app
-- logic) so follow-up analytical questions are answered without re-hitting
-- Microsoft Graph each time. `email refresh` overrides it with a fresh pull.
--
-- Only METADATA is ever stored in `datos`: sender (name + address), subject,
-- received date, read status, attachment flag, parent folder ids, folder list
-- and message rules. Never message bodies — caching must not weaken the
-- content-privacy guarantee.
--
-- One row per user (telefono is the PK). Idempotent (IF NOT EXISTS).
-- ============================================================================

create table if not exists email_metadata_cache (
    telefono    text primary key,
    datos       jsonb       not null,   -- normalized metadata pull (no bodies)
    created_at  timestamptz not null default now()
);

comment on table email_metadata_cache is
    'Per-user cache of the last email metadata pull (~2h TTL in app logic). '
    'Metadata only — never message bodies.';
