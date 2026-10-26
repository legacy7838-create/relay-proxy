export function createRateLimiter({ limit, windowMs = 60_000, now = () => Date.now() }) {
  const buckets = new Map();

  function allow(key = "global") {
    if (!Number.isFinite(limit) || limit <= 0) return { allowed: true, remaining: Infinity };

    const current = now();
    let bucket = buckets.get(key);
    if (!bucket || current >= bucket.resetAt) {
      bucket = { count: 0, resetAt: current + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - current) / 1000)),
      };
    }

    return { allowed: true, remaining: limit - bucket.count };
  }

  return { allow, size: () => buckets.size };
}
