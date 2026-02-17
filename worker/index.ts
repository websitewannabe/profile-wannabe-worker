import 'dotenv/config'
import { Worker } from "bullmq"
import { redisConnection } from "./redis"

console.log("Worker starting...")

setInterval(() => {
  console.log("Worker heartbeat:", new Date().toISOString())
}, 10000)

new Worker(
  "onboarding",
  async job => {
    console.log("🔥 JOB RECEIVED:", job.id, job.name, job.data)
  },
  {
    connection: redisConnection,
    concurrency: 3,
  }
).on("failed", (job, err) => {
  console.error("Job failed:", job?.id, err)
})
