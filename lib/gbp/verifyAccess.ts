import {
  getBusinessProfileClientForClient,
  BusinessProfileClient,
  GbpApiError,
} from '../../worker/lib/google/authFactory'
import {
  GoogleConnectionMissingError,
  GoogleConnectionInvalidError,
} from '../../worker/lib/google/connection'

// ─── Result type ──────────────────────────────────────────────────────────────

/**
 * Discriminated outcome from checkGbpAccessGranted.
 *
 *   granted      — Manager access confirmed via live GBP API; advance the client.
 *   no_accounts  — Credential is valid but no GBP accounts are visible yet; retry.
 *   no_locations — Accounts exist but contain no managed locations yet; retry.
 *   auth_error   — Connection missing, credentials invalid/revoked, or Google
 *                  returned 401/403; mark auth_error and stop retrying.
 */
export type GbpAccessOutcome = 'granted' | 'no_accounts' | 'no_locations' | 'auth_error'

export interface GbpAccessCheckResult {
  outcome: GbpAccessOutcome
  /** Human-readable explanation — included in logs and error state. */
  reason: string
}

// ─── checkGbpAccessGranted ────────────────────────────────────────────────────
//
// Verifies GBP manager access by calling the live Google Business Profile API.
// Auth is resolved exclusively via google_connections — no gbp_accounts reads.

export async function checkGbpAccessGranted(
  clientId: string,
): Promise<GbpAccessCheckResult> {
  // ── 1. Resolve auth via google_connections ────────────────────────────────
  //
  // GoogleConnectionMissingError  — no google_connections row; permanent stop.
  // GoogleConnectionInvalidError  — credentials revoked/corrupt; permanent stop.
  // Any other throw               — transient (DB / network); re-thrown so
  //                                 BullMQ schedules a retry.
  let gbp: BusinessProfileClient

  try {
    gbp = await getBusinessProfileClientForClient(clientId)
  } catch (err) {
    if (
      err instanceof GoogleConnectionMissingError ||
      err instanceof GoogleConnectionInvalidError
    ) {
      return {
        outcome: 'auth_error',
        reason:  'missing_google_connection',
      }
    }
    throw err
  }

  // ── 2. List accounts visible to the credential ────────────────────────────
  //
  // 401 / 403 from Google means the access token is invalid or the credential
  // no longer has the required scopes — permanent auth failure, stop retrying.
  let accounts: Array<{ name: string }>

  try {
    accounts = await gbp.listGoogleAccounts()
  } catch (err) {
    if (err instanceof GbpApiError && (err.httpStatus === 401 || err.httpStatus === 403)) {
      return {
        outcome: 'auth_error',
        reason:  `gbp_api_${err.httpStatus}_on_accounts`,
      }
    }
    throw err
  }

  if (accounts.length === 0) {
    return {
      outcome: 'no_accounts',
      reason:  'no_gbp_accounts_visible',
    }
  }

  // ── 3. Check locations across all visible accounts ─────────────────────────
  //
  // Short-circuit as soon as one location is confirmed — no need to paginate
  // or iterate beyond the first non-empty account for an access check.
  let totalLocations = 0

  for (const account of accounts) {
    let locations: Array<{ name: string }>

    try {
      locations = await gbp.listLocationsForGoogleAccount(account.name)
    } catch (err) {
      if (err instanceof GbpApiError && (err.httpStatus === 401 || err.httpStatus === 403)) {
        return {
          outcome: 'auth_error',
          reason:  `gbp_api_${err.httpStatus}_on_locations`,
        }
      }
      throw err
    }

    totalLocations += locations.length

    if (totalLocations > 0) {
      return {
        outcome: 'granted',
        reason:  'gbp_api_confirmed',
      }
    }
  }

  // ── 4. Accounts exist but no locations found in any of them ───────────────
  return {
    outcome: 'no_locations',
    reason:  'no_locations_in_gbp_accounts',
  }
}
