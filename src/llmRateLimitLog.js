// Logs the Groq (OpenAI-compatible) rate-limit headers returned on every LLM
// response, so the remaining free-tier budget is visible in the Cloud Run logs
// without opening the Groq dashboard. Purely observational: it never changes the
// request, the returned completion, or the control flow — a logging failure is
// swallowed so it can't break an LLM call.

const HEADER = {
    remainingRequests: 'x-ratelimit-remaining-requests',
    limitRequests: 'x-ratelimit-limit-requests',
    remainingTokens: 'x-ratelimit-remaining-tokens',
    limitTokens: 'x-ratelimit-limit-tokens',
    resetRequests: 'x-ratelimit-reset-requests',
    resetTokens: 'x-ratelimit-reset-tokens',
};

// Reads a header from either a Fetch `Headers` object (.get) or a plain object.
function readHeader(headers, name) {
    if (!headers) return undefined;
    if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
    return headers[name];
}

// Returns a human-readable one-liner, or null when the provider sent no
// rate-limit headers at all (nothing to report).
export function formatRateLimitLog(headers) {
    const remReq = readHeader(headers, HEADER.remainingRequests);
    const remTok = readHeader(headers, HEADER.remainingTokens);
    if (remReq == null && remTok == null) return null;

    const limReq = readHeader(headers, HEADER.limitRequests);
    const limTok = readHeader(headers, HEADER.limitTokens);
    const resetReq = readHeader(headers, HEADER.resetRequests);
    const resetTok = readHeader(headers, HEADER.resetTokens);

    return (
        `📊 Groq rate-limit — requests: ${remReq ?? 'n/d'}/${limReq ?? 'n/d'} restantes` +
        `${resetReq ? ` (reset ${resetReq})` : ''}; ` +
        `tokens: ${remTok ?? 'n/d'}/${limTok ?? 'n/d'} restantes` +
        `${resetTok ? ` (reset ${resetTok})` : ''}`
    );
}

// Wraps the OpenAI-SDK client so each chat.completions.create call also logs its
// rate-limit headers. Uses the SDK's `.withResponse()` to reach the raw HTTP
// response, then returns just the completion so every existing call site keeps
// working unchanged.
export function attachRateLimitLogging(client, log = console.log) {
    const completions = client?.chat?.completions;
    if (!completions || typeof completions.create !== 'function') return client;

    const original = completions.create.bind(completions);
    completions.create = (params, options) =>
        original(params, options)
            .withResponse()
            .then(({ data, response }) => {
                try {
                    const line = formatRateLimitLog(response?.headers);
                    if (line) log(line);
                } catch {
                    // Never let logging break an LLM call.
                }
                return data;
            });
    return client;
}
