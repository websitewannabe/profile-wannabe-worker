/**
 * worker/lib/google/connection.ts
 *
 * Loads a client's Google connection from Supabase and returns a ready-to-use
 * access token (or signals that the agency master token should be used instead).
 *
 * Supported connection types
 * ─────────────────────────
 *   agency_master  — The agency's own OAuth session handles API calls.
 *                    No per-client token is decrypted; callers should switch
 *                    to the agency credential path.
 *
 *   client_oauth   — The client completed their own OAuth flow.  The stored
 *                    tokens are encrypted at rest with AES-256-GCM.  If the
 *                    access token is expired or within the near-expiry window
 *                    it is refreshed via the Google token endpoint and the new
 *                    value is persisted back to Supabase (encrypted).
 *
 * Security notes
 * ─────────────
 *   - Decrypted token values are held only in local variables and are never
 *     logged, never serialised, and never included in thrown errors.
 *   - Logs use clientId for correlation; no token material appears in them.
 *   - All Supabase queries are scoped to client_id (tenant isolation).
 *
 * Required env vars
 * ─────────────────
 *   TOKEN_ENCRYPTION_KEY              — 64-char hex (32 bytes); shared with SaaS.
 *   GOOGLE_OAUTH_CLIENT_ID_AGENCY     — Client ID for the "agency" Google Cloud project.
 *   GOOGLE_OAUTH_CLIENT_SECRET_AGENCY — Client secret for the "agency" project.
 *   GOOGLE_OAUTH_CLIENT_ID_SAAS       — Client ID for the "saas" Google Cloud project.
 *   GOOGLE_OAUTH_CLIENT_SECRET_SAAS   — Client secret for the "saas" project.
 *
 * Credentials are resolved lazily per-call based on the oauth_project field of
 * the google_connections row, so only the project actually in use needs to be set.
 */

import { supabase } from '../../supabase'
import { decrypt, encrypt, DecryptionError } from '../crypto/tokens'

// ─── Config ───────────────────────────────────────────────────────────────────

/** Refresh the access token this many seconds before it actually expires. */
const NEAR_EXPIRY_BUFFER_SECS = 300 // 5 minutes

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

// ─── OAuth project type and credential resolver ───────────────────────────────

/** Which Google Cloud project's OAuth app issued this connection's credentials. */
export type OAuthProject = 'agency' | 'saas'

/**
 * Resolves the OAuth client credentials for the given project.
 * Validated lazily (at call time) so only the project actually in use needs
 * to be configured.  Both env vars must be present or this throws immediately.
 */
