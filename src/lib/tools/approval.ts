import { waitForApproval } from '../agent/hitl';
import type { ApprovalCallback } from './types';

export async function requestAndWait(
  toolName: string,
  input: unknown,
  send?: ApprovalCallback,
): Promise<boolean> {
  if (!send) return true; // no HITL configured — allow
  const approvalId = crypto.randomUUID();
  await send(approvalId, toolName, input);
  return waitForApproval(approvalId);
}
