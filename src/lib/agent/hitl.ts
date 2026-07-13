import { configManager } from '../config';

/**
 * In-memory HITL (Human-in-the-Loop) approval gate.
 *
 * When a dangerous tool needs user confirmation, call waitForApproval()
 * before executing. Send a Telegram inline keyboard keyed by approvalId.
 * The bot's callbackQuery handler calls resolveApproval() to unblock.
 *
 * Note: state is process-local. Approvals are lost on server restart,
 * which is acceptable since Telegram webhook round-trips are short-lived.
 */

interface PendingEntry {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

/** Default approval TTL — 30s was short for a human to see and tap a
 *  Telegram button; 120s gives realistic response time while still failing
 *  safe (auto-deny) if nobody's there. Configurable via tools.approvalTimeoutMs. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

export function getApprovalTimeoutMs(): number {
  return configManager.get().tools?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
}

export type ApprovalOutcome = 'approved' | 'denied' | 'timeout';

/**
 * Registers an approval gate and returns a Promise that resolves to whether
 * the request was approved, explicitly denied, or timed out with no
 * response. Distinguishing timeout from an explicit denial lets the model
 * offer to retry instead of concluding the user refused.
 */
export function waitForApproval(id: string, ttlMs = getApprovalTimeoutMs()): Promise<ApprovalOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve('timeout'); // auto-deny on timeout, but distinguishably
    }, ttlMs);

    pending.set(id, { resolve: (approved) => resolve(approved ? 'approved' : 'denied'), timer });
  });
}

/**
 * Called by the Telegram callbackQuery handler when the user clicks
 * Approve or Deny. Returns false if the approvalId is unknown or expired.
 */
export function resolveApproval(id: string, approved: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(approved);
  return true;
}

export function hasPendingApproval(id: string): boolean {
  return pending.has(id);
}
