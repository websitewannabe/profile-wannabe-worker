/**
 * worker/lib/google/authFactory.ts
 *
 * Factory that returns a fully-configured Business Profile API client for a
 * given client, resolving their OAuth token exclusively from google_connections.
 *
 * ─── Token resolution ─────────────────────────────────────────────────────────
 *   All token resolution flows through getValidAccessTokenForClient(clientId),
 *   which reads from the google_connections table keyed by client_id.
 *   Only client_oauth connections are supported; agency_master rows throw
 *   immediately so no global credential env var is ever required.
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
 *
 *   GOOGLE_AGENCY_REFRESH_TOKEN is NOT used and must NOT be set as a dependency.
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *   const gbp = await getBusinessProfileClientForClient(clientId)
 *   const res = await gbp.get('/accounts')
 *   // or a fully-qualified GBP URL:
 *   const res2 = await gbp.get(
 *     'https://mybusinessbusinessinformation.googleapis.com/v1/locations/...',
 *   )
 */

import { getValidAccessTokenForClient } from './connection'
import type { OAuthProject }            from './connection'

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

  /** Connection mode — always client_oauth; safe to log and inspect. */
  readonly mode: 'client_oauth'

  /** Client tenant identifier — safe to log and inspect. */
  readonly clientId: string

  /** OAuth project whose credentials issued this token — safe to log. */
  readonly oauthProject: OAuthProject

  constructor(opts: {
    accessToken:  string
    clientId:     string
    oauthProject: OAuthProject
  }) {
    this.#accessToken = opts.accessToken
    this.mode         = 'client_oauth'
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
 * given client.
 *
 * Token resolution goes exclusively through getValidAccessTokenForClient(clientId),
 * which reads from google_connections (client_oauth mode only).
 * agency_master connections are rejected — this worker does not carry a global
 * agency refresh token.
 *
 * @throws if the google_connections row is missing, connection_type is
 *         agency_master, credentials are invalid/revoked, or a required env
 *         var is absent.
 *         For graceful-stop behaviour (set status + return null), use
 *         getGoogleAuthForClient() from auth.ts instead.
 */
export async function getBusinessProfileClientForClient(
  clientId: string,
): Promise<BusinessProfileClient> {
  const { accessToken, oauthProject } = await getValidAccessTokenForClient(clientId)

  console.log('[google/authFactory] client_oauth — connection resolved', {
    clientId,
    mode:         'client_oauth',
    oauthProject,
  })

  return new BusinessProfileClient({
    accessToken,
    clientId,
    oauthProject,
  })
}
