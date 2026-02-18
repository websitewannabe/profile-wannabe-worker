/**
 * worker/lib/google/authFactory.ts
 *
 * Factory that returns a fully-configured Business Profile API client for a
 * given client, handling both connection modes and OAuth projects transparently.
 *
 * ─── Connection modes ─────────────────────────────────────────────────────────
 *   agency_master  — The worker uses the agency's own Google credentials.
 *                    The agency refresh token (GOOGLE_AGENCY_REFRESH_TOKEN) is
 *                    exchanged using the OAuth project specified in the
 *                    google_connections.oauth_project column.  The resulting
 *                    access token is cached in-process per project.
 *
 *   client_oauth   — The client completed their own OAuth flow.  Tokens are
 *                    stored encrypted in Supabase.  loadGoogleConnection()
 *                    handles decryption, expiry checking, refresh (using the
 *                    correct project credentials), and DB persistence before
 *                    the client is returned.
 *
 * ─── OAuth projects ───────────────────────────────────────────────────────────
 *   agency  — Uses GOOGLE_OAUTH_CLIENT_ID_AGENCY / GOOGLE_OAUTH_CLIENT_SECRET_AGENCY.
 *   saas    — Uses GOOGLE_OAUTH_CLIENT_ID_SAAS   / GOOGLE_OAUTH_CLIENT_SECRET_SAAS.
 *
 *   The project is read from google_connections.oauth_project and determines
 *   which credential pair is used for every token refresh.
 *
 * ─── Security ─────────────────────────────────────────────────────────────────
 *   Access token values are held exclusively in class-private (#) fields and
 *   local variables.  They are never logged, never serialised, and never
 *   included in error messages.
 *   Logs contain only clientId, connection mode, and oauth_project label.
 *
 * ─── Required env vars ────────────────────────────────────────────────────────
 *   GOOGLE_OAUTH_CLIENT_ID_AGENCY     — OAuth client ID for the agency project.
 *   GOOGLE_OAUTH_CLIENT_SECRET_AGENCY — OAuth client secret for the agency project.
 *   GOOGLE_OAUTH_CLIENT_ID_SAAS       — OAuth client ID for the saas project.
 *   GOOGLE_OAUTH_CLIENT_SECRET_SAAS   — OAuth client secret for the saas project.
 *   GOOGLE_AGENCY_REFRESH_TOKEN       — Refresh token for the agency's own Google
 *                                       account (agency_master connections only).
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *   const gbp = await getBusinessProfileClientForClient(clientId)
 *   const res = await gbp.get('/accounts')
 *   // or a fully-qualified GBP URL:
 *   const res2 = await gbp.get(
 *     'https://mybusinessbusinessinformation.googleapis.com/v1/locations/...',
 *   )
 */

import { loadGoogleConnection, resolveOAuthCredentials } from './connection'
import type { OAuthProject }                             from './connection'

// ─── GbpApiError ─────────────────────────────────────────────────────────────

/**
 * Thrown by BusinessProfileClient typed methods when Google returns a non-2xx
 * HTTP response.  Callers should inspect httpStatus to distinguish permanent
 * auth failures (401 / 403) from transient errors (5xx).
 */
export class GbpApiError extends Error {
  readonly httpStatus: number

  constructor(message: string, httpStatus: number) {
    super(message)
    this.name       = 'GbpApiError'
    this.httpStatus = httpStatus
  }
}

// ─── GBP API base URL ─────────────────────────────────────────────────────────
//
// Default base for relative paths.  For other GBP sub-APIs
// (businessinformation, reviews, etc.) pass the full URL to any method.

const GBP_BASE_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1'

// ─── Google token constants ───────────────────────────────────────────────────

const GOOGLE_TOKEN_ENDPOINT   = 'https://oauth2.googleapis.com/token'
const NEAR_EXPIRY_BUFFER_SECS = 300   // refresh 5 min before actual expiry

// ─── Per-project agency token cache ──────────────────────────────────────────
//
// Keyed by OAuthProject so each project's access token is cached independently.
// Module-scoped to persist for the worker process lifetime.

interface CachedToken {
  readonly value:     string
  readonly expiresAt: number   // ms epoch
}

const _agencyTokenCache = new Map<OAuthProject, CachedToken>()

// ─── BusinessProfileClient ────────────────────────────────────────────────────

/**
 * Authenticated HTTP client for the Google Business Profile family of APIs.
 *
 * The access token is stored in an ECMAScript private field (#accessToken) and
 * is not accessible from outside this class — it cannot be logged, serialised,
 * or leaked via property enumeration.
 *
 * Call the convenience methods (get / post / patch / delete) for common verbs,
 * or request() for anything else.  All methods inject Authorization automatically.
 */
export class BusinessProfileClient {
  readonly #accessToken: string

