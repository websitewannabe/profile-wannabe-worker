import 'dotenv/config'
import { Worker } from 'bullmq'
import { redisConnection } from './redis'
import { validateTenantScope, TenantScopeError } from './utils/validateTenantScope'
import { handleNotificationDelivery } from './jobs/notificationDelivery'
import { handleClientOnboardingEmail } from './jobs/clientOnboardingEmail'
import { handleClientOnboardingReminder } from './jobs/clientOnboardingReminder'
import { handleAccessGrantedOnboarding } from './jobs/accessGrantedOnboarding'
import { handleVerifyGbpAccess } from './jobs/verifyGbpAccess'
import { handleProfileAuditV1 } from './jobs/profileAuditV1'
import type { TenantJobPayload } from './types'

// ─── Runtime validation ───────────────────────────────────────────────────────

const REQUIRED_FIELDS: (keyof TenantJobPayload)[] = [
  'clientId',
  'profileId',
  'locationId',
  'initiatedByUserId',
]

function assertTenantJobPayload(data: unknown): asserts data is TenantJobPayload {
  if (typeof data !== 'object' || data === null) {
    console.error('[assertTenantJobPayload] Job data is not an object', {
      received: data,
    })
    throw new Error('Job data must be a non-null object')
  }

  const record = data as Record<string, unknown>
  const missing = REQUIRED_FIELDS.filter(field => typeof record[field] !== 'string' || record[field] === '')

  if (missing.length > 0) {
    console.error('[assertTenantJobPayload] Job rejected — missing required fields', {
      missingFields: missing,
      receivedFields: Object.keys(record),
      data: record,
    })
    throw new Error(`Job is missing required fields: ${missing.join(', ')}`)
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

console.log('Worker starting...')

setInterval(() => {
  console.log('Worker heartbeat:', new Date().toISOString())
}, 10000)

new Worker(
  'onboarding',
  async job => {
    console.log('Job received:', job.id, job.name)

    // ── 1. Validate required fields are present ──────────────────────────────
    assertTenantJobPayload(job.data)
    const { clientId, profileId, locationId, initiatedByUserId } = job.data

    // ── 2. Validate tenant ownership chain (fail fast) ───────────────────────
    await validateTenantScope(clientId, profileId, locationId)

    console.log(`[${job.name}] Tenant scope valid — proceeding`, {
      jobId: job.id,
      clientId,
      profileId,
      locationId,
      initiatedByUserId,
    })

    // ── 3. Job-specific logic goes here ──────────────────────────────────────
    // TODO: implement onboarding job logic
  },
  {
    connection: redisConnection,
    concurrency: 3,
  },
).on('failed', (job, err) => {
  if (err instanceof TenantScopeError) {
    console.error('Job failed (tenant scope):', job?.id, err.message, err.context)
  } else {
    console.error('Job failed:', job?.id, err)
  }
})

// ─── verify_gbp_access worker ─────────────────────────────────────────────────
//
// Polls for GBP manager access confirmation every 12 hours, up to 5 attempts.
// Exhaustion handling (admin notification + error status) runs inside the job
// handler on the final attempt, so the failed event here only fires on
// unexpected errors (DB failures, tenant scope violations, etc.).

new Worker(
  'verify_gbp_access',
  handleVerifyGbpAccess,
  {
    connection:  redisConnection,
    concurrency: 5,
  },
).on('failed', (job, err) => {
  console.error('[verify_gbp_access] Job failed unexpectedly', {
    jobId:   job?.id,
    attempt: job?.attemptsMade,
    error:   err instanceof Error ? err.message : String(err),
  })
})

// ─── access_granted_onboarding worker ─────────────────────────────────────────

new Worker(
  'access_granted_onboarding',
  handleAccessGrantedOnboarding,
  {
    connection: redisConnection,
    concurrency: 3,
  },
).on('failed', (job, err) => {
  console.error('[access_granted_onboarding] Job failed', {
    jobId:   job?.id,
    attempt: job?.attemptsMade,
    error:   err instanceof Error ? err.message : String(err),
  })
})

// ─── client_onboarding_reminder worker ────────────────────────────────────────

new Worker(
  'client_onboarding_reminder',
  handleClientOnboardingReminder,
  {
    connection: redisConnection,
    concurrency: 5,
  },
).on('failed', (job, err) => {
  console.error('[client_onboarding_reminder] Job failed', {
    jobId:   job?.id,
    attempt: job?.attemptsMade,
    error:   err instanceof Error ? err.message : String(err),
  })
})

// ─── client_onboarding_email worker ───────────────────────────────────────────

new Worker(
  'client_onboarding_email',
  handleClientOnboardingEmail,
  {
    connection: redisConnection,
    concurrency: 5,
  },
).on('failed', (job, err) => {
  console.error('[client_onboarding_email] Job failed', {
    jobId:   job?.id,
    attempt: job?.attemptsMade,
    error:   err instanceof Error ? err.message : String(err),
  })
})

// ─── profile_audit worker ──────────────────────────────────────────────────────
//
// Runs profile_audit_v1 jobs.  Stable jobId (audit-v1:<locationId>) in the
// enqueue call ensures at-most-one audit per location is queued at a time.

new Worker(
  'profile_audit_v1',
  handleProfileAuditV1,
  {
    connection: redisConnection,
    concurrency: 3,
  },
).on('failed', (job, err) => {
  console.error('[profile_audit] Job failed', {
    jobId:   job?.id,
    attempt: job?.attemptsMade,
    error:   err instanceof Error ? err.message : String(err),
  })
})

// ─── notification_delivery worker ─────────────────────────────────────────────

new Worker(
  'notification_delivery',
  handleNotificationDelivery,
  {
    connection: redisConnection,
    concurrency: 5,
  },
).on('failed', (job, err) => {
  console.error('[notification_delivery] Job failed', {
    jobId:   job?.id,
    attempt: job?.attemptsMade,
    error:   err instanceof Error ? err.message : String(err),
  })
})
