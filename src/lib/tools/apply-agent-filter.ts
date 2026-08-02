import type { ToolSet } from 'ai';

/**
 * Apply an agent's per-agent tool allowlist to a merged ToolSet of built-in +
 * MCP tools.
 *
 * - When `agentFilter` is undefined or empty, the merged set is returned
 *   unchanged (the agent has no restriction and gets every tool).
 * - When `agentFilter` is a non-empty list of tool names, only matching tools
 *   are kept. Matching is exact by the tool's registered name (so MCP tools
 *   are matched by their server-prefixed name, e.g. `talonpress_publish_package`).
 *
 * This is the single source of truth for the per-agent tool filter; the
 * Telegram, email, and web-chat paths all call it so they cannot drift.
 */
export function applyAgentToolFilter(
  merged: ToolSet,
  agentFilter: string[] | undefined,
): ToolSet {
  if (!agentFilter || agentFilter.length === 0) return merged;
  const keep = new Set(agentFilter);
  return Object.fromEntries(Object.entries(merged).filter(([k]) => keep.has(k)));
}
