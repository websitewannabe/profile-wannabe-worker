/**
 * worker/jobs/profileAuditV1.ts
 *
 * BullMQ job handler: profile_audit_v1
 *
 * Input:  { clientId: string, gbpLocationId: string }
 *         gbpLocationId = UUID primary key of gbp_locations
 * Job ID: audit-v1:<gbpLocationId>  (stable — ensures idempotency via BullMQ dedup)
 *
 * Steps:
 *   1.  Validate payload
 *   2.  Load gbp_locations row + verify tenant ownership via gbp_accounts
 *   3.  Fetch GBP location details (Business Information API)
 *   4.  Fetch review stats (prefer GBP payload aggregate → reviews API → local DB)
 *   5.  Fetch 28-day performance baseline from gbp_analytics_daily
 *   6.  Compute v1 score (0–100)
 *   7.  Generate prioritised recommendations (top 10)
 *   8.  Write new profile_audits row
 *
 * Security: All auth comes from google_connections via getBusinessProfileClientForClient().
 *           gbp_accounts token columns are NEVER read — only id + client_id are selected.
 *           Every DB query is scoped to client_id (tenant isolation).
 */

import type { Job } from 'bullmq'
import { supabase } from '../supabase'
import { getBusinessProfileClientForClient, GbpApiError } from '../lib/google/authFactory'
import type {
  ProfileAuditV1Payload,
  AuditRecommendation,
  AuditSeverity,
  AuditScoreDimensions,
  AuditReviewStats,
  AuditPerformanceBaseline,
} from '../types'

// ─── GBP API constants ────────────────────────────────────────────────────────

const BIZ_INFO_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1'
const REVIEWS_BASE  = 'https://mybusiness.googleapis.com/v4'

/**
 * Fields requested from the Business Information API.
 * Includes metadata (may carry aggregate review counts) and openInfo (locationState).
 */
const LOCATION_READ_MASK = [
  'name',
  'title',
  'categories',
  'websiteUri',
  'phoneNumbers',
  'regularHours',
  'specialHours',
  'profile',
  'serviceArea',
  'latlng',
  'storefrontAddress',
  'attributes',
  'metadata',
  'openInfo',
].join(',')

// ─── GBP API response types ───────────────────────────────────────────────────

interface GbpCategory {
  name:        string
  displayName: string
}

interface GbpPhoneNumbers {
  primaryPhone?:     string
  additionalPhones?: string[]
}

interface GbpPeriod {
  openDay:   string
  openTime:  { hours: number; minutes?: number }
  closeDay:  string
  closeTime: { hours: number; minutes?: number }
}

interface GbpRegularHours {
  periods?: GbpPeriod[]
}

interface GbpSpecialHourPeriod {
  startDate: { year: number; month: number; day: number }
  openTime?: { hours: number; minutes?: number }
  closeTime?: { hours: number; minutes?: number }
  isClosed?: boolean
}

interface GbpSpecialHours {
  specialHourPeriods?: GbpSpecialHourPeriod[]
}

interface GbpProfile {
  description?: string
}

interface GbpServiceArea {
  businessType?: string
  places?:       { placeInfos?: Array<{ name: string; placeId: string }> }
}

interface GbpLatLng {
  latitude?:  number
  longitude?: number
}

interface GbpPostalAddress {
  regionCode?:         string
  postalCode?:         string
  administrativeArea?: string
  locality?:           string
  addressLines?:       string[]
}

interface GbpAttribute {
  name:    string
  values?: unknown[]
}

/**
 * Metadata field from the Business Information API.
 * Some accounts return totalReviewCount + averageRating here — use them when
 * present to avoid an extra Reviews API call.
 */
interface GbpMetadata {
  mapsUri?:          string
  newReviewUri?:     string
  placeId?:          string
  totalReviewCount?: number
  averageRating?:    number
}

