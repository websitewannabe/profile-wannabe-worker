import { Queue } from "bullmq"
import { redisConnection } from "./redis"

export const onboardingQueue = new Queue("onboarding", {
  connection: redisConnection,
})

export const recalibrationQueue = new Queue("recalibration", {
  connection: redisConnection,
})