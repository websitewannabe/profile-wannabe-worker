import { Queue } from "bullmq"
import { redisConnection } from "./redis"

export const onboardingQueue = new Queue("onboarding", {
  connection: redisConnection,
})

export const recalibrationQueue = new Queue("recalibration", {
  connection: redisConnection,
})

export const verifyGbpAccessQueue = new Queue("verify_gbp_access", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type:  "fixed",
      delay: 12 * 60 * 60 * 1000,  // 12 hours between each check
    },
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 500 },
  },
})

export const accessGrantedOnboardingQueue = new Queue("access_granted_onboarding", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 10_000, // 10 s → 20 s → 40 s
    },
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 500 },
  },
})

export const clientOnboardingReminderQueue = new Queue("client_onboarding_reminder", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: "exponential",
      delay: 15_000, // 15 s → 30 s
    },
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 500 },
  },
})

export const clientOnboardingEmailQueue = new Queue("client_onboarding_email", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 10_000, // 10 s → 20 s → 40 s
    },
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 500 },
  },
})

export const notificationDeliveryQueue = new Queue("notification_delivery", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5_000, // 5 s → 10 s → 20 s
    },
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 500 },
  },
})