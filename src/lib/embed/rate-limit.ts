/**
 * Per-conversation inbound rate limiting.
 *
 * There is no rate limiting anywhere else in the app — every other channel is
 * gated by something outside our control (Telegram's own limits, an IMAP poll
 * cycle, the dashboard password). The embed channel is the first surface where a
 * host can drive turns as fast as it likes, so it carries its own limiter.
 *
 * In-process and best-effort: a multi-replica deployment limits per replica.
 * That is deliberate — the point is to stop a runaway page loop, not to be a
 * billing control.
 */

interface Bucket {
  windowStart: number;
  count: number;
}

const WINDOW_MS = 60_000;

function buckets(): Map<string, Bucket> {
  const g = globalThis as typeof globalThis & { __embedRateBuckets?: Map<string, Bucket> };
  if (!g.__embedRateBuckets) g.__embedRateBuckets = new Map();
  return g.__embedRateBuckets;
}

/**
 * Consume one unit for a chat. Returns whether the request may proceed and, when
 * it may not, how many seconds until the window rolls over (for Retry-After).
 */
export function consumeEmbedRate(
  chatId: string,
  perMinute: number,
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const map = buckets();
  const bucket = map.get(chatId);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    map.set(chatId, { windowStart: now, count: 1 });
    // Opportunistic cleanup so an app with many short-lived conversations does
    // not accumulate one entry per chat forever.
    if (map.size > 5000) {
      for (const [key, b] of map) {
        if (now - b.windowStart >= WINDOW_MS) map.delete(key);
      }
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  if (bucket.count >= perMinute) {
    const elapsed = now - bucket.windowStart;
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000)) };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}