  /** Connection mode — safe to log and inspect. */
  readonly mode: 'agency_master' | 'client_oauth'

  /** Client tenant identifier — safe to log and inspect. */
  readonly clientId: string

  /** OAuth project whose credentials issued this token — safe to log. */
  readonly oauthProject: OAuthProject

  constructor(opts: {
    accessToken:  string
    mode:         'agency_master' | 'client_oauth'
    clientId:     string
    oauthProject: OAuthProject
  }) {
    this.#accessToken = opts.accessToken
    this.mode         = opts.mode
    this.clientId     = opts.clientId
    this.oauthProject = opts.oauthProject
  }

  /**
   * GET request to a GBP API path or full URL.
   * Path examples:
   *   'accounts'                      → GBP_BASE_URL/accounts
   *   '/accounts/123/locations'       → GBP_BASE_URL/accounts/123/locations
   *   'https://mybusiness.../v1/...'  → used as-is
   */
  get(path: string): Promise<Response> {
    return this.#authedFetch(path, { method: 'GET' })
  }

  /** POST request.  Body is serialised to JSON automatically. */
  post(path: string, body: unknown): Promise<Response> {
    return this.#authedFetch(path, {
      method: 'POST',
      body:   JSON.stringify(body),
    })
  }

  /** PATCH request.  Body is serialised to JSON automatically. */
  patch(path: string, body: unknown): Promise<Response> {
    return this.#authedFetch(path, {
      method: 'PATCH',
      body:   JSON.stringify(body),
    })
  }

  /** DELETE request. */
  delete(path: string): Promise<Response> {
    return this.#authedFetch(path, { method: 'DELETE' })
  }

  /**
   * Low-level authenticated fetch.  Use when you need full control over headers
   * or the request body format.  Authorization is still injected automatically.
   */
  request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.#authedFetch(path, init)
  }

  // ── GBP domain methods ─────────────────────────────────────────────────────

  /**
   * Lists all Google Business Profile accounts visible to the authenticated
   * credential.  Returns an empty array when no accounts are accessible.
   *
   * @throws {GbpApiError} on any non-2xx HTTP response.
   */
  async listGoogleAccounts(): Promise<Array<{ name: string }>> {
    const res = await this.get('accounts')

    if (!res.ok) {
      throw new GbpApiError(
        `[BusinessProfileClient] listGoogleAccounts failed — HTTP ${res.status} for clientId=${this.clientId}`,
        res.status,
      )
    }

    const data = await res.json() as { accounts?: Array<{ name: string }> }
    return data.accounts ?? []
  }

  /**
   * Lists locations managed under the given GBP account resource name.
   * Returns an empty array when no locations are found.
   *
   * @param accountName  Full GBP account resource name, e.g. "accounts/12345678".
   * @throws {GbpApiError} on any non-2xx HTTP response.
   */
  async listLocationsForGoogleAccount(
    accountName: string,
  ): Promise<Array<{ name: string }>> {
    const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`
    const res = await this.get(url)

    if (!res.ok) {
      throw new GbpApiError(
        `[BusinessProfileClient] listLocationsForGoogleAccount failed — HTTP ${res.status} ` +
        `for clientId=${this.clientId} account=${accountName}`,
        res.status,
      )
    }

    const data = await res.json() as { locations?: Array<{ name: string }> }
    return data.locations ?? []
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #authedFetch(path: string, init: RequestInit): Promise<Response> {
    const url = path.startsWith('http')
      ? path
      : `${GBP_BASE_URL}/${path.replace(/^\/+/, '')}`

    const headers = new Headers(init.headers as HeadersInit | undefined)
    // Authorization is set last — callers cannot accidentally override it.
    headers.set('Content-Type', 'application/json')
    headers.set('Authorization', `Bearer ${this.#accessToken}`)

    return fetch(url, { ...init, headers })
  }
}

// ─── getBusinessProfileClientForClient ───────────────────────────────────────

/**
 * Returns a BusinessProfileClient configured with a valid access token for the
 * given client, using the OAuth project specified in google_connections.
 *
 * Handles both connection modes:
 *   agency_master → refreshes (and caches per project) the agency's access token.
 *   client_oauth  → loadGoogleConnection() decrypts, refreshes if expired using
 *                   the correct project credentials, and persists the updated
 *                   token back to Supabase before returning.
 *
 * @throws if the google_connections row is missing, credentials are invalid or
 *         revoked, or a required env var is absent.
 *         For graceful-stop behaviour (set status + return null), use
 *         getGoogleAuthForClient() from auth.ts instead.
 */
