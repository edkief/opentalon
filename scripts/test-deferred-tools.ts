/**
 * Regression checks for family-aware deferred tool discovery (#53).
 *
 * Run with: pnpm test:deferred-tools
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { applyAgentToolFilter } from '../src/lib/tools/apply-agent-filter';
import {
  formatDeferredToolFamilyDirectory,
  initialActiveTools,
  loadDeferredTools,
  searchDeferredTools,
} from '../src/lib/tools/deferred';
import {
  getToolFamily,
  mcpToolFamily,
  setToolFamily,
  setToolSetFamily,
} from '../src/lib/tools/family-metadata';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXECUTOR_SOURCE = fs.readFileSync(
  path.join(ROOT, 'src/lib/agent/llm-executor.ts'),
  'utf8',
);

let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${label}`);
}

function stub(description: string) {
  return tool({ description, inputSchema: z.object({}) });
}

console.log('\n[1] Family metadata');

const webTools = setToolSetFamily({
  web_search: stub('Search the internet for relevant pages.'),
  web_fetch: stub('Fetch the contents of a web page.'),
}, 'web');
const fileTools = setToolSetFamily({
  read_file: stub('Read a file from the workspace.'),
  fuzzy_patch: stub('Apply a fuzzy patch to a workspace file.'),
}, 'files');
const browserNavigate = stub('Navigate a rendered browser page to a URL.');
setToolFamily(browserNavigate, mcpToolFamily('Browser'));

const allTools: ToolSet = {
  ...webTools,
  ...fileTools,
  browser_navigate: browserNavigate,
  send_file: stub('Send a local file to the current chat.'),
  spawn_specialist: stub('Delegate a focused task to a specialist.'),
  custom_action: stub('Perform a deployment-specific action.'),
};

ok('built-in metadata records the original family', getToolFamily('web_search', allTools.web_search).id === 'web');
ok('built-in metadata records its source', getToolFamily('web_search', allTools.web_search).source === 'built-in');
ok('MCP server names become normalized family ids', getToolFamily('browser_navigate', browserNavigate).id === 'browser');
ok('MCP tools retain their source', getToolFamily('browser_navigate', browserNavigate).source === 'mcp');
ok('send_file has a centralized channel classification', getToolFamily('send_file', allTools.send_file).source === 'channel');
ok('specialist controls have a centralized agents classification', getToolFamily('spawn_specialist', allTools.spawn_specialist).id === 'agents');
ok('unclassified request-local tools remain discoverable', getToolFamily('custom_action', allTools.custom_action).id === 'other');

console.log('\n[2] Request-accurate family directory');

const active = initialActiveTools(allTools);
const directory = formatDeferredToolFamilyDirectory(allTools, active);
ok('always-active read_file is excluded from the deferred count', directory.includes('- files [built-in] (1 tool):'));
ok('built-in families include a concise description', directory.includes('- web [built-in] (2 tools): Search the web'));
ok('MCP families are distinguished in the directory', directory.includes('- browser [mcp] (1 tool):'));
ok('channel and dynamic families are distinguished', directory.includes('- communication [channel]') && directory.includes('- agents [dynamic]'));
ok('unknown dynamic tools fall back to other', directory.includes('- other [dynamic]'));

const filtered = applyAgentToolFilter(allTools, ['web_fetch', 'browser_navigate']);
const filteredDirectory = formatDeferredToolFamilyDirectory(filtered, initialActiveTools(filtered));
ok('directory includes tools surviving the request filter', filteredDirectory.includes('- web [built-in] (1 tool):'));
ok('directory does not advertise a filtered-out family', !filteredDirectory.includes('communication'));
ok('metadata survives ToolSet filtering by object identity', filteredDirectory.includes('- browser [mcp]'));
ok('executor injects the directory only through the deferred path',
  /deferredFamilyDirectory[\s\S]*formatDeferredToolFamilyDirectory/.test(EXECUTOR_SOURCE) &&
  /deferredFamilyDirectory\s*\?[\s\S]*baseVolatileSystem/.test(EXECUTOR_SOURCE));

console.log('\n[3] Family-aware search');

const familyList = searchDeferredTools(allTools, active, {});
ok('empty search lists the compact family directory', familyList.startsWith('## Deferred Tool Families'));

const webList = searchDeferredTools(allTools, active, { family: 'WEB' });
ok('family-only search enumerates that family', webList.includes('web_search') && webList.includes('web_fetch'));
ok('family-only search excludes other families', !webList.includes('browser_navigate'));

const scopedSearch = searchDeferredTools(allTools, active, {
  query: 'contents page',
  family: 'web',
});
ok('query can be scoped to one family', scopedSearch.includes('web_fetch') && !scopedSearch.includes('browser_navigate'));

const unknownFamily = searchDeferredTools(allTools, active, { family: 'missing' });
ok('unknown family reports valid alternatives', unknownFamily.includes('Available deferred families:'));

console.log('\n[4] Exact-name loading');

const loadResult = loadDeferredTools(allTools, active, ['web_fetch', 'web']);
ok('exact tool names become active', active.has('web_fetch') && loadResult.includes('Loaded: web_fetch'));
ok('family names are not accepted as load targets', !active.has('web') && loadResult.includes('Unknown (ignored): web'));
ok('loaded tools disappear from subsequent family enumeration', !searchDeferredTools(allTools, active, { family: 'web' }).includes('web_fetch'));

if (failed > 0) {
  console.error(`\n${failed} deferred-tool check(s) failed.`);
  process.exit(1);
}

console.log('\nAll deferred tool family invariants hold.');
