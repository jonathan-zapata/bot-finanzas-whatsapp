# bot-finanzas-whatsapp

WhatsApp bot that logs your expenses automatically. Write to it in natural language (e.g. *"Pagué 2000 de Antel en efectivo"*) and the bot uses an LLM to extract the data, validates the result, and saves it to Supabase — replying on WhatsApp with a confirmation.

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

Every message is processed idempotently by `message_id`: if Meta retries delivery of a webhook, the expense isn't duplicated and the LLM isn't queried again.

## Project structure

```
index.js                       Express server: webhook routes (verification + reception)
src/
  config.js                    Loads and validates environment variables
  whatsappClient.js            Sends messages and verifies Meta's signature
  aiExtractor.js                LLM prompt + validation of the extracted expense (Zod)
  paymentsRepo.js                Access to the `pagos` table (save, find duplicates, idempotency)
  pendingConfirmationsRepo.js      Access to the `confirmaciones_pendientes` table
  responseParser.js                Interprets the user's yes/no answers
  messageHandler.js                 Orchestrates the full flow of an incoming message
supabase/migrations/            SQL database migrations
tests/                           Unit tests (node --test)
```

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

3. Run the migrations in `supabase/migrations/` on your Supabase project. Besides what the migrations create, you need a `pagos` table with (at least) these columns: `telefono`, `message_id` (unique, for idempotency), `servicio`, `monto`, `divisa`, `metodo_pago`, `cuotas`, `categoria`, `fecha_gasto`.

   Table, column, and enum values stay in Spanish on purpose: they're the live database schema and the LLM's expected output contract, shared with the bot's Spanish-speaking (Uruguayan) users — see [`src/aiExtractor.js`](src/aiExtractor.js) for the field definitions.

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
