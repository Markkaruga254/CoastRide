const buckets = new Map<string, { count: number; resetAt: number }>()
let operations = 0
const MAX_BUCKETS = 10_000

/**
 * Process-local fixed-window limiter for inbound callbacks.
 * For multi-instance deployments, replace with a shared store (for example Redis).
 */
export function allowRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const current = buckets.get(key)
  if (current && now < current.resetAt) {
    if (current.count >= limit) return false
    current.count += 1
    return true
  }

  if (buckets.size >= MAX_BUCKETS || ++operations % 256 === 0) {
    for (const [bucketKey, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(bucketKey)
    }
  }

  if (buckets.size >= MAX_BUCKETS) return false
  buckets.set(key, { count: 1, resetAt: now + windowMs })
  return true
}

/** Clear in-memory buckets between isolated integration tests. */
export function resetRateLimits(): void {
  buckets.clear()
  operations = 0
}
