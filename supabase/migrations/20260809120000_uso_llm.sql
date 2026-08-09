-- ============================================================================
-- Migration: LLM usage & cost ledger.
--
-- Records one row per LLM (Groq) call the bot makes, tagged by which agent made
-- it, so accumulated token consumption and cost are queryable per agent — the
-- data the `email costos` report reads. Before this, usage was only visible as
-- ephemeral rate-limit lines in the Cloud Run logs; nothing was persisted and
-- `completion.usage` was never read at all.
--
-- Cost is computed at WRITE time from the model's price (src/llmPricing.js), so
-- the stored figure stays stable even if Groq changes its rates later. It's an
-- estimate: on the free tier the amount actually billed is US$0.
--
-- Idempotent (IF NOT EXISTS). Column names stay in Spanish, matching the rest
-- of the live schema (see `pagos`, `mensajes_procesados`).
-- ============================================================================

create table if not exists uso_llm (
    id              bigint generated always as identity primary key,
    agente          text           not null,          -- 'expense' | 'email' (matches each agent's domain)
    modelo          text           not null,          -- e.g. 'llama-3.3-70b-versatile'
    tokens_entrada  integer        not null default 0,
    tokens_salida   integer        not null default 0,
    costo_usd       numeric(12, 6) not null default 0, -- estimated, from src/llmPricing.js
    created_at      timestamptz    not null default now()
);

comment on table uso_llm is
    'Per-call LLM usage ledger: tokens in/out and estimated USD cost, tagged by '
    'agent. Written best-effort after every completion; read by the cost report '
    '(email costos). Free-tier real cost is US$0.';

-- The cost report aggregates by agent over a recent window; these back both.
create index if not exists idx_uso_llm_created_at on uso_llm (created_at);
create index if not exists idx_uso_llm_agente on uso_llm (agente);
