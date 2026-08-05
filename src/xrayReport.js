// Deterministic workflow x-ray — the "where" of the mailbox. No LLM, no
// taxonomy: given the metadata pull, these are exact, reproducible numbers.
//
//   - unread count
//   - folder-location breakdown of the unread mail (unrouted mail counts under
//     the Inbox — no synthetic bucket)
//   - a listing of the user's rules: what each does and where it routes mail
//
// All functions are pure so they're trivially testable from fake metadata.

function folderNameMap(folders) {
    const byId = new Map();
    for (const f of folders ?? []) byId.set(f.id, f.displayName);
    return byId;
}

// Groups messages by their parent folder's display name. A message whose folder
// isn't in the map (or is the Inbox) is counted under the Inbox — unrouted mail
// honestly appears where it actually is, not in a made-up bucket.
export function buildFolderBreakdown({ messages, folders, inbox }) {
    const byId = folderNameMap(folders);
    const inboxName = inbox?.displayName ?? 'Inbox';
    const counts = new Map();
    for (const m of messages ?? []) {
        const name = byId.get(m.parentFolderId) ?? inboxName;
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// A short Spanish description of a rule's trigger conditions.
function describeConditions(conditions) {
    if (!conditions) return 'siempre';
    const parts = [];
    const senders = conditions.senderContains ?? conditions.fromAddresses?.map((r) => r.emailAddress?.address);
    if (senders?.length) parts.push(`viene de ${senders.filter(Boolean).join(', ')}`);
    if (conditions.subjectContains?.length) parts.push(`el asunto contiene "${conditions.subjectContains.join(', ')}"`);
    if (conditions.bodyContains?.length) parts.push('el cuerpo contiene ciertas palabras');
    if (conditions.hasAttachments) parts.push('tiene adjuntos');
    if (conditions.importance) parts.push(`importancia ${conditions.importance}`);
    return parts.length ? `si ${parts.join(' y ')}` : 'siempre';
}

// A short Spanish description of a rule's actions, resolving the destination
// folder id to its name.
function describeActions(actions, byId) {
    if (!actions) return 'no hace nada';
    const parts = [];
    if (actions.moveToFolder) parts.push(`mueve a "${byId.get(actions.moveToFolder) ?? 'otra carpeta'}"`);
    if (actions.copyToFolder) parts.push(`copia a "${byId.get(actions.copyToFolder) ?? 'otra carpeta'}"`);
    if (actions.delete) parts.push('borra el mensaje');
    if (actions.markAsRead) parts.push('lo marca como leído');
    if (actions.markImportance) parts.push(`marca importancia ${actions.markImportance}`);
    if (actions.forwardTo?.length) parts.push('lo reenvía');
    if (actions.stopProcessingRules) parts.push('y frena las demás reglas');
    return parts.length ? parts.join(', ') : 'no hace nada';
}

// One structured row per rule (for both display and, later, recommendations).
export function buildRulesReport({ rules, folders }) {
    const byId = folderNameMap(folders);
    return [...(rules ?? [])]
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
        .map((rule) => ({
            name: rule.displayName ?? '(sin nombre)',
            enabled: rule.isEnabled !== false,
            destinationFolderId: rule.actions?.moveToFolder ?? null,
            destinationFolder: rule.actions?.moveToFolder
                ? byId.get(rule.actions.moveToFolder) ?? null
                : null,
            conditions: describeConditions(rule.conditions),
            actions: describeActions(rule.actions, byId),
        }));
}

// Renders the full x-ray as a WhatsApp message.
export function formatXrayReport(data) {
    const messages = data.messages ?? [];
    const breakdown = buildFolderBreakdown(data);
    const rules = buildRulesReport(data);

    const lines = ['📊 *Radiografía de tu correo* (solo lectura, no toqué nada)', ''];
    lines.push(`📥 Correos sin leer: *${messages.length}*`);
    lines.push('');

    lines.push('📂 *Dónde está tu correo sin leer:*');
    if (breakdown.length === 0) {
        lines.push('• (no hay correo sin leer)');
    } else {
        for (const { name, count } of breakdown) lines.push(`• ${name}: ${count}`);
    }
    lines.push('');

    lines.push(`⚙️ *Tus reglas* (${rules.length}):`);
    if (rules.length === 0) {
        lines.push('• No encontré reglas configuradas.');
    } else {
        for (const r of rules) {
            const status = r.enabled ? '' : ' _(desactivada)_';
            lines.push(`• *${r.name}*${status}: ${r.conditions} → ${r.actions}`);
        }
    }

    return lines.join('\n');
}