/** Location open/closed state (locationState equivalent in the v1 API). */
interface GbpOpenInfo {
  status?:      string   // OPEN | CLOSED_PERMANENTLY | CLOSED_TEMPORARILY
  canReopen?:   boolean
  openingDate?: { year?: number; month?: number; day?: number }
}

interface GbpLocationDetail {
  name?:             string        // resource name e.g. "locations/123"
  title?:            string        // business name
  categories?: {
    primaryCategory?:      GbpCategory
    additionalCategories?: GbpCategory[]
  }
  websiteUri?:        string
  phoneNumbers?:      GbpPhoneNumbers
  regularHours?:      GbpRegularHours
  specialHours?:      GbpSpecialHours
  profile?:           GbpProfile
  serviceArea?:       GbpServiceArea
  latlng?:            GbpLatLng
  storefrontAddress?: GbpPostalAddress
  attributes?:        GbpAttribute[]
  metadata?:          GbpMetadata
  openInfo?:          GbpOpenInfo
}

// ─── DB row shapes ────────────────────────────────────────────────────────────

interface GbpLocationRow {
  id:          string   // UUID primary key
  location_id: string   // GBP resource name, e.g. "locations/1234567890"
  account_id:  string   // FK → gbp_accounts.id
  name:        string
}

interface AnalyticsDailyRow {
  views_search:               number | null
  views_maps:                 number | null
  views_total:                number | null
  actions_website:            number | null
  actions_phone:              number | null
  actions_driving_directions: number | null
  date:                       string
}

// ─── Payload validation ───────────────────────────────────────────────────────

function assertPayload(data: unknown): asserts data is ProfileAuditV1Payload {
  if (typeof data !== 'object' || data === null) {
    throw new Error('[profileAuditV1] Job data must be a non-null object')
  }

  const record  = data as Record<string, unknown>
  const missing = (['clientId', 'gbpLocationId'] as const).filter(
    f => typeof record[f] !== 'string' || record[f] === '',
  )

  if (missing.length > 0) {
    throw new Error(
      `[profileAuditV1] Job is missing required fields: ${missing.join(', ')}`,
    )
  }
}

// ─── Tenant validation ────────────────────────────────────────────────────────

/**
 * Loads the gbp_locations row by UUID primary key and confirms tenant ownership
 * by joining through gbp_accounts.
 *
 * Ownership chain: gbp_locations.account_id → gbp_accounts.client_id = clientId
 *
 * SECURITY: Only id + client_id are selected from gbp_accounts.
 *           Token columns (access_token, refresh_token, expires_at) are never read.
 *
 * @throws if the location doesn't exist or its account belongs to a different client.
 */
async function loadAndVerifyLocation(
  clientId:      string,
  gbpLocationId: string,
): Promise<GbpLocationRow> {
  // ── 1. Load the location row ───────────────────────────────────────────────
  const { data: locData, error: locError } = await supabase
    .from('gbp_locations')
    .select('id, location_id, account_id, name')
    .eq('id', gbpLocationId)
    .maybeSingle()

  if (locError) {
    throw new Error(
      `[profileAuditV1] DB error loading gbp_locations row for gbpLocationId=${gbpLocationId}: ${locError.message}`,
    )
  }

  if (!locData) {
    throw Object.assign(
      new Error(`[profileAuditV1] Location ${gbpLocationId} not found`),
      { [Symbol.for('bullmq:skipRetry')]: true },
    )
  }

  const location = locData as GbpLocationRow

  // ── 2. Verify ownership via gbp_accounts ──────────────────────────────────
  // TENANT ISOLATION: filter by both account id AND client_id.
  // SECURITY: only select id + client_id — never read token columns.
  const { data: accountData, error: accountError } = await supabase
    .from('gbp_accounts')
    .select('id, client_id')
    .eq('id', location.account_id)
    .eq('client_id', clientId)    // tenant boundary
    .maybeSingle()

  if (accountError) {
    throw new Error(
      `[profileAuditV1] DB error verifying account ownership for accountId=${location.account_id}: ${accountError.message}`,
    )
  }

  if (!accountData) {
    throw Object.assign(
      new Error(
        `[profileAuditV1] Tenant violation — location ${gbpLocationId} does not belong to client ${clientId}`,
      ),
      { [Symbol.for('bullmq:skipRetry')]: true },
    )
  }

  return location
}

