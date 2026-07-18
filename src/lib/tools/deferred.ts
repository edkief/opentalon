import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';

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
  'rag_search',
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

/**
 * Build the search_tools / load_tools meta-tools over the full tool set. Both
 * close over `activeSet`, which the executor reads each step to decide which
 * schemas to expose: load_tools mutates it so newly-loaded tools appear on the
 * next step.
 */
export function createDeferredToolControls(allTools: ToolSet, activeSet: Set<string>): ToolSet {
  const isDeferrable = (name: string) => !DEFERRED_META_TOOLS.includes(name);

  const search_tools = tool({
    description:
      'Search the full tool catalog for tools that are not currently loaded. ' +
      'Most tools are deferred to keep each request small; use this to find the ones you need, ' +
      'then call load_tools with their names to enable them. Returns matching tool names and short descriptions.',
    inputSchema: z.object({
      query: z.string().describe('What you want to do (keywords), e.g. "take a screenshot of a web page"'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
    }),
    execute: async (input: { query: string; limit?: number }) => {
      const limit = input.limit ?? 10;
      const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      const candidates = Object.entries(allTools)
        .filter(([name]) => isDeferrable(name) && !activeSet.has(name))
        .map(([name, def]) => {
          const desc = description(def);
          return { name, desc, score: scoreTool(name, desc, terms) };
        });

      const matched = candidates
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      // No keyword hits — fall back to listing available (not-yet-loaded) tool
      // names so the model still sees what exists rather than a dead end.
      if (matched.length === 0) {
        const names = candidates.map((c) => c.name);
        if (names.length === 0) return 'All available tools are already loaded.';
        return `No strong matches for "${input.query}". Not-yet-loaded tools:\n${names.map((n) => `- ${n}`).join('\n')}\n\nCall load_tools with the name(s) you need.`;
      }

      return (
        `Found ${matched.length} tool(s). Call load_tools with the names you need:\n` +
        matched.map((c) => `- ${c.name}: ${shortDescription(c.desc)}`).join('\n')
      );
    },
  });

  const load_tools = tool({
    description:
      'Enable one or more deferred tools by exact name so their full schemas become available on the next step, ' +
      'after which you can call them normally. Find names with search_tools first.',
    inputSchema: z.object({
      names: z.array(z.string()).min(1).describe('Exact tool names to load, e.g. ["browser_navigate","browser_snapshot"]'),
    }),
    execute: async (input: { names: string[] }) => {
      const loaded: string[] = [];
      const already: string[] = [];
      const unknown: string[] = [];
      for (const name of input.names) {
        if (!(name in allTools) || !isDeferrable(name)) {
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
    },
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
