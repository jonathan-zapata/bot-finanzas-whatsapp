# Email agent — deploy & connect (Phase 1)

The email agent extends the existing WhatsApp bot with read-only access to a
personal Microsoft (Hotmail/Outlook) mailbox. This document covers the console
steps that can't be done from code: the Azure app registration and the GCP
Secret Manager setup for the rotating Microsoft refresh token.

> Phase 1 is **read-only, enforced by Microsoft**: only `Mail.Read` and
> `MailboxSettings.Read` are ever requested (`offline_access` is what makes a
> refresh token be issued). No write scope is requested, so the bot literally
> cannot modify the mailbox.

## 1. Register the Azure AD app ("Personal accounts only")

1. Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Name it (e.g. `bot-finanzas-email-agent`).
3. **Supported account types**: *Personal Microsoft accounts only*. (Free — no
   paid Azure subscription is needed for a personal mailbox.)
4. **Redirect URI**: platform **Web**, value exactly:
   `https://<your-cloud-run-url>/oauth/microsoft/callback`
   This must match `MS_REDIRECT_URI` byte-for-byte.
5. Register. Copy the **Application (client) ID** → `MS_CLIENT_ID`.
6. **Certificates & secrets** → **New client secret** → copy the *value* (not the
   id) → `MS_CLIENT_SECRET`.
7. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions** → add `Mail.Read` and `MailboxSettings.Read`.
   `offline_access` is included automatically by the consent request. Do **not**
   add `Mail.ReadWrite` or any write scope.

## 2. Secret Manager: the rotating refresh token

The refresh token rotates, so it is read **and written** at runtime (unlike the
static secrets in ticket 02, which are mounted as env vars). Create an empty
secret; the callback route writes the first version when you connect.

```bash
PROJECT_ID=your-gcp-project-id

# Create the (initially empty) secret. The app adds versions at runtime.
gcloud secrets create ms-refresh-token \
  --project="$PROJECT_ID" \
  --replication-policy=automatic

# Grant Cloud Run's runtime service account read + add-version on JUST this secret.
RUNTIME_SA=$(gcloud run services describe bot-finanzas-whatsapp \
  --project="$PROJECT_ID" --region=<region> \
  --format='value(spec.template.spec.serviceAccountName)')

gcloud secrets add-iam-policy-binding ms-refresh-token --project="$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding ms-refresh-token --project="$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretVersionAdder
```

## 3. Configure the service

Set these on the Cloud Run service (env vars; the client secret can also be a
mounted secret — see ticket 02):

| Var | Value |
| --- | --- |
| `MS_CLIENT_ID` | Application (client) ID |
| `MS_CLIENT_SECRET` | Client secret value |
| `MS_REDIRECT_URI` | `https://<cloud-run-url>/oauth/microsoft/callback` |
| `MS_TENANT` | `consumers` (default; personal accounts) |
| `GCP_PROJECT_ID` | your project id |
| `MS_REFRESH_TOKEN_SECRET` | `ms-refresh-token` (default) |

## 4. Connect from WhatsApp

1. Message the bot: **`email conectar`** (or `email connect`).
2. Open the returned Microsoft link, sign in, and approve the read-only consent.
3. Microsoft redirects to `/oauth/microsoft/callback`; the app exchanges the code
   and stores the refresh token as a new version of `ms-refresh-token`.
4. Later email requests obtain an access token silently and persist Microsoft's
   rotated refresh token automatically. If the connection is missing or expires,
   any mailbox request replies asking you to run `email conectar` again.
