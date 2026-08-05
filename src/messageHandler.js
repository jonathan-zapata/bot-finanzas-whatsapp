import { wasAlreadyProcessed as wasAlreadyProcessedReal } from './paymentsRepo.js';
import { getPending as getPendingReal } from './pendingConfirmationsRepo.js';
import { expenseAgent, EXPENSE_DOMAIN } from './expenseAgent.js';
import { emailAgent } from './emailAgent.js';

// ==========================================
// LEVEL-1 ROUTER (agent selection)
// ==========================================
//
// This is the bot's single entry point for an already-authenticated incoming
// text message (Meta's signature verified in index.js). It keeps the outer
// order it always had:
//
//   1. Idempotency by message_id (guards against WhatsApp webhook retries)
//   2. Pending-question check — this message may be the answer to a question
//      a *specific agent* asked; dispatch it back to that agent by domain
//   3. Fresh message → Level-1 prefix routing to the owning agent
//
// Agent selection at level 1 is deterministic: an explicit text prefix selects
// the email agent; anything without a recognized prefix falls through to the
// expense agent (its behavior unchanged). Keeping this boundary a plain string
// match — never an LLM guess — is deliberate: a misroute here could silently
// feed an email request to the expense extractor.
//
// Agents are plain objects satisfying a small shared contract
// (`{ domain, handleMessage, handlePendingReply }`) held in a dispatch table —
// no base class, no inheritance (two agents is too few to justify one). All
// data/AI dependencies are injected via `deps`, defaulting to the real ones, so
// tests fake each seam without simulating Supabase or the network.

// Prefix-bearing agents, checked in order. The expense agent is the default and
// is intentionally not in this list — it owns everything that matches nothing.
const PREFIX_AGENTS = [emailAgent];
const DEFAULT_AGENT = expenseAgent;

// Every agent that can *ask* a pending question, keyed by its domain, so a
// reply can be routed back to the one that asked.
const AGENTS_BY_DOMAIN = {
    [expenseAgent.domain]: expenseAgent,
    [emailAgent.domain]: emailAgent,
};

// Level-1 routing: first prefix agent that claims the message wins, otherwise
// the default agent. Returns the chosen agent and the free-text remainder
// (post-prefix, for prefix agents; the full text for the default agent).
function routeByPrefix(userText) {
    for (const agent of PREFIX_AGENTS) {
        const { matched, remainder } = agent.matchPrefix(userText);
        if (matched) return { agent, remainder };
    }
    return { agent: DEFAULT_AGENT, remainder: userText };
}

export async function handleIncomingMessage(args) {
    const {
        supabase,
        ai,
        whatsapp,
        userPhone,
        messageId,
        userText,
        model,
        confirmationWindowMinutes,
        deps = {},
    } = args;

    const {
        wasAlreadyProcessed = wasAlreadyProcessedReal,
        getPending = getPendingReal,
    } = deps;

    // 1. Idempotency: a webhook retry for a message we already processed.
    if (await wasAlreadyProcessed(supabase, messageId)) {
        console.log(`Message ${messageId} already processed, ignoring WhatsApp retry.`);
        return;
    }

    // 2. Is this message the answer to a pending question? Route it to the agent
    //    that asked. A reply carries no prefix (the user just types "2" or "sí"),
    //    so we rely on the stored domain discriminator; older rows without one
    //    default to the expense agent (its historical owner).
    const pending = await getPending(supabase, userPhone, confirmationWindowMinutes);
    if (pending) {
        const owner = AGENTS_BY_DOMAIN[pending.dominio] ?? AGENTS_BY_DOMAIN[EXPENSE_DOMAIN];
        await owner.handlePendingReply({
            supabase,
            ai,
            whatsapp,
            userPhone,
            userText,
            pending,
            model,
            confirmationWindowMinutes,
            deps,
        });
        return;
    }

    // 3. Fresh message → Level-1 prefix routing to the owning agent.
    const { agent, remainder } = routeByPrefix(userText);
    await agent.handleMessage({
        supabase,
        ai,
        whatsapp,
        userPhone,
        messageId,
        userText,
        remainder,
        model,
        confirmationWindowMinutes,
        deps,
    });
}
