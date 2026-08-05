import { withStandingOther } from './taxonomyBuilder.js';

const TABLE = 'email_taxonomia';

// Durable, per-user store for the confirmed category taxonomy. It outlives the
// ~2h metadata cache and every session, so summaries are labeled consistently
// over time. `rebuild categories` just overwrites it.

// Returns the stored taxonomy (array of category names) or null if the user
// hasn't confirmed one yet.
export async function getTaxonomy(supabase, phone) {
    const { data, error } = await supabase.from(TABLE).select('categorias').eq('telefono', phone).maybeSingle();
    if (error) {
        console.error('❌ Error reading taxonomy:', error);
        return null;
    }
    return data?.categorias ?? null;
}

// Persists (replaces) the confirmed taxonomy, always including the standing
// "Other/Uncategorized" category exactly once.
export async function saveTaxonomy(supabase, phone, categories) {
    const categorias = withStandingOther(categories);
    const { error } = await supabase
        .from(TABLE)
        .upsert(
            { telefono: phone, categorias, updated_at: new Date().toISOString() },
            { onConflict: 'telefono' }
        );
    if (error) throw error;
    return categorias;
}
