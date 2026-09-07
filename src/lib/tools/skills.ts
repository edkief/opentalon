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

function getSystemSkillsDir(): string {
  return process.env.SYSTEM_SKILLS_DIR ?? path.join(process.cwd(), 'system-skills');
}

function skillDir(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getSkillsDir(), safe);
}

function skillMdPath(name: string): string {
  return path.join(skillDir(name), 'SKILL.md');
}

function systemSkillDir(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getSystemSkillsDir(), safe);
}

async function resolvedSkillDir(name: string): Promise<string | null> {
  const workspaceDir = skillDir(name);
  try {
    await fs.access(path.join(workspaceDir, 'SKILL.md'));
    return workspaceDir;
  } catch {
    const systemDir = systemSkillDir(name);
    try {
      await fs.access(path.join(systemDir, 'SKILL.md'));
      return systemDir;
    } catch {
      return null;
    }
  }
}

interface SkillMeta {
  name: string;
  description: string;
}

async function readSkill(name: string): Promise<{ meta: SkillMeta; markdown: string } | null> {
  try {
    const dir = await resolvedSkillDir(name);
    if (!dir) return null;
    const markdown = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8');
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
    const skills: SkillMeta[] = [];
    const seen = new Set<string>();

    // Workspace skills take precedence, so users can deliberately override a
    // system skill without modifying the immutable copy shipped in the image.
    for (const root of [getSkillsDir(), getSystemSkillsDir()]) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        const mdPath = path.join(root, entry.name, 'SKILL.md');
        try {
          const markdown = await fs.readFile(mdPath, 'utf-8');
          const { data } = matter(markdown);
          if (data.name && data.description) {
            const name = String(data.name);
            seen.add(entry.name);
            seen.add(name);
            skills.push({ name, description: String(data.description) });
          }
        } catch {
          // skip folders without a valid SKILL.md
        }
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    skillsCache = { skills, timestamp: now };
    return skills;
  } catch {
    return [];
  }
}

/**
 * Returns a short "- name: description" list of saved skills, or empty
 * string if none. When `allowedSkills` is provided (an agent's soul-config
 * skill allowlist), the list is filtered to it — otherwise a specialist's
 * prompt would advertise skills it isn't actually allowed to load via
 * skill_get (whose allowlist enforcement this must mirror to avoid the
 * prompt promising access the tool will then refuse).
 */
export async function getSkillsSummary(allowedSkills?: string[] | null): Promise<string> {
  let skills = await listSkills();
  if (Array.isArray(allowedSkills)) {
    skills = skills.filter((s) => allowedSkills.includes(s.name));
  }
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
      inputSchema: z.object({}),
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
    }),

    skill_get: tool({
      description:
        "Read the full SKILL.md content of a skill by name. " +
        "Returns the instructional document — read and understand it, then follow its instructions, which may describe " +
        "a workflow to perform, steps to follow, or scripts to run via run_command.",
      inputSchema: z.object({
        name: z.string().describe('The skill name'),
      }),
      execute: async (input: { name: string }) => {
        if (Array.isArray(opts?.allowedSkills) && !(opts.allowedSkills as string[]).includes(input.name)) {
          return `Error: skill "${input.name}" not found.`;
        }
        const skill = await readSkill(input.name);
        if (!skill) return `Error: skill "${input.name}" not found.`;

        // Append script listing with absolute paths if the scripts/ folder exists
        let result = skill.markdown;
        const dir = await resolvedSkillDir(input.name);
        const scriptsDir = path.join(dir!, 'scripts');
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
    }),

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
      }),
      execute: async (input: { name: string; description: string; content: string }) => {
        await writeSkillMd(input.name, input.description, input.content);
        invalidateSkillsCache();
        return `Skill "${input.name}" saved to skills/${input.name}/SKILL.md.`;
      },
    }),

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
      }),
      execute: async (input: { skill_name: string; filename: string; content: string }) => {
        // Sanitize filename — no path traversal, no hidden files
        const safe = input.filename
          .replace(/[^a-zA-Z0-9_\-.]/g, '_')
          .replace(/^\.+/, '');
        if (!safe) return 'Error: invalid filename.';

        const scriptsDir = path.join(skillDir(input.skill_name), 'scripts');
        await fs.mkdir(scriptsDir, { recursive: true });

        const scriptPath = path.join(scriptsDir, safe);
        await fs.writeFile(scriptPath, input.content, 'utf-8');

        if (safe.endsWith('.sh')) {
          await fs.chmod(scriptPath, 0o755);
        }

        invalidateSkillsCache();
        return `Script saved to skills/${input.skill_name}/scripts/${safe}.`;
      },
    }),

    skill_delete: tool({
      description: 'Delete a skill and all its files (SKILL.md + scripts/) from the library.',
      inputSchema: z.object({
        name: z.string().describe('The skill name to delete'),
      }),
      execute: async (input: { name: string }) => {
        try {
          try {
            await fs.access(skillMdPath(input.name));
          } catch {
            if (await resolvedSkillDir(input.name)) {
              return `Error: system skill "${input.name}" is read-only. Create a workspace skill with the same name to override it.`;
            }
          }
          await fs.rm(skillDir(input.name), { recursive: true, force: true });
          invalidateSkillsCache();
          return `Skill "${input.name}" deleted.`;
        } catch {
          return `Error: skill "${input.name}" not found.`;
        }
      },
    }),
  };
}
