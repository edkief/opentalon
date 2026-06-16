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
import type { BuiltInToolsOpts } from './types';

const execAsync = promisify(exec);

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

export function getTerminalTools(opts?: BuiltInToolsOpts): ToolSet {
  const send = opts?.sendApprovalRequest;
  const shellEnv: Record<string, string> = {};
  if (opts?.telegramChatId) shellEnv['TELEGRAM_CHAT_ID'] = opts.telegramChatId;

  return {
    run_command: tool({
      description:
        'Run an arbitrary shell command on the local machine. ' +
        'Supports pipes, redirects, and shell syntax. Requires user approval. ' +
        'TELEGRAM_CHAT_ID and TELEGRAM_BOT_TOKEN are available as environment variables.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute'),
        cwd: z.string().optional().describe('Working directory (defaults to process cwd)'),
      }),
      execute: async (input: { command: string; cwd?: string }) => {
        const approved = await requestAndWait('run_command', input, send);
        if (!approved) return 'Action "run_command" was denied by the user.';
        try {
          return await runShell(input.command, input.cwd, shellEnv);
        } catch (err) {
          return `Command failed: ${err instanceof Error ? err.message : String(err)}`;
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
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

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
  };
}
