import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configManager } from '../config';
import { getWorkspaceDir } from './skills';
import { requestAndWait } from './approval';
import { toolError, errorMessage } from './errors';
import type { BuiltInToolsOpts } from './types';

const execAsync = promisify(exec);

function getCommandTimeoutMs(): number {
  return configManager.get().tools?.commandTimeoutMs ?? 30_000;
}

// Resolved per call (not at tool creation) so secrets hot-reload takes effect.
// Classic PAT wins: it covers API surfaces (e.g. Projects v2 GraphQL) that
// fine-grained tokens cannot reach, while git push/pull still goes through the
// credential helper with the fine-grained token.
function getGitHubTokenEnv(): Record<string, string> {
  const git = configManager.getSecrets().git;
  const token = git?.classicPat ?? git?.pat;
  return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
}

async function runShell(command: string, cwd?: string, extraEnv?: Record<string, string>): Promise<string> {
  const shell = configManager.get().tools?.shell ?? process.env.SHELL ?? '/bin/bash';
  const timeoutMs = getCommandTimeoutMs();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd ?? getWorkspaceDir(),
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
      shell,
      env: { ...process.env, ...getGitHubTokenEnv(), ...extraEnv },
    });
    return [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n') || '(no output)';
  } catch (err: unknown) {
    // Node kills the process and sets `.killed` when the timeout fires —
    // surface a distinguishable message so the model knows to shorten the
    // command or split it up, rather than treating it as a generic failure.
    const e = err as { killed?: boolean; signal?: string };
    if (e?.killed) {
      throw new Error(`run_command timed out after ${timeoutMs}ms and was killed`);
    }
    throw err;
  }
}

export function getTerminalTools(opts?: BuiltInToolsOpts): ToolSet {
  const send = opts?.sendApprovalRequest;
  const shellEnv: Record<string, string> = {};
  if (opts?.chatId) shellEnv['TELEGRAM_CHAT_ID'] = opts.chatId;

  return {
    run_command: tool({
      // Description is intentionally short and STATIC — cross-cutting guidance
      // (timeout, available env vars, approval) lives once in the system prompt
      // under "Shell command execution". Embedding the configured timeout value
      // here would bust the Anthropic prompt cache on every config change, since
      // the tools array is part of the cached request prefix (see #20).
      description:
        'Run an arbitrary shell command on the local machine (supports pipes, redirects, and shell syntax) ' +
        'and return its combined stdout/stderr. Requires user approval. See "Shell command execution" in the ' +
        'system prompt for the timeout and available environment variables.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute'),
        cwd: z.string().optional().describe('Working directory (defaults to process cwd)'),
      }),
      execute: async (input: { command: string; cwd?: string }) => {
        const approved = await requestAndWait('run_command', input, send);
        if (approved === 'timeout') return 'Error: run_command approval request timed out — the user did not respond in time. You may ask them to retry.';
        if (approved !== 'approved') return 'Error: run_command was denied by the user.';
        try {
          return await runShell(input.command, input.cwd, shellEnv);
        } catch (err) {
          // Unexpected/infrastructure failure (nonzero exit, timeout, missing
          // shell, etc.) — throw so the SDK surfaces a structured tool-error
          // part instead of a string the model could mistake for output.
          toolError(`run_command failed: ${errorMessage(err)}`);
        }
      },
    }),

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
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          if (e?.code === 'ENOENT') return `Error: file not found: ${filePath}`;
          toolError(`Failed to read ${filePath}: ${errorMessage(err)}`);
        }
      },
    }),

    write_file: tool({
      description:
        'Create a new file or overwrite an existing file with the given content. ' +
        'Parent directories are created automatically. ' +
        'Use this to create new files; use str_replace_based_edit for targeted edits to existing files.',
      inputSchema: z.object({
        path: z.string().describe('File path (absolute or workspace-relative)'),
        content: z.string().describe('Full file content to write'),
      }),
      execute: async ({ path: filePath, content }: { path: string; content: string }) => {
        try {
          const absPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(getWorkspaceDir(), filePath);
          let existed = true;
          try {
            await fs.access(absPath);
          } catch {
            existed = false;
          }
          await fs.mkdir(path.dirname(absPath), { recursive: true });
          await fs.writeFile(absPath, content, 'utf-8');
          const bytes = Buffer.byteLength(content, 'utf-8');
          return `Done: ${existed ? 'overwrote' : 'created'} ${filePath} (${bytes} bytes)`;
        } catch (err) {
          toolError(`Failed to write ${filePath}: ${errorMessage(err)}`);
        }
      },
    }),

    str_replace_based_edit: tool({
      description:
        'Replace an exact string in a file with a new string. ' +
        'By default old_str must match exactly one occurrence in the file. ' +
        'Set replace_all to true to replace every occurrence. ' +
        'Use this for targeted, precise file edits.',
      inputSchema: z.object({
        path: z.string().describe('File path (absolute or workspace-relative)'),
        old_str: z.string().describe('Exact string to replace — must appear exactly once unless replace_all is true'),
        new_str: z.string().describe('Replacement string'),
        replace_all: z.boolean().optional().describe('Replace all occurrences instead of requiring a single match'),
      }),
      execute: async ({ path: filePath, old_str, new_str, replace_all }: { path: string; old_str: string; new_str: string; replace_all?: boolean }) => {
        try {
          const absPath = path.isAbsolute(filePath)
            ? filePath
            : path.join(getWorkspaceDir(), filePath);
          const content = await fs.readFile(absPath, 'utf-8');
          const count = content.split(old_str).length - 1;
          if (count === 0) return `Error: old_str not found in ${filePath}`;
          if (replace_all) {
            await fs.writeFile(absPath, content.split(old_str).join(new_str), 'utf-8');
            return `Done: replaced ${count} occurrence${count === 1 ? '' : 's'} in ${filePath}`;
          }
          if (count > 1) return `Error: old_str matches ${count} locations in ${filePath} — make it more specific or set replace_all`;
          await fs.writeFile(absPath, content.replace(old_str, new_str), 'utf-8');
          return `Done: replaced 1 occurrence in ${filePath}`;
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          if (e?.code === 'ENOENT') return `Error: file not found: ${filePath}`;
          toolError(`Failed to edit ${filePath}: ${errorMessage(err)}`);
        }
      },
    }),

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
        } catch (err: unknown) {
          const e = err as NodeJS.ErrnoException;
          if (e?.code === 'ENOENT') return `Error: file not found: ${filePath}`;
          toolError(`Failed to patch ${filePath}: ${errorMessage(err)}`);
        }
      },
    }),
  };
}
