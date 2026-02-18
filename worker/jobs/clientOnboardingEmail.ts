import type { Job } from 'bullmq'
import { supabase } from '../supabase'
import { sendTemplateEmail } from '../../lib/email/sendgrid'
import { validateTenantScope } from '../utils/validateTenantScope'
import type {
  ClientOnboardingEmailPayload,
  OnboardingEmailStatus,
  OnboardingEmailLogRow,
} from '../types'

// ─── Template ID map ──────────────────────────────────────────────────────────
//
// Each onboarding status maps to a dedicated SendGrid Dynamic Template.
// Template IDs are resolved from env at startup so misconfiguration surfaces
// immediately rather than at runtime.

const TEMPLATE_IDS: Record<OnboardingEmailStatus, string> = (() => {
  const required: Record<OnboardingEmailStatus, string> = {
    awaiting_gbp_confirmation: 'SENDGRID_TEMPLATE_ONBOARDING_AWAITING_GBP_CONFIRMATION',
    awaiting_access_request:   'SENDGRID_TEMPLATE_ONBOARDING_AWAITING_ACCESS_REQUEST',
    access_requested:          'SENDGRID_TEMPLATE_ONBOARDING_ACCESS_REQUESTED',
    access_granted:            'SENDGRID_TEMPLATE_ONBOARDING_ACCESS_GRANTED',
  }

  const resolved = {} as Record<OnboardingEmailStatus, string>
  const missing: string[] = []

  for (const [status, envKey] of Object.entries(required) as [OnboardingEmailStatus, string][]) {
    const val = process.env[envKey]
    if (!val) {
      missing.push(envKey)
    } else {
      resolved[status] = val
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[clientOnboardingEmail] Missing required env vars: ${missing.join(', ')}`,
    )
  }

  return resolved
})()

// ─── Runtime payload validation ───────────────────────────────────────────────

const VALID_STATUSES = new Set<string>([
  'awaiting_gbp_confirmation',
  'awaiting_access_request',
  'access_requested',
  'access_granted',
])

function assertPayload(data: unknown): asserts data is ClientOnboardingEmailPayload {
  if (typeof data !== 'object' || data === null) {
    throw new Error('[clientOnboardingEmail] Job data must be a non-null object')
  }

  const record = data as Record<string, unknown>

  const requiredStrings = [
    'clientId',
    'profileId',
    'locationId',
    'initiatedByUserId',
    'onboardingStatus',
  ] as const

  const missing = requiredStrings.filter(
    f => typeof record[f] !== 'string' || record[f] === '',
  )

  if (missing.length > 0) {
    throw new Error(
      `[clientOnboardingEmail] Job is missing required fields: ${missing.join(', ')}`,
    )
  }

  if (!VALID_STATUSES.has(record.onboardingStatus as string)) {
    throw new Error(
      `[clientOnboardingEmail] onboardingStatus "${record.onboardingStatus}" is not a supported email-trigger status`,
    )
  }
}

// ─── Log row helpers ──────────────────────────────────────────────────────────
//
// Errors from these helpers are logged but never re-thrown — audit logging
// must not mask or override the real send result.

async function insertLogRow(
  clientId:         string,
  onboardingStatus: string,
  templateId:       string,
  recipientEmail:   string,
  jobId:            string | undefined,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('onboarding_email_log')
    .insert({
      client_id:         clientId,
      onboarding_status: onboardingStatus,
      template_id:       templateId,
      recipient_email:   recipientEmail,
      status:            'pending',
      job_id:            jobId ?? null,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[clientOnboardingEmail] Failed to insert log row', {
      clientId,
      onboardingStatus,
      recipientEmail,
      error: error.message,
    })
    return null
  }

  return (data as Pick<OnboardingEmailLogRow, 'id'>).id
}

async function updateLogRow(
  logId:  string,
  status: 'sent' | 'failed' | 'skipped',
  opts:   { error?: string; sentAt?: string } = {},
): Promise<void> {
  const patch: Record<string, unknown> = { status }
  if (opts.sentAt) patch.sent_at = opts.sentAt
  if (opts.error)  patch.error   = opts.error

  const { error } = await supabase
    .from('onboarding_email_log')
    .update(patch)
    .eq('id', logId)

  if (error) {
    console.error('[clientOnboardingEmail] Failed to update log row', {
      logId,
      status,
      error: error.message,
    })
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleClientOnboardingEmail(job: Job): Promise<void> {
  // ── 1. Validate payload ────────────────────────────────────────────────────
  assertPayload(job.data)
  const { clientId, profileId, locationId, onboardingStatus, initiatedByUserId } = job.data

  console.log('[clientOnboardingEmail] Job received', {
    jobId:            job.id,
    clientId,
    profileId,
    locationId,
    onboardingStatus,
    initiatedByUserId,
    attempt:          job.attemptsMade + 1,
  })

  // ── 2. Tenant scope validation — fail fast before any data access ──────────
  await validateTenantScope(clientId, profileId, locationId)

  console.log('[clientOnboardingEmail] Tenant scope validated', {
    jobId:    job.id,
    clientId,
    onboardingStatus,
  })

  // ── 3. Resolve template ID for this status ─────────────────────────────────
  const templateId = TEMPLATE_IDS[onboardingStatus]

  // ── 4. Fetch client — tenant-scoped ───────────────────────────────────────
  const { data: clientData, error: clientError } = await supabase
    .from('clients')
    .select('id, name, user_id, email_notifications_enabled')
    .eq('id', clientId)   // tenant boundary
    .maybeSingle()

  if (clientError) {
    throw new Error(
      `[clientOnboardingEmail] DB error fetching client ${clientId}: ${clientError.message}`,
    )
  }

  if (!clientData) {
    throw Object.assign(
      new Error(`[clientOnboardingEmail] Client ${clientId} not found`),
      { [Symbol.for('bullmq:skipRetry')]: true },
    )
  }

  const client = clientData as {
    id: string
    name: string
    user_id: string
    email_notifications_enabled: boolean
  }

  // ── 5. Kill-switch: respect per-client email suppression ──────────────────
  if (!client.email_notifications_enabled) {
    console.log('[clientOnboardingEmail] Email suppressed — email_notifications_enabled is false', {
      jobId:    job.id,
      clientId,
      onboardingStatus,
    })
    return
  }

  // ── 6. Resolve recipient from client.user_id ──────────────────────────────
  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('id, email, full_name')
    .eq('id', client.user_id)
    .maybeSingle()

  if (userError) {
    throw new Error(
      `[clientOnboardingEmail] DB error fetching user ${client.user_id}: ${userError.message}`,
    )
  }

  if (!userData) {
    throw Object.assign(
      new Error(
        `[clientOnboardingEmail] User ${client.user_id} not found — cannot send onboarding email for client ${clientId}`,
      ),
      { [Symbol.for('bullmq:skipRetry')]: true },
    )
  }

  const user = userData as { id: string; email: string; full_name: string | null }

  // ── 7. Insert pending audit log row ───────────────────────────────────────
  const logId = await insertLogRow(
    clientId,
    onboardingStatus,
    templateId,
    user.email,
    job.id,
  )

  console.log('[clientOnboardingEmail] Sending template email', {
    jobId:            job.id,
    clientId,
    onboardingStatus,
    templateId,
    to:               user.email,
    logId,
  })

  // ── 8. Build template data and send ───────────────────────────────────────
  const dynamicTemplateData: Record<string, unknown> = {
    client_name:       client.name,
    recipient_name:    user.full_name ?? user.email,
    onboarding_status: onboardingStatus,
    year:              new Date().getFullYear(),
  }

  try {
    await sendTemplateEmail({
      to:                  user.email,
      templateId,
      dynamicTemplateData,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (logId) {
      await updateLogRow(logId, 'failed', { error: message })
    }

    console.error('[clientOnboardingEmail] Send failed', {
      jobId:            job.id,
      clientId,
      onboardingStatus,
      to:               user.email,
      logId,
      error:            message,
    })

    throw err   // re-throw so BullMQ retries
  }

  // ── 9. Mark delivery as sent ──────────────────────────────────────────────
  const sentAt = new Date().toISOString()

  if (logId) {
    await updateLogRow(logId, 'sent', { sentAt })
  }

  console.log('[clientOnboardingEmail] Email sent successfully', {
    jobId:            job.id,
    clientId,
    onboardingStatus,
    templateId,
    to:               user.email,
    logId,
    sentAt,
  })
}
