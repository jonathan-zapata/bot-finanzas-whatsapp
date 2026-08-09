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

// Wraps the OpenAI-SDK client so each chat.completions.create call also (a) logs
// its rate-limit headers and (b) reports its token usage for cost tracking. Uses
// the SDK's `.withResponse()` to reach both the raw HTTP response (for headers)
// and the parsed completion (for `usage`), then returns just the completion so
// every existing call site keeps working unchanged.
//
// Options (a bare function is still accepted as the log sink, for backward
// compatibility with the original single-arg logging usage):
//   - log:     where rate-limit one-liners go (default console.log).
//   - onUsage: optional async ({ agent, model, usage }) => void, called after
//              each completion that carried a usage payload. `agent` comes from
//              the caller's out-of-band `_agentTag` param (see below). It's
//              awaited so the record lands before a serverless host throttles the
//              CPU on response; any error it throws is swallowed.
//
// `_agentTag` is our own attribution field: callers add it to the create params
// to say which agent made the call, and it's stripped here so it never reaches
// the provider's API.
export function attachRateLimitLogging(client, options = console.log) {
    const { log = console.log, onUsage } = typeof options === 'function' ? { log: options } : options;

    const completions = client?.chat?.completions;
    if (!completions || typeof completions.create !== 'function') return client;

    const original = completions.create.bind(completions);
    completions.create = (params, requestOptions) => {
        const { _agentTag, ...body } = params ?? {};
        return original(body, requestOptions)
            .withResponse()
            .then(async ({ data, response }) => {
                try {
                    const line = formatRateLimitLog(response?.headers);
                    if (line) log(line);
                } catch {
                    // Never let logging break an LLM call.
                }
                if (onUsage && data?.usage) {
                    try {
                        await onUsage({ agent: _agentTag, model: data.model, usage: data.usage });
                    } catch {
                        // Usage recording is best-effort; never let it break the call.
                    }
                }
                return data;
            });
    };
    return client;
}
