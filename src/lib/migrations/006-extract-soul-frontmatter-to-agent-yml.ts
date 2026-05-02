import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { stringify as stringifyYaml } from 'yaml';
import type { WorkspaceMigration } from './runner';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();

function extractAndMigrate(agentDir: string, label: string): void {
  const soulPath = join(agentDir, 'SOUL.md');
  const agentConfigPath = join(agentDir, 'agent.yml');

  if (!existsSync(soulPath)) return;

  const raw = readFileSync(soulPath, 'utf-8');
  const { data, content } = matter(raw);

  // Nothing to migrate if there's no frontmatter
  if (!data || Object.keys(data).length === 0) return;

  // Write config to agent.yml (only if it doesn't already exist)
  if (!existsSync(agentConfigPath)) {
    writeFileSync(agentConfigPath, stringifyYaml(data), 'utf-8');
    console.log(`[Migration] Created ${label}/agent.yml from SOUL.md frontmatter`);
  }

  // Rewrite SOUL.md as pure markdown (strip frontmatter)
  writeFileSync(soulPath, content.trimStart(), 'utf-8');
  console.log(`[Migration] Stripped frontmatter from ${label}/SOUL.md`);
}

const migration: WorkspaceMigration = {
  id: 'extract-soul-frontmatter-to-agent-yml',
  description: 'Move SOUL.md YAML frontmatter into a dedicated agent.yml file for each agent',
  async run() {
    const agentsDir = join(WORKSPACE, 'agents');
    if (!existsSync(agentsDir)) return;

    for (const entry of readdirSync(agentsDir)) {
      const agentDir = join(agentsDir, entry);
      if (!statSync(agentDir).isDirectory()) continue;
      extractAndMigrate(agentDir, `agents/${entry}`);
    }
  },
};

export default migration;
