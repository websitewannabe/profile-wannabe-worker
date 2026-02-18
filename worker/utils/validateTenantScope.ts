import { supabase } from '../supabase'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TenantScopeContext {
  clientId: string
  profileId: string
  locationId: string
  reason: string
}

/**
 * Thrown when a job's (clientId, profileId, locationId) triple fails
 * ownership validation.  Catching this error class lets callers distinguish
 * tenant-scope failures from unexpected runtime errors.
 */
export class TenantScopeError extends Error {
  readonly context: TenantScopeContext

  constructor(message: string, context: TenantScopeContext) {
    super(message)
    this.name = 'TenantScopeError'
    this.context = context
  }
}

// ─── Validator ────────────────────────────────────────────────────────────────

/**
 * Validates that the given (clientId, profileId, locationId) form a valid
 * ownership chain before any job logic runs.
 *
 * TENANT ISOLATION RULE: Every query in this file (and across the worker) MUST
 * include `.eq('client_id', clientId)` as the outermost filter.  This ensures
 * that even if a profileId or locationId were somehow forged or leaked across
 * tenants, no row belonging to a different client is ever matched or mutated.
 *
 * Checks (in order, fail-fast):
 *   1. profileId belongs to clientId   → profiles.client_id = clientId
 *   2. locationId belongs to clientId AND profileId
 *                                      → gbp_locations.client_id  = clientId
 *                                        gbp_locations.profile_id = profileId
 *
 * @throws {TenantScopeError} on any ownership mismatch or DB error
 */
export async function validateTenantScope(
  clientId: string,
  profileId: string,
  locationId: string,
): Promise<void> {
  // ── 1. Profile must belong to client ──────────────────────────────────────
  // TENANT ISOLATION: Always filter by client_id first.  Never query profiles
  // by profileId alone — a profileId is not globally unique across tenants.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('client_id', clientId) // tenant boundary — must come first
    .eq('id', profileId)
    .maybeSingle()

  if (profileError) {
    const msg = `[validateTenantScope] DB error verifying profile ownership`
    console.error(msg, { clientId, profileId, locationId, error: profileError.message })
    throw new TenantScopeError(msg, {
      clientId,
      profileId,
      locationId,
      reason: `db_error: ${profileError.message}`,
    })
  }

  if (!profile) {
    const msg = `[validateTenantScope] Profile ${profileId} does not belong to client ${clientId}`
    console.error(msg, { clientId, profileId, locationId })
    throw new TenantScopeError(msg, {
      clientId,
      profileId,
      locationId,
      reason: 'profile_client_mismatch',
    })
  }

  // ── 2. Location must belong to client AND profile ─────────────────────────
  // TENANT ISOLATION: Filter by client_id in addition to profile_id.  Never
  // query gbp_locations by locationId or profileId alone — doing so would
  // allow a malicious or misconfigured job to access locations from a
  // different tenant if profile_id values ever collide across clients.
  const { data: location, error: locationError } = await supabase
    .from('gbp_locations')
    .select('id')
    .eq('client_id', clientId)  // tenant boundary — must be present on every query
    .eq('profile_id', profileId)
    .eq('id', locationId)
    .maybeSingle()

  if (locationError) {
    const msg = `[validateTenantScope] DB error verifying location ownership`
    console.error(msg, { clientId, profileId, locationId, error: locationError.message })
    throw new TenantScopeError(msg, {
      clientId,
      profileId,
      locationId,
      reason: `db_error: ${locationError.message}`,
    })
  }

  if (!location) {
    const msg = `[validateTenantScope] Location ${locationId} does not belong to profile ${profileId} / client ${clientId}`
    console.error(msg, { clientId, profileId, locationId })
    throw new TenantScopeError(msg, {
      clientId,
      profileId,
      locationId,
      reason: 'location_profile_mismatch',
    })
  }
}
