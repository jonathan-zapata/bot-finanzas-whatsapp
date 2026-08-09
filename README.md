# bot-finanzas-whatsapp

WhatsApp bot with two agents behind a deterministic router:

- **Expense agent** (default) — logs your expenses automatically. Write to it in natural language (e.g. *"Pagué 2000 de Antel en efectivo"*) and the bot uses an LLM to extract the data, validates the result, and saves it to Supabase — replying on WhatsApp with a confirmation.
- **Email agent** — reach it with the `email …` prefix (e.g. *"email dame un resumen"*). It connects to a personal Microsoft (Hotmail/Outlook) mailbox **read-only** and answers questions about it: a semantic inbox summary, a folder/rule x-ray, folder/rule recommendations, and a confirmable category taxonomy. See [Email agent](#email-agent-read-only).

A **Level-1 router** picks the agent by explicit prefix (never an LLM guess); an `email …` message goes to the email agent, everything else to the expense agent unchanged. Within the email agent, a **Level-2 LLM classifier** maps the request to a closed set of read-only actions.

## How it works

1. Meta (WhatsApp Cloud API) sends a `POST /webhook` with the user's message.
2. The `X-Hub-Signature-256` signature is verified with the App Secret before processing anything.
3. If the user has a pending confirmation question (see below), the message is interpreted as the answer to that question.
4. Otherwise, the text is sent to the LLM (any OpenAI-compatible endpoint) to extract the expense: item, amount, currency, payment method, installments, category, and date.
5. The result is validated against a strict schema (Zod) — if the LLM hallucinates a value outside the expected enums, it's discarded instead of saved.
6. A possible exact duplicate (same phone + item + amount + currency) is looked up in `pagos`:
   - Same date → suspected technical duplicate (e.g. a retry), so the user is asked before saving.
   - Different date → saved anyway, with a note that it looks like a recurring expense.
   - No match → saved directly.
7. The bot replies on WhatsApp confirming what was logged.

Every message is processed idempotently by `message_id`, recorded in a domain-agnostic `mensajes_procesados` ledger: if Meta retries delivery of a webhook, the action isn't repeated and the LLM isn't queried again — for **either** agent (expenses and email). The `pagos.message_id` UNIQUE constraint remains as an expense-specific backstop against races.

## Project structure

```
index.js                       Express server: webhook routes + Microsoft OAuth callback
src/
  config.js                    Loads and validates environment variables
  whatsappClient.js            Sends messages and verifies Meta's signature
  messageHandler.js            Level-1 router: idempotency → pending → prefix dispatch
  responseParser.js            Interprets the user's yes/no answers

  # LLM cost tracking (both agents)
  llmRateLimitLog.js           Wraps the LLM client: logs rate-limit headers + reports token usage
  llmPricing.js                Per-model Groq token prices → USD cost of a call
  llmUsageRepo.js              Writes/reads the `uso_llm` ledger (per-agent tokens + cost)
  usageReport.js               Renders the `email costos` report

  # Expense agent (default)
  expenseAgent.js              Expense flow as an agent (extract → dedupe → save)
  aiExtractor.js               LLM prompt + Zod validation of the extracted expense
  paymentsRepo.js              Access to the `pagos` table (save, dedupe, idempotency)
  pendingConfirmationsRepo.js  Shared pending-question store (with a `dominio` discriminator)

  # Email agent (email … prefix, read-only)
  emailAgent.js                Orchestrates: classify → connect/gate → run action → reply
  emailIntentClassifier.js     Level-2 LLM classifier over a closed, Zod-validated enum
  emailServices.js             Composes auth + Graph + cache + taxonomy into one bundle
  microsoftAuth.js             OAuth: consent URL, code exchange, rotating-token refresh
  secretManager.js             GCP Secret Manager wrapper (the rotating refresh token)
  graphClient.js               Microsoft Graph reads (metadata-only $select; 429 backoff)
  metadataCacheRepo.js         ~2h metadata cache (`email_metadata_cache`)
  taxonomyBuilder.js           Proposes a category taxonomy from folders + rule names
  taxonomyRepo.js              Confirmed taxonomy store (`email_taxonomia`)
  xrayReport.js                Deterministic folder/rule x-ray
  summaryClassifier.js         Sender→category classification (metadata only)
  summaryReport.js             Semantic inbox summary rendering
  recommendationsReport.js     Folder/rule recommendations (informational)
supabase/migrations/           SQL database migrations
docs/                          Email agent deploy + Secret Manager migration guides
tests/                         Unit tests (node --test)
```

## Email agent (read-only)

Message the bot starting with **`email`** followed by what you want:

| Say | Action |
|---|---|
| `email conectar` | Get a Microsoft consent link to connect your mailbox (read-only) |
| `email dame un resumen` | Semantic inbox summary — who wrote you, grouped by category |
| `email radiografía` | X-ray: where your recent mail (read + unread, last ~14 days) lands by folder + what your rules do, with a count of older mail |
| `email recomendaciones` | Proposed folder structure + which rules hide mail vs. reduce noise |
| `email configurar categorías` / `email reconstruir categorías` | Build/rebuild your category taxonomy (confirm once) |
| `email actualizar` | Force a fresh pull, bypassing the ~2h cache |
| `email costos` | LLM cost report: accumulated Groq spend, broken down by agent (expense + email) |
| `email ayuda` | List what the email agent can do |

If your request is ambiguous, the bot replies with a short numbered menu; answer with the number. All actions are **read-only**: phase 1 requests only `Mail.Read` + `MailboxSettings.Read`, so Microsoft itself enforces that nothing can be modified. Only email **metadata** (sender, subject, dates, flags, folder) is ever read — never message bodies.

Setup requires an Azure app registration and GCP Secret Manager for the rotating refresh token — see [`docs/email-agent-deploy.md`](docs/email-agent-deploy.md). Migrating the bot's static secrets to Secret Manager is documented in [`docs/secret-manager-migration.md`](docs/secret-manager-migration.md).

## LLM cost tracking

Every LLM (Groq) call is metered. The client wrapper (`src/llmRateLimitLog.js`) reads each completion's `usage`, computes a USD cost from the model's price (`src/llmPricing.js`), and writes one row per call to the `llm_usage` table — tagged by the agent that made it (`expense` or `email`). Recording is **best-effort**: a failure there is logged and swallowed, never breaking the reply.

Ask the bot **`email costos`** for the accumulated spend, broken down by agent. The figure is an *estimate* from Groq's published prices; while you're on the free tier the amount actually billed is **US$0** (the report says so). Prices live in `src/llmPricing.js` — add a model there to track it; an unpriced model is recorded at $0 rather than guessed. Run the `llm_usage` migration in `supabase/migrations/` before relying on the report.

## Requirements

- Node.js 22+
- A Meta app with WhatsApp Cloud API configured
- A Supabase project
- An OpenAI-compatible endpoint for the LLM (e.g. [Groq](https://groq.com) in production, or [Ollama](https://ollama.com) locally for development)

## Setup

1. Clone the repo and install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in the variables:

   ```bash
   cp .env.example .env
   ```

   | Variable | Description |
   |---|---|
   | `PORT` | Server port (default `3000`; Cloud Run overrides it with its own `PORT`) |
   | `WEBHOOK_VERIFY_TOKEN` | A secret string you choose, used in the initial webhook verification with Meta |
   | `WHATSAPP_TOKEN` | Access token for the Meta app |
   | `PHONE_NUMBER_ID` | WhatsApp Business phone number ID |
   | `WHATSAPP_APP_SECRET` | Meta App Secret, used to verify the signature of each incoming webhook |
   | `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | Credentials for the LLM endpoint (OpenAI-compatible) |
   | `SUPABASE_URL` / `SUPABASE_KEY` | Supabase project credentials |
   | `VENTANA_CONFIRMACION_MIN` | Optional (default `30`). Minutes a duplicate-confirmation question stays pending before it expires |

3. Run the migrations in `supabase/migrations/` on your Supabase project. Besides what the migrations create, you need a `payments` table with (at least) these columns: `phone`, `message_id` (unique, for idempotency), `service`, `amount`, `currency`, `payment_method`, `installments`, `category`, `expense_date`.

   **Naming convention:** table and column names are in **English** — the project's convention going forward. What stays in Spanish is *content*, not schema: the enum **values** stored in columns (e.g. `credito`, `Vivienda`, `UYU`), the LLM's JSON output contract (its keys mirror the domain object in [`src/aiExtractor.js`](src/aiExtractor.js), mapped to the English columns in [`src/paymentsRepo.js`](src/paymentsRepo.js)), and every user-facing WhatsApp string — all for the bot's Spanish-speaking (Uruguayan) users.

   If you're upgrading an existing deployment whose schema is still in Spanish, run the idempotent [`supabase/migrations/20260809140000_rename_schema_to_english.sql`](supabase/migrations/20260809140000_rename_schema_to_english.sql) once — it renames every table and column in place (data preserved) and is safe to re-run.

## Local usage

```bash
node index.js
```

The server starts on `PORT` (default `3000`) and exposes:

- `GET /webhook` — webhook verification with Meta.
- `POST /webhook` — receiving WhatsApp messages.

To expose your local server to Meta during development, use a tunnel (e.g. `ngrok http 3000`) and set that URL in the WhatsApp Cloud API panel.

## Tests

```bash
npm test
```

Unit tests run with Node's built-in test runner (`node --test`) and inject fakes for Supabase, the LLM, and the WhatsApp client — no network or credentials required.

## Deployment

Includes a `Dockerfile` ready to deploy to Cloud Run (or another container host). Cloud Run injects its own `PORT` at runtime, which `config.js` already respects.

```bash
docker build -t bot-finanzas-whatsapp .
docker run -p 8080:8080 --env-file .env bot-finanzas-whatsapp
```
