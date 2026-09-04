/**
 * Email threading — pure functions (no DB, no IO).
 *
 * A conversation = one email thread. We derive a stable `chatId` of the form
 * `email:<16-hex>` from the RFC 5322 Message-Id / References / In-Reply-To
 * chain, so replies land in the same conversation. New subject (no header
 * links) = new conversation.
 *
 * The DB-backed resolution (reusing a chatId when any referenced Message-Id is
 * already known, subject fallback) lives in `src/lib/db/email.ts`; this module
 * holds only the deterministic string logic those callers compose.
 */

import { createHash } from 'node:crypto';

/** Strip surrounding angle brackets and whitespace from a Message-Id. */
export function normalizeMessageId(id: string | null | undefined): string {
  if (!id) return '';
  return id.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
}

/** Normalize a list of Message-Ids, dropping empties and de-duplicating (order preserved). */
export function normalizeIds(ids: Array<string | null | undefined> | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids ?? []) {
    const n = normalizeMessageId(raw);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Candidate referenced ids for DB lookup, oldest-first-ish:
 * `[In-Reply-To, ...References]`, normalized and de-duplicated. Any of these
 * being known in email_messages means this mail joins that thread.
 */
export function referencedIds(
  inReplyTo: string | null | undefined,
  references: Array<string | null | undefined> | null | undefined,
): string[] {
  return normalizeIds([inReplyTo, ...(references ?? [])]);
}

/**
 * The thread root id for header-based threading. RFC 5322 orders References
 * oldest-first, so the first References entry is the thread root; fall back to
 * In-Reply-To, then the message's own id.
 */
export function rootMessageId(
  ownMessageId: string,
  inReplyTo: string | null | undefined,
  references: Array<string | null | undefined> | null | undefined,
): string {
  const refs = normalizeIds(references);
  if (refs.length > 0) return refs[0];
  const irt = normalizeMessageId(inReplyTo);
  if (irt) return irt;
  return normalizeMessageId(ownMessageId);
}

/** Derive the `email:<16-hex>` thread id from a (normalized) seed id. */
export function threadIdFromSeed(seedId: string): string {
  const hash = createHash('sha256').update(normalizeMessageId(seedId)).digest('hex').slice(0, 16);
  return `email:${hash}`;
}

const SUBJECT_PREFIX_RE = /^\s*((re|fwd?|aw|wg|sv|rif|res|ref)\s*(\[\d+\])?\s*:\s*)+/i;

/**
 * Normalize a subject for subject-fallback threading: strip leading reply/
 * forward prefixes (Re:, Fwd:, Fw:, and common localized variants), lowercase,
 * and collapse whitespace.
 */
export function normalizeSubject(subject: string | null | undefined): string {
  if (!subject) return '';
  let s = subject;
  // Strip potentially-stacked prefixes (Re: Fwd: ...).
  let prev: string;
  do {
    prev = s;
    s = s.replace(SUBJECT_PREFIX_RE, '');
  } while (s !== prev);
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Whether a subject carries a reply/forward prefix (i.e. is not a brand-new subject). */
export function subjectIsReply(subject: string | null | undefined): boolean {
  return !!subject && SUBJECT_PREFIX_RE.test(subject);
}

/** Build the `Re: <subject>` reply subject without stacking `Re: Re:`. */
export function buildReplySubject(subject: string | null | undefined): string {
  const base = (subject ?? '').trim();
  if (!base) return 'Re:';
  if (subjectIsReply(base)) {
    // Already has a reply prefix — normalize to a single leading "Re: ".
    const stripped = base.replace(SUBJECT_PREFIX_RE, '').trim();
    return `Re: ${stripped}`;
  }
  return `Re: ${base}`;
}

/**
 * Cap a References chain to keep headers bounded while preserving threading:
 * keep the first (thread root) plus the last N-1 entries.
 */
export function capReferences(refs: string[], max = 30): string[] {
  if (refs.length <= max) return refs;
  return [refs[0], ...refs.slice(refs.length - (max - 1))];
}

/**
 * @deprecated Renamed to `threadIdFromSeed` (#44). The derived id is a thread
 * identity that also serves as the email chatId; splitting those is out of
 * scope for the epic. Removed in #48 (T7).
 */
export const chatIdFromSeed = threadIdFromSeed;
