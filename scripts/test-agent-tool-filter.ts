/**
 * Regression checks for the per-agent tool allowlist, including the MCP
 * allowlist symmetry across channels (#34). Runs without LLM calls — just
 * asserts the filter behaves the way every channel caller now relies on.
 *
 * Run with:  pnpm tsx scripts/test-agent-tool-filter.ts
 *
 * Drift guards read source files directly so a silent rename, a copy-paste
 * drift between the three channels, or a reintroduced bug pattern fails
 * the test instead of silently regressing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolSet } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';
import { applyAgentToolFilter } from '../src/lib/tools/apply-agent-filter';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const TELEGRAM_TOOLS_SRC = fs.readFileSync(
  path.join(ROOT, 'src/lib/telegram/tools.ts'),
  'utf-8',
);
const EMAIL_TOOLS_SRC = fs.readFileSync(
  path.join(ROOT, 'src/lib/email/tools.ts'),
  'utf-8',
);
const CHAT_ROUTE_SRC = fs.readFileSync(
  path.join(ROOT, 'src/app/api/chat/route.ts'),
  'utf-8',
);
const TOOLS_API_SRC = fs.readFileSync(
  path.join(ROOT, 'src/app/api/tools/route.ts'),
  'utf-8',
);

let failed = 0;
const ok = (label: string, cond: boolean) => {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${label}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── 0. Source-file drift guards (so a silent rename can't pass) ───────────
console.log('\n[0] Source structure');

// The shared helper is the only thing the three channels should call.
ok('telegram/tools.ts imports applyAgentToolFilter', /from\s+['"][^'"]*apply-agent-filter['"]/.test(TELEGRAM_TOOLS_SRC));
ok('email/tools.ts imports applyAgentToolFilter', /from\s+['"][^'"]*apply-agent-filter['"]/.test(EMAIL_TOOLS_SRC));
ok('chat/route.ts imports applyAgentToolFilter', /from\s+['"][^'"]*apply-agent-filter['"]/.test(CHAT_ROUTE_SRC));

// The relic bug pattern is gone — `|| mcpToolNames.has(k)` would defeat the
// per-agent filter for every MCP tool on the email and web-chat channels.
ok('telegram/tools.ts does not have the bypass clause', !/mcpToolNames\.has\(k\)/.test(TELEGRAM_TOOLS_SRC));
ok('email/tools.ts does not have the bypass clause', !/mcpToolNames\.has\(k\)/.test(EMAIL_TOOLS_SRC));
ok('chat/route.ts does not have the bypass clause', !/mcpToolNames\.has\(k\)/.test(CHAT_ROUTE_SRC));

// Each channel call site actually calls the helper.
ok('telegram/tools.ts calls applyAgentToolFilter', /applyAgentToolFilter\(/.test(TELEGRAM_TOOLS_SRC));
ok('email/tools.ts calls applyAgentToolFilter', /applyAgentToolFilter\(/.test(EMAIL_TOOLS_SRC));
ok('chat/route.ts calls applyAgentToolFilter', /applyAgentToolFilter\(/.test(CHAT_ROUTE_SRC));

// /api/tools must initialize the registry so MCP tools appear on the first
// dashboard load, not only after the first chat triggers init as a side effect.
ok(
  '/api/tools awaits mcpRegistry.initialize() before listing',
  /await\s+mcpRegistry\.initialize\(\)/.test(TOOLS_API_SRC) &&
    /listToolNames/.test(TOOLS_API_SRC),
);

// ── 1. Behavior matrix ────────────────────────────────────────────────────
console.log('\n[1] applyAgentToolFilter behavior');

// Synthetic mix of built-in + MCP tools.
const stubMerged: ToolSet = {
  // Built-in
  read_file: tool({ description: 'read_file', inputSchema: z.object({ p: z.string() }) }),
  run_command: tool({ description: 'run_command', inputSchema: z.object({ c: z.string() }) }),
  memory_recall: tool({ description: 'memory_recall', inputSchema: z.object({ q: z.string() }) }),
  // MCP (server-prefixed names, e.g. "talonpress_publish_package")
  talonpress_publish_package: tool({
    description: 'talonpress_publish_package',
    inputSchema: z.object({ version: z.string() }),
  }),
  talonpress_list_drafts: tool({
    description: 'talonpress_list_drafts',
    inputSchema: z.object({}),
  }),
  github_create_issue: tool({
    description: 'github_create_issue',
    inputSchema: z.object({ title: z.string() }),
  }),
};

// 1a. No filter (agent has no per-agent restriction) → everything passes.
const noFilter = applyAgentToolFilter(stubMerged, undefined);
ok('undefined filter returns every tool', Object.keys(noFilter).length === Object.keys(stubMerged).length);
ok('undefined filter keeps built-ins', 'read_file' in noFilter && 'run_command' in noFilter);
ok('undefined filter keeps MCP tools', 'talonpress_publish_package' in noFilter && 'github_create_issue' in noFilter);

// 1b. Empty-array filter is treated as "no restriction" (mirrors SoulManager
// behavior, which strips `tools: []` and the filter reads it as unrestricted).
const emptyFilter = applyAgentToolFilter(stubMerged, []);
ok('empty-array filter returns every tool', Object.keys(emptyFilter).length === Object.keys(stubMerged).length);

// 1c. Built-in-only filter → MCP tools are stripped.
const builtInOnly = applyAgentToolFilter(stubMerged, ['read_file']);
ok('built-in-only filter keeps read_file', 'read_file' in builtInOnly);
ok('built-in-only filter strips run_command', !('run_command' in builtInOnly));
ok('built-in-only filter strips every MCP tool', !('talonpress_publish_package' in builtInOnly) && !('talonpress_list_drafts' in builtInOnly) && !('github_create_issue' in builtInOnly));

// 1d. MCP-only filter → built-ins are stripped.
const mcpOnly = applyAgentToolFilter(stubMerged, ['talonpress_publish_package']);
ok('mcp-only filter keeps talonpress_publish_package', 'talonpress_publish_package' in mcpOnly);
ok('mcp-only filter strips every built-in', !('read_file' in mcpOnly) && !('run_command' in mcpOnly) && !('memory_recall' in mcpOnly));
ok('mcp-only filter strips other MCP tools not in the list', !('talonpress_list_drafts' in mcpOnly) && !('github_create_issue' in mcpOnly));

// 1e. Mixed filter: built-in + MCP together.
const mixed = applyAgentToolFilter(stubMerged, ['read_file', 'talonpress_publish_package', 'github_create_issue']);
ok('mixed filter keeps read_file (built-in)', 'read_file' in mixed);
ok('mixed filter keeps talonpress_publish_package (mcp)', 'talonpress_publish_package' in mixed);
ok('mixed filter keeps github_create_issue (mcp)', 'github_create_issue' in mixed);
ok('mixed filter strips run_command', !('run_command' in mixed));
ok('mixed filter strips memory_recall', !('memory_recall' in mixed));
ok('mixed filter strips talonpress_list_drafts', !('talonpress_list_drafts' in mixed));
ok('mixed filter returns exactly 3 tools', Object.keys(mixed).length === 3);

// 1f. Filter referencing nothing → empty set.
const noMatch = applyAgentToolFilter(stubMerged, ['nonexistent_tool']);
ok('no-match filter returns empty set', Object.keys(noMatch).length === 0);

// 1g. MCP server-prefixed names are matched as registered (not the bare name).
// This is the regression guard for the original Telegram bug — the filter
// checks the prefixed name ("talonpress_publish_package"), not the bare one
// ("publish_package") that the MCP server exports.
const requiresPrefix = applyAgentToolFilter(stubMerged, ['publish_package']);
ok('filter does not match bare MCP name (publish_package)', !('talonpress_publish_package' in requiresPrefix));
ok('filter does match prefixed MCP name (talonpress_publish_package)', 'talonpress_publish_package' in applyAgentToolFilter(stubMerged, ['talonpress_publish_package']));

// 1h. Input object is not mutated (filter must return a new ToolSet).
const frozenInput: ToolSet = { ...stubMerged };
applyAgentToolFilter(frozenInput, ['read_file']);
ok('applyAgentToolFilter does not mutate the input', Object.keys(frozenInput).length === Object.keys(stubMerged).length);

// 1i. Empty ToolSet is handled gracefully.
const emptyMerged: ToolSet = {};
ok('empty input + undefined filter returns empty', Object.keys(applyAgentToolFilter(emptyMerged, undefined)).length === 0);
ok('empty input + filter returns empty', Object.keys(applyAgentToolFilter(emptyMerged, ['read_file'])).length === 0);

// ── 2. Cross-channel consistency ──────────────────────────────────────────
console.log('\n[2] All three channels funnel through the same helper');

// The previous implementations diverged between channels. The drift guard
// above already checks each call site imports and calls the helper; this
// section asserts no other "filter" branch has crept in that could re-open
// the divergence.
const alternativeFilterPatterns = [
  /Object\.entries\([^)]*\)\.filter\([^)]*agentFilter[^)]*\)/, // inline duplicate of the helper
  /\.filter\(\(\[k[^\]]*\]\)\s*=>\s*[^)]*includes\(k\)\)/,     // inline string check
];
const dupes = alternativeFilterPatterns.filter((re) =>
  re.test(TELEGRAM_TOOLS_SRC) || re.test(EMAIL_TOOLS_SRC) || re.test(CHAT_ROUTE_SRC),
);
ok('no inline duplicate of the filter logic in any channel', dupes.length === 0);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll per-agent tool filter invariants hold.');
