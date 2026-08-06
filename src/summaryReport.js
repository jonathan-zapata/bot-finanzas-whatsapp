import { STANDING_OTHER } from './taxonomyBuilder.js';

// Builds the semantic inbox summary — the "who / what" of the Inbox. Given the
// Inbox's unread messages, the confirmed taxonomy, and the per-sender category
// assignments, it produces category counts and an "appears to need action"
// highlight. Pure and deterministic given its inputs (the only LLM step is the
// sender classification that produced `assignments`).

// Distinct senders (by address) of a set of messages, with the subjects they
// sent — the metadata the classifier needs.
export function collectSenders(messages) {
    const byAddress = new Map();
    for (const m of messages ?? []) {
        const address = m.from?.address ?? '';
        if (!address) continue;
        if (!byAddress.has(address)) {
            byAddress.set(address, { address, name: m.from?.name ?? '', subjects: [] });
        }
        if (m.subject) byAddress.get(address).subjects.push(m.subject);
    }
    return [...byAddress.values()];
}

function categoryOf(address, assignmentMap) {
    return assignmentMap.get(address) ?? STANDING_OTHER;
}

// Aggregates messages into { category → { count, senders:Set } }, ordered by the
// taxonomy (so reports are consistent), with any category actually present that
// isn't in the taxonomy appended (defensive; normally just Other).
export function buildCategoryCounts({ messages, taxonomy, assignments }) {
    const assignmentMap = new Map((assignments ?? []).map((a) => [a.sender, a.category]));
    const buckets = new Map();
    const ensure = (name) => {
        if (!buckets.has(name)) buckets.set(name, { category: name, count: 0, senders: new Set() });
        return buckets.get(name);
    };
    for (const name of taxonomy ?? []) ensure(name);

    for (const m of messages ?? []) {
        const address = m.from?.address ?? '';
        const cat = categoryOf(address, assignmentMap);
        const bucket = ensure(cat);
        bucket.count += 1;
        if (address) bucket.senders.add(m.from?.name || address);
    }

    // Taxonomy order first, then any extras, dropping empty categories.
    const order = [...(taxonomy ?? [])];
    for (const name of buckets.keys()) if (!order.includes(name)) order.push(name);
    return order
        .map((name) => buckets.get(name))
        .filter((b) => b && b.count > 0)
        .map((b) => ({ category: b.category, count: b.count, senders: [...b.senders] }));
}

// A deterministic "appears to need action" signal from metadata alone: unread
// mail with attachments (often something to handle). Honest about being a
// heuristic — it never claims to have read anything.
export function collectActionItems(messages, { limit = 5 } = {}) {
    return (messages ?? [])
        .filter((m) => m.hasAttachments)
        .slice(0, limit)
        .map((m) => ({ subject: m.subject || '(sin asunto)', sender: m.from?.name || m.from?.address || 'desconocido' }));
}

export function formatSummaryReport({ messages, taxonomy, assignments, windowDays }) {
    const counts = buildCategoryCounts({ messages, taxonomy, assignments });
    const actionItems = collectActionItems(messages);

    const windowNote = windowDays ? ` (últimos ${windowDays} días)` : '';
    const lines = ['🧾 *Resumen de tu bandeja* (solo lectura)', ''];
    lines.push(`📥 Sin leer en la bandeja${windowNote}: *${(messages ?? []).length}*`);
    lines.push('');

    lines.push('*Quién te escribió, por categoría:*');
    if (counts.length === 0) {
        lines.push('• (no hay correo sin leer en la bandeja)');
    } else {
        for (const c of counts) {
            const who = c.senders.slice(0, 4).join(', ');
            const more = c.senders.length > 4 ? `, +${c.senders.length - 4}` : '';
            lines.push(`• *${c.category}*: ${c.count}${who ? ` (${who}${more})` : ''}`);
        }
    }
    lines.push('');

    lines.push('⚠️ *Parecen necesitar acción* (tienen adjuntos):');
    if (actionItems.length === 0) {
        lines.push('• Nada con adjuntos saltó como urgente.');
    } else {
        for (const a of actionItems) lines.push(`• "${a.subject}" — ${a.sender}`);
    }

    return lines.join('\n');
}
