/** Regression checks for the run_command -> run_shell model-facing rename. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { migrateRunShellReferences } from '../src/lib/migrations/011-rename-run-command-tool';
import { getTerminalTools } from '../src/lib/tools/terminal';

let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opentalon-run-shell-'));
try {
  fs.mkdirSync(path.join(workspace, 'agents', 'default'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'agents', 'unchanged'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'config.yaml'), `# keep this comment
tools:
  allowlist:
    - run_command
    - web_search
  dangerousTools: [run_command, deploy]
`, 'utf-8');
  fs.writeFileSync(path.join(workspace, 'agents', 'default', 'agent.yml'), `tools:
  - read_file
  - run_command
`, 'utf-8');
  fs.writeFileSync(path.join(workspace, 'agents', 'unchanged', 'agent.yml'), 'tools: "*"\n', 'utf-8');

  migrateRunShellReferences(workspace);

  const configRaw = fs.readFileSync(path.join(workspace, 'config.yaml'), 'utf-8');
  const config = parseYaml(configRaw);
  const agent = parseYaml(fs.readFileSync(path.join(workspace, 'agents', 'default', 'agent.yml'), 'utf-8'));
  ok('config allowlist is migrated', config.tools.allowlist[0] === 'run_shell');
  ok('dangerous tool list is migrated too', config.tools.dangerousTools[0] === 'run_shell');
  ok('unrelated config entries are preserved', config.tools.allowlist[1] === 'web_search' && config.tools.dangerousTools[1] === 'deploy');
  ok('YAML comments survive the migration', configRaw.includes('# keep this comment'));
  ok('per-agent tool allowlist is migrated', agent.tools.includes('run_shell') && !agent.tools.includes('run_command'));
  ok('non-sequence tool settings are left alone', fs.readFileSync(path.join(workspace, 'agents', 'unchanged', 'agent.yml'), 'utf-8') === 'tools: "*"\n');

  const terminalTools = getTerminalTools();
  const shellDescription = (terminalTools.run_shell as { description?: string }).description ?? '';
  ok('only run_shell is exposed to the model', 'run_shell' in terminalTools && !('run_command' in terminalTools));
  ok('shell schema excludes delegation', shellDescription.includes('cannot delegate tasks'));
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nAll run-shell rename checks passed.\n' : `\n${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