export async function getBusinessProfileClientForClient(
  clientId: string,
): Promise<BusinessProfileClient> {
  const connection = await loadGoogleConnection(clientId)

  // ── agency_master path ────────────────────────────────────────────────────

  if (connection.mode === 'agency_master') {
    const { oauthProject } = connection

    console.log('[google/authFactory] agency_master — loading agency credentials', {
      clientId,
      mode:         'agency_master',
      oauthProject,
    })

    const agencyAccessToken = await getAgencyAccessToken(oauthProject)

    return new BusinessProfileClient({
      accessToken:  agencyAccessToken,
      mode:         'agency_master',
      clientId,
      oauthProject,
    })
  }

  // ── client_oauth path ─────────────────────────────────────────────────────
  //
  // loadGoogleConnection() has already:
  //   1. Decrypted the refresh token
  //   2. Resolved project-specific OAuth credentials
  //   3. Checked expiry and refreshed the access token via Google if needed
  //   4. Persisted the new encrypted_access_token + token_expires_at to Supabase

  const { oauthProject } = connection

  console.log('[google/authFactory] client_oauth — connection resolved', {
    clientId,
    mode:         'client_oauth',
    oauthProject,
  })

  return new BusinessProfileClient({
    accessToken:  connection.accessToken,
    mode:         'client_oauth',
    clientId,
    oauthProject,
  })
}

// ─── Agency token management ──────────────────────────────────────────────────

/**
 * Returns a valid access token for the agency's own Google account, using the
 * specified OAuth project's credentials for the token refresh call.
 *
 * Access tokens are cached per-project.  Each cached entry is validated against
 * a NEAR_EXPIRY_BUFFER_SECS early-refresh window before being returned, so
 * callers never receive a token that expires mid-request.
 *
 * The token value is never logged.  Only the project label appears in logs.
 *
 * @throws if GOOGLE_AGENCY_REFRESH_TOKEN is absent, project credentials are
 *         missing, or the Google token endpoint rejects the request.
 */
async function getAgencyAccessToken(oauthProject: OAuthProject): Promise<string> {
  // ── Return cached token if still valid ────────────────────────────────────
  const cached = _agencyTokenCache.get(oauthProject)

  if (cached) {
    const bufferMs        = NEAR_EXPIRY_BUFFER_SECS * 1000
    const effectiveExpiry = cached.expiresAt - bufferMs

    if (Date.now() < effectiveExpiry) {
      return cached.value
    }

    // Entry is expired or within buffer — evict and refresh.
    _agencyTokenCache.delete(oauthProject)
  }

  // ── Resolve credentials ───────────────────────────────────────────────────
  const agencyRefreshToken = process.env.GOOGLE_AGENCY_REFRESH_TOKEN
  if (!agencyRefreshToken) {
    throw new Error(
      '[google/authFactory] GOOGLE_AGENCY_REFRESH_TOKEN is required for ' +
      'agency_master connections but is not set.',
    )
  }

  // resolveOAuthCredentials validates both vars and throws with the specific
  // env var name if either is missing — no need to duplicate that check here.
  const creds = resolveOAuthCredentials(oauthProject)

  // ── Refresh via Google token endpoint ─────────────────────────────────────
  console.log('[google/authFactory] Refreshing agency access token', {
    oauthProject: creds.projectLabel,
  })

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: agencyRefreshToken,
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
  })

  let res: Response
  try {
    res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (networkErr) {
    throw new Error(
      '[google/authFactory] Network error refreshing agency access token: ' +
      (networkErr instanceof Error ? networkErr.message : String(networkErr)),
    )
  }

  if (!res.ok) {
    // Never include the response body — it may echo back sensitive parameters.
    throw new Error(
      `[google/authFactory] Google rejected agency token refresh (project=${creds.projectLabel}) — ` +
      `HTTP ${res.status} ${res.statusText}. ` +
      `Verify GOOGLE_AGENCY_REFRESH_TOKEN and GOOGLE_OAUTH_CLIENT_ID_${oauthProject.toUpperCase()} are valid.`,
    )
  }

  let tokenData: { access_token?: string; expires_in?: number }
  try {
    tokenData = await res.json() as { access_token?: string; expires_in?: number }
  } catch {
    throw new Error(
      `[google/authFactory] Failed to parse Google agency token response (project=${creds.projectLabel}).`,
    )
  }

  if (!tokenData.access_token) {
    throw new Error(
      `[google/authFactory] Google agency token response missing access_token (project=${creds.projectLabel}).`,
    )
  }

  // ── Populate per-project cache ────────────────────────────────────────────
  // expires_in is seconds; default 3600 (1 hour) if omitted.
  const expiresInMs = (tokenData.expires_in ?? 3600) * 1000
  const entry: CachedToken = {
    value:     tokenData.access_token,
    expiresAt: Date.now() + expiresInMs,
  }
  _agencyTokenCache.set(oauthProject, entry)

  console.log('[google/authFactory] Agency access token refreshed and cached', {
    oauthProject: creds.projectLabel,
  })

  return entry.value
}
