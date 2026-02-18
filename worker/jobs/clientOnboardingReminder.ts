import type { Job } from 'bullmq'
import { supabase } from '../supabase'
import { sendTemplateEmail } from '../../lib/email/sendgrid'
import { validateTenantScope } from '../utils/validateTenantScope'
import type {
  ClientOnboardingReminderPayload,
  NotificationDeliveryRow,
} from '../types'

// ─── Template ID ──────────────────────────────────────────────────────────────
//
// A single branded reminder template is used regardless of which onboarding
// status is being reminded about.  The current status is passed to the
// template as a dynamic variable so copy can be contextualised in SendGrid.

const REMINDER_TEMPLATE_ID = (() => {
  const val = process.env.SENDGRID_TEMPLATE_ONBOARDING_REMINDER
  if (!val) {
    throw new Error(
      '[clientOnboardingReminder] SENDGRID_TEMPLATE_ONBOARDING_REMINDER is required but not set',
    )
  }
  return val
})()

// ─── Runtime payload validation ───────────────────────────────────────────────

function assertPayload(data: unknown): asserts data is ClientOnboardingReminderPayload {
  if (typeof data !== 'object' || data === null) {
    throw new Error('[clientOnboardingReminder] Job data must be a non-null object')
  }

  const record = data as Record<string, unknown>

  const required = [
    'clientId',
    'profileId',
    'locationId',
    'initiatedByUserId',
    'expectedOnboardingStatus',
  ] as const

  const missing = required.filter(
    f => typeof record[f] !== 'string' || record[f] === '',
  )

  if (missing.length > 0) {
    throw new Error(
      `[clientOnboardingReminder] Job is missing required fields: ${missing.join(', ')}`,
    )
  }
}

// ─── Delivery row helpers ─────────────────────────────────────────────────────
//
// These helpers write to notification_deliveries, which requires a parent
// notifications row.  A synthetic notifications row is created before calling
// insertDeliveryRow so the FK constraint is always satisfied.
//
// Errors are logged but never re-thrown — audit tracking must not mask the
// real send result.

async function insertNotificationRow(
  clientId:         string,
  profileId:        string,
  locationId:       string,
  userId:           string,
  onboardingStatus: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('notifications')
    .insert({
      client_id:             clientId,
      profile_id:            profileId,
      location_id:           locationId,
      user_id:               userId,
      type:                  'onboarding_reminder',
      title:                 'Onboarding Reminder',
      message:               `Reminder: your onboarding is still at "${onboardingStatus}". Please complete the next step.`,
      metadata:              { onboarding_status: onboardingStatus },
      channel_email:         true,
      channel_webhook:       false,
      email_delivery_status: 'pending',
    })
    .select('id')
    .single()

  if (error) {
    console.error('[clientOnboardingReminder] Failed to insert notifications row', {
      clientId,
      profileId,
      locationId,
      userId,
      onboardingStatus,
      error: error.message,
    })
    return null
  }

  return (data as { id: string }).id
}

async function insertDeliveryRow(
  notificationId: string,
  clientId:       string,
  userId:         string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('notification_deliveries')
    .insert({
      notification_id: notificationId,
      client_id:       clientId,
      user_id:         userId,
      channel:         'email',
      status:          'pending',
    })
    .select('id')
    .single()

  if (error) {
    console.error('[clientOnboardingReminder] Failed to insert delivery row', {
      notificationId,
      clientId,
      userId,
      error: error.message,
    })
    return null
  }

  return (data as Pick<NotificationDeliveryRow, 'id'>).id
}

