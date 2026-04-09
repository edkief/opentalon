import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { BraveSearch } from 'brave-search';
import type { ToolSet } from 'ai';
import { waitForApproval } from '../agent/hitl';
import { retrieveContext } from '../memory/retrieve';
import { memoryManager } from '../agent/memory-manager';
import { FreshnessOption } from 'brave-search/dist/types';
import { configManager } from '../config';
import { getSchedulingTools } from './scheduling';
import { createSecretRequest } from '../db/secret-requests';
import { todoManager } from '../agent/todo-manager';
import { getJobById, createResumedJob, updateJobStatus } from '../db/jobs';
import { createUserInput, getUserInput } from '../db/user-inputs';
import { emitUserInputRequest } from '../agent/log-bus';
import { schedulerService } from '../scheduler';
import { db } from '../db';
import { workflows as workflowsTable } from '../db/schema';
import { ne, eq, inArray } from 'drizzle-orm';
import { workflowEngine } from '../workflow/engine';

const execAsync = promisify(exec);

/** Serializes web_search calls with 1s delay between completions (Brave Search API rate limit: 1 req/s). */
let webSearchQueue: Promise<boolean> = Promise.resolve(false);

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

let skillsCache: { skills: SkillMeta[]; timestamp: number } | null = null;
const SKILLS_CACHE_TTL = 5000;

function invalidateSkillsCache() {
  skillsCache = null;
}

export { invalidateSkillsCache, listSkills };

