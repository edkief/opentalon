/**
 * Email address helpers (pure).
 *
 * Normalization is for COMPARISON ONLY (whitelist / self-loop / privacy checks).
 * We never rewrite the addresses we actually send to — `+tag` suffixes and
 * display names are preserved on the wire.
 */

import type { AddressObject } from 'mailparser';

/**
 * Normalize an address for comparison: lowercase + trim. When `stripPlus` is
 * true, drop the `+tag` sub-address portion of the local part
 * (`user+foo@x.com` → `user@x.com`).
 */
export function normalizeAddress(addr: string | null | undefined, stripPlus = true): string {
  if (!addr) return '';
  let a = addr.trim().toLowerCase();
  // In case a raw "Name <addr>" slipped through, keep only the angle-bracket part.
  const angle = a.match(/<([^>]+)>/);
  if (angle) a = angle[1].trim();
  if (stripPlus) {
    const at = a.indexOf('@');
    if (at > 0) {
      const local = a.slice(0, at);
      const domain = a.slice(at);
      const plus = local.indexOf('+');
      if (plus >= 0) a = local.slice(0, plus) + domain;
    }
  }
  return a;
}

/** Flatten a mailparser AddressObject (or array of them) into raw address strings. */
export function extractAddresses(
  field: AddressObject | AddressObject[] | undefined,
): string[] {
  if (!field) return [];
  const objs = Array.isArray(field) ? field : [field];
  const out: string[] = [];
  for (const obj of objs) {
    for (const a of obj.value ?? []) {
      if (a.address) out.push(a.address);
    }
  }
  return out;
}

/** Normalize a list of addresses for comparison, dropping empties + duplicates. */
export function normalizeAddresses(addrs: string[], stripPlus = true): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    const n = normalizeAddress(a, stripPlus);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** Whether `addr` is present in `set` (all compared normalized). */
export function addressInSet(addr: string, set: Set<string>, stripPlus = true): boolean {
  return set.has(normalizeAddress(addr, stripPlus));
}

/** Build a normalized comparison Set from a whitelist plus the agent's own address. */
export function buildAllowedSet(
  whitelist: string[] | undefined,
  ownAddresses: Array<string | undefined>,
  stripPlus = true,
): Set<string> {
  const set = new Set<string>();
  for (const a of whitelist ?? []) {
    const n = normalizeAddress(a, stripPlus);
    if (n) set.add(n);
  }
  for (const a of ownAddresses) {
    const n = normalizeAddress(a, stripPlus);
    if (n) set.add(n);
  }
  return set;
}

/** Whether every participant is in the allowed set (used for privacy=private + memory scope). */
export function allParticipantsAllowed(
  participants: string[],
  allowed: Set<string>,
  stripPlus = true,
): boolean {
  return participants.every((p) => addressInSet(p, allowed, stripPlus));
}
