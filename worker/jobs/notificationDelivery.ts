import type { Job } from 'bullmq'
import { supabase } from '../supabase'
import { sendTemplateEmail } from '../../lib/email/sendgrid'
import { validateTenantScope } from '../utils/validateTenantScope'
import type {
  NotificationDeliveryPayload,
  NotificationRow,
  NotificationDeliveryRow,
  ClientRow,
  NotificationEmailRecipient,
} from '../types'

// ─── Env ──────────────────────────────────────────────────────────────────────

const NOTIFICATION_TEMPLATE_ID = process.env.SENDGRID_TEMPLATE_NOTIFICATION_ID
if (!NOTIFICATION_TEMPLATE_ID) {
  throw new Error('[notificationDelivery] SENDGRID_TEMPLATE_NOTIFICATION_ID is required but not set')
}

// ─── Delivery row helpers ─────────────────────────────────────────────────────
//
// The worker uses the service-role client (bypasses RLS).  All writes include
// client_id so that the RLS policies on reads remain meaningful for API callers.
//
// Errors from these helpers are logged but never throw — delivery row tracking
// is an audit concern and must not shadow real send failures.

async function insertDeliveryRow(
  notificationId: string,
  clientId:       string,
  userId:         string | null,
  channel:        'email' | 'webhook',
): Promise<string | null> {
  const { data, error } = await supabase
    .from('notification_deliveries')
    .insert({
      notification_id: notificationId,
      client_id:       clientId,
      user_id:         userId,
      channel,
      status:          'pending',
    })
    .select('id')
    .single()

  if (error) {
    console.error('[notificationDelivery] Failed to insert delivery row', {
      notificationId,
      clientId,
      userId,
      channel,
      error: error.message,
    })
    return null
  }

  return (data as Pick<NotificationDeliveryRow, 'id'>).id
}

async function updateDeliveryRow(
  deliveryId: string,
  status:     'sent' | 'failed',
  opts:       { error?: string; sentAt?: string } = {},
): Promise<void> {
  const patch: Record<string, unknown> = { status }
  if (opts.sentAt) patch.sent_at = opts.sentAt
  if (opts.error)  patch.error   = opts.error

  const { error } = await supabase
    .from('notification_deliveries')
    .update(patch)
    .eq('id', deliveryId)

  if (error) {
    console.error('[notificationDelivery] Failed to update delivery row', {
      deliveryId,
      status,
      error: error.message,
    })
  }
}

// ─── Runtime payload validation ───────────────────────────────────────────────

function assertPayload(data: unknown): asserts data is NotificationDeliveryPayload {
  if (typeof data !== 'object' || data === null) {
    throw new Error('[notificationDelivery] Job data must be a non-null object')
  }
  const record = data as Record<string, unknown>
  const required = [
    'clientId',
    'profileId',
    'locationId',
    'notificationId',
    'initiatedByUserId',
  ] as const
  const missing = required.filter(f => typeof record[f] !== 'string' || record[f] === '')
  if (missing.length > 0) {
    throw new Error(
      `[notificationDelivery] Job is missing required fields: ${missing.join(', ')}`,
    )
  }
}

// ─── Recipient resolution ─────────────────────────────────────────────────────

/**
 * Single-recipient path: fetch the named user's email directly.
 * TENANT ISOLATION: users are not client-scoped in the schema, but we only
 * reach this path after the notification has been verified to belong to
 * clientId, and the user_id came from that notification row.
 */
async function fetchSingleRecipient(
  userId: string,
  notificationId: string,
): Promise<NotificationEmailRecipient> {
  const { data: user, error } = await supabase
    .from('users')
    .select('id, email, full_name')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    throw new Error(
      `[notificationDelivery] DB error fetching user ${userId}: ${error.message}`,
    )
  }
  if (!user) {
    throw new Error(
      `[notificationDelivery] User ${userId} not found — cannot deliver notification ${notificationId}`,
    )
  }

  return {
    userId:   user.id as string,
    email:    user.email as string,
    fullName: (user.full_name as string | null) ?? null,
  }
}