async function listSkills(): Promise<SkillMeta[]> {
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

// ─── Shell execution ───────────────────────────────────────────────────────────

async function runShell(command: string, cwd?: string, extraEnv?: Record<string, string>): Promise<string> {
  const shell = configManager.get().tools?.shell ?? process.env.SHELL ?? '/bin/bash';
  const { stdout, stderr } = await execAsync(command, {
    cwd: cwd ?? getWorkspaceDir(),
    timeout: 30_000,
    maxBuffer: 512 * 1024,
    shell,
    env: { ...process.env, ...extraEnv },
  });
  return [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n') || '(no output)';
}

// ─── agent-browser helper ─────────────────────────────────────────────────────

function getBrowserBin(): string {
  return configManager.get().tools?.agentBrowserBin ?? 'agent-browser';
}

function isBrowserEnabled(): boolean {
  return configManager.get().tools?.agentBrowserEnabled === true;
}

async function runBrowser(args: string): Promise<string> {
  const bin = getBrowserBin();
  try {
    const { stdout, stderr } = await execAsync(`${bin} ${args}`, {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      shell: '/bin/sh',
    });
    return [stdout, stderr].filter(Boolean).join('\n') || '(no output)';
  } catch (err: any) {
    const msg = err?.stderr ? `${err.message}\n${err.stderr}` : String(err);
    return `agent-browser error: ${msg}`;
  }
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
  sendTelegramMessage?: (chatId: string, text: string, format: 'html' | 'markdown') => Promise<void>;
  allowedSkills?: string[] | null;      // null = all allowed; string[] = explicit allowlist
  allowedWorkflows?: string[] | null;   // null = all allowed; string[] = explicit allowlist
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

    // ── Read file ─────────────────────────────────────────────────────────────
    read_file: tool({
      description:
        'Read the contents of a file. Optionally specify start_line and end_line (1-based, inclusive) ' +
        'to read a slice. At most 500 lines are returned per call; use start_line/end_line to paginate ' +
        'through larger files.',
      inputSchema: z.object({
        path: z.string().describe('File path (absolute or workspace-relative)'),
        start_line: z.number().int().min(1).optional().describe('First line to return (1-based, inclusive). Defaults to 1.'),
        end_line: z.number().int().min(1).optional().describe('Last line to return (1-based, inclusive). Defaults to start_line + 499.'),
      }),
      execute: async ({ path: filePath, start_line, end_line }: { path: string; start_line?: number; end_line?: number }) => {
        const MAX_LINES = 500;
        try {
          const absPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(getWorkspaceDir(), filePath);
          const content = await fs.readFile(absPath, 'utf-8');
          const lines = content.split('\n');
          const total = lines.length;
          const from = Math.max(1, start_line ?? 1);
          const to = Math.min(total, end_line ?? from + MAX_LINES - 1, from + MAX_LINES - 1);
          const slice = lines.slice(from - 1, to);
          const header = `[${filePath}] lines ${from}-${to} of ${total}${to < total ? ` (${total - to} more lines)` : ''}`;
          return `${header}\n${slice.map((l, i) => `${from + i}\t${l}`).join('\n')}`;
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    // ── String-replace edit ───────────────────────────────────────────────────
    str_replace_based_edit: tool({
      description:
        'Replace an exact string in a file with a new string. ' +
        'old_str must match exactly one occurrence in the file. ' +
        'Use this for targeted, precise file edits.',
      inputSchema: z.object({
        path: z.string().describe('File path (absolute or workspace-relative)'),
        old_str: z.string().describe('Exact string to replace — must appear exactly once in the file'),
        new_str: z.string().describe('Replacement string'),
      }),
      execute: async ({ path: filePath, old_str, new_str }: { path: string; old_str: string; new_str: string }) => {
        try {
          const absPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(getWorkspaceDir(), filePath);
          const content = await fs.readFile(absPath, 'utf-8');
          const count = content.split(old_str).length - 1;
          if (count === 0) return `Error: old_str not found in ${filePath}`;
          if (count > 1) return `Error: old_str matches ${count} locations in ${filePath} — make it more specific`;
          await fs.writeFile(absPath, content.replace(old_str, new_str), 'utf-8');
          return `Done: replaced 1 occurrence in ${filePath}`;
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    // ── Fuzzy patch ───────────────────────────────────────────────────────────
    fuzzy_patch: tool({
      description:
        'Apply a fuzzy patch to a file. Provide the original text block (old_str) and its replacement (new_str); ' +
        'the patch is applied with character-level fuzzy matching so minor context drift is tolerated. ' +
        'Use this when str_replace_based_edit fails due to slightly stale context.',
      inputSchema: z.object({
        path: z.string().describe('File path (absolute or workspace-relative)'),
        old_str: z.string().describe('The original text block to replace'),
        new_str: z.string().describe('The replacement text'),
      }),
      execute: async ({ path: filePath, old_str, new_str }: { path: string; old_str: string; new_str: string }) => {
        try {
          const { diff_match_patch } = await import('diff-match-patch');
          const dmp = new diff_match_patch();
          const absPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(getWorkspaceDir(), filePath);
          const content = await fs.readFile(absPath, 'utf-8');
          const patches = dmp.patch_make(old_str, new_str);
          const [result, applied] = dmp.patch_apply(patches, content);
          const failCount = (applied as boolean[]).filter((b) => !b).length;
          if (failCount > 0)
            return `Warning: ${failCount}/${applied.length} patch hunks failed to apply in ${filePath}`;
          await fs.writeFile(absPath, result, 'utf-8');
          return `Done: all ${applied.length} patch hunks applied to ${filePath}`;
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    // ── Skill library ─────────────────────────────────────────────────────────
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

    // ── Web search ───────────────────────────────────────────────────────────
    web_search: tool({
      description:
        'Search the web for current information. Use this when the user asks about ' +
        'recent events, facts, or anything that may require up-to-date information. ' +
        'By default results are limited to the past month — use freshness to widen ' +
        '(e.g. "py" for past year, or omit for all time) or tighten ("pw" past week, "pd" past day). ' +
        'Requires BRAVE_API_KEY environment variable.',
      inputSchema: z.object({
        query: z.string().describe('The search query'),
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Number of results to return (default 5)'),
        freshness: z
          .enum(['pd', 'pw', 'pm', 'py'])
          .optional()
          .describe(
            'Limit results by discovery date: pd=past day, pw=past week, pm=past month (default), py=past year. ' +
            'Omit only for historical or timeless queries.',
          ),
      }) as any,
      execute: async (input: { query: string; count?: number; freshness?: string }) => {
        const runSearch = async (): Promise<string> => {
          const apiKey = configManager.getSecrets().tools?.braveApiKey ?? process.env.BRAVE_API_KEY;
          if (!apiKey) return 'Web search is not configured (set tools.braveApiKey in secrets.yaml or BRAVE_API_KEY env var).';

          const client = new BraveSearch(apiKey);
          const count = input.count ?? 5;
          const freshness = (input.freshness ?? FreshnessOption.PastMonth) as FreshnessOption;

          try {
            const response = await client.webSearch(input.query, { count, freshness });
            const results = response.web?.results ?? [];

            if (results.length === 0) return 'No results found.';

            return results
              .map((r, i) =>
                `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description ?? ''}`,
              )
              .join('\n\n');
          } catch (err) {
            return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        };

        const myRun = webSearchQueue
          .then((prevStarted) =>
            prevStarted ? new Promise<void>((r) => setTimeout(r, 1000)) : undefined
          )
          .then(runSearch);
        webSearchQueue = myRun.then(() => true);
        return myRun;
      },
    } as any),

    // ── Web fetch ─────────────────────────────────────────────────────────────
    web_fetch: tool({
      description:
        'Fetch content from a URL. Returns the response body as text. ' +
        'Supports custom headers, HTTP methods, and request body. ' +
        'Use this to retrieve web page content, API responses, or any public URL content.',
      inputSchema: z.object({
        url: z.string().describe('The URL to fetch'),
        method: z
          .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])
          .optional()
          .describe('HTTP method (default: GET)'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe('Custom headers as key-value pairs'),
        body: z
          .string()
          .optional()
          .describe('Request body for POST/PUT/PATCH methods'),
        timeout: z
          .number()
          .int()
          .min(1000)
          .max(60000)
          .optional()
          .describe('Request timeout in milliseconds (default: 30000)'),
      }) as any,
      execute: async (input: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        timeout?: number;
      }) => {
        const controller = new AbortController();
        const timeout = input.timeout ?? 30_000;
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          const response = await fetch(input.url, {
            method: input.method ?? 'GET',
            headers: input.headers,
            body: input.body,
            signal: controller.signal,
          });

          const contentType = response.headers.get('content-type') ?? '';
          let data: string;

          if (contentType.includes('application/json')) {
            const json = await response.json();
            data = JSON.stringify(json, null, 2);
          } else {
            data = await response.text();
          }

          return `Status: ${response.status} ${response.statusText}\n` +
            `Content-Type: ${contentType}\n\n` +
            data;
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            return `Request timed out after ${timeout}ms`;
          }
          return `Fetch failed: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          clearTimeout(timeoutId);
        }
      },
    } as any),

    // ── Long-term memory (RAG) ────────────────────────────────────────────────
    rag_search: tool({
      description:
        'Search long-term memory (Qdrant vector store) for information relevant to a query. ' +
        'Use this when the user references something from a past conversation or asks about ' +
        'something you might have stored. Returns the most relevant memory excerpts. ' +
        'This is semantic search — it finds conceptually similar content, not exact matches.',
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

    // ── Core Memory (MEMORY.md) ───────────────────────────────────────────────
    memory_read: tool({
      description:
        'Read the contents of MEMORY.md — the persistent scratchpad for important user ' +
        'preferences and facts. Always available in the system prompt, but call this tool ' +
        'to get the latest version mid-conversation.',
      inputSchema: z.object({}),
      execute: async () => memoryManager.getContent() || '(MEMORY.md is empty)',
    }),

    memory_append: tool({
      description:
        'Append a fragment to MEMORY.md. Use this to add new preferences, facts, or ' +
        'instructions that should persist across conversations. Multiple fragments are ' +
        'separated by blank lines. Prefer this over overwriting — use memory_delete to remove.',
      inputSchema: z.object({
        content: z.string().describe('The fragment to append to MEMORY.md'),
      }),
      execute: async (input: { content: string }) => {
        memoryManager.append(input.content);
        return 'Fragment appended to MEMORY.md.';
      },
    }),

    memory_delete: tool({
      description:
        'Delete a fragment from MEMORY.md by exact text match. Use this to remove outdated ' +
        'or incorrect information. The fragment must match exactly (including whitespace).',
      inputSchema: z.object({
        fragment: z.string().describe('The exact fragment to delete from MEMORY.md'),
      }),
      execute: async (input: { fragment: string }) => {
        const deleted = memoryManager.delete(input.fragment);
        return deleted ? 'Fragment deleted from MEMORY.md.' : 'Fragment not found in MEMORY.md.';
      },
    }),

    // ── Secret request ────────────────────────────────────────────────────────
    ...(opts?.telegramChatId && opts?.sendTelegramMessage
      ? {
          request_secret: tool({
            description:
              'Request a sensitive value (password, token, API key, or any credential) from the user ' +
              'via a secure one-time web link. Call this tool with a short name and a clear reason. ' +
              'The secure link will be sent to the user automatically. You will receive a unique request ID. ' +
              'When the user submits or declines, you will be notified automatically in this conversation. ' +
              'You do NOT need to poll or call any other tool to retrieve the value.',
            inputSchema: z.object({
              name: z.string().describe('Short label for the requested secret, e.g. "GitHub token"'),
              reason: z
                .string()
                .describe('Clear explanation of why you need this secret and what it will be used for'),
              flavourText: z
                .string()
                .optional()
                .describe('Optional friendly message to include when prompting the user for the secret'),
            }) as any,
            execute: async (input: { name: string; reason: string; flavourText?: string }) => {
              const uid = crypto.randomUUID();
              const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
              const url = `${publicBaseUrl}/retrieve-secret/${uid}`;
              await createSecretRequest(uid, input.name, input.reason, opts!.telegramChatId!);

              const userMessage = `🔐 <b>Secret Request</b>\n\n` +
                `I need <b>${input.name}</b> for:\n${input.reason}\n\n` +
                `Please provide it securely here:\n${url}\n\n` +
                `<i>This link expires in 15 minutes.</i>` +
                (input.flavourText ? `\n\n${input.flavourText}` : '');

              await opts.sendTelegramMessage!(opts.telegramChatId!, userMessage, 'html');

              return `Secret request sent. Request ID: ${uid}`;
            },
          } as any),
        }
      : {}),

    // ── Scheduling ────────────────────────────────────────────────────────────
    ...(opts?.telegramChatId ? getSchedulingTools(opts.telegramChatId) : {}),

    // ── Workflow ──────────────────────────────────────────────────────────────
    workflow_list: tool({
      description:
        'List all non-archived workflows (draft and active) with their id, name, and description. ' +
        'Use this to discover available workflows before triggering one with workflow_run.',
      inputSchema: z.object({}) as any,
      execute: async () => {
        const allowedWf = opts?.allowedWorkflows;
        const query = db
          .select({ id: workflowsTable.id, name: workflowsTable.name, description: workflowsTable.description, status: workflowsTable.status })
          .from(workflowsTable);
        const rows = await (Array.isArray(allowedWf) && allowedWf.length > 0
          ? query.where(inArray(workflowsTable.id, allowedWf))
          : Array.isArray(allowedWf) && allowedWf.length === 0
            ? Promise.resolve([])
            : query.where(ne(workflowsTable.status, 'archived')));
        const filtered = Array.isArray(allowedWf)
          ? rows
          : rows.filter(r => r.status !== 'archived');
        return filtered.length === 0 ? 'No workflows found.' : JSON.stringify(filtered, null, 2);
      },
    } as any),

    workflow_run: tool({
      description:
        'Trigger a workflow by id. Optionally pass a free-text input message as trigger data — ' +
        'downstream nodes can access it as triggerData.message. ' +
        'HITL nodes in the workflow send an approval request to the triggering Telegram chat. ' +
        'Use workflow_list to find valid workflow ids.',
      inputSchema: z.object({
        workflow_id: z.string().describe('The workflow id to trigger'),
        input: z.string().optional().describe('Optional free-text message passed as triggerData.message to the workflow input node'),
      }) as any,
      execute: async (inp: { workflow_id: string; input?: string }) => {
        if (Array.isArray(opts?.allowedWorkflows) && !(opts.allowedWorkflows as string[]).includes(inp.workflow_id)) {
          return `Workflow "${inp.workflow_id}" not found.`;
        }
        const [wf] = await db
          .select({ status: workflowsTable.status })
          .from(workflowsTable)
          .where(eq(workflowsTable.id, inp.workflow_id))
          .limit(1);
        if (!wf) return `Workflow "${inp.workflow_id}" not found.`;
        if (wf.status === 'archived') return `Workflow "${inp.workflow_id}" is archived and cannot be run.`;
        const chatId = opts?.telegramChatId ?? 'agent';
        const triggerData: Record<string, unknown> = inp.input ? { message: inp.input } : {};
        try {
          const runId = await workflowEngine.createRun(inp.workflow_id, triggerData, chatId);
          return JSON.stringify({ runId, workflow_id: inp.workflow_id, status: 'started' });
        } catch (err) {
          return `Failed to start workflow: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    } as any),

    // ── Agent Browser ─────────────────────────────────────────────────────────
    ...(isBrowserEnabled()
      ? {
          browser_navigate: tool({
            description:
              'Open a URL in the headless browser. Call this first before any other browser tools. ' +
              'The browser session persists until browser_close is called. ' +
              'Returns the page title and URL after navigation.',
            inputSchema: z.object({
              url: z.string().describe('URL to open'),
              wait: z
                .enum(['load', 'networkidle', 'domcontentloaded'])
                .optional()
                .describe('Wait condition after navigation (default: load)'),
            }) as any,
            execute: async (input: { url: string; wait?: string }) => {
              const waitFlag = input.wait
                ? ` && ${getBrowserBin()} wait --load ${input.wait}`
                : '';
              return runBrowser(`open ${JSON.stringify(input.url)}${waitFlag}`);
            },
          } as any),

          browser_snapshot: tool({
            description:
              'Get the accessibility tree of the current page. ' +
              'Returns element references like @e1, @e2 that can be passed to browser_act. ' +
              'Always call this after browser_navigate to understand the page structure. ' +
              'Set interactive_only: true (default) to only return clickable/fillable elements.',
            inputSchema: z.object({
              interactive_only: z
                .boolean()
                .optional()
                .describe('Only return interactive elements (default: true)'),
              depth: z
                .number()
                .int()
                .min(1)
                .max(20)
                .optional()
                .describe('Limit tree depth (useful for large pages)'),
            }) as any,
            execute: async (input: { interactive_only?: boolean; depth?: number }) => {
              const flags = [
                (input.interactive_only ?? true) ? '-i' : '',
                input.depth ? `-d ${input.depth}` : '',
              ]
                .filter(Boolean)
                .join(' ');
              return runBrowser(`snapshot ${flags}`);
            },
          } as any),

          browser_get: tool({
            description:
              'Read information from the current page. ' +
              'Use "url" or "title" for page-level info. ' +
              'Use "text" with a CSS selector or @ref to extract element text. ' +
              'Use "value" to read input field values.',
            inputSchema: z.object({
              what: z
                .enum(['text', 'html', 'value', 'title', 'url', 'count'])
                .describe('What to retrieve'),
              selector: z
                .string()
                .optional()
                .describe('CSS selector or @ref (e.g. @e1). Required for text/html/value/count.'),
            }) as any,
            execute: async (input: { what: string; selector?: string }) => {
              const sel = input.selector ? ` ${JSON.stringify(input.selector)}` : '';
              return runBrowser(`get ${input.what}${sel}`);
            },
          } as any),

          browser_act: tool({
            description:
              'Perform an action in the browser that modifies page state. Requires user approval. ' +
              'Use refs from browser_snapshot (e.g. @e1) as the selector — they are more reliable than CSS selectors. ' +
              'Actions: click, fill (clear+type), type (append text), press (key like "Enter"/"Tab"), ' +
              'check/uncheck (checkboxes), scroll (up/down/left/right), back, forward, reload.',
            inputSchema: z.object({
              action: z
                .enum([
                  'click',
                  'fill',
                  'type',
                  'press',
                  'check',
                  'uncheck',
                  'scroll',
                  'back',
                  'forward',
                  'reload',
                ])
                .describe('The action to perform'),
              selector: z
                .string()
                .optional()
                .describe('CSS selector or @ref. Required for click/fill/type/check/uncheck.'),
              value: z
                .string()
                .optional()
                .describe(
                  'Text for fill/type, key name for press (e.g. "Enter"), direction for scroll (up/down/left/right).',
                ),
            }) as any,
            execute: async (input: { action: string; selector?: string; value?: string }) => {
              const approved = await requestAndWait('browser_act', input, send);
              if (!approved) return 'browser_act was denied by the user.';

              let cmd: string;
              switch (input.action) {
                case 'click':
                case 'check':
                case 'uncheck':
                  cmd = `${input.action} ${JSON.stringify(input.selector ?? '')}`;
                  break;
                case 'fill':
                case 'type':
                  cmd = `${input.action} ${JSON.stringify(input.selector ?? '')} ${JSON.stringify(input.value ?? '')}`;
                  break;
                case 'press':
                  cmd = `press ${JSON.stringify(input.value ?? '')}`;
                  break;
                case 'scroll':
                  cmd = `scroll ${input.value ?? 'down'}`;
                  break;
                case 'back':
                case 'forward':
                case 'reload':
                  cmd = input.action;
                  break;
                default:
                  return `Unknown action: ${input.action}`;
              }
              return runBrowser(cmd);
            },
          } as any),

          browser_screenshot: tool({
            description:
              'Take a screenshot of the current page and save it to a file. ' +
              'Returns the file path — pass it to send_file to send the image to Telegram. ' +
              'Set full_page: true to capture the entire page height, not just the visible viewport.',
            inputSchema: z.object({
              filename: z
                .string()
                .optional()
                .describe('Output filename (default: auto-generated in workspace dir)'),
              full_page: z
                .boolean()
                .optional()
                .describe('Capture full page height (default: false)'),
              annotate: z
                .boolean()
                .optional()
                .describe('Overlay numbered labels on interactive elements'),
            }) as any,
            execute: async (input: { filename?: string; full_page?: boolean; annotate?: boolean }) => {
              const outPath = input.filename
                ? path.resolve(getWorkspaceDir(), input.filename)
                : path.join(getWorkspaceDir(), `screenshot-${Date.now()}.png`);
              const flags = [input.full_page ? '--full' : '', input.annotate ? '--annotate' : '']
                .filter(Boolean)
                .join(' ');
              await runBrowser(`screenshot ${flags} ${JSON.stringify(outPath)}`);
              return outPath;
            },
          } as any),

          browser_close: tool({
            description:
              'Close the browser session and release all resources. ' +
              'Call this when you are done browsing.',
            inputSchema: z.object({}) as any,
            execute: async () => {
              return runBrowser('close');
            },
          } as any),
        }
      : {}),

    // ── Todo list ────────────────────────────────────────────────────────────
    ...(memoryChatId ? {
      todo_create: tool({
        description:
          'Clear the existing todo list and start a new one with a high-level goal and tasks. ' +
          'Use this at the start of any multi-step or non-trivial task.',
        inputSchema: z.object({
          goal: z.string().describe('High-level goal for this task, e.g. "Fix authentication bug"'),
          todos: z.array(z.string()).min(1).describe('List of task descriptions to work through'),
        }) as any,
        execute: async (input: { goal: string; todos: string[] }) => {
          const list = {
            goal: input.goal,
            todos: input.todos.map(text => ({ id: crypto.randomUUID(), text, done: false })),
          };
          todoManager.save(memoryChatId, list);
          return `Todo list created.\n${todoManager.format(list)}`;
        },
      } as any),

      todo_add: tool({
        description: 'Append one or more tasks to the current todo list.',
        inputSchema: z.object({
          todos: z.array(z.string()).min(1).describe('Task descriptions to add'),
        }) as any,
        execute: async (input: { todos: string[] }) => {
          const existing = todoManager.load(memoryChatId) ?? { goal: '', todos: [] };
          const newItems = input.todos.map(text => ({ id: crypto.randomUUID(), text, done: false }));
          const list = { ...existing, todos: [...existing.todos, ...newItems] };
          todoManager.save(memoryChatId, list);
          return `Tasks added.\n${todoManager.format(list)}`;
        },
      } as any),

      todo_update: tool({
        description:
          'Update a task in the todo list — mark it done/undone or change its text. ' +
          'Use the first 8 characters of the task id shown in the list.',
        inputSchema: z.object({
          id: z.string().describe('Task id or id prefix (first 8 chars)'),
          done: z.boolean().describe('New completion status'),
          text: z.string().optional().describe('New task text (omit to keep existing)'),
        }) as any,
        execute: async (input: { id: string; done: boolean; text?: string }) => {
          const list = todoManager.load(memoryChatId);
          if (!list) return 'No todo list exists. Use todo_create to start one.';
          const item = list.todos.find(t => t.id.startsWith(input.id));
          if (!item) return `Task with id prefix "${input.id}" not found.`;
          item.done = input.done;
          if (input.text) item.text = input.text;
          todoManager.save(memoryChatId, list);
          return `Task updated.\n${todoManager.format(list)}`;
        },
      } as any),

      todo_clear: tool({
        description: 'Clear the todo list entirely once a task is fully complete.',
        inputSchema: z.object({}) as any,
        execute: async () => {
          todoManager.clear(memoryChatId);
          return 'Todo list cleared.';
        },
      } as any),

      // ── Resume specialist task ─────────────────────────────────────────────────
      resume_specialist: tool({
        description:
          'Resume a specialist task that hit the max steps limit or has completed. ' +
          'Use this when the user asks to resume a background task or wants to continue working on a completed task. ' +
          'You can find the job_id from the max steps or completion notification message. ' +
          'For completed jobs, provide guidance on what to do differently.',
        inputSchema: z.object({
          job_id: z.string().describe('The job ID of the task to resume'),
          additional_steps: z.number().optional().describe('Additional steps to allow (default: same as original limit)'),
          guidance: z.string().optional().describe('Additional guidance for what to do differently (especially for completed jobs)'),
        }) as any,
        execute: async (input: { job_id: string; additional_steps?: number; guidance?: string }) => {
          const job = await getJobById(input.job_id);
          if (!job) return `Job not found: ${input.job_id}`;

          // Allow resume from completed or max_steps_reached
          const validStatuses = ['completed', 'max_steps_reached'];
          if (!validStatuses.includes(job.status)) {
            return `Job ${input.job_id} is not in a resumable status (current: ${job.status}). Only 'completed' or 'max_steps_reached' jobs can be resumed.`;
          }

          const chatId = job.chatId;
          const newJobId = await createResumedJob(job, input.additional_steps, input.guidance);
          await schedulerService.scheduleOnce(newJobId, chatId, job.taskDescription, 0, { specialistId: newJobId });
          await updateJobStatus(input.job_id, 'completed', undefined, 'Resumed via tool');

          return `Task resumed successfully.\nOriginal job: ${input.job_id.slice(0, 8)}...\nNew job: ${newJobId.slice(0, 8)}...\nAdditional steps: ${input.additional_steps ?? job.maxStepsUsed ?? 15}`;
        },
      } as any),

      // ── Request user guidance ─────────────────────────────────────────────────
      request_guidance: tool({
        description:
          'Request guidance from the user before continuing. ' +
          'Use as a LAST RESORT when you need user confirmation or direction that you cannot determine autonomously. ' +
          'Examples: reviewing an implementation plan before executing, choosing between approaches, confirming sensitive operations. ' +
          'Before calling this, try to proceed with your best judgment or provide options. ' +
          'The agent should do as much work as possible before requesting input.',
        inputSchema: z.object({
          prompt: z.string().describe('Clear question or context for the user'),
          options: z.array(z.string()).optional().describe('If user should choose from specific options'),
        }) as any,
        execute: async (input: { prompt: string; options?: string[] }, params?: { chatId?: string }) => {
          const chatId = params?.chatId ?? memoryChatId;
          if (!chatId) return 'Cannot determine chat ID for user input request';

          // Create user input request in DB
          const inputId = await createUserInput({
            chatId,
            prompt: input.prompt,
            options: input.options,
          });

          // Emit event so Telegram handler can send prompt to user
          emitUserInputRequest({
            id: crypto.randomUUID(),
            inputId,
            chatId,
            prompt: input.prompt,
            options: input.options,
            timestamp: new Date().toISOString(),
          });

          // Poll for user response (max 5 minutes)
          const startTime = Date.now();
          const pollInterval = 2000; // 2 seconds

          while (Date.now() - startTime < 300000) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));

            const userInput = await getUserInput(inputId);
            if (!userInput) {
              return 'User input request expired or was cancelled.';
            }

            if (userInput.status === 'responded' && userInput.response) {
              return `User guidance provided: ${userInput.response}`;
            }

            if (userInput.status === 'expired') {
              return 'User input request timed out.';
            }
          }

          return 'User input request timed out after 5 minutes.';
        },
      } as any),
    } : {}),
  };
}