export function resolveOAuthCredentials(project: OAuthProject): {
  clientId:     string
  clientSecret: string
  projectLabel: string   // safe to log — name only, no secret material
} {
  const suffix      = project.toUpperCase() as 'AGENCY' | 'SAAS'
  const idKey       = `GOOGLE_OAUTH_CLIENT_ID_${suffix}`
  const secretKey   = `GOOGLE_OAUTH_CLIENT_SECRET_${suffix}`
  const clientId    = process.env[idKey]
  const clientSecret = process.env[secretKey]

  if (!clientId) {
    throw new Error(`[google/connection] ${idKey} is required for oauth_project="${project}" but is not set.`)
  }
  if (!clientSecret) {
    throw new Error(`[google/connection] ${secretKey} is required for oauth_project="${project}" but is not set.`)
  }

  return { clientId, clientSecret, projectLabel: project }
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

/**
 * Thrown when no google_connections row exists for the client.
 * Permanent — the client has not completed the Google OAuth/connection setup.
 */
export class GoogleConnectionMissingError extends Error {
  readonly clientId: string
  constructor(clientId: string) {
    super(`[google/connection] No google_connections row found for clientId=${clientId}.`)
    this.name = 'GoogleConnectionMissingError'
    this.clientId = clientId
  }
}

/**
 * Thrown for permanent authentication failures that require user action:
 *   - Missing or corrupt token data in the DB
 *   - Google 4xx response (credentials revoked or invalid)
 *
 * Must NOT be thrown for transient failures (network errors, 5xx from Google).
 * Callers should catch this and reset onboarding status without retrying.
 */
export class GoogleConnectionInvalidError extends Error {
  readonly clientId: string
  constructor(message: string, clientId: string) {
    super(message)
    this.name = 'GoogleConnectionInvalidError'
    this.clientId = clientId
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Returned when the client uses the agency's own Google account. */
export interface AgencyMasterConnection {
  mode: 'agency_master'
  /** OAuth project whose client credentials must be used for agency token refresh. */
  oauthProject: OAuthProject
}

/** Returned when the client completed their own OAuth flow. */
export interface ClientOAuthConnection {
  mode: 'client_oauth'
  /** Decrypted, valid access token — ready to use in GBP API calls. */
  accessToken: string
  /** OAuth project whose credentials were used to issue and refresh this token. */
  oauthProject: OAuthProject
}

export type GoogleConnection = AgencyMasterConnection | ClientOAuthConnection

// ─── DB row shape ─────────────────────────────────────────────────────────────

interface GoogleConnectionRow {
  id: string
  client_id: string
  connection_type: string
  oauth_project:   string   // 'agency' | 'saas' — cast to OAuthProject after validation
  encrypted_access_token:  string | null
  encrypted_refresh_token: string | null
  token_expires_at:        string | null
}

// ─── Google token refresh response ────────────────────────────────────────────

interface GoogleTokenResponse {
  access_token: string
  expires_in:   number   // seconds from now
  token_type:   string
  // Google may or may not rotate the refresh token
  refresh_token?: string
}

// ─── loadGoogleConnection ─────────────────────────────────────────────────────

/**
 * Fetches the google_connections row for the given client and returns a
 * GoogleConnection object.
 *
 * For `client_oauth` connections the access token is decrypted and refreshed
 * if it is expired or within the near-expiry window.  The refreshed token is
 * persisted back to Supabase before being returned.
 *
 * @throws if the row is missing, the connection type is unrecognised, tokens
 *         are absent or undecryptable, or the Google token endpoint fails.
 */
export async function loadGoogleConnection(clientId: string): Promise<GoogleConnection> {
  // ── 1. Fetch the connection row ────────────────────────────────────────────
  const { data, error } = await supabase
    .from('google_connections')
    .select('id, client_id, connection_type, oauth_project, encrypted_access_token, encrypted_refresh_token, token_expires_at')
    .eq('client_id', clientId)   // tenant isolation — mandatory
    .maybeSingle()

  if (error) {
    throw new Error(
      `[google/connection] DB error fetching google_connections for clientId=${clientId}: ${error.message}`,
    )
  }

  if (!data) {
    throw new GoogleConnectionMissingError(clientId)
  }

  const row = data as GoogleConnectionRow

  // Validate oauth_project value from DB before treating as a typed enum.
  if (row.oauth_project !== 'agency' && row.oauth_project !== 'saas') {
    throw new Error(
      `[google/connection] Unknown oauth_project="${row.oauth_project}" for clientId=${clientId}. ` +
      'Expected "agency" or "saas".',
    )
  }
  const oauthProject = row.oauth_project as OAuthProject

  // ── 2. Branch on connection type ──────────────────────────────────────────

  if (row.connection_type === 'agency_master') {
    console.log(`[google/connection] agency_master connection — clientId=${clientId} project=${oauthProject}`)
    return { mode: 'agency_master', oauthProject }
  }

  if (row.connection_type === 'client_oauth') {
    return resolveClientOAuth(clientId, row, oauthProject)
  }

  throw new Error(
    `[google/connection] Unknown connection_type="${row.connection_type}" for clientId=${clientId}.`,
  )
}

// ─── resolveClientOAuth ───────────────────────────────────────────────────────

async function resolveClientOAuth(
  clientId:     string,
  row:          GoogleConnectionRow,
  oauthProject: OAuthProject,
): Promise<ClientOAuthConnection> {
  // ── Decrypt refresh token (required) ──────────────────────────────────────
  if (!row.encrypted_refresh_token) {
    throw new GoogleConnectionInvalidError(
      `[google/connection] client_oauth row has no encrypted_refresh_token for clientId=${clientId}.`,
      clientId,
    )
  }

  let refreshToken: string
  try {
    refreshToken = decrypt(row.encrypted_refresh_token)
  } catch (err) {
    if (err instanceof DecryptionError) {
      throw new GoogleConnectionInvalidError(
        `[google/connection] Failed to decrypt refresh_token for clientId=${clientId} — key mismatch or data corruption.`,
        clientId,
      )
    }
    throw err
  }

  // ── Check whether the access token is usable ──────────────────────────────
  const needsRefresh = isExpiredOrNearExpiry(row.token_expires_at)

  if (!needsRefresh && row.encrypted_access_token) {
    // Attempt to use the stored access token.
    let accessToken: string
    try {
      accessToken = decrypt(row.encrypted_access_token)
    } catch (err) {
      if (err instanceof DecryptionError) {
        // Stored token is corrupt — fall through to refresh.
        console.warn(
          `[google/connection] Stored access_token failed decryption for clientId=${clientId} — will refresh.`,
        )
        return performRefresh(clientId, row.id, refreshToken, oauthProject)
      }
      throw err
    }

    console.log(`[google/connection] Using valid stored access token — clientId=${clientId} project=${oauthProject}`)
    return { mode: 'client_oauth', accessToken, oauthProject }
  }

  // ── Access token missing or expired — refresh via Google ──────────────────
  return performRefresh(clientId, row.id, refreshToken, oauthProject)
}

// ─── performRefresh ───────────────────────────────────────────────────────────

/**
 * Calls the Google token endpoint with the refresh token, persists the new
 * encrypted access token to Supabase, and returns the usable access token.
 *
 * Token values are never logged.
 */
async function performRefresh(
  clientId:     string,
  connectionId: string,
  refreshToken: string,
  oauthProject: OAuthProject,
): Promise<ClientOAuthConnection> {
  const creds = resolveOAuthCredentials(oauthProject)

  console.log(`[google/connection] Refreshing access token — clientId=${clientId} project=${creds.projectLabel}`)

  // ── Call Google token endpoint ─────────────────────────────────────────────
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
  })

  let tokenRes: Response
  try {
    tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (networkErr) {
    throw new Error(
      `[google/connection] Network error reaching Google token endpoint for clientId=${clientId}: ` +
      (networkErr instanceof Error ? networkErr.message : String(networkErr)),
    )
  }

  if (!tokenRes.ok) {
    // 4xx → permanent (credentials revoked/invalid); 5xx → transient (retry).
    // Never include the response body — it may echo back sensitive parameters.
    if (tokenRes.status >= 400 && tokenRes.status < 500) {
      throw new GoogleConnectionInvalidError(
        `[google/connection] Google token refresh rejected (HTTP ${tokenRes.status}) for clientId=${clientId} — credentials revoked or invalid.`,
        clientId,
      )
    }
    throw new Error(
      `[google/connection] Google token refresh failed for clientId=${clientId} — ` +
      `HTTP ${tokenRes.status} ${tokenRes.statusText}.`,
    )
  }

  let tokenData: GoogleTokenResponse
  try {
    tokenData = await tokenRes.json() as GoogleTokenResponse
  } catch {
    throw new Error(
      `[google/connection] Failed to parse Google token response for clientId=${clientId}.`,
    )
  }

  if (!tokenData.access_token) {
    throw new GoogleConnectionInvalidError(
      `[google/connection] Google token response missing access_token for clientId=${clientId}.`,
      clientId,
    )
  }

  // ── Compute new expiry ────────────────────────────────────────────────────
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString()

  // ── Encrypt the new access token ──────────────────────────────────────────
  const encryptedAccessToken = encrypt(tokenData.access_token)

  // ── Build update payload ──────────────────────────────────────────────────
  // Google sometimes rotates the refresh token; persist the new one if provided.
  const updatePayload: Record<string, string> = {
    encrypted_access_token: encryptedAccessToken,
    token_expires_at:       expiresAt,
    updated_at:             new Date().toISOString(),
  }

  if (tokenData.refresh_token) {
    updatePayload.encrypted_refresh_token = encrypt(tokenData.refresh_token)
  }

  // ── Persist to Supabase ───────────────────────────────────────────────────
  const { error: updateError } = await supabase
    .from('google_connections')
    .update(updatePayload)
    .eq('id',        connectionId)   // primary key
    .eq('client_id', clientId)       // tenant isolation double-lock

  if (updateError) {
    throw new Error(
      `[google/connection] Failed to persist refreshed token for clientId=${clientId}: ${updateError.message}`,
    )
  }

  console.log(`[google/connection] Refreshed and persisted new access token — clientId=${clientId} project=${oauthProject}`)

  return { mode: 'client_oauth', accessToken: tokenData.access_token, oauthProject }
}

// ─── getValidAccessTokenForClient ────────────────────────────────────────────

/**
 * Returns a valid, decrypted access token for the given client by resolving
 * their google_connections row.
 *
 * This is the single authorised token-resolution path for the worker.
 * Only `client_oauth` connections are supported — the worker carries no
 * global agency refresh token and never falls back to one.
 *
 * @throws {GoogleConnectionMissingError} if no google_connections row exists.
 * @throws {GoogleConnectionInvalidError} if tokens are absent, corrupt, or revoked.
 * @throws {Error} if connection_type is "agency_master" or unrecognised.
 */
export async function getValidAccessTokenForClient(
  clientId: string,
): Promise<{ accessToken: string; oauthProject: OAuthProject }> {
  const connection = await loadGoogleConnection(clientId)

  if (connection.mode === 'agency_master') {
    throw new Error(
      `[google/connection] agency_master connections are not supported in this worker. ` +
      `clientId=${clientId} must use connection_type="client_oauth". ` +
      `Update the google_connections row or re-run the client OAuth flow.`,
    )
  }

  return {
    accessToken:  connection.accessToken,
    oauthProject: connection.oauthProject,
  }
}

// ─── isExpiredOrNearExpiry ────────────────────────────────────────────────────

/**
 * Returns true if the token_expires_at timestamp is missing, in the past,
 * or within NEAR_EXPIRY_BUFFER_SECS seconds of the current time.
 */
function isExpiredOrNearExpiry(tokenExpiresAt: string | null): boolean {
  if (!tokenExpiresAt) return true

  const expiresAt  = new Date(tokenExpiresAt).getTime()
  const bufferMs   = NEAR_EXPIRY_BUFFER_SECS * 1000
  const effectiveExpiry = expiresAt - bufferMs

  return Date.now() >= effectiveExpiry
}
