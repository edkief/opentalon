import {
  existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, copyFileSync, rmSync,
} from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import type { WorkspaceMigration } from './runner';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

function snapshotOriginals(agentDir: string): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapDir = join(agentDir, 'snapshots', `pre-agent-md-merge-${timestamp}`);
  mkdirSync(snapDir, { recursive: true });
  for (const file of ['SOUL.md', 'IDENTITY.md', 'agent.yml']) {
    const src = join(agentDir, file);
    if (existsSync(src)) copyFileSync(src, join(snapDir, file));
  }
}

function mergeAgent(agentDir: string, label: string): void {
  const soulPath = join(agentDir, 'SOUL.md');
  const identityPath = join(agentDir, 'IDENTITY.md');
  const agentMdPath = join(agentDir, 'AGENT.md');

  if (existsSync(agentMdPath)) return; // already migrated
  if (!existsSync(soulPath)) return;   // nothing to migrate

  snapshotOriginals(agentDir);

  const soulContent = readFileSync(soulPath, 'utf-8').trim();
  let identityContent = '';
  if (existsSync(identityPath)) {
    identityContent = matter(readFileSync(identityPath, 'utf-8')).content.trim();
  }

  const date = new Date().toISOString().slice(0, 10);
  const notice = `> **⚠️ Agent definition migrated (${date}):** Your SOUL.md and IDENTITY.md files have been combined into this single AGENT.md file. This is now the one place to edit your personality, instructions, and identity — mention this to the user in your reply so they know to look here from now on.`;

  const sections = [notice];
  if (identityContent) sections.push(`## Identity\n${identityContent}`);
  sections.push(`## Soul\n${soulContent}`);

  writeFileSync(agentMdPath, `${sections.join('\n\n')}\n`, 'utf-8');
  rmSync(soulPath);
  if (existsSync(identityPath)) rmSync(identityPath);

  console.log(`[Migration] Merged ${label}/{SOUL.md,IDENTITY.md} → AGENT.md`);
}

const migration: WorkspaceMigration = {
  id: 'merge-soul-identity-to-agent-md',
  description: 'Merge each agent\'s SOUL.md + IDENTITY.md into a single AGENT.md',
  async run() {
    const agentsDir = join(WORKSPACE, 'agents');
    if (!existsSync(agentsDir)) return;

    for (const entry of readdirSync(agentsDir)) {
      const agentDir = join(agentsDir, entry);
      if (!statSync(agentDir).isDirectory()) continue;
      mergeAgent(agentDir, `agents/${entry}`);
    }
  },
};

export default migration;
