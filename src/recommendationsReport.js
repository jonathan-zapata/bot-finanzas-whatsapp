import { STANDING_OTHER } from './taxonomyBuilder.js';

// The `recommendations` action — a single informational report backed by the
// x-ray data. It proposes a redesigned folder structure and flags each existing
// rule as "hides important mail" vs. "usefully reduces noise", with reasoning.
//
// It is READ-ONLY by construction: pure functions over already-loaded metadata,
// with no Graph call at all (let alone a write). Phase 1 has no write scope, so
// every recommendation is informational — the report says so explicitly.

// Senders/rule names that look like automated noise (safe to file away).
const NOISE_PATTERN =
    /linkedin|newsletter|no-?reply|noreply|notificac|notification|marketing|promo|mailer|daemon|digest|updates?|bolet[ií]n|noticias|deals?|ofertas?/i;

function ruleText(rule) {
    const senders = rule.conditions?.senderContains ?? rule.conditions?.fromAddresses?.map((r) => r.emailAddress?.address) ?? [];
    return [rule.displayName, ...(senders ?? []), ...(rule.conditions?.subjectContains ?? [])]
        .filter(Boolean)
        .join(' ');
}

// Classifies each rule. Verdict is one of 'noise' (usefully reduces noise),
// 'hides' (looks like it hides important mail), or 'neutral' (doesn't move mail
// out of the Inbox).
export function classifyRules({ rules, folders }) {
    const byId = new Map((folders ?? []).map((f) => [f.id, f.displayName]));
    return (rules ?? []).map((rule) => {
        const text = ruleText(rule);
        const isNoise = NOISE_PATTERN.test(text);
        const movesOut = Boolean(rule.actions?.moveToFolder);
        const marksRead = Boolean(rule.actions?.markAsRead);
        const deletes = Boolean(rule.actions?.delete);
        const dest = rule.actions?.moveToFolder ? byId.get(rule.actions.moveToFolder) ?? 'otra carpeta' : null;
        const name = rule.displayName ?? '(sin nombre)';

        if (deletes && !isNoise) {
            return { name, verdict: 'hides', reason: 'borra correos automáticamente y no parece ser solo ruido — podrías estar perdiendo cosas.' };
        }
        if (isNoise && (movesOut || deletes)) {
            return { name, verdict: 'noise', reason: `manda ruido conocido a "${dest ?? 'una carpeta'}"; útil para despejar la bandeja.` };
        }
        if (movesOut && marksRead) {
            return { name, verdict: 'hides', reason: `saca el correo a "${dest}" y lo marca como leído: nunca llegás a verlo.` };
        }
        if (movesOut && !isNoise) {
            return { name, verdict: 'hides', reason: `saca a "${dest}" correo que no parece ruido; revisá si te estás perdiendo algo importante.` };
        }
        return { name, verdict: 'neutral', reason: 'no saca correo de tu bandeja.' };
    });
}

// Proposes a folder structure. Prefers the confirmed taxonomy (that's how the
// user chose to think about their mail); otherwise consolidates existing
// non-empty folders.
export function buildFolderProposal({ folders, taxonomy }) {
    if (taxonomy && taxonomy.length > 1) {
        const cats = taxonomy.filter((c) => c !== STANDING_OTHER);
        return {
            basis: 'taxonomy',
            keepInInbox: 'lo importante y lo que requiere acción',
            folders: cats,
        };
    }
    const existing = (folders ?? []).map((f) => f.displayName).filter(Boolean);
    return {
        basis: 'existing',
        keepInInbox: 'lo importante y lo que requiere acción',
        folders: existing.slice(0, 12),
    };
}

export function formatRecommendationsReport({ folders, rules, taxonomy }) {
    const proposal = buildFolderProposal({ folders, taxonomy });
    const ruleVerdicts = classifyRules({ rules, folders });

    const lines = ['💡 *Recomendaciones para tu correo* (informativo)', ''];

    lines.push('📁 *Estructura de carpetas propuesta:*');
    lines.push(`Dejá en la bandeja de entrada ${proposal.keepInInbox}, y usá estas carpetas:`);
    if (proposal.folders.length === 0) {
        lines.push('• (todavía no tengo suficientes señales; configurá tus categorías con *email configurar categorías*)');
    } else {
        for (const f of proposal.folders) lines.push(`• ${f}`);
    }
    lines.push('');

    const hides = ruleVerdicts.filter((r) => r.verdict === 'hides');
    const noise = ruleVerdicts.filter((r) => r.verdict === 'noise');

    lines.push('🚨 *Reglas que podrían esconderte correo importante:*');
    if (hides.length === 0) {
        lines.push('• No detecté ninguna que parezca esconder correo importante.');
    } else {
        for (const r of hides) lines.push(`• *${r.name}*: ${r.reason}`);
    }
    lines.push('');

    lines.push('✅ *Reglas que reducen ruido (conviene conservar):*');
    if (noise.length === 0) {
        lines.push('• No detecté reglas de este tipo.');
    } else {
        for (const r of noise) lines.push(`• *${r.name}*: ${r.reason}`);
    }
    lines.push('');

    lines.push(
        '⚠️ Esto es *solo una propuesta informativa*. En esta fase NO cambié ' +
            'ni voy a cambiar nada en tu casilla — no tengo permiso de escritura. ' +
            'Aplicar cambios queda para una fase posterior, siempre con tu aprobación.'
    );

    return lines.join('\n');
}
