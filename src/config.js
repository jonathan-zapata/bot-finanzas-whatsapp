import dotenv from 'dotenv';

dotenv.config();

const REQUIRED_ENV_VARS = [
    'WEBHOOK_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
    'LLM_API_KEY',
    'LLM_BASE_URL',
    'SUPABASE_URL',
    'SUPABASE_KEY',
    'WHATSAPP_TOKEN',
    'PHONE_NUMBER_ID',
];

const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    console.error('   Check .env.example for the full list.');
    process.exit(1);
}

export const config = {
    port: process.env.PORT || 3000,
    webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN,
    whatsappAppSecret: process.env.WHATSAPP_APP_SECRET,
    llmApiKey: process.env.LLM_API_KEY,
    llmBaseUrl: process.env.LLM_BASE_URL,
    // No default forced to Groq: this lets you point to a local Ollama (e.g.
    // "qwen2.5:7b") without touching code, just by changing LLM_MODEL and
    // LLM_BASE_URL in .env.
    llmModel: process.env.LLM_MODEL || 'llama-3.3-70b-versatile',
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
    whatsappToken: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.PHONE_NUMBER_ID,
    // Window (in minutes) a duplicate confirmation stays pending before it
    // expires. If the user doesn't reply within this time, the question lapses
    // and their next message is treated as a new one.
    confirmationWindowMinutes: Number(process.env.VENTANA_CONFIRMACION_MIN) || 30,

    // ── Email agent (optional) ────────────────────────────────────────────
    // Not in REQUIRED_ENV_VARS: the bot boots and the expense flow runs without
    // any of these. They're only needed to connect a Microsoft mailbox. When
    // unset, the email agent replies that the connection isn't configured
    // instead of crashing.
    microsoft: {
        clientId: process.env.MS_CLIENT_ID,
        clientSecret: process.env.MS_CLIENT_SECRET,
        // Must exactly match the redirect URI registered on the Azure app and
        // point at GET /oauth/microsoft/callback on this service.
        redirectUri: process.env.MS_REDIRECT_URI,
        // "consumers" for personal Hotmail/Outlook accounts.
        tenant: process.env.MS_TENANT || 'consumers',
        // Secret Manager secret id that holds the rotating refresh token.
        refreshTokenSecret: process.env.MS_REFRESH_TOKEN_SECRET || 'ms-refresh-token',
    },
    gcpProjectId: process.env.GCP_PROJECT_ID,
    // Days of read+unread mail the x-ray covers (the summary stays unread-only).
    emailRecentWindowDays: Number(process.env.EMAIL_XRAY_WINDOW_DAYS) || 14,
};
