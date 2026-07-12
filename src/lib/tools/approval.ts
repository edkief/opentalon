import { waitForApproval } from '../agent/hitl';
import type { ApprovalOutcome } from '../agent/hitl';
import type { ApprovalCallback } from './types';

export type { ApprovalOutcome };

export async function requestAndWait(
  toolName: string,
  input: unknown,
  send?: ApprovalCallback,
): Promise<ApprovalOutcome> {
  if (!send) return 'approved'; // no HITL configured — allow
  const approvalId = crypto.randomUUID();
  await send(approvalId, toolName, input);
  return waitForApproval(approvalId);
}
