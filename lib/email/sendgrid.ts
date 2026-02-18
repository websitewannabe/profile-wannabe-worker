import sgMail from '@sendgrid/mail'

// ─── Env validation ───────────────────────────────────────────────────────────

const apiKey = process.env.SENDGRID_API_KEY
if (!apiKey) {
  throw new Error('[sendgrid] SENDGRID_API_KEY is required but not set')
}

const fromEmail = process.env.SENDGRID_FROM_EMAIL
if (!fromEmail) {
  throw new Error('[sendgrid] SENDGRID_FROM_EMAIL is required but not set')
}

sgMail.setApiKey(apiKey)

// ─── Error class ──────────────────────────────────────────────────────────────

export class SendGridError extends Error {
  readonly statusCode: number
  readonly responseBody: unknown

  constructor(message: string, statusCode: number, responseBody: unknown) {
    super(message)
    this.name = 'SendGridError'
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
}

// ─── Shared error handler ─────────────────────────────────────────────────────

function handleSendGridFailure(
  err: unknown,
  context: { to: string; label: string },
): never {
  const sgErr = err as {
    message?: string
    response?: { status?: number; body?: unknown }
  }

  const statusCode   = sgErr.response?.status ?? 0
  const responseBody = sgErr.response?.body   ?? null
  const message      = sgErr.message           ?? 'Unknown SendGrid error'

  console.error(`[sendgrid] ${context.label} failed`, {
    to:           context.to,
    statusCode,
    responseBody,
    error:        message,
  })

  throw new SendGridError(
    `[sendgrid] Failed to send to "${context.to}": ${message}`,
    statusCode,
    responseBody,
  )
}

// ─── sendEmail ────────────────────────────────────────────────────────────────
// Plain-text / HTML email without a template.

export interface SendEmailOptions {
  to: string
  subject: string
  /** HTML body — at least one of html or text must be provided. */
  html?: string
  /** Plain-text body — at least one of html or text must be provided. */
  text?: string
}

export async function sendEmail({ to, subject, html, text }: SendEmailOptions): Promise<void> {
  if (!html && !text) {
    throw new Error('[sendgrid] sendEmail requires at least one of html or text')
  }

  const msg: Parameters<typeof sgMail.send>[0] = {
    to,
    from: fromEmail as string,
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
  }

  let response: Awaited<ReturnType<typeof sgMail.send>>

  try {
    response = await sgMail.send(msg)
  } catch (err) {
    handleSendGridFailure(err, { to, label: 'sendEmail' })
  }

  const [clientResponse] = response
  console.log('[sendgrid] Email sent', {
    to,
    subject,
    statusCode: clientResponse.statusCode,
  })
}

// ─── sendTemplateEmail ────────────────────────────────────────────────────────
// Sends a branded email using a SendGrid Dynamic Template.
// The template controls layout and styling; dynamicTemplateData populates
// the Handlebars variables inside it.

export interface SendTemplateEmailOptions {
  to: string
  templateId: string
  dynamicTemplateData: Record<string, unknown>
  /** Optional subject override — the template's own subject is used if omitted. */
  subject?: string
}

export async function sendTemplateEmail({
  to,
  templateId,
  dynamicTemplateData,
  subject,
}: SendTemplateEmailOptions): Promise<void> {
  const msg: Parameters<typeof sgMail.send>[0] = {
    to,
    from:    fromEmail as string,
    templateId,
    dynamicTemplateData,
    ...(subject ? { subject } : {}),
  }

  let response: Awaited<ReturnType<typeof sgMail.send>>

  try {
    response = await sgMail.send(msg)
  } catch (err) {
    handleSendGridFailure(err, { to, label: 'sendTemplateEmail' })
  }

  const [clientResponse] = response
  console.log('[sendgrid] Template email sent', {
    to,
    templateId,
    statusCode: clientResponse.statusCode,
  })
}
