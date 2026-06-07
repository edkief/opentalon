import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { configManager } from '../config';
import type { BuiltInToolsOpts } from './types';

// ─── Workspace & skill path helpers ──────────────────────────────────────────

export function getWorkspaceDir(): string {
  return configManager.get().tools?.agentWorkspace ?? process.env.AGENT_WORKSPACE ?? process.cwd();
}

function getSkillsDir(): string {
  return configManager.get().tools?.skillsDir ?? process.env.SKILLS_DIR ?? path.join(getWorkspaceDir(), 'skills');
}

function skillDir(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getSkillsDir(), safe);
}

function skillMdPath(name: string): string {
  return path.join(skillDir(name), 'SKILL.md');
}

function skillScriptsDir(name: string): string {
  return path.join(skillDir(name), 'scripts');
}

interface SkillMeta {
  name: string;
  description: string;
}

async function readSkill(name: string): Promise<{ meta: SkillMeta; markdown: string } | null> {
  try {
    const markdown = await fs.readFile(skillMdPath(name), 'utf-8');
    const { data } = matter(markdown);
    if (!data.name || !data.description) return null;
    return { meta: { name: String(data.name), description: String(data.description) }, markdown };
  } catch {
    return null;
  }
}

async function writeSkillMd(name: string, description: string, content: string): Promise<void> {
  await fs.mkdir(skillDir(name), { recursive: true });
  const markdown = matter.stringify(content.trim(), { name, description, license: 'None' });
  await fs.writeFile(skillMdPath(name), markdown, 'utf-8');
}

// ─── Skills cache ─────────────────────────────────────────────────────────────

let skillsCache: { skills: SkillMeta[]; timestamp: number } | null = null;
const SKILLS_CACHE_TTL = 5000;

export function invalidateSkillsCache() {
  skillsCache = null;
}

export async function listSkills(): Promise<SkillMeta[]> {
  const now = Date.now();
  if (skillsCache && now - skillsCache.timestamp < SKILLS_CACHE_TTL) {
    return skillsCache.skills;
  }
  try {
    await fs.mkdir(getSkillsDir(), { recursive: true });
    const entries = await fs.readdir(getSkillsDir(), { withFileTypes: true });
    const skills: SkillMeta[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const mdPath = path.join(getSkillsDir(), entry.name, 'SKILL.md');
      try {
        const markdown = await fs.readFile(mdPath, 'utf-8');
        const { data } = matter(markdown);
        if (data.name && data.description) {
          skills.push({ name: String(data.name), description: String(data.description) });
        }
      } catch {
        // skip folders without a valid SKILL.md
      }
    }
    skillsCache = { skills, timestamp: now };
    return skills;
  } catch {
    return [];
  }
}

/** Returns a short "- name: description" list of all saved skills, or empty string if none. */
export async function getSkillsSummary(): Promise<string> {
  const skills = await listSkills();
  if (skills.length === 0) return '';
  return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
}

// ─── Skill tools ──────────────────────────────────────────────────────────────

