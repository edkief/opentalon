import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isScalar, isSeq, parseDocument, type Document } from 'yaml';
import type { WorkspaceMigration } from './runner';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

function renameInSequence(doc: Document, path: string[]): boolean {
  const sequence = doc.getIn(path, true);
  if (!isSeq(sequence)) return false;

  let changed = false;
  for (const item of sequence.items) {
    if (isScalar(item) && item.value === 'run_command') {
      item.value = 'run_shell';
      changed = true;
    }
  }
  return changed;
}

function migrateYamlFile(filePath: string, paths: string[][]): void {
  if (!existsSync(filePath)) return;

  const raw = readFileSync(filePath, 'utf-8');
  let doc: Document;
  try {
    doc = parseDocument(raw);
  } catch {
    return;
  }
  if (doc.errors.length > 0) return;

  let changed = false;
  for (const path of paths) changed = renameInSequence(doc, path) || changed;
  if (changed) writeFileSync(filePath, doc.toString(), 'utf-8');
}

export function migrateRunShellReferences(workspace: string): void {
  migrateYamlFile(join(workspace, 'config.yaml'), [
    ['tools', 'allowlist'],
    ['tools', 'dangerousTools'],
  ]);

  const agentsDir = join(workspace, 'agents');
  if (!existsSync(agentsDir)) return;
  for (const entry of readdirSync(agentsDir)) {
    const agentDir = join(agentsDir, entry);
    if (!statSync(agentDir).isDirectory()) continue;
    migrateYamlFile(join(agentDir, 'agent.yml'), [['tools']]);
  }
}

const migration: WorkspaceMigration = {
  id: 'rename-run-command-tool',
  description: 'Rename persisted run_command allowlist entries to run_shell',
  async run() {
    migrateRunShellReferences(WORKSPACE);
  },
};

export default migration;
