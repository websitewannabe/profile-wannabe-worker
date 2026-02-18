// ─── Canonical job payload type ───────────────────────────────────────────────
//
// Every job enqueued into any worker queue MUST include all four of these
// fields.  Handlers that accept job.data should type it as TenantJobPayload.
// Use assertTenantJobPayload() (see index.ts) to validate at runtime.

export interface TenantJobPayload {
  /** Tenant identifier — top-level ownership boundary for all DB queries. */
  clientId: string

  /** The GBP profile being acted on, must belong to clientId. */
  profileId: string

  /** The GBP location being acted on, must belong to clientId + profileId. */
  locationId: string

  /** User who triggered the job — used for audit logging and attribution. */
  initiatedByUserId: string
}

// ─── Notification delivery job payload ────────────────────────────────────────

export interface NotificationDeliveryPayload {
  /** Tenant identifier — all DB queries must be scoped to this. */
  clientId: string

  /** GBP profile context — used for tenant scope validation. */
  profileId: string

  /** GBP location context — used for tenant scope validation. */
  locationId: string

  /** The notifications row to deliver. */
  notificationId: string

  /** User who triggered the job — used for audit logging. */
  initiatedByUserId: string
}

// ─── Resolved email recipient (used internally by the delivery handler) ───────

export interface NotificationEmailRecipient {
  userId: string
  email: string
  fullName: string | null
}

// ─── Notification row shape (subset of columns used by the delivery handler) ──

export type ChannelDeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export interface NotificationRow {
  id: string
  client_id: string
  user_id: string | null
  type: string
  title: string
  message: string
  metadata: Record<string, unknown>
  channel_email: boolean
  channel_webhook: boolean
  email_sent_at: string | null
  webhook_sent_at: string | null
  /** Overall delivery outcome across all channels. */
  delivery_status: 'pending' | 'delivered' | 'partial' | 'failed'
  /** Per-channel status for email. */
  email_delivery_status: ChannelDeliveryStatus
  /** Per-channel status for webhook. */
  webhook_delivery_status: ChannelDeliveryStatus
}

// ─── Client row shape (subset used by the delivery handler) ───────────────────

export interface ClientRow {
  id: string
  name: string
  /** When false, all outbound email for this client is suppressed. */
  email_notifications_enabled: boolean
  client_dashboard_api_url: string | null
  client_dashboard_api_key: string | null
}

// ─── User row shape (subset used to resolve recipient email) ──────────────────

export interface UserRow {
  id: string
  email: string
}

// ─── Client onboarding email job ──────────────────────────────────────────────

/**
 * The subset of onboarding_status values that trigger a templated email.
 * Matches the four statuses the client_onboarding_email job handles.
 */
export type OnboardingEmailStatus =
  | 'awaiting_gbp_confirmation'
  | 'awaiting_access_request'
  | 'access_requested'
  | 'access_granted'

export interface ClientOnboardingEmailPayload {
  /** Tenant identifier — all DB queries must be scoped to this. */
  clientId: string

  /** GBP profile context — used for tenant scope validation. */
  profileId: string

  /** GBP location context — used for tenant scope validation. */
  locationId: string

  /** The new onboarding status that triggered this email. */
  onboardingStatus: OnboardingEmailStatus

  /** User who triggered the status change — used for audit logging. */
  initiatedByUserId: string
}

// ─── onboarding_email_log row shape ───────────────────────────────────────────

export interface OnboardingEmailLogRow {
  id: string
  client_id: string
  onboarding_status: string
  template_id: string
  recipient_email: string
  status: 'pending' | 'sent' | 'failed' | 'skipped'
  error: string | null
  sent_at: string | null
  job_id: string | null
  created_at: string
}

// ─── access_granted → onboarding bootstrap job ────────────────────────────────

export interface AccessGrantedOnboardingPayload {
  /** Tenant identifier — all DB queries must be scoped to this. */
  clientId: string

  /** GBP profile to set pending_onboarding — must belong to clientId. */
  profileId: string

  /** GBP location context — used for tenant scope validation. */
  locationId: string

  /** User who triggered the status change — used for audit logging. */
  initiatedByUserId: string
}

// ─── gbp_accounts row shape (subset used by access_granted handler) ───────────

export interface GbpAccountRow {
  id: string
  client_id: string
  account_name: string
  access_token: string | null
  refresh_token: string | null
  expires_at: string | null
  created_at: string
}

// ─── verify_gbp_access polling job ────────────────────────────────────────────

export interface VerifyGbpAccessPayload {
  /** Tenant identifier — all DB queries must be scoped to this. */
  clientId: string

  /** GBP profile context — used for tenant scope validation. */
  profileId: string

  /** GBP location context — used for tenant scope validation. */
  locationId: string

  /** User who triggered the status change — used for audit logging. */
  initiatedByUserId: string
}

// ─── Client onboarding reminder job ───────────────────────────────────────────

export interface ClientOnboardingReminderPayload {
  /** Tenant identifier — all DB queries must be scoped to this. */
  clientId: string

  /** GBP profile context — used for tenant scope validation. */
  profileId: string

  /** GBP location context — used for tenant scope validation. */
  locationId: string

  /**
   * The onboarding_status that was active when this reminder was scheduled.
   * At execution time the worker re-fetches the live status and compares it
   * to this value.  If they differ the client has progressed — exit silently.
   */
  expectedOnboardingStatus: string

  /** User who scheduled the reminder — used for audit logging. */
  initiatedByUserId: string
}

// ─── profile_audit_v1 job ─────────────────────────────────────────────────────

export interface ProfileAuditV1Payload {
  /** Tenant identifier — all DB queries must be scoped to this. */
  clientId: string

  /** GBP profile context — pass null when not applicable for system-initiated audits. */
  profileId: string | null

  /**
   * UUID primary key of the gbp_locations row to audit.
   * Named locationId to conform to the global job contract (TenantJobPayload).
   */
  locationId: string

  /** User who triggered the job — pass null for system-initiated audits. */
  initiatedByUserId: string | null
}

// ─── profile_audit_v1 internal types ─────────────────────────────────────────

export type AuditSeverity = 'high' | 'med' | 'low'

export interface AuditRecommendation {
  title:          string
  why_it_matters: string
  severity:       AuditSeverity
  suggested_fix:  string
}

export interface AuditScoreDimensions {
  completeness: number   // 0–50
  reputation:   number   // 0–30
  activity:     number   // 0–20
}

export interface AuditReviewStats {
  count:           number
  averageRating:   number | null
  /** Number of reviews without a reply (optional — computed from local DB). */
  unrepliedCount?: number
  /** Where the aggregate data was sourced from. */
  source:          'gbp_payload' | 'reviews_api' | 'db'
}

export interface AuditPerformanceBaseline {
  periodDays:             number
  viewsSearchTotal:       number
  viewsMapsTotal:         number
  viewsTotal:             number
  actionsWebsiteTotal:    number
  actionsPhoneTotal:      number
  actionsDirectionsTotal: number
  daysWithData:           number
  /** True when performance data could not be fully retrieved. */
  partial?:               boolean
  /** Human-readable reason when partial is true. */
  partialReason?:         string
}

// ─── notification_deliveries row shape ────────────────────────────────────────

export interface NotificationDeliveryRow {
  id: string
  notification_id: string
  client_id: string
  user_id: string | null
  channel: 'email' | 'webhook'
  status: 'pending' | 'sent' | 'failed'
  error: string | null
  sent_at: string | null
  created_at: string
}
