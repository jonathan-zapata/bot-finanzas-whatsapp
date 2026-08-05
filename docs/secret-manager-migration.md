# Secret Manager migration (static secrets)

Moves the bot's existing static secrets out of plain environment variables / a
`.env` file into **GCP Secret Manager**, mounted into Cloud Run as environment
variables. The application keeps reading `process.env.*` exactly as today — **no
application code changes** — but the values now come from Secret Manager, with
IAM-scoped access and audit logging on every read.

This isolates blast radius: a leaked Supabase key no longer implies a
compromised anything-else, and it establishes the Secret Manager + IAM +
service-account plumbing the Microsoft refresh token (ticket 04) reuses at
runtime.

> Scope: this is a **deploy/config change only**. The rotating Microsoft refresh
> token is handled separately (runtime read/write) — see
> [`email-agent-deploy.md`](./email-agent-deploy.md).

## Secrets to migrate

| Secret id (Secret Manager) | Env var the app reads |
| --- | --- |
| `whatsapp-token` | `WHATSAPP_TOKEN` |
| `whatsapp-app-secret` | `WHATSAPP_APP_SECRET` |
| `llm-api-key` | `LLM_API_KEY` |
| `supabase-key` | `SUPABASE_KEY` |
| `webhook-verify-token` | `WEBHOOK_VERIFY_TOKEN` |

Non-secret config (`SUPABASE_URL`, `LLM_BASE_URL`, `LLM_MODEL`, `PHONE_NUMBER_ID`,
`PORT`) stays as ordinary env vars.

## 1. Create the secrets

```bash
PROJECT_ID=your-gcp-project-id

create_secret () {  # usage: create_secret <secret-id> <value>
  printf '%s' "$2" | gcloud secrets create "$1" \
    --project="$PROJECT_ID" --replication-policy=automatic --data-file=-
}

create_secret whatsapp-token        "$WHATSAPP_TOKEN"
create_secret whatsapp-app-secret   "$WHATSAPP_APP_SECRET"
create_secret llm-api-key           "$LLM_API_KEY"
create_secret supabase-key          "$SUPABASE_KEY"
create_secret webhook-verify-token  "$WEBHOOK_VERIFY_TOKEN"
```

To rotate a value later, add a new version:
`printf '%s' "$NEW" | gcloud secrets versions add <secret-id> --data-file=-`.

## 2. Grant Cloud Run's service account access to ONLY these secrets

```bash
REGION=your-region
RUNTIME_SA=$(gcloud run services describe bot-finanzas-whatsapp \
  --project="$PROJECT_ID" --region="$REGION" \
  --format='value(spec.template.spec.serviceAccountName)')

for s in whatsapp-token whatsapp-app-secret llm-api-key supabase-key webhook-verify-token; do
  gcloud secrets add-iam-policy-binding "$s" --project="$PROJECT_ID" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role=roles/secretmanager.secretAccessor
done
```

## 3. Deploy Cloud Run with the secrets mounted as env vars

`--set-secrets` maps each env var to a secret version. The app code is unchanged
— it still reads `process.env.WHATSAPP_TOKEN`, etc. Keep the non-secret config on
`--set-env-vars`.

```bash
gcloud run deploy bot-finanzas-whatsapp \
  --project="$PROJECT_ID" --region="$REGION" \
  --source . \
  --set-secrets=\
WHATSAPP_TOKEN=whatsapp-token:latest,\
WHATSAPP_APP_SECRET=whatsapp-app-secret:latest,\
LLM_API_KEY=llm-api-key:latest,\
SUPABASE_KEY=supabase-key:latest,\
WEBHOOK_VERIFY_TOKEN=webhook-verify-token:latest \
  --set-env-vars=\
SUPABASE_URL=https://your-project.supabase.co,\
LLM_BASE_URL=https://api.groq.com/openai/v1,\
LLM_MODEL=llama-3.3-70b-versatile,\
PHONE_NUMBER_ID=your-phone-number-id
```

## 4. Verify

1. The service boots (check the logs for `Server running on port ...`).
2. Send an expense message end to end (e.g. "Pagué 2000 de Antel en efectivo") —
   it should classify, save, and confirm exactly as before. The secrets are now
   being read from Secret Manager.
3. Confirm the plain-text secret env vars are gone from the service revision
   (`gcloud run services describe ... --format='value(spec.template.spec.containers[0].env)'`).
4. Once verified, remove the secret values from any `.env` used by the deploy
   pipeline; `.env` remains only for local development.

## Notes

- Consciously accepted residual: Cloud Run's own service account remains the
  trust root — Secret Manager IAM doesn't protect against that identity itself
  being compromised.
- `Dockerfile`/app code did **not** change for this migration; only the deploy
  invocation and IAM did.
