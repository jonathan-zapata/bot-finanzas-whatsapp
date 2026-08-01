# bot-finanzas-whatsapp

Bot de WhatsApp que registra tus gastos automáticamente. Le escribís en lenguaje natural (ej. *"Pagué 2000 de Antel en efectivo"*) y el bot usa un LLM para extraer los datos, valida el resultado y lo guarda en Supabase — respondiéndote por WhatsApp con la confirmación.

## Cómo funciona

1. Meta (WhatsApp Cloud API) manda un webhook `POST /webhook` con el mensaje del usuario.
2. Se verifica la firma `X-Hub-Signature-256` con el App Secret antes de procesar nada.
3. Si el usuario tiene una pregunta de confirmación pendiente (ver más abajo), el mensaje se interpreta como respuesta a esa pregunta.
4. Si no, el texto se manda al LLM (cualquier endpoint compatible con OpenAI) para extraer el gasto: servicio, monto, divisa, método de pago, cuotas, categoría y fecha.
5. El resultado se valida contra un schema estricto (Zod) — si el LLM alucina un valor fuera de los enums esperados, se descarta en vez de guardarse.
6. Se busca un posible duplicado exacto (mismo teléfono + servicio + monto + divisa) en `pagos`:
   - Misma fecha → se sospecha de duplicado técnico (ej. reintento) y se le pregunta al usuario antes de guardar.
   - Otra fecha → se guarda igual y se avisa que parece un gasto recurrente.
   - Sin match → se guarda directamente.
7. El bot responde por WhatsApp confirmando lo anotado.

Cada mensaje se procesa de forma idempotente por `message_id`: si Meta reintenta la entrega de un webhook, no se duplica el gasto ni se vuelve a consultar al LLM.

## Estructura del proyecto

```
index.js                   Servidor Express: rutas del webhook (verificación + recepción)
src/
  config.js                Carga y valida variables de entorno
  whatsappClient.js         Envío de mensajes y verificación de firma de Meta
  aiExtractor.js            Prompt al LLM + validación del gasto extraído (Zod)
  pagosRepo.js               Acceso a la tabla `pagos` (guardar, buscar duplicados, idempotencia)
  confirmacionesRepo.js       Acceso a la tabla `confirmaciones_pendientes`
  respuestaParser.js          Interpreta respuestas sí/no del usuario
  messageHandler.js            Orquesta el flujo completo de un mensaje entrante
supabase/migrations/         Migraciones SQL de la base de datos
tests/                        Tests unitarios (node --test)
```

## Requisitos

- Node.js 22+
- Una app de Meta con WhatsApp Cloud API configurada
- Un proyecto de Supabase
- Un endpoint compatible con OpenAI para el LLM (ej. [Groq](https://groq.com) en producción, o [Ollama](https://ollama.com) local para desarrollo)

## Configuración

1. Cloná el repo e instalá dependencias:

   ```bash
   npm install
   ```

2. Copiá `.env.example` a `.env` y completá las variables:

   ```bash
   cp .env.example .env
   ```

   | Variable | Descripción |
   |---|---|
   | `PORT` | Puerto del servidor (default `3000`; Cloud Run lo sobreescribe con su propio `PORT`) |
   | `WEBHOOK_VERIFY_TOKEN` | String secreto que vos elegís, usado en la verificación inicial del webhook con Meta |
   | `WHATSAPP_TOKEN` | Token de acceso de la app de Meta |
   | `PHONE_NUMBER_ID` | ID del número de WhatsApp Business |
   | `WHATSAPP_APP_SECRET` | App Secret de Meta, usado para verificar la firma de cada webhook entrante |
   | `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | Credenciales del endpoint LLM (compatible con OpenAI) |
   | `SUPABASE_URL` / `SUPABASE_KEY` | Credenciales del proyecto de Supabase |
   | `VENTANA_CONFIRMACION_MIN` | Opcional (default `30`). Minutos que una pregunta de confirmación de duplicado queda pendiente antes de expirar |

3. Corré las migraciones de `supabase/migrations/` en tu proyecto de Supabase. Además de lo que crean las migraciones, necesitás una tabla `pagos` con (al menos) las columnas: `telefono`, `message_id` (única, para idempotencia), `servicio`, `monto`, `divisa`, `metodo_pago`, `cuotas`, `categoria`, `fecha_gasto`.

## Uso local

```bash
node index.js
```

El servidor arranca en `PORT` (default `3000`) y expone:

- `GET /webhook` — verificación del webhook con Meta.
- `POST /webhook` — recepción de mensajes de WhatsApp.

Para exponer tu servidor local a Meta durante desarrollo, usá un túnel (ej. `ngrok http 3000`) y configurá esa URL en el panel de WhatsApp Cloud API.

## Tests

```bash
npm test
```

Los tests unitarios corren con el runner nativo de Node (`node --test`) e inyectan fakes para Supabase, el LLM y el cliente de WhatsApp — no requieren red ni credenciales.

## Deploy

Incluye un `Dockerfile` listo para desplegar en Cloud Run (u otro host de contenedores). Cloud Run inyecta su propio `PORT` en runtime, que `config.js` ya respeta.

```bash
docker build -t bot-finanzas-whatsapp .
docker run -p 8080:8080 --env-file .env bot-finanzas-whatsapp
```