// ─── GBP location detail fetch ────────────────────────────────────────────────

/**
 * Fetches the location resource from the Business Information API.
 * Returns null (with a warning) when the API returns 404 so the audit can
 * still run against cached/derived data rather than hard-failing.
 */
async function fetchGbpLocationDetail(
  gbp:             Awaited<ReturnType<typeof getBusinessProfileClientForClient>>,
  gbpResourceName: string,
  clientId:        string,
): Promise<GbpLocationDetail | null> {
  const url = `${BIZ_INFO_BASE}/${gbpResourceName}?readMask=${LOCATION_READ_MASK}`

  let res: Response
  try {
    res = await gbp.get(url)
  } catch (err) {
    throw new Error(
      `[profileAuditV1] Network error fetching GBP location detail for clientId=${clientId} resource=${gbpResourceName}: ` +
      (err instanceof Error ? err.message : String(err)),
    )
  }

  if (res.status === 404) {
    console.warn('[profileAuditV1] GBP location not found via API — proceeding with DB-only data', {
      clientId,
      gbpResourceName,
    })
    return null
  }

  if (!res.ok) {
    throw new GbpApiError(
      `[profileAuditV1] Business Information API returned HTTP ${res.status} for clientId=${clientId} resource=${gbpResourceName}`,
      res.status,
    )
  }

  return await res.json() as GbpLocationDetail
}

// ─── Review stats ─────────────────────────────────────────────────────────────

/**
 * Fetches aggregate review stats using a three-tier fallback strategy:
 *   1. GBP location payload metadata.totalReviewCount (cheapest — no extra call)
 *   2. GBP Reviews API  (one extra API call; returns aggregates in the response)
 *   3. Local DB reviews table (always available)
 *
 * unrepliedCount is always computed from the local DB (optional, non-blocking).
 */
