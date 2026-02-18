import { verifyGbpAccessQueue } from '../queues'
import type { VerifyGbpAccessPayload } from '../types'

/**
 * Enqueues a verify_gbp_access polling job with a stable deduplication jobId.
 *
 * BullMQ skips the add when a job with this ID is already waiting, delayed,
 * or active — so callers can safely call this multiple times (e.g. from a
 * webhook retry, an admin trigger, or an onboarding status transition) without
 * creating duplicate polling loops for the same client.
 *
 * The stable ID format is:  verify-gbp-access:<clientId>
 *
 * @returns The BullMQ job ID (always the stable key), or undefined on error.
 */
export async function enqueueVerifyGbpAccess(
  payload: VerifyGbpAccessPayload,
): Promise<string | undefined> {
  const jobId = `verify-gbp-access:${payload.clientId}`

  const job = await verifyGbpAccessQueue.add(
    'verify_gbp_access',
    payload,
    { jobId },
  )

  return job.id
}
