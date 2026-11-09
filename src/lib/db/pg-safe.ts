/**
 * Makes agent content storable in Postgres (#83).
 *
 * Tool output can carry two things Postgres refuses:
 * - a NUL byte (`\0`), e.g. from reading a binary file or from shell output.
 *   `text` columns reject it ("invalid byte sequence for encoding UTF8: 0x00")
 *   and `jsonb` rejects its `\u0000` escape ("unsupported Unicode escape
 *   sequence") — the 2026-11-08 failure behind #80;
 * - an unpaired UTF-16 surrogate (half an emoji, typically from a `.slice` on
 *   UTF-16 code units): `jsonb` rejects it ("Unicode low surrogate must follow
 *   a high surrogate").
 *
 * Both are replaced with U+FFFD, which keeps a visible marker and the length.
 * Strings without either are returned as-is, so ordinary text (valid emoji and
 * other non-ASCII included) is stored unchanged.
 */

const UNSAFE = /[\0\uD800-\uDFFF]/;

export function pgSafeText(s: string): string {
  // The range above also matches valid surrogate pairs; the replace is a no-op for them.
  if (!UNSAFE.test(s)) return s;
  return s.toWellFormed().replaceAll('\0', '�');
}

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-cleans strings (values and keys) in plain objects and arrays. Other
 * values — numbers, Dates, class instances, typed arrays — pass through. Returns
 * the input itself when nothing needed cleaning.
 */
export function pgSafe<T>(value: T): T {
  if (typeof value === 'string') return pgSafeText(value) as T;
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    value.forEach((item, i) => {
      const cleaned = pgSafe(item);
      if (cleaned !== item) {
        out ??= [...value];
        out[i] = cleaned;
      }
    });
    return (out ?? value) as T;
  }

  if (!isPlainObject(value)) return value;

  let changed = false;
  const entries = Object.entries(value).map(([k, v]) => {
    const ck = pgSafeText(k);
    const cv = pgSafe(v);
    if (ck !== k || cv !== v) changed = true;
    return [ck, cv] as const;
  });
  return (changed ? Object.fromEntries(entries) : value) as T;
}

/** `s.slice(0, max)` that never ends on the first half of a surrogate pair. */
export function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  const last = s.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}
