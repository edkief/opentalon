import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { ToolSet } from 'ai';
import { waitForApproval } from '../agent/hitl';
import { retrieveContext } from '../memory/retrieve';

const execAsync = promisify(exec);

// ─── Skill storage (Anthropic SKILL.md format) ──────────────────────────────
//
// Each skill lives in its own folder:
//
//   skills/
//     ping_host/
//       SKILL.md          ← YAML frontmatter + instructional content
//       scripts/          ← optional supporting scripts
//         ping.sh
//
// SKILL.md format:
//
//   ---
//   name: ping_host
//   description: Use this skill when the user wants to ping a host.
//   license: None
//   ---
//
//   ## Overview
//   ...instructional content...

export function getWorkspaceDir(): string {
  return process.env.AGENT_WORKSPACE ?? process.cwd();
}

function getSkillsDir(): string {
  return process.env.SKILLS_DIR ?? path.join(getWorkspaceDir(), 'skills');
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

async function listSkills(): Promise<SkillMeta[]> {
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
    return skills;
  } catch {
    return [];
  }
}

// ─── Shell execution ───────────────────────────────────────────────────────────

async function runShell(command: string, cwd?: string, extraEnv?: Record<string, string>): Promise<string> {
  const shell = process.env.SHELL || '/bin/bash';
  const { stdout, stderr } = await execAsync(command, {
    cwd: cwd ?? getWorkspaceDir(),
    timeout: 30_000,
    maxBuffer: 512 * 1024,
    shell,
    env: { ...process.env, ...extraEnv },
  });
  return [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n') || '(no output)';
}

// ─── HITL helper ──────────────────────────────────────────────────────────────

type ApprovalCallback = (approvalId: string, toolName: string, input: unknown) => Promise<void>;

async function requestAndWait(
  toolName: string,
  input: unknown,
  send?: ApprovalCallback,
): Promise<boolean> {
  if (!send) return true; // no HITL configured — allow
  const approvalId = crypto.randomUUID();
  await send(approvalId, toolName, input);
  return waitForApproval(approvalId);
}

// ─── Built-in tools ────────────────────────────────────────────────────────────

export function getBuiltInTools(opts?: {
  sendApprovalRequest?: ApprovalCallback;
  telegramChatId?: string;
  memoryScope?: 'private' | 'shared';
}): ToolSet {
  const send = opts?.sendApprovalRequest;
  const shellEnv: Record<string, string> = {};
  if (opts?.telegramChatId) shellEnv['TELEGRAM_CHAT_ID'] = opts.telegramChatId;
  const memoryScope = opts?.memoryScope ?? 'private';
  const memoryChatId = opts?.telegramChatId;

  return {
    // ── Terminal ──────────────────────────────────────────────────────────────
    run_command: tool({
      description:
        'Run an arbitrary shell command on the local machine. ' +
        'Supports pipes, redirects, and shell syntax. Requires user approval. ' +
        'TELEGRAM_CHAT_ID and TELEGRAM_BOT_TOKEN are available as environment variables.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute'),
        cwd: z.string().optional().describe('Working directory (defaults to process cwd)'),
      }) as any,
      execute: async (input: { command: string; cwd?: string }) => {
        const approved = await requestAndWait('run_command', input, send);
        if (!approved) return 'Action "run_command" was denied by the user.';
        try {
          return await runShell(input.command, input.cwd, shellEnv);
        } catch (err) {
          return `Command failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    } as any),

    // ── Skill library ─────────────────────────────────────────────────────────
    skill_list: tool({
      description:
        'List all skills in the skill library. ' +
        'This is a LOOKUP ONLY — after finding the right skill you MUST call skill_get ' +
        'to read its instructions, then execute using run_command. Do not stop here.',
      inputSchema: z.object({}) as any,
      execute: async () => {
        const skills = await listSkills();
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
        "Returns the instructional document — understand it, then execute " +
        "using run_command (referencing scripts in the skill's scripts/ folder if present).",
      inputSchema: z.object({
        name: z.string().describe('The skill name'),
      }) as any,
      execute: async (input: { name: string }) => {
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
          return `Skill "${input.name}" deleted.`;
        } catch {
          return `Skill "${input.name}" not found.`;
        }
      },
    } as any),

    // ── Long-term memory ──────────────────────────────────────────────────────
    search_memory: tool({
      description:
        'Search long-term memory (Qdrant) for information relevant to a query. ' +
        'Use this when the user references something from a past conversation or asks about ' +
        'something you might have stored. Returns the most relevant memory excerpts.',
      inputSchema: z.object({
        query: z.string().describe('Natural-language search query'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Max results to return (default 5)'),
      }) as any,
      execute: async (input: { query: string; limit?: number }) => {
        const results = await retrieveContext({
          query: input.query,
          scope: memoryScope,
          limit: input.limit ?? 5,
          chatId: memoryChatId,
        });
        return results || 'No relevant memories found.';
      },
    } as any),
  };
}
