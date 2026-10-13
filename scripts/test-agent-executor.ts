/**
 * Harness-backed agent settings in agent.yml (#68): executor, workdir and
 * harnessTimeoutMs round-trip, and values that don't fit are dropped.
 *
 * Run: pnpm test:agent-executor
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import SoulManager from '../src/lib/soul/soul-manager';

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail !== undefined ? `\n      got: ${JSON.stringify(detail)}` : ''}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opentalon-agent-executor-'));
const agentPath = path.join(dir, 'AGENT.md');
const ymlPath = path.join(dir, 'agent.yml');
fs.writeFileSync(agentPath, '# Coder\n');
const sm = new SoulManager(agentPath);
const yml = () => parseYaml(fs.readFileSync(ymlPath, 'utf-8')) as Record<string, unknown>;

console.log('=== agent.yml executor settings ===\n');

ok('an agent with no agent.yml is native (executor absent)', sm.getConfig().executor === undefined);

sm.writeConfig({ model: 'anthropic/claude-sonnet-4-5', executor: 'pi', workdir: 'repos/app', harnessTimeoutMs: 1_800_000 });
{
  const config = sm.getConfig();
  ok('executor, workdir and harnessTimeoutMs round-trip', config.executor === 'pi' && config.workdir === 'repos/app' && config.harnessTimeoutMs === 1_800_000, config);
  ok('…next to the existing fields', config.model === 'anthropic/claude-sonnet-4-5');
}

sm.writeConfig({ executor: 'native', workdir: undefined, harnessTimeoutMs: undefined });
{
  const written = yml();
  ok('switching back to native removes executor, workdir and timeout from agent.yml',
    !('executor' in written) && !('workdir' in written) && !('harnessTimeoutMs' in written) && written.model === 'anthropic/claude-sonnet-4-5', written);
}

fs.writeFileSync(ymlPath, 'executor: opencode\nworkdir: "   "\nharnessTimeoutMs: 5000\n');
{
  const config = sm.getConfig();
  ok('an unknown executor is ignored (native)', config.executor === undefined, config);
  ok('a blank workdir is ignored', config.workdir === undefined);
  ok('a timeout under 60s is ignored', config.harnessTimeoutMs === undefined);
}

fs.writeFileSync(ymlPath, 'executor: pi\nworkdir: "  /srv/checkout  "\nharnessTimeoutMs: 90000.5\n');
{
  const config = sm.getConfig();
  ok('workdir is trimmed', config.workdir === '/srv/checkout', config);
  ok('a non-integer timeout is ignored', config.harnessTimeoutMs === undefined);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed === 0 ? '[OK]' : '[FAIL]'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
