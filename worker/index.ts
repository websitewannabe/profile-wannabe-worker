import { Worker } from "bullmq"
import { redisConnection } from "./redis"

new Worker(
  "onboarding",
  async job => {
    console.log("Starting onboarding job", job.id)
    // placeholder
  },
  {
    connection: redisConnection,
    concurrency: 3,
  }
)