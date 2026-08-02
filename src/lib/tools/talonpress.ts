import type { ToolSet } from 'ai';
import { getTalonpressTools as _getTalonpressTools, type TalonpressConfig } from '@talonpress/mcp-tools';
import { configManager } from '../config';
import { getWorkspaceDir } from './skills';

export function getTalonpressTools(): ToolSet {
  const cfg = configManager.get().tools?.talonpress;
  if (!cfg?.url) return {};
  return _getTalonpressTools(cfg as TalonpressConfig, getWorkspaceDir());
}

/**
 * Names of registered Talonpress tools, derived from the same ToolSet the
 * runtime uses. The MCP client is lazy inside `@talonpress/mcp-tools`, so
 * enumerating the ToolSet keys does not trigger a network call to the
 * TalonPress server — only the per-tool `execute` does.
 *
 * Returned in the shape the dashboard's tool picker expects
 * ({ name, category }) so they group under a single "talonpress" header
 * alongside built-in groups (terminal, web, memory, …) and per-server MCP
 * groups.
 */
export function listTalonpressTools(): { name: string; category: string }[] {
  const cfg = configManager.get().tools?.talonpress;
  if (!cfg?.url) return [];
  return Object.keys(getTalonpressTools()).map((name) => ({
    name,
    category: 'talonpress',
  }));
}