/**
 * Broadcast path: fetch all users who have access to this client.
 * Uses user_client_access as the authoritative membership table.
 * TENANT ISOLATION: filtered strictly by client_id.
 */
async function fetchClientRecipients(
  clientId: string,
): Promise<NotificationEmailRecipient[]> {
  const { data, error } = await supabase
    .from('user_client_access')
    .select('user_id, users!inner(id, email, full_name)')
    .eq('client_id', clientId) // tenant boundary

  if (error) {
    throw new Error(
      `[notificationDelivery] DB error fetching client recipients for ${clientId}: ${error.message}`,
    )
  }

  if (!data || data.length === 0) {
    return []
  }

  return (data as Array<{
    user_id: string
    users: { id: string; email: string; full_name: string | null }
  }>).map(row => ({
    userId:   row.users.id,
    email:    row.users.email,
    fullName: row.users.full_name ?? null,
  }))
}

// ─── Email channel ────────────────────────────────────────────────────────────

interface EmailTemplateData {
  title:       string
  message:     string
  cta_url:     string
  cta_text:    string
  client_name: string
  year:        number
}

async function deliverEmailChannel(
  notif:    NotificationRow,
  client:   ClientRow,
  clientId: string,
): Promise<{ sentCount: number; failedCount: number; firstError: string | null }> {
  // Kill-switch: abort the whole email channel for this client
  if (!client.email_notifications_enabled) {
    console.log('[notificationDelivery] Email suppressed — email_notifications_enabled is false', {
      notificationId: notif.id,
      clientId,
    })
    return { sentCount: 0, failedCount: 0, firstError: null }
  }

  // Resolve recipients
  let recipients: NotificationEmailRecipient[]
  if (notif.user_id) {
    const single = await fetchSingleRecipient(notif.user_id, notif.id)
    recipients = [single]
  } else {
    recipients = await fetchClientRecipients(clientId)
  }

  if (recipients.length === 0) {
    console.warn('[notificationDelivery] No email recipients found', {
      notificationId: notif.id,
      clientId,
      mode: notif.user_id ? 'single' : 'broadcast',
    })
    return { sentCount: 0, failedCount: 0, firstError: null }
  }

  // Build template data — cta_url / cta_text come from notification metadata
  const templateData: EmailTemplateData = {
    title:       notif.title,
    message:     notif.message,
    cta_url:     (notif.metadata?.cta_url  as string | undefined) ?? '',
    cta_text:    (notif.metadata?.cta_text as string | undefined) ?? 'View',
    client_name: client.name,
    year:        new Date().getFullYear(),
  }

  let sentCount    = 0
  let failedCount  = 0
  let firstError: string | null = null

  for (const recipient of recipients) {
    // ── Insert pending delivery row before attempting the send ────────────────
    const deliveryId = await insertDeliveryRow(
      notif.id, clientId, recipient.userId, 'email',
    )

    console.log('[notificationDelivery] Sending template email', {
      notificationId: notif.id,
      clientId,
      userId:     recipient.userId,
      to:         recipient.email,
      templateId: NOTIFICATION_TEMPLATE_ID,
    })

    try {
      await sendTemplateEmail({
        to:                  recipient.email,
        templateId:          NOTIFICATION_TEMPLATE_ID as string,
        dynamicTemplateData: templateData,
      })

      sentCount++
      const sentAt = new Date().toISOString()

      if (deliveryId) {
        await updateDeliveryRow(deliveryId, 'sent', { sentAt })
      }

      console.log('[notificationDelivery] Email sent successfully', {
        notificationId: notif.id,
        clientId,
        userId:     recipient.userId,
        to:         recipient.email,
        deliveryId,
      })
    } catch (err) {
      failedCount++
      const message = err instanceof Error ? err.message : String(err)
      if (!firstError) firstError = message

      if (deliveryId) {
        await updateDeliveryRow(deliveryId, 'failed', { error: message })
      }

      console.error('[notificationDelivery] Email send failed', {
        notificationId: notif.id,
        clientId,
        userId:     recipient.userId,
        to:         recipient.email,
        deliveryId,
        error:      message,
      })
      // Continue to next recipient — accumulate failures, throw at end.
    }
  }

  return { sentCount, failedCount, firstError }
}

