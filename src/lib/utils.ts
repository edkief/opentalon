import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Presentation label for a conversation message's author. `user` and `system`
 * keep their role word; the AI side shows the agent's name (its id, which is the
 * human-readable name). Falls back to the default agent, then a generic "agent"
 * for legacy rows without an agentId. The underlying `role` value stays
 * `'assistant'` in state/API/DB — this is display-only.
 */
export function messageRoleLabel(
  role: string,
  agentId?: string | null,
  defaultAgentId?: string,
): string {
  if (role === 'user' || role === 'system') return role;
  return agentId || defaultAgentId || 'agent';
}