async function fetchReviewStats(
  gbp:             Awaited<ReturnType<typeof getBusinessProfileClientForClient>>,
  gbpResourceName: string,
  locationDbId:    string,
  detail:          GbpLocationDetail | null,
): Promise<AuditReviewStats> {
  // ── 1. Prefer GBP payload aggregate ───────────────────────────────────────
  const payloadCount  = detail?.metadata?.totalReviewCount
  const payloadRating = detail?.metadata?.averageRating

  if (payloadCount !== undefined && payloadCount !== null) {
    const unrepliedCount = await fetchUnrepliedCount(locationDbId)
    return {
      count:         payloadCount,
      averageRating: payloadRating ?? null,
      unrepliedCount,
      source:        'gbp_payload',
    }
  }

  // ── 2. Call GBP Reviews API ────────────────────────────────────────────────
  try {
    const apiStats       = await fetchReviewsFromApi(gbp, gbpResourceName)
    const unrepliedCount = await fetchUnrepliedCount(locationDbId)
    return {
      count:         apiStats.count,
      averageRating: apiStats.averageRating,
      unrepliedCount,
      source:        'reviews_api',
    }
  } catch (err) {
    console.warn('[profileAuditV1] Reviews API failed — falling back to local DB', {
      gbpResourceName,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ── 3. Fallback: local DB ──────────────────────────────────────────────────
  return fetchReviewStatsFromDb(locationDbId)
}

/**
 * Fetches aggregate review data from the GBP Reviews API.
 * Uses pageSize=1 so we only retrieve the response-level aggregates
 * (averageRating + totalReviewCount) without downloading full review bodies.
 */
async function fetchReviewsFromApi(
  gbp:             Awaited<ReturnType<typeof getBusinessProfileClientForClient>>,
  gbpResourceName: string,
): Promise<{ count: number; averageRating: number | null }> {
  const url = `${REVIEWS_BASE}/${gbpResourceName}/reviews?pageSize=1`
  const res = await gbp.get(url)

  if (!res.ok) {
    throw new GbpApiError(
      `[profileAuditV1] Reviews API returned HTTP ${res.status} for resource=${gbpResourceName}`,
      res.status,
    )
  }

  const data = await res.json() as {
    averageRating?:    number
    totalReviewCount?: number
  }

  return {
    count:         data.totalReviewCount ?? 0,
    averageRating: data.averageRating    ?? null,
  }
}

/**
 * Computes review count and average rating from the local reviews table.
 * Used as a last-resort fallback when the GBP API is unavailable.
 */
async function fetchReviewStatsFromDb(locationDbId: string): Promise<AuditReviewStats> {
  const { data, error } = await supabase
    .from('reviews')
    .select('rating')
    .eq('location_id', locationDbId)

  if (error) {
    console.warn('[profileAuditV1] DB error fetching reviews — defaulting to zero stats', {
      locationDbId,
      error: error.message,
    })
    return { count: 0, averageRating: null, source: 'db' }
  }

  const rows = (data ?? []) as Array<{ rating: number | null }>

  if (rows.length === 0) {
    return { count: 0, averageRating: null, source: 'db' }
  }

  const rated     = rows.filter(r => r.rating !== null)
  const avgRating = rated.length > 0
    ? rated.reduce((sum, r) => sum + (r.rating as number), 0) / rated.length
    : null

  return {
    count:         rows.length,
    averageRating: avgRating !== null ? Math.round(avgRating * 10) / 10 : null,
    source:        'db',
  }
}

/**
 * Counts reviews without a reply from the local DB (optional signal).
 * Null response (response IS NULL) is treated as unreplied.
 */
async function fetchUnrepliedCount(locationDbId: string): Promise<number | undefined> {
  const { count, error } = await supabase
    .from('reviews')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationDbId)
    .is('response', null)

  if (error) {
    console.warn('[profileAuditV1] DB error counting unreplied reviews — skipping', {
      locationDbId,
      error: error.message,
    })
    return undefined
  }

  return count ?? 0
}

// ─── Performance baseline ─────────────────────────────────────────────────────

/**
 * Aggregates the last 28 days of daily performance data from gbp_analytics_daily.
 * Returns a zeroed baseline with partial=true if the query fails, so the audit
 * can still complete with a partial flag rather than hard-failing.
 */
async function fetchPerformanceBaseline(locationDbId: string): Promise<AuditPerformanceBaseline> {
  const since = new Date()
  since.setDate(since.getDate() - 28)
  const sinceDate = since.toISOString().split('T')[0]

  const { data, error } = await supabase
    .from('gbp_analytics_daily')
    .select(
      'views_search, views_maps, views_total, actions_website, actions_phone, actions_driving_directions, date',
    )
    .eq('location_id', locationDbId)
    .gte('date', sinceDate)
    .order('date', { ascending: false })

  if (error) {
    console.warn('[profileAuditV1] DB error fetching analytics — recording partial audit', {
      locationDbId,
      error: error.message,
    })
    return {
      periodDays:             28,
      viewsSearchTotal:       0,
      viewsMapsTotal:         0,
      viewsTotal:             0,
      actionsWebsiteTotal:    0,
      actionsPhoneTotal:      0,
      actionsDirectionsTotal: 0,
      daysWithData:           0,
      partial:                true,
      partialReason:          'db_error',
    }
  }

  const rows = (data ?? []) as AnalyticsDailyRow[]

  return {
    periodDays:             28,
    viewsSearchTotal:       rows.reduce((s, r) => s + (r.views_search               ?? 0), 0),
    viewsMapsTotal:         rows.reduce((s, r) => s + (r.views_maps                 ?? 0), 0),
    viewsTotal:             rows.reduce((s, r) => s + (r.views_total                ?? 0), 0),
    actionsWebsiteTotal:    rows.reduce((s, r) => s + (r.actions_website            ?? 0), 0),
    actionsPhoneTotal:      rows.reduce((s, r) => s + (r.actions_phone              ?? 0), 0),
    actionsDirectionsTotal: rows.reduce((s, r) => s + (r.actions_driving_directions ?? 0), 0),
    daysWithData:           rows.length,
  }
}

// ─── Recent post check ────────────────────────────────────────────────────────

/**
 * Returns true if the location has at least one GBP post published in the
 * last 30 days.
 */
async function hasRecentPost(locationDbId: string): Promise<boolean> {
  const since = new Date()
  since.setDate(since.getDate() - 30)

  const { data, error } = await supabase
    .from('gbp_posts')
    .select('id')
    .eq('location_id', locationDbId)
    .gte('created_time', since.toISOString())
    .limit(1)

  if (error) {
    console.warn('[profileAuditV1] DB error checking recent posts — assuming none', {
      locationDbId,
      error: error.message,
    })
    return false
  }

  return (data ?? []).length > 0
}

// ─── Score computation ────────────────────────────────────────────────────────

interface ScoringContext {
  detail:      GbpLocationDetail | null
  reviews:     AuditReviewStats
  performance: AuditPerformanceBaseline
  recentPost:  boolean
}

/**
 * Computes the v1 audit score (0–100) across three dimensions:
 *
 *   Completeness  (50 pts) — presence of core profile fields
 *     title/name:        8 pts
 *     primary category:  8 pts
 *     address or SAB:    8 pts
 *     primary phone:     8 pts
 *     website:           8 pts
 *     regular hours:     5 pts
 *     description:       5 pts
 *
 *   Reputation    (30 pts) — rating + review volume thresholds
 *     Rating ≥4.5 → 15 | ≥4.0 → 10 | ≥3.5 → 5 | <3.5 → 0
 *     Count  ≥50  → 15 | ≥20  → 10 | ≥5   → 5 | <5   → 0
 *
 *   Activity      (20 pts) — recent post + performance signals
 *     Recent post (≤30 days):             10 pts
 *     Performance signals (views ≥ 100):  10 pts
 */
function computeScore(ctx: ScoringContext): AuditScoreDimensions {
  const { detail, reviews, performance, recentPost } = ctx

  // ── Completeness (50 pts) ─────────────────────────────────────────────────
  let completeness = 0

  if (detail?.title)                                                          completeness += 8
  if (detail?.categories?.primaryCategory?.name)                              completeness += 8

  const hasAddress     = Boolean(detail?.storefrontAddress?.addressLines?.length)
  const hasServiceArea = Boolean(detail?.serviceArea?.businessType)
  if (hasAddress || hasServiceArea)                                            completeness += 8

  if (detail?.phoneNumbers?.primaryPhone)                                     completeness += 8
  if (detail?.websiteUri)                                                     completeness += 8
  if (detail?.regularHours?.periods && detail.regularHours.periods.length > 0) completeness += 5
  if (detail?.profile?.description)                                           completeness += 5

  // ── Reputation (30 pts) ───────────────────────────────────────────────────
  let reputation = 0

  const rating = reviews.averageRating
  if (rating !== null) {
    if (rating >= 4.5)      reputation += 15
    else if (rating >= 4.0) reputation += 10
    else if (rating >= 3.5) reputation +=  5
  }

  const count = reviews.count
  if (count >= 50)      reputation += 15
  else if (count >= 20) reputation += 10
  else if (count >= 5)  reputation +=  5

  // ── Activity (20 pts) ─────────────────────────────────────────────────────
  let activity = 0

  if (recentPost)                    activity += 10
  if (performance.viewsTotal >= 100) activity += 10

  return { completeness, reputation, activity }
}

// ─── Recommendation generation ────────────────────────────────────────────────

/**
 * Produces an ordered array of prioritised recommendations (max 10).
 * High-severity items appear first, followed by med, then low.
 */
function generateRecommendations(ctx: ScoringContext): AuditRecommendation[] {
  const { detail, reviews, performance, recentPost } = ctx
  const recs: AuditRecommendation[] = []

  const add = (
    title:          string,
    why_it_matters: string,
    severity:       AuditSeverity,
    suggested_fix:  string,
  ) => recs.push({ title, why_it_matters, severity, suggested_fix })

  // ── Missing primary category ───────────────────────────────────────────────
  if (!detail?.categories?.primaryCategory?.name) {
    add(
      'Add a primary business category',
      'Google uses your primary category to decide which searches you appear in. Without it your listing is essentially unranked for relevant queries.',
      'high',
      'In Google Business Profile, go to Edit Profile → Business Category and choose the most accurate primary category.',
    )
  }

  // ── Missing phone number ───────────────────────────────────────────────────
  if (!detail?.phoneNumbers?.primaryPhone) {
    add(
      'Add a phone number',
      'Missing phone numbers reduce click-through rate by up to 25% and prevent customers from reaching you directly from Search and Maps.',
      'high',
      'In Google Business Profile, go to Edit Profile → Contact and add your primary business phone number.',
    )
  }

  // ── Missing website ────────────────────────────────────────────────────────
  if (!detail?.websiteUri) {
    add(
      'Add your website URL',
      'Listings without a website lose significant traffic and reduce consumer trust. Google also uses website signals in local ranking.',
      'high',
      'In Google Business Profile, go to Edit Profile → Contact and enter your website URL.',
    )
  }

  // ── Missing business hours ─────────────────────────────────────────────────
  const noHours = !detail?.regularHours?.periods || detail.regularHours.periods.length === 0
  if (noHours) {
    add(
      'Add regular business hours',
      'Listings without hours show as "Hours not available", which suppresses visibility in near-me searches and reduces customer confidence.',
      'high',
      'In Google Business Profile, go to Edit Profile → Hours and add your regular weekly schedule.',
    )
  }

  // ── Missing description ────────────────────────────────────────────────────
  if (!detail?.profile?.description) {
    add(
      'Write a business description',
      'The description (up to 750 characters) is your pitch to customers and provides Google keyword context. Profiles without one miss an easy completeness win.',
      'high',
      'In Google Business Profile, go to Edit Profile → Business Info → Business description and write a compelling, keyword-rich description.',
    )
  }

  // ── Missing address or service area ───────────────────────────────────────
  const hasAddress     = Boolean(detail?.storefrontAddress?.addressLines?.length)
  const hasServiceArea = Boolean(detail?.serviceArea?.businessType)
  if (!hasAddress && !hasServiceArea) {
    add(
      'Add your business address or service area',
      'Without a location or service area Google cannot surface your listing in geo-specific searches, severely limiting local visibility.',
      'high',
      'In Google Business Profile, set a storefront address if customers visit you, or define a service area if you go to them.',
    )
  }

  // ── Low rating ────────────────────────────────────────────────────────────
  if (reviews.averageRating !== null && reviews.averageRating < 4.0) {
    add(
      'Improve your average star rating',
      `Your current rating of ${reviews.averageRating.toFixed(1)} ★ is below the 4.0 threshold that most customers use as a minimum when choosing a business.`,
      'high',
      'Respond professionally to all negative reviews within 24 hours. Ask satisfied customers to leave a review. Resolve the root causes of recurring complaints.',
    )
  }

  // ── Low review volume ─────────────────────────────────────────────────────
  if (reviews.count < 20) {
    add(
      'Grow your review count',
      `With only ${reviews.count} review${reviews.count === 1 ? '' : 's'}, your listing lacks the social proof that drives customer confidence and local ranking signals.`,
      'med',
      'Implement a systematic ask-for-review process: send a follow-up message to happy customers with a direct link to your review page. Aim for 5+ new reviews per month.',
    )
  }

  // ── No recent post ────────────────────────────────────────────────────────
  if (!recentPost) {
    add(
      'Publish a Google Business Profile post',
      'Listings with recent posts signal active management to Google and give customers a reason to engage. Post frequency is a soft ranking signal.',
      'med',
      'Create at least one post per week — share updates, offers, or events. Use the Posts tab in Google Business Profile or schedule via your dashboard.',
    )
  }

  // ── Low performance visibility ─────────────────────────────────────────────
  if (performance.daysWithData > 0 && performance.viewsTotal < 100) {
    add(
      'Improve search and maps visibility',
      `Your listing received only ${performance.viewsTotal} total views over the past ${performance.daysWithData} days. This suggests low discoverability.`,
      'med',
      'Ensure your categories, description, and services are fully filled in. Build local citations and backlinks. Consider running a Local Services Ad or Smart Campaign.',
    )
  }

  // ── Missing attributes ────────────────────────────────────────────────────
  if (!detail?.attributes || detail.attributes.length === 0) {
    add(
      'Add business attributes',
      'Attributes (e.g. wheelchair accessible, outdoor seating, women-owned) help Google surface your listing for specific customer queries and improve profile completeness.',
      'low',
      'In Google Business Profile, go to Edit Profile → More → Attributes and enable all that apply to your business.',
    )
  }

  // ── No special hours configured ───────────────────────────────────────────
  if (!detail?.specialHours?.specialHourPeriods || detail.specialHours.specialHourPeriods.length === 0) {
    add(
      'Configure holiday / special hours',
      'Without special hours, your listing may show "Possibly closed" on holidays, causing customers to go elsewhere unnecessarily.',
      'low',
      'In Google Business Profile, go to Edit Profile → Special hours and add your hours for upcoming holidays and any irregular closures.',
    )
  }

  // Sort: high → med → low, then cap at 10
  const ORDER: Record<AuditSeverity, number> = { high: 0, med: 1, low: 2 }
  recs.sort((a, b) => ORDER[a.severity] - ORDER[b.severity])

  return recs.slice(0, 10)
}

// ─── DB write ─────────────────────────────────────────────────────────────────

async function writeAuditRow(
  clientId:            string,
  gbpLocationId:       string,
  score:               number,
  auditJson:           Record<string, unknown>,
  recommendationsJson: AuditRecommendation[],
): Promise<string> {
  const { data, error } = await supabase
    .from('profile_audits')
    .insert({
      client_id:            clientId,
      gbp_location_id:      gbpLocationId,
      audit_version:        'v1',
      score,
      audit_json:           auditJson,
      recommendations_json: recommendationsJson,
      audited_at:           new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) {
    throw new Error(
      `[profileAuditV1] DB error writing profile_audits row for gbpLocationId=${gbpLocationId}: ${error.message}`,
    )
  }

  return (data as { id: string }).id
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleProfileAuditV1(job: Job): Promise<void> {
  // ── 1. Validate payload ────────────────────────────────────────────────────
  assertPayload(job.data)
  const { clientId, gbpLocationId } = job.data

  console.log('[profileAuditV1] Job started', {
    jobId:         job.id,
    clientId,
    gbpLocationId,
    attempt:       job.attemptsMade + 1,
  })

  // ── 2. Load & verify location ownership via gbp_accounts ──────────────────
  const location = await loadAndVerifyLocation(clientId, gbpLocationId)

  console.log('[profileAuditV1] Tenant ownership verified', {
    jobId:           job.id,
    clientId,
    gbpLocationId,
    gbpResourceName: location.location_id,
  })

  // ── 3. Build authenticated GBP client (uses google_connections auth only) ──
  const gbp = await getBusinessProfileClientForClient(clientId)

  // ── 4. Fetch GBP location detail ──────────────────────────────────────────
  const detail = await fetchGbpLocationDetail(gbp, location.location_id, clientId)

  console.log('[profileAuditV1] GBP location detail fetched', {
    jobId:         job.id,
    clientId,
    gbpLocationId,
    hasDetail:     detail !== null,
    title:         detail?.title          ?? '(missing)',
    locationState: detail?.openInfo?.status ?? null,
  })

  // ── 5. Fetch review stats ──────────────────────────────────────────────────
  const reviews = await fetchReviewStats(gbp, location.location_id, gbpLocationId, detail)

  console.log('[profileAuditV1] Review stats loaded', {
    jobId:         job.id,
    clientId,
    gbpLocationId,
    count:         reviews.count,
    avgRating:     reviews.averageRating,
    unreplied:     reviews.unrepliedCount,
    source:        reviews.source,
  })

  // ── 6. Fetch performance baseline (last 28 days) ───────────────────────────
  const performance = await fetchPerformanceBaseline(gbpLocationId)

  console.log('[profileAuditV1] Performance baseline loaded', {
    jobId:        job.id,
    clientId,
    gbpLocationId,
    viewsTotal:   performance.viewsTotal,
    daysWithData: performance.daysWithData,
    partial:      performance.partial ?? false,
  })

  // ── 7. Check for recent post ───────────────────────────────────────────────
  const recentPost = await hasRecentPost(gbpLocationId)

  console.log('[profileAuditV1] Recent post check', {
    jobId:         job.id,
    clientId,
    gbpLocationId,
    recentPost,
  })

  // ── 8. Compute score ───────────────────────────────────────────────────────
  const ctx: ScoringContext = { detail, reviews, performance, recentPost }
  const dimensions          = computeScore(ctx)
  const score               = dimensions.completeness + dimensions.reputation + dimensions.activity

  console.log('[profileAuditV1] Score computed', {
    jobId:         job.id,
    clientId,
    gbpLocationId,
    score,
    dimensions,
  })

  // ── 9. Generate recommendations ────────────────────────────────────────────
  const recommendations = generateRecommendations(ctx)

  console.log('[profileAuditV1] Recommendations generated', {
    jobId:         job.id,
    clientId,
    gbpLocationId,
    count:         recommendations.length,
    highSeverity:  recommendations.filter(r => r.severity === 'high').length,
  })

  // ── 10. Build audit_json snapshot ─────────────────────────────────────────
  const auditJson: Record<string, unknown> = {
    gbp_resource_name:    location.location_id,
    location_db_name:     location.name,
    audit_version:        'v1',
    audited_at:           new Date().toISOString(),
    score_dimensions:     dimensions,
    gbp_detail: {
      title:              detail?.title                    ?? null,
      categories:         detail?.categories               ?? null,
      website_uri:        detail?.websiteUri               ?? null,
      phone_numbers:      detail?.phoneNumbers             ?? null,
      regular_hours:      detail?.regularHours             ?? null,
      special_hours:      detail?.specialHours             ?? null,
      description:        detail?.profile?.description     ?? null,
      service_area:       detail?.serviceArea              ?? null,
      address:            detail?.storefrontAddress        ?? null,
      latlng:             detail?.latlng                   ?? null,
      attributes:         detail?.attributes               ?? null,
      location_state:     detail?.openInfo?.status         ?? null,
    },
    review_stats:         reviews,
    performance_baseline: performance,
    recent_post:          recentPost,
  }

  // ── 11. Write audit row ────────────────────────────────────────────────────
  const auditId = await writeAuditRow(
    clientId,
    gbpLocationId,
    score,
    auditJson,
    recommendations,
  )

  console.log('[profileAuditV1] Audit complete', {
    jobId:               job.id,
    clientId,
    gbpLocationId,
    gbpResourceName:     location.location_id,
    auditId,
    score,
    recommendationCount: recommendations.length,
  })
}
