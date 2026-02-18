/**
 * worker/lib/google/auth.ts
 *
 * Single factory for Google API authentication in the worker.
 *
 * ─── Rule ────────────────────────────────────────────────────────────────────
 * Job handlers MUST NOT call any Google API endpoint directly.  They must
 * obtain a GoogleAuthContext from getGoogleAuthForClient() first.  If this
 * function returns null the handler must return immediately — status has
 * already been reset and no further work should be attempted.
 *
 * ─── Return values ────────────────────────────────────────────────────────────
 *   { mode: 'agency_master' }
 *     — The agency's master OAuth session covers this client.  The caller
 *       must use the agency credential path (separate from this module).
 *
 *   { mode: 'client_oauth', accessToken: string }
 *     — A ready-to-use bearer token for GBP API calls on behalf of the client.
 *       Include as: Authorization: Bearer <accessToken>
 *
 *   null
 *     — No usable connection.  onboarding_status (and optionally profiles.status)
 *       have been reset to 'awaiting_access_request'.  The job handler must
 *       return immediately without retrying.
 *
 * ─── Error behaviour ─────────────────────────────────────────────────────────
 *   Permanent auth failures (missing row, invalid/revoked credentials) → null.
 *   Transient failures (network errors, Google 5xx, DB errors) → re-thrown so
 *   BullMQ schedules a retry.
 *
 * ─── Security ─────────────────────────────────────────────────────────────────
 *   Token values are never logged.  Error messages contain only clientId.
 */

import { supabase }                    from '../../supabase'
import { loadGoogleConnection }        from './connection'
import {
  GoogleConnectionMissingError,
  GoogleConnectionInvalidError,
}                                      from './connection'
import type { GoogleConnection }       from './connection'

// ─── Return type ──────────────────────────────────────────────────────────────

export type GoogleAuthContext =
  | { mode: 'agency_master' }
  | { mode: 'client_oauth'; accessToken: string }

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Returns a GoogleAuthContext when a valid connection exists, or null when the
 * connection is absent/invalid (in which case onboarding statuses are reset).
 *
 * @param clientId  - Tenant boundary.  Must be present on every call.
 * @param opts.profileId - When provided, profiles.status is also reset on
 *                         permanent failures.  Pass whenever the calling job
 *                         has a profileId in scope.
 */
export async function getGoogleAuthForClient(
  clientId: string,
  opts: { profileId?: string } = {},
): Promise<GoogleAuthContext | null> {
  let connection: GoogleConnection

  try {
    connection = await loadGoogleConnection(clientId)

  } catch (err) {
    // ── Permanent: no connection row ──────────────────────────────────────
    if (err instanceof GoogleConnectionMissingError) {
      console.warn('[google/auth] No Google connection configured — stopping job gracefully', {
        clientId,
        onboardingStatus: 'awaiting_access_request',
      })
      await resetOnboardingStatus(clientId, opts.profileId, 'awaiting_access_request',
        'No Google connection configured for this client.')
      return null
    }

    // ── Permanent: revoked / corrupt credentials ───────────────────────────
    if (err instanceof GoogleConnectionInvalidError) {
      console.warn('[google/auth] Google connection invalid or revoked — stopping job gracefully', {
        clientId,
        onboardingStatus: 'awaiting_access_request',
      })
      await resetOnboardingStatus(clientId, opts.profileId, 'awaiting_access_request',
        'Google credentials are invalid or have been revoked. Re-authentication required.')
      return null
    }

    // ── Transient: DB error, network error, Google 5xx ────────────────────
    // Re-throw so BullMQ schedules a retry.  Do not reset status — the
    // connection may be perfectly valid once the transient condition clears.
    throw err
  }

  // ── Map to context ────────────────────────────────────────────────────────

  if (connection.mode === 'agency_master') {
    console.log('[google/auth] Agency master connection — using agency credentials', { clientId })
    return { mode: 'agency_master' }
  }

  // client_oauth — access token is already decrypted and refreshed if needed
  console.log('[google/auth] Client OAuth connection resolved', { clientId })
  return { mode: 'client_oauth', accessToken: connection.accessToken }
}

// ─── Status reset helpers ─────────────────────────────────────────────────────

/**
 * Resets clients.onboarding_status and optionally profiles.status.
 *
 * Errors are logged but never re-thrown — status reset is best-effort.  The
 * factory's null return is the authoritative signal to the caller.
 */
async function resetOnboardingStatus(
  clientId:  string,
  profileId: string | undefined,
  status:    string,
  lastError: string,
): Promise<void> {
  // ── Client-level status ───────────────────────────────────────────────────
  const { error: clientError } = await supabase
    .from('clients')
    .update({
      onboarding_status:     status,
      onboarding_last_error: lastError,
    })
    .eq('id', clientId)   // tenant boundary

  if (clientError) {
    console.error('[google/auth] Failed to reset clients.onboarding_status', {
      clientId,
      status,
      error: clientError.message,
    })
  } else {
    console.log('[google/auth] Reset clients.onboarding_status', { clientId, status })
  }

  // ── Profile-level status (when profileId is in scope) ────────────────────
  if (!profileId) return

  const { error: profileError } = await supabase
    .from('profiles')
    .update({ status })
    .eq('client_id', clientId)   // tenant boundary
    .eq('id', profileId)

  if (profileError) {
    console.error('[google/auth] Failed to reset profiles.status', {
      clientId,
      profileId,
      status,
      error: profileError.message,
    })
  } else {
    console.log('[google/auth] Reset profiles.status', { clientId, profileId, status })
  }
}
