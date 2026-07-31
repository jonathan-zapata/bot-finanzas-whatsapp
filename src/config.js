import dotenv from 'dotenv';

dotenv.config();

const REQUERIDAS = [
    'WEBHOOK_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
    'LLM_API_KEY',
    'LLM_BASE_URL',
    'SUPABASE_URL',
    'SUPABASE_KEY',
    'WHATSAPP_TOKEN',
    'PHONE_NUMBER_ID',
];

const faltantes = REQUERIDAS.filter((clave) => !process.env[clave]);
if (faltantes.length > 0) {
    console.error(`❌ Faltan variables de entorno requeridas: ${faltantes.join(', ')}`);
    console.error('   Revisá .env.example para ver la lista completa.');
    process.exit(1);
}

export const config = {
    port: process.env.PORT || 3000,
    webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN,
    whatsappAppSecret: process.env.WHATSAPP_APP_SECRET,
    llmApiKey: process.env.LLM_API_KEY,
    llmBaseUrl: process.env.LLM_BASE_URL,
    // Sin default forzado a Groq: así podés apuntar a Ollama local (ej. "qwen2.5:7b")
    // sin tocar código, solo cambiando LLM_MODEL y LLM_BASE_URL en el .env.
    llmModel: process.env.LLM_MODEL || 'llama-3.1-8b-instant',
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
    whatsappToken: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.PHONE_NUMBER_ID,
};
