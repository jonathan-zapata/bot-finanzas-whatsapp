import { withStandingOther } from './taxonomyBuilder.js';

const TABLE = 'email_taxonomy';

// Durable, per-user store for the confirmed category taxonomy. It outlives the
// ~2h metadata cache and every session, so summaries are labeled consistently
// over time. `rebuild categories` just overwrites it.

// Returns the stored taxonomy (array of category names) or null if the user
// hasn't confirmed one yet.
export async function getTaxonomy(supabase, phone) {
    const { data, error } = await supabase.from(TABLE).select('categories').eq('phone', phone).maybeSingle();
    if (error) {
        console.error('❌ Error reading taxonomy:', error);
        return null;
    }
    return data?.categories ?? null;
}

// Persists (replaces) the confirmed taxonomy, always including the standing
// "Other/Uncategorized" category exactly once.
export async function saveTaxonomy(supabase, phone, categories) {
    const withOther = withStandingOther(categories);
    const { error } = await supabase
        .from(TABLE)
        .upsert(
            { phone, categories: withOther, updated_at: new Date().toISOString() },
            { onConflict: 'phone' }
        );
    if (error) throw error;
    return withOther;
}
