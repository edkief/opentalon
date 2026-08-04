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
      // Pinned (not @latest) so the version resolved here always matches
      // the one used to install the browser at build time (see Dockerfile) —
      // @latest can drift and request a browser revision that isn't cached.
      '@playwright/mcp@0.0.78',
      // Playwright MCP defaults to the "chrome" channel (a system Google
      // Chrome install). Pin it to Playwright's own bundled Chromium instead —
      // that's what `npx playwright install chromium` puts in place in the
      // Docker image, and it avoids "Chromium distribution 'chrome' is not
      // found at /opt/google/chrome/chrome" on hosts without Chrome.
      '--browser',
      'chromium',
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
