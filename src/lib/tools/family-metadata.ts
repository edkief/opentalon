import type { ToolSet } from 'ai';
import type { ToolFamily } from './types';

export type ToolFamilySource = 'built-in' | 'mcp' | 'channel' | 'dynamic';

export interface ToolFamilyMetadata {
  id: string;
  description: string;
  source: ToolFamilySource;
}

export const BUILT_IN_TOOL_FAMILY_DESCRIPTIONS: Record<ToolFamily, string> = {
  terminal: 'Run shell commands and manage processes.',
  'code-search': 'Search and inspect source code.',
  notebook: 'Create and run computational notebooks.',
  lsp: 'Use language-server code intelligence and diagnostics.',
  skills: 'Discover and manage reusable agent skills.',
  web: 'Search the web and fetch online content.',
  memory: 'Recall, read, and maintain persistent memory and history.',
  workflows: 'Discover and run saved workflows.',
  todos: 'Create and maintain task lists.',
  agents: 'List, spawn, and resume specialist agents.',
  communication: 'Send messages and files through the active channel.',
  files: 'Read, write, and edit workspace files.',
  talonpress: 'Publish and manage TalonPress sites.',
  scheduling: 'Create and manage scheduled tasks.',
};

const metadataByTool = new WeakMap<object, ToolFamilyMetadata>();

const DYNAMIC_TOOL_FAMILIES: Record<string, ToolFamilyMetadata> = {
  send_file: {
    id: 'communication',
    description: BUILT_IN_TOOL_FAMILY_DESCRIPTIONS.communication,
    source: 'channel',
  },
  spawn_specialist: {
    id: 'agents',
    description: BUILT_IN_TOOL_FAMILY_DESCRIPTIONS.agents,
    source: 'dynamic',
  },
  await_specialists: {
    id: 'agents',
    description: BUILT_IN_TOOL_FAMILY_DESCRIPTIONS.agents,
    source: 'dynamic',
  },
};

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** Attach discovery-only metadata without changing the AI SDK tool schema. */
export function setToolFamily(toolDef: unknown, metadata: ToolFamilyMetadata): void {
  if (isObject(toolDef)) metadataByTool.set(toolDef, metadata);
}

export function setToolSetFamily(
  tools: ToolSet,
  family: ToolFamily,
): ToolSet {
  const metadata: ToolFamilyMetadata = {
    id: family,
    description: BUILT_IN_TOOL_FAMILY_DESCRIPTIONS[family],
    source: 'built-in',
  };
  for (const toolDef of Object.values(tools)) setToolFamily(toolDef, metadata);
  return tools;
}

/**
 * Resolve family metadata after tool sets have been merged and filtered. Tool
 * objects retain WeakMap metadata by identity; the small fallback table covers
 * request-local tools created outside the central registries.
 */
export function getToolFamily(name: string, toolDef: unknown): ToolFamilyMetadata {
  if (isObject(toolDef)) {
    const metadata = metadataByTool.get(toolDef);
    if (metadata) return metadata;
  }
  return DYNAMIC_TOOL_FAMILIES[name] ?? {
    id: 'other',
    description: 'Other tools available for this request.',
    source: 'dynamic',
  };
}

export function mcpToolFamily(server: string): ToolFamilyMetadata {
  const id = server.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'mcp';
  return {
    id,
    description: id === 'browser'
      ? 'Navigate and interact with rendered web pages.'
      : `Use tools provided by the ${server || 'configured'} MCP server.`,
    source: 'mcp',
  };
}
