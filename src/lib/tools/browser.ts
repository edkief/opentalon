import path from 'node:path';
import { configManager } from '../config';
import { getWorkspaceDir } from './skills';
import type { StdioServerConfig } from './registry';

/**
 * Headless browser tools are provided by the Playwright MCP server
 * (@playwright/mcp) over stdio, rather than a bespoke tool family. This keeps
 * us on a standard, actively maintained tool surface (~25 tools: navigation,
 * snapshots, clicks, forms, tabs, dialogs, network, console) instead of a
 * hand-rolled shell-out wrapper, and gets browser tools the same HITL
 * (tools.dangerousTools), per-tool timeout, and reconnect handling every
 * other MCP server already gets from the registry.
 *
 * `getMcpServers()` in ./registry prepends this config (when enabled) to the
 * configured `tools.mcpServers` list, so it participates in normal
 * init/reload/shutdown. `prefix: ''` keeps Playwright's native `browser_*`
 * tool names instead of doubling up to `browser_browser_*`.
 */
export function getBrowserServerConfig(): StdioServerConfig | null {
  const b = configManager.get().tools?.browser;
  if (!b?.enabled) return null;

  return {
    name: 'browser',
    prefix: '',
    command: b.command ?? 'npx',
    args: b.args ?? [
      '-y',
      '@playwright/mcp@latest',
      '--headless',
      '--isolated',
      '--output-dir',
      path.join(getWorkspaceDir(), 'browser'),
    ],
    env: b.env,
    tools: b.tools,
    timeout: b.timeout,
    toolTimeouts: b.toolTimeouts,
  };
}
