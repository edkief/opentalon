import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { getToolFamily, type ToolFamilySource } from './family-metadata';

/**
 * Deferred / on-demand tool loading (#19 part 2).
 *
 * Instead of shipping every tool's JSON schema on every request, the model is
 * given a small always-active core plus two meta-tools — `search_tools` and
 * `load_tools`. The remaining tools are "deferred": their execute functions
 * exist, but their schemas are withheld (via the executor's per-step
 * `activeTools` gate) until the model explicitly loads them. This keeps the
 * serialized tools array small without losing capability breadth — the same
 * pattern Claude Code uses for its own deferred tools.
 *
 * Opt-in (config `tools.deferredTools`); off by default.
 */

/** The two meta-tools; always active so the model can discover/load the rest. */
export const DEFERRED_META_TOOLS = ['search_tools', 'load_tools'];

/**
 * Core tools kept active from the start so an agent can read/write files, run
 * commands, and manage memory/todos without first loading anything. Everything
 * else is discovered via search_tools and enabled via load_tools.
 */
export const DEFERRED_ALWAYS_ACTIVE = [
  'read_file',
  'write_file',
  'str_replace_based_edit',
  'run_command',
  'memory_read',
  'memory_append',
  'memory_recall',
  'todo_create',
  'todo_add',
  'todo_update',
  'todo_clear',
];

function description(def: unknown): string {
  const d = (def ?? {}) as { description?: unknown };
  return typeof d.description === 'string' ? d.description : '';
}

/** First sentence / first ~140 chars of a description, for compact catalog listings. */
function shortDescription(desc: string): string {
  const firstSentence = desc.split(/(?<=\.)\s/)[0] ?? desc;
  const s = firstSentence.length > 140 ? `${firstSentence.slice(0, 137)}…` : firstSentence;
  return s.trim();
}

/**
 * Score a tool against query terms: a term in the name is worth more than a
 * term in the description. Returns 0 when nothing matches.
 */
function scoreTool(name: string, desc: string, terms: string[]): number {
  const lname = name.toLowerCase();
  const ldesc = desc.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (!t) continue;
    if (lname.includes(t)) score += 3;
    if (ldesc.includes(t)) score += 1;
  }
  return score;
}

interface DeferredToolEntry {
  name: string;
  desc: string;
  family: string;
  familyDescription: string;
  source: ToolFamilySource;
}

function deferredToolEntries(allTools: ToolSet, activeSet: Set<string>): DeferredToolEntry[] {
  return Object.entries(allTools)
    .filter(([name]) => !DEFERRED_META_TOOLS.includes(name) && !activeSet.has(name))
    .map(([name, def]) => {
      const family = getToolFamily(name, def);
      return {
        name,
        desc: description(def),
        family: family.id,
        familyDescription: family.description,
        source: family.source,
      };
    });
}

/** Compact capability map injected into the prompt while deferred mode is on. */
export function formatDeferredToolFamilyDirectory(
  allTools: ToolSet,
  activeSet: Set<string>,
): string {
  const families = new Map<string, {
    description: string;
    sources: Set<ToolFamilySource>;
    count: number;
  }>();

  for (const entry of deferredToolEntries(allTools, activeSet)) {
    const current = families.get(entry.family) ?? {
      description: entry.familyDescription,
      sources: new Set<ToolFamilySource>(),
      count: 0,
    };
    current.sources.add(entry.source);
    current.count += 1;
    families.set(entry.family, current);
  }

  if (families.size === 0) return '';
  const lines = [...families.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, family]) => {
      const sources = [...family.sources].sort().join(', ');
      const noun = family.count === 1 ? 'tool' : 'tools';
      return `- ${id} [${sources}] (${family.count} ${noun}): ${family.description}`;
    });

  return [
    '## Deferred Tool Families',
    'These additional capability families are available through deferred loading:',
    ...lines,
    'Use search_tools to list/search a family, then load_tools with the exact tool names you need.',
  ].join('\n');
}

export interface DeferredToolSearchInput {
  query?: string;
  family?: string;
  limit?: number;
}