// ─── Webhook channel ──────────────────────────────────────────────────────────

async function deliverWebhookChannel(
  notif:  NotificationRow,
  client: ClientRow,
): Promise<void> {
  const webhookUrl = client.client_dashboard_api_url
  const webhookKey = client.client_dashboard_api_key

  if (!webhookUrl) {
    console.warn(
      '[notificationDelivery] No webhook URL configured for client — skipping webhook channel',
      { clientId: client.id, notificationId: notif.id },
    )
    return
  }

  // Webhook deliveries are not user-scoped (user_id = null)
  const deliveryId = await insertDeliveryRow(notif.id, client.id, null, 'webhook')

  const payload = {
    event: 'notification.deliver',
    notification: {
      id:       notif.id,
      type:     notif.type,
      title:    notif.title,
      message:  notif.message,
      metadata: notif.metadata,
    },
  }

  console.log('[notificationDelivery] Sending webhook', {
    notificationId: notif.id,
    clientId:       client.id,
    webhookUrl,
    deliveryId,
  })

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(webhookKey ? { 'X-API-Key': webhookKey } : {}),
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)')
    const message = `Webhook endpoint returned ${res.status}: ${body}`

    if (deliveryId) {
      await updateDeliveryRow(deliveryId, 'failed', { error: message })
    }

    throw new Error(`[notificationDelivery] ${message}`)
  }

  const sentAt = new Date().toISOString()
  if (deliveryId) {
    await updateDeliveryRow(deliveryId, 'sent', { sentAt })
  }

  console.log('[notificationDelivery] Webhook sent successfully', {
    notificationId: notif.id,
    clientId:       client.id,
    deliveryId,
  })
}

// ─── Delivery status helper ───────────────────────────────────────────────────

