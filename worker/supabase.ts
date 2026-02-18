import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SECRET_KEY

if (!supabaseUrl) throw new Error('SUPABASE_URL is required')
if (!supabaseKey) throw new Error('SUPABASE_SECRET_KEY is required')

/**
 * Supabase service-role client for worker use.
 *
 * ─── TENANT ISOLATION CONTRACT ────────────────────────────────────────────────
 * This client has elevated (service-role) privileges and bypasses Row Level
 * Security.  Every query and every write performed through this client MUST
 * manually enforce tenant isolation by including:
 *
 *   READ  → .eq('client_id', clientId)  on every SELECT
 *   WRITE → { client_id: clientId, ... }  in every INSERT / UPSERT payload
 *           + .eq('client_id', clientId)  on every UPDATE / DELETE filter
 *
 * Never query or mutate rows using only a profileId or locationId — those
 * values are not globally unique across tenants and must always be combined
 * with client_id to prevent cross-tenant data leakage.
 * ──────────────────────────────────────────────────────────────────────────────
 */
export const supabase = createClient(supabaseUrl, supabaseKey)
