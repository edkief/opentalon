import type { ToolSet } from 'ai';
import { getTalonpressTools as _getTalonpressTools, type TalonpressConfig } from '@talonpress/mcp-tools';
import { configManager } from '../config';
import { getWorkspaceDir } from './skills';

export function getTalonpressTools(): ToolSet {
  const cfg = configManager.get().tools?.talonpress;
  if (!cfg?.url) return {};
  return _getTalonpressTools(cfg as TalonpressConfig, getWorkspaceDir());
}