async function updateDeliveryRow(
  deliveryId:     string,
  notificationId: string,
  status:         'sent' | 'failed',
  opts:           { error?: string; sentAt?: string } = {},
): Promise<void> {
  // Update notification_deliveries
  const deliveryPatch: Record<string, unknown> = { status }
  if (opts.sentAt) deliveryPatch.sent_at = opts.sentAt
  if (opts.error)  deliveryPatch.error   = opts.error

  const { error: deliveryError } = await supabase
    .from('notification_deliveries')
    .update(deliveryPatch)
    .eq('id', deliveryId)

  if (deliveryError) {
    console.error('[clientOnboardingReminder] Failed to update delivery row', {
      deliveryId,
      status,
      error: deliveryError.message,
    })
  }

  // Mirror final status back onto the parent notifications row
  const notifPatch: Record<string, unknown> = {
    email_delivery_status: status,
  }
  if (opts.sentAt) notifPatch.email_sent_at = opts.sentAt

  const { error: notifError } = await supabase
    .from('notifications')
    .update(notifPatch)
    .eq('id', notificationId)

  if (notifError) {
    console.error('[clientOnboardingReminder] Failed to update notifications row', {
      notificationId,
      status,
      error: notifError.message,
    })
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleClientOnboardingReminder(job: Job): Promise<void> {
  // ── 1. Validate payload ────────────────────────────────────────────────────
  assertPayload(job.data)
  const {
    clientId,
    profileId,
    locationId,
    expectedOnboardingStatus,
    initiatedByUserId,
  } = job.data

  console.log('[clientOnboardingReminder] Job received', {
    jobId:                   job.id,
    clientId,
    profileId,
    locationId,
    expectedOnboardingStatus,
    initiatedByUserId,
    attempt:                 job.attemptsMade + 1,
  })

  // ── 2. Tenant scope validation — fail fast before any data access ──────────
  await validateTenantScope(clientId, profileId, locationId)

  console.log('[clientOnboardingReminder] Tenant scope validated', {
    jobId:    job.id,
    clientId,
  })

  // ── 3. Fetch client — tenant-scoped ───────────────────────────────────────
  const { data: clientData, error: clientError } = await supabase
    .from('clients')
    .select('id, name, user_id, email_notifications_enabled, onboarding_status')
    .eq('id', clientId)   // tenant boundary
    .maybeSingle()

  if (clientError) {
    throw new Error(
      `[clientOnboardingReminder] DB error fetching client ${clientId}: ${clientError.message}`,
    )
  }

  if (!clientData) {
    // Client no longer exists — nothing to remind, don't retry.
    console.warn('[clientOnboardingReminder] Client not found — skipping', {
      jobId: job.id,
      clientId,
    })
    throw Object.assign(
      new Error(`[clientOnboardingReminder] Client ${clientId} not found`),
      { [Symbol.for('bullmq:skipRetry')]: true },
    )
  }

  const client = clientData as {
    id:                         string
    name:                       string
    user_id:                    string
    email_notifications_enabled: boolean
    onboarding_status:          string
  }

  // ── 4. Staleness check — has the status advanced since scheduling? ─────────
  if (client.onboarding_status !== expectedOnboardingStatus) {
    console.log(
      '[clientOnboardingReminder] Status has changed since scheduling — exiting silently',
      {
        jobId:                   job.id,
        clientId,
        expectedOnboardingStatus,
        currentOnboardingStatus: client.onboarding_status,
      },
    )
    return   // not an error — client progressed, reminder is stale
  }

  console.log('[clientOnboardingReminder] Status unchanged — reminder is still relevant', {
    jobId:            job.id,
    clientId,
    onboardingStatus: client.onboarding_status,
  })

  // ── 5. Kill-switch: respect per-client email suppression ──────────────────
  if (!client.email_notifications_enabled) {
    console.log(
      '[clientOnboardingReminder] Email suppressed — email_notifications_enabled is false',
      {
        jobId:    job.id,
        clientId,
        onboardingStatus: client.onboarding_status,
      },
    )
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
      `[clientOnboardingReminder] DB error fetching user ${client.user_id}: ${userError.message}`,
    )
  }

  if (!userData) {
    console.warn('[clientOnboardingReminder] Recipient user not found — skipping', {
      jobId:   job.id,
      clientId,
      userId:  client.user_id,
    })
    throw Object.assign(
      new Error(
        `[clientOnboardingReminder] User ${client.user_id} not found for client ${clientId}`,
      ),
      { [Symbol.for('bullmq:skipRetry')]: true },
    )
  }

  const user = userData as { id: string; email: string; full_name: string | null }

  // ── 7. Create parent notifications row ───────────────────────────────────
  const notificationId = await insertNotificationRow(
    clientId,
    profileId,
    locationId,
    user.id,
    client.onboarding_status,
  )

  // ── 8. Create pending notification_deliveries row ─────────────────────────
  const deliveryId = notificationId
    ? await insertDeliveryRow(notificationId, clientId, user.id)
    : null

  console.log('[clientOnboardingReminder] Sending reminder email', {
    jobId:            job.id,
    clientId,
    onboardingStatus: client.onboarding_status,
    templateId:       REMINDER_TEMPLATE_ID,
    to:               user.email,
    notificationId,
    deliveryId,
  })

  // ── 9. Build template data and send ───────────────────────────────────────
  const dynamicTemplateData: Record<string, unknown> = {
    client_name:       client.name,
    recipient_name:    user.full_name ?? user.email,
    onboarding_status: client.onboarding_status,
    year:              new Date().getFullYear(),
  }

  try {
    await sendTemplateEmail({
      to:                  user.email,
      templateId:          REMINDER_TEMPLATE_ID,
      dynamicTemplateData,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (notificationId && deliveryId) {
      await updateDeliveryRow(deliveryId, notificationId, 'failed', { error: message })
    }

    console.error('[clientOnboardingReminder] Send failed', {
      jobId:            job.id,
      clientId,
      onboardingStatus: client.onboarding_status,
      to:               user.email,
      notificationId,
      deliveryId,
      error:            message,
    })

    throw err   // re-throw so BullMQ retries (up to configured attempts)
  }

  // ── 10. Mark delivery as sent ─────────────────────────────────────────────
  const sentAt = new Date().toISOString()

  if (notificationId && deliveryId) {
    await updateDeliveryRow(deliveryId, notificationId, 'sent', { sentAt })
  }

  console.log('[clientOnboardingReminder] Reminder sent successfully', {
    jobId:            job.id,
    clientId,
    onboardingStatus: client.onboarding_status,
    templateId:       REMINDER_TEMPLATE_ID,
    to:               user.email,
    notificationId,
    deliveryId,
    sentAt,
  })
}
