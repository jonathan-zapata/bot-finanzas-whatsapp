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
};
