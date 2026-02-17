import type { ConnectionOptions } from "bullmq"

function parseRedisUrlToConnectionOptions(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl)

  const port = url.port ? Number(url.port) : 6379
  const rawDb =
    url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined
  const db = typeof rawDb === "number" && Number.isFinite(rawDb) ? rawDb : undefined

  const base: ConnectionOptions = {
    host: url.hostname,
    port: Number.isFinite(port) ? port : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    db,
  }

  // Use TLS when the URL scheme is rediss://
  if (url.protocol === "rediss:") {
    // BullMQ ultimately passes this to ioredis; an empty TLS options object enables TLS defaults.
    ;(base as ConnectionOptions & { tls: unknown }).tls = {}
  }

  return base
}

const redisUrl = process.env.REDIS_URL
if (!redisUrl) {
  throw new Error("REDIS_URL is required for BullMQ workers")
}

export const redisConnection: ConnectionOptions =
  parseRedisUrlToConnectionOptions(redisUrl)