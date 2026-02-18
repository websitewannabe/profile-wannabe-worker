import type { Job } from 'bullmq'
import { supabase } from '../supabase'
import { validateTenantScope } from '../utils/validateTenantScope'
import { accessGrantedOnboardingQueue } from '../queues'
import { checkGbpAccessGranted } from '../../lib/gbp/verifyAccess'
import type { VerifyGbpAccessPayload } from '../types'

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Must match the `attempts` value in verifyGbpAccessQueue.defaultJobOptions.
 * Used to detect the final attempt and trigger exhaustion handling inline,
 * before BullMQ moves the job to the failed state.
 */
const MAX_ATTEMPTS = 5

// ─── Sentinel error ───────────────────────────────────────────────────────────
//
// Thrown when GBP access has not yet been granted.  This is expected during
// the polling window and causes BullMQ to schedule the next attempt after 12 h.

class GbpAccessNotYetGrantedError extends Error {
  constructor(reason: string) {
    super(`[verifyGbpAccess] GBP access not yet granted: ${reason}`)
    this.name = 'GbpAccessNotYetGrantedError'
  }
}

// ─── Runtime payload validation ───────────────────────────────────────────────

function assertPayload(data: unknown): asserts data is VerifyGbpAccessPayload {
  if (typeof data !== 'object' || data === null) {
    throw new Error('[verifyGbpAccess] Job data must be a non-null object')
  }

  const record = data as Record<string, unknown>

  const required = [
    'clientId',
    'profileId',
    'locationId',
    'initiatedByUserId',
  ] as const

  const missing = required.filter(
    f => typeof record[f] !== 'string' || record[f] === '',
  )

  if (missing.length > 0) {
    throw new Error(
      `[verifyGbpAccess] Job is missing required fields: ${missing.join(', ')}`,
    )
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Advances the client to access_granted and enqueues the growth lifecycle
 * bootstrap job.  Deduplication on accessGrantedOnboarding's own jobId
 * prevents double-triggering if this job retried after a partial success.
 */
async function triggerGrowthLifecycle(
  clientId:          string,
  profileId:         string,
  locationId:        string,
  initiatedByUserId: string,
  jobId:             string | undefined,
): Promise<void> {
  // ── a. Advance onboarding status ─────────────────────────────────────────
  const { error: updateError } = await supabase
    .from('clients')
    .update({
      onboarding_status:     'access_granted',
      onboarding_last_error: null,
    })
    .eq('id', clientId)   // tenant boundary

  if (updateError) {
    throw new Error(
      `[verifyGbpAccess] DB error advancing onboarding_status to access_granted: ${updateError.message}`,
    )
  }

  // ── b. Enqueue access_granted_onboarding (deduped) ───────────────────────
  const bootstrapJobId = `access-granted-onboarding:${clientId}`

  await accessGrantedOnboardingQueue.add(
    'access_granted_onboarding',
    { clientId, profileId, locationId, initiatedByUserId },
    { jobId: bootstrapJobId },
  )

  // ── c. Log to activity_log ────────────────────────────────────────────────
  const { error: logError } = await supabase
    .from('activity_log')
    .insert({
      client_id:   clientId,
      user_id:     initiatedByUserId,
      action:      'gbp_access_verified',
      entity_type: 'client',
      entity_id:   clientId,
      metadata:    {
        trigger:           'verify_gbp_access_job',
        bullmq_job_id:     jobId ?? null,
        bootstrap_job_id:  bootstrapJobId,
      },
    })

  if (logError) {
    // Non-fatal — log and continue.
    console.error('[verifyGbpAccess] Failed to write gbp_access_verified activity_log', {
      clientId,
      error: logError.message,
    })
  }
}

/**
 * Handles a permanent auth_error outcome.
 *
 * Actions (in order, each failure logged but not re-thrown):
 *   1. Set clients.onboarding_status = 'auth_error'
 *   2. Log to activity_log
 */
async function handleAuthError(
  clientId:          string,
  profileId:         string,
  initiatedByUserId: string,
  reason:            string,
  jobId:             string | undefined,
): Promise<void> {
  const errorMessage =
    `GBP access verification failed due to an authentication error: ${reason}`

  const { error: statusError } = await supabase
    .from('clients')
    .update({
      onboarding_status:     'auth_error',
      onboarding_last_error: errorMessage,
    })
    .eq('id', clientId)   // tenant boundary

  if (statusError) {
    console.error('[verifyGbpAccess] Failed to set onboarding_status=auth_error', {
      clientId,
      error: statusError.message,
    })
  }

  const { error: logError } = await supabase
    .from('activity_log')
    .insert({
      client_id:   clientId,
      user_id:     initiatedByUserId,
      action:      'gbp_access_auth_error',
      entity_type: 'client',
      entity_id:   clientId,
      metadata:    {
        reason,
        bullmq_job_id: jobId ?? null,
      },
    })

  if (logError) {
    console.error('[verifyGbpAccess] Failed to write gbp_access_auth_error activity_log', {
      clientId,
      error: logError.message,
    })
  }
}

/**
 * Handles the case where all polling attempts are exhausted without GBP access
 * being confirmed.
 *
 * Actions (in order, each failure logged but not re-thrown):
 *   1. Set clients.onboarding_status = 'error'
 *   2. Broadcast admin notification via notifications table
 *   3. Log exhaustion event to activity_log
 */
async function handleExhausted(
  clientId:          string,
  profileId:         string,
  initiatedByUserId: string,
  reason:            string,
  jobId:             string | undefined,
): Promise<void> {
  const errorMessage =
    `GBP access verification exhausted after ${MAX_ATTEMPTS} attempts (last reason: ${reason})`

  // ── 1. Mark client as error state ─────────────────────────────────────────
  const { error: statusError } = await supabase
    .from('clients')
    .update({
      onboarding_status:     'error',
      onboarding_last_error: errorMessage,
    })
    .eq('id', clientId)   // tenant boundary

  if (statusError) {
    console.error('[verifyGbpAccess] Failed to set onboarding_status=error', {
      clientId,
      error: statusError.message,
    })
  }

  // ── 2. Create admin broadcast notification ────────────────────────────────
  //
  // user_id = null targets all users with access to this client.
  // The notification type 'gbp_access_verification_exhausted' lets the
  // dashboard surface this specifically to admin / internal users.
  const { error: notifError } = await supabase
    .from('notifications')
    .insert({
      client_id:             clientId,
      profile_id:            profileId,
      user_id:               null,      // broadcast to all client users
      type:                  'gbp_access_verification_exhausted',
      title:                 'GBP Access Verification Failed',
      message:               `Google Business Profile manager access could not be confirmed for this client after ${MAX_ATTEMPTS} attempts spanning ${MAX_ATTEMPTS - 1} days. Manual intervention is required.`,
      metadata:              {
        max_attempts:      MAX_ATTEMPTS,
        last_check_reason: reason,
        bullmq_job_id:     jobId ?? null,
        is_admin_alert:    true,
      },
      channel_email:         false,   // raised as in-app; email escalation is separate
      channel_webhook:       false,
      email_delivery_status: 'skipped',
    })

  if (notifError) {
    console.error('[verifyGbpAccess] Failed to insert admin notification', {
      clientId,
      error: notifError.message,
    })
  }

  // ── 3. Log to activity_log ────────────────────────────────────────────────
  const { error: logError } = await supabase
    .from('activity_log')
    .insert({
      client_id:   clientId,
      user_id:     initiatedByUserId,
      action:      'gbp_access_verification_exhausted',
      entity_type: 'client',
      entity_id:   clientId,
      metadata:    {
        max_attempts:      MAX_ATTEMPTS,
        last_check_reason: reason,
        bullmq_job_id:     jobId ?? null,
      },
    })

  if (logError) {
    console.error('[verifyGbpAccess] Failed to write exhaustion activity_log', {
      clientId,
      error: logError.message,
    })
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleVerifyGbpAccess(job: Job): Promise<void> {
  // ── 1. Validate payload ────────────────────────────────────────────────────
  assertPayload(job.data)
  const { clientId, profileId, locationId, initiatedByUserId } = job.data

  // job.attemptsMade is 0-indexed: 0 = first attempt, 4 = fifth attempt.
  const attemptNumber  = job.attemptsMade + 1
  const isLastAttempt  = attemptNumber >= MAX_ATTEMPTS

  console.log('[verifyGbpAccess] Job received', {
    jobId:             job.id,
    clientId,
    profileId,
    locationId,
    attemptNumber,
    maxAttempts:       MAX_ATTEMPTS,
    isLastAttempt,
    initiatedByUserId,
  })

  // ── 2. Tenant scope validation — fail fast, no retry ──────────────────────
  await validateTenantScope(clientId, profileId, locationId)

  console.log('[verifyGbpAccess] Tenant scope validated', {
    jobId:    job.id,
    clientId,
  })

  // ── 3. Fetch client — verify status is still awaiting_google_approval ─────
  const { data: clientData, error: clientError } = await supabase
    .from('clients')
    .select('id, name, onboarding_status')
    .eq('id', clientId)   // tenant boundary
    .maybeSingle()

  if (clientError) {
    throw new Error(
      `[verifyGbpAccess] DB error fetching client ${clientId}: ${clientError.message}`,
    )
  }

  if (!clientData) {
    throw Object.assign(
      new Error(`[verifyGbpAccess] Client ${clientId} not found`),
      { [Symbol.for('bullmq:skipRetry')]: true },
    )
  }

  const client = clientData as { id: string; name: string; onboarding_status: string }

  // ── 4. Idempotency guard — exit silently if status already advanced ────────
  if (client.onboarding_status !== 'awaiting_google_approval') {
    console.log('[verifyGbpAccess] Status is no longer awaiting_google_approval — skipping', {
      jobId:         job.id,
      clientId,
      currentStatus: client.onboarding_status,
    })
    return
  }

  // ── 5. Check GBP access ───────────────────────────────────────────────────
  console.log('[verifyGbpAccess] Checking GBP access', {
    jobId:         job.id,
    clientId,
    attemptNumber,
  })

  const { outcome, reason } = await checkGbpAccessGranted(clientId)

  // ── 6a. Access confirmed — trigger growth lifecycle ────────────────────────
  if (outcome === 'granted') {
    console.log('[verifyGbpAccess] GBP access confirmed — advancing to access_granted', {
      jobId:  job.id,
      clientId,
      reason,
      attemptNumber,
    })

    await triggerGrowthLifecycle(
      clientId,
      profileId,
      locationId,
      initiatedByUserId,
      job.id,
    )

    console.log('[verifyGbpAccess] Growth lifecycle triggered successfully', {
      jobId:    job.id,
      clientId,
    })

    return   // success — polling complete
  }

  // ── 6b. Auth error — credentials are invalid/revoked; stop immediately ─────
  //
  // Retrying won't help.  Mark the client auth_error and return so BullMQ
  // treats this attempt as completed (no further retries scheduled).
  if (outcome === 'auth_error') {
    console.warn('[verifyGbpAccess] Auth error — stopping polling and marking auth_error', {
      jobId:  job.id,
      clientId,
      reason,
      attemptNumber,
    })

    await handleAuthError(clientId, profileId, initiatedByUserId, reason, job.id)

    console.warn('[verifyGbpAccess] Auth error handling complete — polling stopped', {
      jobId:    job.id,
      clientId,
    })

    return   // do NOT throw — no retry
  }

  // ── 6c. No accounts / no locations — leave onboarding_status unchanged ─────
  //
  // outcome === 'no_accounts' | 'no_locations'
  // The client is still waiting for access to propagate; status stays as-is.
  console.log('[verifyGbpAccess] GBP access not yet confirmed', {
    jobId:         job.id,
    clientId,
    outcome,
    reason,
    attemptNumber,
    isLastAttempt,
  })

  // ── 6d. Last attempt exhausted — handle inline, do not throw ──────────────
  //
  // By returning (not throwing) on the last attempt, BullMQ marks this job
  // as completed rather than failed.  This cleanly stops all further retries
  // while still giving us full control over the exhaustion side-effects.
  if (isLastAttempt) {
    console.warn('[verifyGbpAccess] All attempts exhausted — creating admin alert', {
      jobId:    job.id,
      clientId,
      outcome,
      reason,
    })

    await handleExhausted(clientId, profileId, initiatedByUserId, reason, job.id)

    console.warn('[verifyGbpAccess] Exhaustion handling complete — polling stopped', {
      jobId:    job.id,
      clientId,
    })

    return   // do NOT throw — no more retries
  }

  // ── 6e. Still within retry window — throw to schedule next check in 12 h ──
  console.log('[verifyGbpAccess] Scheduling next check in 12 hours', {
    jobId:            job.id,
    clientId,
    outcome,
    reason,
    attemptNumber,
    nextAttemptNumber: attemptNumber + 1,
  })

  throw new GbpAccessNotYetGrantedError(reason)
}
