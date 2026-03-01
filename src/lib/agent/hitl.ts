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

/**
 * Registers an approval gate and returns a Promise that resolves to
 * `true` (approved) or `false` (denied / timed out).
 */
export function waitForApproval(id: string, ttlMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(false); // auto-deny on timeout
    }, ttlMs);

    pending.set(id, { resolve, timer });
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
