// Renders the LLM cost report the `email costos` action sends over WhatsApp.
// Pure and deterministic (like xrayReport / summaryReport): it takes the
// aggregated summary from llmUsageRepo.getUsageSummary and returns a string.
// User-facing copy stays in Spanish (Uruguayan users).

// Friendly labels for each agent tag (the raw tags match each agent's domain).
const AGENT_LABELS = {
    expense: '💰 Finanzas',
    email: '📬 Email',
    unknown: '❓ Otros',
};

function agentLabel(agent) {
    return AGENT_LABELS[agent] ?? agent;
}

// Small USD amounts (a few calls on a cheap model) round to $0.00 at two
// decimals, which reads as "free" and hides real consumption. Show 4 decimals
// under a cent, 2 at or above it.
function formatUsd(value) {
    const v = Number(value) || 0;
    if (v > 0 && v < 0.01) return `US$${v.toFixed(4)}`;
    return `US$${v.toFixed(2)}`;
}

function formatTokens(value) {
    return (Number(value) || 0).toLocaleString('es-UY');
}

export function formatUsageReport(summary, { periodLabel = 'desde el inicio' } = {}) {
    if (!summary) {
        return '⚠️ No pude leer el consumo de la API ahora mismo. Probá de nuevo en un rato.';
    }

    const { byAgent = [], total } = summary;
    if (!total || total.calls === 0) {
        return `📊 Todavía no registré ningún consumo de la API (${periodLabel}).`;
    }

    const lines = [...byAgent]
        .sort((a, b) => b.costUsd - a.costUsd)
        .map((a) => {
            const tokens = formatTokens(a.tokensIn + a.tokensOut);
            return `• ${agentLabel(a.agent)}: ${formatUsd(a.costUsd)} · ${a.calls} llamadas · ${tokens} tokens`;
        });

    return (
        `📊 *Costos de la API (${periodLabel})*\n\n` +
        lines.join('\n') +
        `\n\n*Total: ${formatUsd(total.costUsd)}* · ${total.calls} llamadas · ` +
        `${formatTokens(total.tokensIn + total.tokensOut)} tokens\n\n` +
        'ℹ️ Estimado con los precios de Groq. Si estás dentro del tier gratuito, ' +
        'lo facturado es US$0.'
    );
}