function resolveOverallStatus(
  emailRequested: boolean,
  webhookRequested: boolean,
  emailDone: boolean,
  webhookDone: boolean,
): NotificationRow['delivery_status'] {
  const requested = (emailRequested ? 1 : 0) + (webhookRequested ? 1 : 0)
  const done      = (emailDone  ? 1 : 0)      + (webhookDone  ? 1 : 0)

  if (done === 0)         return 'failed'
  if (done === requested) return 'delivered'
  return 'partial'
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleNotificationDelivery(job: Job): Promise<void> {
  // ── 1. Validate payload ────────────────────────────────────────────────────
  assertPayload(job.data)
  const { clientId, profileId, locationId, notificationId, initiatedByUserId } = job.data

  console.log('[notificationDelivery] Job received', {
    jobId: job.id,
    notificationId,
    clientId,
    profileId,
    locationId,
    initiatedByUserId,
    attempt: job.attemptsMade + 1,
  })

  // ── 2. Tenant scope validation — fail fast before any data access ──────────
  // Throws TenantScopeError (non-retryable intent) on ownership mismatch.
  await validateTenantScope(clientId, profileId, locationId)

  console.log('[notificationDelivery] Tenant scope validated', {
    notificationId,
    clientId,
  })

  // ── 3. Fetch notification — scoped to tenant ───────────────────────────────
  const { data: notification, error: notifError } = await supabase
    .from('notifications')
    .select(
      'id, client_id, user_id, type, title, message, metadata,' +
      'channel_email, channel_webhook, email_sent_at, webhook_sent_at,' +
      'delivery_status, email_delivery_status, webhook_delivery_status',
    )
    .eq('client_id', clientId)   // tenant boundary — always first
    .eq('id', notificationId)
    .maybeSingle()

  if (notifError) {
    console.error('[notificationDelivery] DB error fetching notification', {
      notificationId,
      clientId,
      error: notifError.message,
    })
    throw new Error(`[notificationDelivery] DB error fetching notification: ${notifError.message}`)
  }

  if (!notification) {
    // Permanent failure — notification does not exist or belongs to another tenant.
    console.error('[notificationDelivery] Notification not found or tenant mismatch', {
      notificationId,
      clientId,
    })
    throw Object.assign(
      new Error(
        `[notificationDelivery] Notification ${notificationId} not found for client ${clientId}`,
      ),
      { [Symbol.for('bullmq:skipRetry')]: true },
    )
  }

  const notif = notification as unknown as NotificationRow

  // ── 4. Idempotency guard — skip channels already delivered ─────────────────
  const needsEmail   = notif.channel_email   && notif.email_sent_at   === null
  const needsWebhook = notif.channel_webhook && notif.webhook_sent_at === null

  if (!needsEmail && !needsWebhook) {
    console.log('[notificationDelivery] All channels already delivered — nothing to do', {
      notificationId,
      clientId,
    })
    return
  }

  // ── 5. Fetch client — needed for both email + webhook channels ─────────────
  const { data: clientData, error: clientError } = await supabase
    .from('clients')
    .select('id, name, email_notifications_enabled, client_dashboard_api_url, client_dashboard_api_key')
    .eq('id', clientId)
    .maybeSingle()

  if (clientError) {
    console.error('[notificationDelivery] DB error fetching client', {
      clientId,
      error: clientError.message,
    })
    throw new Error(`[notificationDelivery] DB error fetching client: ${clientError.message}`)
  }

  if (!clientData) {
    // Client vanished after scope validation — should never happen, but be safe.
    throw Object.assign(
      new Error(`[notificationDelivery] Client ${clientId} not found`),
      { [Symbol.for('bullmq:skipRetry')]: true },
    )
  }

  const client = clientData as ClientRow

  // ── 6. Attempt each channel independently ─────────────────────────────────
  let emailDone   = !needsEmail
  let webhookDone = !needsWebhook
  const updates: Record<string, unknown> = {}

  // ── 6a. Email channel ──────────────────────────────────────────────────────
  if (needsEmail) {
    try {
      const { sentCount, failedCount, firstError } =
        await deliverEmailChannel(notif, client, clientId)

      if (failedCount > 0 && sentCount === 0) {
        // Every recipient failed — mark channel failed and let job retry.
        throw new Error(firstError ?? 'All recipients failed')
      }

      // At least one send succeeded (or zero recipients — treat as done).
      updates.email_sent_at         = new Date().toISOString()
      updates.email_delivery_status = failedCount > 0 ? 'partial' : 'sent'
      emailDone = true

    } catch (err) {
      updates.email_delivery_status = 'failed'

      console.error('[notificationDelivery] Email channel failed', {
        notificationId,
        clientId,
        error: err instanceof Error ? err.message : String(err),
      })
      // Defer re-throw — attempt webhook first.
    }
  }

  // ── 6b. Webhook channel ────────────────────────────────────────────────────
  if (needsWebhook) {
    try {
      await deliverWebhookChannel(notif, client)
      updates.webhook_sent_at         = new Date().toISOString()
      updates.webhook_delivery_status = 'sent'
      webhookDone = true
    } catch (err) {
      updates.webhook_delivery_status = 'failed'

      console.error('[notificationDelivery] Webhook channel failed', {
        notificationId,
        clientId,
        webhookUrl: client.client_dashboard_api_url,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── 7. Persist all channel updates atomically ──────────────────────────────
  updates.delivery_status = resolveOverallStatus(
    notif.channel_email,
    notif.channel_webhook,
    !needsEmail  || emailDone,
    !needsWebhook || webhookDone,
  )

  const { error: updateError } = await supabase
    .from('notifications')
    .update(updates)
    .eq('client_id', clientId)   // tenant boundary on writes
    .eq('id', notificationId)

  if (updateError) {
    // Log but don't mask the real failure — the channel error below takes priority.
    console.error('[notificationDelivery] Failed to persist delivery updates', {
      notificationId,
      clientId,
      updates,
      error: updateError.message,
    })
  }

  // ── 8. Throw if any required channel is still pending — triggers BullMQ retry
  if ((needsEmail && !emailDone) || (needsWebhook && !webhookDone)) {
    throw new Error(
      `[notificationDelivery] One or more channels failed for notification ${notificationId}`,
    )
  }

  console.log('[notificationDelivery] Delivery complete', {
    jobId:           job.id,
    notificationId,
    clientId,
    delivery_status: updates.delivery_status,
  })
}