export function getSkillTools(opts?: BuiltInToolsOpts): ToolSet {
  return {
    skill_list: tool({
      description:
        'List all skills in the skill library. ' +
        'This is a LOOKUP ONLY — after finding the right skill you MUST call skill_get ' +
        'to read its instructions, then execute using run_command. Do not stop here.',
      inputSchema: z.object({}) as any,
      execute: async () => {
        let skills = await listSkills();
        if (Array.isArray(opts?.allowedSkills)) {
          skills = skills.filter((s) => (opts.allowedSkills as string[]).includes(s.name));
        }
        if (skills.length === 0) return 'No skills saved yet.';
        return JSON.stringify(
          skills.map((s) => ({ name: s.name, description: s.description })),
          null,
          2,
        );
      },
    } as any),

    skill_get: tool({
      description:
        "Read the full SKILL.md content of a skill by name. " +
        "Returns the instructional document — read and understand it, then follow its instructions, which may describe " +
        "a workflow to perform, steps to follow, or scripts to run via run_command.",
      inputSchema: z.object({
        name: z.string().describe('The skill name'),
      }) as any,
      execute: async (input: { name: string }) => {
        if (Array.isArray(opts?.allowedSkills) && !(opts.allowedSkills as string[]).includes(input.name)) {
          return `Skill "${input.name}" not found.`;
        }
        const skill = await readSkill(input.name);
        if (!skill) return `Skill "${input.name}" not found.`;

        // Append script listing with absolute paths if the scripts/ folder exists
        let result = skill.markdown;
        const scriptsDir = skillScriptsDir(input.name);
        try {
          const scripts = await fs.readdir(scriptsDir);
          if (scripts.length > 0) {
            result += `\n\n## Available scripts\n${scripts.map((s) => `- ${path.join(scriptsDir, s)}`).join('\n')}`;
          }
        } catch {
          // no scripts/ directory — fine
        }
        return result;
      },
    } as any),

    skill_save: tool({
      description:
        'Create or update a skill. Creates skills/{name}/SKILL.md with YAML frontmatter ' +
        'and an instructional Markdown body. ' +
        'Write a how-to guide — describe the goal, commands, flags, and examples. ' +
        'Do NOT hard-code a single fixed command; write documentation the agent can adapt.',
      inputSchema: z.object({
        name: z
          .string()
          .describe('Short snake_case identifier, e.g. "ping_host" (no spaces)'),
        description: z
          .string()
          .describe(
            'One-sentence trigger: "Use this skill when the user wants to…" — ' +
            'this is what appears in skill_list and drives skill selection.',
          ),
        content: z
          .string()
          .describe(
            'Instructional Markdown body: overview, commands, flags, examples. ' +
            'Do not include YAML frontmatter — it is generated automatically.',
          ),
      }) as any,
      execute: async (input: { name: string; description: string; content: string }) => {
        await writeSkillMd(input.name, input.description, input.content);
        invalidateSkillsCache();
        return `Skill "${input.name}" saved to skills/${input.name}/SKILL.md.`;
      },
    } as any),

    skill_add_script: tool({
      description:
        "Add a supporting script to a skill's scripts/ subfolder. " +
        'Can be called in parallel with skill_save — the skill directory is created automatically. ' +
        'Shell scripts (.sh) are automatically made executable.',
      inputSchema: z.object({
        skill_name: z.string().describe('The skill name'),
        filename: z
          .string()
          .describe('Script filename, e.g. "ping.sh" or "analyze.py" (no path separators)'),
        content: z.string().describe('The full script content'),
      }) as any,
      execute: async (input: { skill_name: string; filename: string; content: string }) => {
        // Sanitize filename — no path traversal, no hidden files
        const safe = input.filename
          .replace(/[^a-zA-Z0-9_\-.]/g, '_')
          .replace(/^\.+/, '');
        if (!safe) return 'Invalid filename.';

        const scriptsDir = skillScriptsDir(input.skill_name);
        await fs.mkdir(scriptsDir, { recursive: true });

        const scriptPath = path.join(scriptsDir, safe);
        await fs.writeFile(scriptPath, input.content, 'utf-8');

        if (safe.endsWith('.sh')) {
          await fs.chmod(scriptPath, 0o755);
        }

        invalidateSkillsCache();
        return `Script saved to skills/${input.skill_name}/scripts/${safe}.`;
      },
    } as any),

    skill_delete: tool({
      description: 'Delete a skill and all its files (SKILL.md + scripts/) from the library.',
      inputSchema: z.object({
        name: z.string().describe('The skill name to delete'),
      }) as any,
      execute: async (input: { name: string }) => {
        try {
          await fs.rm(skillDir(input.name), { recursive: true, force: true });
          invalidateSkillsCache();
          return `Skill "${input.name}" deleted.`;
        } catch {
          return `Skill "${input.name}" not found.`;
        }
      },
    } as any),
  };
}
