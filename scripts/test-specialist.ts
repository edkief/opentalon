/**
 * Regression checks for the strict-stateless-specialist invariants. Runs
 * without LLM calls — just asserts the tool set behaves the way every
 * supervisor caller now relies on.
 *
 * Run with:  pnpm tsx scripts/test-specialist.ts
 *
 * NOTE: We deliberately do NOT import createSpecialistTools / spawnSpecialist
 * because they transitively load the agent registry, DB, MCP, and the rest of
 * the runtime. Instead we read the actual denylist constants from the source
 * file at runtime and re-implement scopeToolsByNames in this script for
 * isolated behavior checks. If the source drifts, the cross-check fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolSet } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SPECIALIST_SRC = fs.readFileSync(
  path.join(ROOT, 'src/lib/agent/specialist.ts'),
  'utf-8',
);

function readArrayLiteral(name: string): string[] {
  // Reads a `export const NAME = [ ... ] as const;` or `export const NAME = [ ... ];`
  // literal from the source. Stops at the first matching '];'.
  const re = new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\];`);
  const match = SPECIALIST_SRC.match(re);
  if (!match) throw new Error(`Could not find exported array '${name}' in specialist.ts`);
  const inner = match[1] ?? '';
  const out: string[] = [];
  for (const m of inner.matchAll(/'([^']+)'/g)) {
    const captured = m[1];
    if (typeof captured === 'string') out.push(captured);
  }
  return out;
}

const SPECIALIST_CORE_TOOLS = readArrayLiteral('SPECIALIST_CORE_TOOLS');
const SPECIALIST_DENIED_TOOLS = readArrayLiteral('SPECIALIST_DENIED_TOOLS');

// Re-implementation of scopeToolsByNames — must stay behaviorally identical to
// the source. The runtime source-extraction above is the drift guard.
function scopeToolsByNames(all: ToolSet, requested: string[] | undefined): ToolSet {
  const denied = new Set(SPECIALIST_DENIED_TOOLS);
  if (!requested || requested.length === 0) {
    const coreOnly = Object.fromEntries(
      Object.entries(all).filter(([k]) => SPECIALIST_CORE_TOOLS.includes(k) && !denied.has(k)),
    );
    return Object.keys(coreOnly).length > 0 ? coreOnly : all;
  }
  const keep = new Set([...requested, ...SPECIALIST_CORE_TOOLS]);
  const scoped = Object.fromEntries(
    Object.entries(all).filter(([k]) => keep.has(k) && !denied.has(k)),
  );
  return Object.keys(scoped).length > 0 ? scoped : all;
}

let failed = 0;
const ok = (label: string, cond: boolean) => {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${label}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── 0. Source-file sanity (so a silent rename can't pass) ─────────────────
console.log('\n[0] Specialist source still exports the expected denylists');
ok('SPECIALIST_CORE_TOOLS is a non-empty string[]', SPECIALIST_CORE_TOOLS.length > 0);
ok('SPECIALIST_DENIED_TOOLS is a non-empty string[]', SPECIALIST_DENIED_TOOLS.length > 0);
ok(
  'denylist includes all four memory_* tools',
  ['memory_recall', 'memory_read', 'memory_append', 'memory_delete'].every((t) =>
    SPECIALIST_DENIED_TOOLS.includes(t),
  ),
);

// ── 1. scopeToolsByNames strips denylist in every branch ───────────────────
console.log('\n[1] scopeToolsByNames strips SPECIALIST_DENIED_TOOLS');

// Synthetic "built-in" tool set: memory, history, files, terminal, web, todo.
const stubBuiltins: ToolSet = {
  memory_recall: tool({ description: 'memory_recall', inputSchema: z.object({ q: z.string() }) }),
  memory_read: tool({ description: 'memory_read', inputSchema: z.object({}) }),
  memory_append: tool({ description: 'memory_append', inputSchema: z.object({ c: z.string() }) }),
  memory_delete: tool({ description: 'memory_delete', inputSchema: z.object({}) }),
  history_gist: tool({ description: 'history_gist', inputSchema: z.object({}) }),
  history_search: tool({ description: 'history_search', inputSchema: z.object({ q: z.string() }) }),
  history_delete: tool({ description: 'history_delete', inputSchema: z.object({ id: z.string() }) }),
  read_file: tool({ description: 'read_file', inputSchema: z.object({ p: z.string() }) }),
  write_file: tool({ description: 'write_file', inputSchema: z.object({ p: z.string(), c: z.string() }) }),
  str_replace_based_edit: tool({ description: 'str_replace', inputSchema: z.object({ p: z.string() }) }),
  run_command: tool({ description: 'run_command', inputSchema: z.object({ c: z.string() }) }),
  web_search: tool({ description: 'web_search', inputSchema: z.object({ q: z.string() }) }),
  todo_create: tool({ description: 'todo_create', inputSchema: z.object({}) }),
};

// Branch A: caller passed an explicit tool subset.
const explicitSubset = scopeToolsByNames(stubBuiltins, ['web_search']);
ok('explicit subset keeps web_search', !!explicitSubset.web_search);
ok('explicit subset keeps SPECIALIST_CORE_TOOLS', SPECIALIST_CORE_TOOLS.every((t) => !!explicitSubset[t]));
ok(
  'explicit subset strips every SPECIALIST_DENIED_TOOLS entry',
  SPECIALIST_DENIED_TOOLS.every((t) => !(t in explicitSubset)),
);
ok('explicit subset strips unrelated todo tools', !('todo_create' in explicitSubset));

// Branch B: caller omitted the subset → must fall back to core-only with denied stripped.
const noSubset = scopeToolsByNames(stubBuiltins, undefined);
ok('no-subset branch keeps SPECIALIST_CORE_TOOLS only', SPECIALIST_CORE_TOOLS.every((t) => !!noSubset[t]));
ok('no-subset branch strips memory_recall', !('memory_recall' in noSubset));
ok('no-subset branch strips memory_append', !('memory_append' in noSubset));
ok('no-subset branch strips memory_delete', !('memory_delete' in noSubset));
ok('no-subset branch strips history_gist', !('history_gist' in noSubset));
ok('no-subset branch strips history_search', !('history_search' in noSubset));
ok('no-subset branch strips history_delete', !('history_delete' in noSubset));
ok('no-subset branch strips web_search (not in core)', !('web_search' in noSubset));
ok('no-subset branch strips todo tools', !('todo_create' in noSubset));

// Branch C: explicit subset with only memory tools → should fall back to core-only.
const memoryOnlySubset = scopeToolsByNames(stubBuiltins, ['memory_recall']);
ok('memory-only subset falls back to core tools', SPECIALIST_CORE_TOOLS.every((t) => !!memoryOnlySubset[t]));
ok('memory-only fallback still strips memory_recall', !('memory_recall' in memoryOnlySubset));

// Branch D: empty-array subset behaves like the undefined branch.
const emptySubset = scopeToolsByNames(stubBuiltins, []);
ok('empty-array subset behaves like undefined branch', SPECIALIST_CORE_TOOLS.every((t) => !!emptySubset[t]));
ok('empty-array subset strips memory_recall', !('memory_recall' in emptySubset));

// ── 2. Source still describes specialists as stateless with explicit handoff ─
console.log('\n[2] spawn_specialist description prompts for memory handoff');
ok(
  'description (spawn_specialist) advertises stateless + context_snapshot handoff',
  /stateless/i.test(SPECIALIST_SRC) &&
    /context_snapshot/i.test(SPECIALIST_SRC) &&
    /memory_recall/i.test(SPECIALIST_SRC) &&
    /memory_read/i.test(SPECIALIST_SRC),
);

// ── 3. Specialist prompt no longer injects Core Memory by default ──────────
console.log('\n[3] executeSpecialist no longer injects Core Memory');
const coreBlockInPrompt = /## Core Memory\s*\(operational context\)/.test(SPECIALIST_SRC);
ok('executeSpecialist prompt no longer has the Core Memory block', !coreBlockInPrompt);
ok(
  'executeSpecialist prompt says specialist has NO Core Memory / RAG access',
  /NO access to Core Memory|NO access to Core Memory or RAG/i.test(SPECIALIST_SRC),
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll specialist invariants hold.');