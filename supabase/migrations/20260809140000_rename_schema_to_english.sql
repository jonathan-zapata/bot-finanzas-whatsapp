-- ============================================================================
-- Migration: rename the whole schema (tables + columns) to English.
--
-- The live schema was originally in Spanish (it mirrored the LLM's output
-- contract and the bot's Uruguayan users). Going forward the DATABASE naming
-- convention is English; the LLM's JSON contract and every user-facing string
-- stay in Spanish (see aiExtractor.js and the WhatsApp copy), and the enum
-- VALUES stored in columns (e.g. 'credito', 'Vivienda', 'UYU') are data, not
-- identifiers, so they are left untouched.
--
-- Fully IDEMPOTENT: every rename is guarded, so it's safe to run more than once
-- and safe whether a given table/column has already been renamed. It converges
-- any database — old Spanish schema, brand-new English schema, or a half-migrated
-- one — to the same English shape. `to_regclass` returns NULL for a missing
-- relation; column guards check information_schema.
--
-- Rename map:
--   pagos                    -> payments
--     telefono->phone, servicio->service, monto->amount, divisa->currency,
--     metodo_pago->payment_method, cuotas->installments, categoria->category,
--     fecha_gasto->expense_date
--   mensajes_procesados      -> processed_messages      (telefono->phone)
--   confirmaciones_pendientes-> pending_confirmations   (telefono->phone,
--                                                         motivo->reason,
--                                                         dominio->domain)
--   email_metadata_cache     -> (unchanged name)        (telefono->phone,
--                                                         datos->data)
--   email_taxonomia          -> email_taxonomy          (telefono->phone,
--                                                         categorias->categories)
--   uso_llm                  -> llm_usage               (agente->agent,
--                                                         modelo->model,
--                                                         tokens_entrada->tokens_in,
--                                                         tokens_salida->tokens_out,
--                                                         costo_usd->cost_usd)
-- ============================================================================

-- ── 1. Table renames ────────────────────────────────────────────────────────
do $$
begin
    if to_regclass('public.pagos') is not null and to_regclass('public.payments') is null then
        alter table pagos rename to payments;
    end if;
    if to_regclass('public.mensajes_procesados') is not null and to_regclass('public.processed_messages') is null then
        alter table mensajes_procesados rename to processed_messages;
    end if;
    if to_regclass('public.confirmaciones_pendientes') is not null and to_regclass('public.pending_confirmations') is null then
        alter table confirmaciones_pendientes rename to pending_confirmations;
    end if;
    if to_regclass('public.email_taxonomia') is not null and to_regclass('public.email_taxonomy') is null then
        alter table email_taxonomia rename to email_taxonomy;
    end if;
    if to_regclass('public.uso_llm') is not null and to_regclass('public.llm_usage') is null then
        alter table uso_llm rename to llm_usage;
    end if;
end $$;

-- ── 2. Column renames ───────────────────────────────────────────────────────
-- Helper: renames a column only if the old name still exists and the new one
-- doesn't yet (so it's idempotent and never collides). It lives in pg_temp, so
-- it's session-local and disappears when the connection closes — nothing left
-- behind in the schema.
create or replace function pg_temp.rename_col_if_exists(tbl text, old_name text, new_name text)
returns void language plpgsql as $$
begin
    if to_regclass('public.' || tbl) is not null
       and exists (
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = tbl and column_name = old_name
       )
       and not exists (
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = tbl and column_name = new_name
       )
    then
        execute format('alter table %I rename column %I to %I', tbl, old_name, new_name);
    end if;
end $$;

select pg_temp.rename_col_if_exists('payments', 'telefono', 'phone');
select pg_temp.rename_col_if_exists('payments', 'servicio', 'service');
select pg_temp.rename_col_if_exists('payments', 'monto', 'amount');
select pg_temp.rename_col_if_exists('payments', 'divisa', 'currency');
select pg_temp.rename_col_if_exists('payments', 'metodo_pago', 'payment_method');
select pg_temp.rename_col_if_exists('payments', 'cuotas', 'installments');
select pg_temp.rename_col_if_exists('payments', 'categoria', 'category');
select pg_temp.rename_col_if_exists('payments', 'fecha_gasto', 'expense_date');

select pg_temp.rename_col_if_exists('processed_messages', 'telefono', 'phone');

select pg_temp.rename_col_if_exists('pending_confirmations', 'telefono', 'phone');
select pg_temp.rename_col_if_exists('pending_confirmations', 'motivo', 'reason');
select pg_temp.rename_col_if_exists('pending_confirmations', 'dominio', 'domain');

select pg_temp.rename_col_if_exists('email_metadata_cache', 'telefono', 'phone');
select pg_temp.rename_col_if_exists('email_metadata_cache', 'datos', 'data');

select pg_temp.rename_col_if_exists('email_taxonomy', 'telefono', 'phone');
select pg_temp.rename_col_if_exists('email_taxonomy', 'categorias', 'categories');

select pg_temp.rename_col_if_exists('llm_usage', 'agente', 'agent');
select pg_temp.rename_col_if_exists('llm_usage', 'modelo', 'model');
select pg_temp.rename_col_if_exists('llm_usage', 'tokens_entrada', 'tokens_in');
select pg_temp.rename_col_if_exists('llm_usage', 'tokens_salida', 'tokens_out');
select pg_temp.rename_col_if_exists('llm_usage', 'costo_usd', 'cost_usd');

-- ── 3. Index renames (cosmetic; IF EXISTS keeps this idempotent) ─────────────
alter index if exists idx_pagos_dup_check rename to idx_payments_dup_check;
alter index if exists idx_uso_llm_created_at rename to idx_llm_usage_created_at;
alter index if exists idx_uso_llm_agente rename to idx_llm_usage_agent;