/** Search/list helper exported separately so discovery behavior is unit-testable. */
export function searchDeferredTools(
  allTools: ToolSet,
  activeSet: Set<string>,
  input: DeferredToolSearchInput,
): string {
  const limit = input.limit ?? 10;
  const query = input.query?.trim() ?? '';
  const requestedFamily = input.family?.trim().toLowerCase() ?? '';
  const allCandidates = deferredToolEntries(allTools, activeSet);

  if (allCandidates.length === 0) return 'All available tools are already loaded.';

  if (!query && !requestedFamily) {
    return formatDeferredToolFamilyDirectory(allTools, activeSet) || 'All available tools are already loaded.';
  }

  const availableFamilies = [...new Set(allCandidates.map((c) => c.family))].sort();
  const candidates = requestedFamily
    ? allCandidates.filter((c) => c.family.toLowerCase() === requestedFamily)
    : allCandidates;

  if (requestedFamily && candidates.length === 0) {
    const suffix = availableFamilies.length
      ? ` Available deferred families: ${availableFamilies.join(', ')}.`
      : ' All available tools are already loaded.';
    return `No not-yet-loaded tools found in family "${input.family}".${suffix}`;
  }

  if (!query) {
    const listed = candidates.slice(0, limit);
    return (
      `Deferred tools in family "${requestedFamily}" (${listed.length}/${candidates.length} shown):\n` +
      listed.map((c) => `- ${c.name}: ${shortDescription(c.desc)}`).join('\n') +
      '\n\nCall load_tools with the exact name(s) you need.'
    );
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreTool(
        candidate.name,
        `${candidate.desc} ${candidate.family} ${candidate.familyDescription}`,
        terms,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);

  if (matched.length === 0) {
    const scope = requestedFamily ? ` in family "${requestedFamily}"` : '';
    const names = candidates.map((candidate) => candidate.name);
    return `No strong matches for "${query}"${scope}. Not-yet-loaded tools${scope}:\n${names.map((name) => `- ${name}`).join('\n')}\n\nCall load_tools with the exact name(s) you need.`;
  }

  const scope = requestedFamily ? ` in family "${requestedFamily}"` : '';
  return (
    `Found ${matched.length} tool(s)${scope}. Call load_tools with the exact names you need:\n` +
    matched.map((candidate) => `- ${candidate.name}: ${shortDescription(candidate.desc)}`).join('\n')
  );
}

export function loadDeferredTools(
  allTools: ToolSet,
  activeSet: Set<string>,
  names: string[],
): string {
  const loaded: string[] = [];
  const already: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    if (!(name in allTools) || DEFERRED_META_TOOLS.includes(name)) {
      unknown.push(name);
    } else if (activeSet.has(name)) {
      already.push(name);
    } else {
      activeSet.add(name);
      loaded.push(name);
    }
  }
  const parts: string[] = [];
  if (loaded.length) parts.push(`Loaded: ${loaded.join(', ')} — available now.`);
  if (already.length) parts.push(`Already loaded: ${already.join(', ')}.`);
  if (unknown.length) parts.push(`Unknown (ignored): ${unknown.join(', ')}. Use search_tools to find valid names.`);
  return parts.join(' ') || 'No tools loaded.';
}

/**
 * Build the search_tools / load_tools meta-tools over the full tool set. Both
 * close over `activeSet`, which the executor reads each step to decide which
 * schemas to expose: load_tools mutates it so newly-loaded tools appear on the
 * next step.
 */
export function createDeferredToolControls(allTools: ToolSet, activeSet: Set<string>): ToolSet {
  const search_tools = tool({
    description:
      'Discover tools whose schemas are not currently loaded. Omit both inputs to list available families; ' +
      'provide family only to enumerate that family; provide query to search globally or within a family. ' +
      'Then call load_tools with exact tool names.',
    inputSchema: z.object({
      query: z.string().optional().describe('What you want to do (keywords), e.g. "take a screenshot of a web page"'),
      family: z.string().optional().describe('Optional exact family id from the deferred family directory, e.g. "browser"'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
    }),
    execute: async (input: DeferredToolSearchInput) => searchDeferredTools(allTools, activeSet, input),
  });

  const load_tools = tool({
    description:
      'Enable one or more deferred tools by exact name so their full schemas become available on the next step, ' +
      'after which you can call them normally. Find names with search_tools first.',
    inputSchema: z.object({
      names: z.array(z.string()).min(1).describe('Exact tool names to load, e.g. ["browser_navigate","browser_snapshot"]'),
    }),
    execute: async (input: { names: string[] }) => loadDeferredTools(allTools, activeSet, input.names),
  });

  return { search_tools, load_tools };
}

/**
 * Compute the initial active-tool set for deferred mode: the always-active core
 * (whichever of those tools are actually present) plus the two meta-tools.
 */
export function initialActiveTools(allTools: ToolSet): Set<string> {
  const active = new Set<string>(DEFERRED_META_TOOLS);
  for (const name of DEFERRED_ALWAYS_ACTIVE) {
    if (name in allTools) active.add(name);
  }
  return active;
}
