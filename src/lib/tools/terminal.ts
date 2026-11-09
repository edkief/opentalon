import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { configManager } from '../config';
import { getWorkspaceDir } from './skills';
import { requestAndWait } from './approval';
import { toolError, errorMessage } from './errors';
import type { BuiltInToolsOpts } from './types';

/**
 * Per-file mutex so concurrent read-modify-write tool calls (write_file,
 * str_replace_based_edit, fuzzy_patch) targeting the same path serialize
 * instead of racing. The AI SDK executes multiple tool calls issued within a
 * single model step concurrently, so without this, a batch of edits to the
 * same file all read the same pre-edit content and whichever write lands last
 * silently overwrites the others — the tool reports "success" for every call,
 * but earlier edits vanish with no error (see #30).
 */
const fileLocks = new Map<string, Promise<void>>();
function withFileLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(absPath) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  fileLocks.set(
    absPath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

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

const RUN_SHELL_MAX_BUFFER = 512 * 1024;
/** How long to keep reading the pipes after the shell exits, for output already written. */
const RUN_SHELL_DRAIN_MS = 250;

/**
 * Run a command through the shell and return its combined output.
 *
 * Resolves when the **shell process exits**, not when its stdout/stderr pipes
 * close (#81). `exec` waits for pipe close, and a backgrounded job keeps the
 * pipe open: in `cd x && cmd > log 2>&1 &` the shell backgrounds the whole
 * `cd x && cmd` list as a subshell, the redirect applies to `cmd` only, and the
 * subshell holds the inherited stdout until `cmd` exits. The call then hung
 * until the timeout killed the foreground shell. Here we give the pipes a short
 * drain window after exit, then drop them; the background job keeps running.
 */
export function runShell(command: string, cwd?: string, extraEnv?: Record<string, string>): Promise<string> {
  const shell = configManager.get().tools?.shell ?? process.env.SHELL ?? '/bin/bash';
  const timeoutMs = getCommandTimeoutMs();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(shell, ['-c', command], {
      cwd: cwd ?? getWorkspaceDir(),
      env: { ...process.env, ...getGitHubTokenEnv(), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let failure: Error | null = null;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    const kill = (reason: Error) => {
      if (!failure) failure = reason;
      child.kill('SIGTERM');
    };
    const timer = setTimeout(
      () => kill(new Error(`run_shell timed out after ${timeoutMs}ms and was killed`)),
      timeoutMs,
    );
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > RUN_SHELL_MAX_BUFFER) {
        kill(new Error(`run_shell output exceeded ${RUN_SHELL_MAX_BUFFER} bytes and the command was killed; redirect large output to a file`));
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      const stdout = Buffer.concat(out).toString('utf-8');
      const stderr = Buffer.concat(err).toString('utf-8');
      if (failure) return reject(failure);
      if (exitCode !== 0) {
        const status = exitCode !== null ? `exit ${exitCode}` : `signal ${exitSignal}`;
        const detail = [stderr.trimEnd(), stdout.trimEnd() && `--- stdout ---\n${stdout.trimEnd()}`]
          .filter(Boolean)
          .join('\n');
        return reject(new Error(`Command failed (${status}): ${command}${detail ? `\n${detail}` : ''}`));
      }
      resolve([stdout, stderr].filter(Boolean).join('\n--- stderr ---\n') || '(no output)');
    };

    child.on('error', (e) => {
      if (!failure) failure = e;
      finish();
    });
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Output the shell already wrote may still be in flight. Wait for the
      // pipes to close, but never longer than the drain window: a background
      // job holding them open must not hold up the call.
      const drain = setTimeout(finish, RUN_SHELL_DRAIN_MS);
      child.on('close', () => {
        clearTimeout(drain);
        finish();
      });
    });
  });
}

const WAIT_DEFAULT_SECONDS = 300;
const WAIT_POLL_MS = 1_000;
const WAIT_TAIL_LINES = 20;
/** Only the end of a log is searched for `pattern`, so a huge log stays cheap to poll. */
const WAIT_SCAN_BYTES = 1024 * 1024;
/** Outputs of a wait that ran out of time start with this; see POLLING_TOOLS in loop-breaker.ts. */
export const WAIT_STILL_RUNNING = 'Still running';

function getMaxWaitMs(): number {
  return configManager.get().tools?.maxWaitMs ?? 600_000;
}

/** Whether a pid is still running. A zombie counts as exited: in a pod we may be PID 1 and never reap it. */
async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
    // Field 3, after the parenthesised command name (which may itself hold spaces or parens).
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true; // no procfs (macOS): kill(0) said it exists
  }
}

/** The last `WAIT_SCAN_BYTES` of a file, or null when it doesn't exist yet. */
async function readTail(absPath: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, WAIT_SCAN_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return buf.toString('utf-8');
  } finally {
    await handle.close();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface WaitForInput {
  pid?: number;
  path?: string;
  pattern?: string;
  timeout_seconds?: number;
}

/**
 * Wait, in one tool call, for background work: a pid to exit, a file to
 * appear, or a log line to match (#82). Polling with `sleep` in run_shell cost
 * a step per check and could wait at most the command timeout.
 */
export async function waitFor(input: WaitForInput, signal?: AbortSignal): Promise<string> {
  if (input.pid === undefined && !input.path) return 'Error: give a pid, a path, or both.';
  if (input.pattern && !input.path) return 'Error: pattern needs a path to search.';
  let regex: RegExp | null = null;
  if (input.pattern) {
    try {
      regex = new RegExp(input.pattern, 'm');
    } catch (err) {
      return `Error: invalid pattern: ${errorMessage(err)}`;
    }
  }
  const absPath = input.path
    ? path.isAbsolute(input.path) ? input.path : path.join(getWorkspaceDir(), input.path)
    : null;

  const maxMs = getMaxWaitMs();
  const askedMs = (input.timeout_seconds ?? WAIT_DEFAULT_SECONDS) * 1000;
  const limitMs = Math.min(askedMs, maxMs);
  const clampNote = askedMs > maxMs ? ` (timeout capped at ${maxMs / 1000}s by tools.maxWaitMs)` : '';
  const start = Date.now();
  const elapsed = () => `${Math.round((Date.now() - start) / 1000)}s`;

  const check = async (): Promise<{ done: string | null; text: string | null }> => {
    const text = absPath ? await readTail(absPath) : null;
    if (input.pid !== undefined && !(await pidAlive(input.pid))) {
      return { done: `process ${input.pid} exited (its exit code isn't visible to wait_for; have the command write it to a file)`, text };
    }
    if (regex && text !== null && regex.test(text)) return { done: `pattern /${input.pattern}/ matched in ${input.path}`, text };
    if (absPath && !regex && input.pid === undefined && text !== null) return { done: `${input.path} exists`, text };
    return { done: null, text };
  };

  let state = await check();
  while (!state.done && Date.now() - start < limitMs) {
    await sleep(Math.min(WAIT_POLL_MS, limitMs - (Date.now() - start)), signal);
    state = await check();
  }

  const head = state.done
    ? `Finished after ${elapsed()}: ${state.done}.`
    : `${WAIT_STILL_RUNNING} after ${elapsed()} (wait timed out${clampNote}). Call wait_for again to keep waiting.`;
  if (!absPath) return head;
  if (state.text === null) return `${head}\n${input.path} does not exist yet.`;
  const lines = state.text.replace(/\n$/, '').split('\n').slice(-WAIT_TAIL_LINES);
  return `${head}\n--- last ${lines.length} line(s) of ${input.path} ---\n${lines.join('\n')}`;
}

export function getTerminalTools(opts?: BuiltInToolsOpts): ToolSet {
  const send = opts?.sendApprovalRequest;
  const shellEnv: Record<string, string> = {};
  if (opts?.chatId) shellEnv['TELEGRAM_CHAT_ID'] = opts.chatId;

  return {
    run_shell: tool({
      // Description is intentionally short and STATIC — cross-cutting guidance
      // (timeout, available env vars, approval) lives once in the system prompt
      // under "Shell command execution". Embedding the configured timeout value
      // here would bust the Anthropic prompt cache on every config change, since
      // the tools array is part of the cached request prefix (see #20).
      description:
        'Execute an operating-system shell command on the local machine (supports pipes, redirects, and shell syntax) ' +
        'and return its combined stdout/stderr. Use only for terminal and process operations; it cannot delegate ' +
        'tasks, invoke other agent tools, or replace an unavailable tool. Requires user approval. See "Shell command execution" in the ' +
        'system prompt for the timeout and available environment variables.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to execute'),
        cwd: z.string().optional().describe('Working directory (defaults to process cwd)'),
      }),
      execute: async (input: { command: string; cwd?: string }) => {
        const approved = await requestAndWait('run_shell', input, send);
        if (approved === 'timeout') return 'Error: run_shell approval request timed out — the user did not respond in time. You may ask them to retry.';
        if (approved !== 'approved') return 'Error: run_shell was denied by the user.';
        try {
          return await runShell(input.command, input.cwd, shellEnv);
        } catch (err) {
          // Unexpected/infrastructure failure (nonzero exit, timeout, missing
          // shell, etc.) — throw so the SDK surfaces a structured tool-error
          // part instead of a string the model could mistake for output.
          toolError(`run_shell failed: ${errorMessage(err)}`);
        }
      },
    }),

    wait_for: tool({
      // Static description, like run_shell's: the cap lives in config and is
      // reported at runtime, so the tools array stays cache-stable (#20).
      description:
        'Wait for background work in a single call instead of polling with sleep: until a process exits (pid), ' +
        'a file exists (path), or a file contains a regex match (path + pattern). Returns early when the condition ' +
        'is met, otherwise after timeout_seconds, with the last lines of the file when a path is given. ' +
        'Read-only; needs no approval.',
      inputSchema: z.object({
        pid: z.number().int().positive().optional().describe('Process id to wait on, e.g. from `echo $!` after backgrounding'),
        path: z.string().optional().describe('File to watch (absolute or workspace-relative), e.g. a log or a done-marker'),
        pattern: z.string().optional().describe('Regex to look for in the file (multiline); needs path'),
        timeout_seconds: z.number().int().min(1).optional().describe(`Longest to wait (default ${WAIT_DEFAULT_SECONDS}); capped by the configured maximum`),
      }),
      execute: async (input: WaitForInput, options?: { abortSignal?: AbortSignal }) => {
        try {
          return await waitFor(input, options?.abortSignal);
        } catch (err) {
          if (options?.abortSignal?.aborted) throw err;
          toolError(`wait_for failed: ${errorMessage(err)}`);
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
        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(getWorkspaceDir(), filePath);
        return withFileLock(absPath, async () => {
          try {
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
        });
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
        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(getWorkspaceDir(), filePath);
        return withFileLock(absPath, async () => {
          try {
            const content = await fs.readFile(absPath, 'utf-8');
            const count = content.split(old_str).length - 1;
            if (count === 0) return `Error: old_str not found in ${filePath}`;
            if (!replace_all && count > 1) {
              return `Error: old_str matches ${count} locations in ${filePath} — make it more specific or set replace_all`;
            }
            const newContent = replace_all ? content.split(old_str).join(new_str) : content.replace(old_str, new_str);
            await fs.writeFile(absPath, newContent, 'utf-8');
            // Pre-flight check (#30): re-read and confirm the write actually
            // landed before reporting success, so a lost update (e.g. a
            // concurrent writer outside this process) surfaces as an error
            // instead of a silent no-op.
            const verify = await fs.readFile(absPath, 'utf-8');
            if (verify !== newContent) {
              return `Error: wrote ${filePath} but a re-read shows different content on disk — another process may be writing to this file concurrently. Re-read the file before retrying.`;
            }
            return `Done: replaced ${count} occurrence${count === 1 ? '' : 's'} in ${filePath}`;
          } catch (err: unknown) {
            const e = err as NodeJS.ErrnoException;
            if (e?.code === 'ENOENT') return `Error: file not found: ${filePath}`;
            toolError(`Failed to edit ${filePath}: ${errorMessage(err)}`);
          }
        });
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
        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(getWorkspaceDir(), filePath);
        return withFileLock(absPath, async () => {
          try {
            const { diff_match_patch } = await import('diff-match-patch');
            const dmp = new diff_match_patch();
            const content = await fs.readFile(absPath, 'utf-8');
            const patches = dmp.patch_make(old_str, new_str);
            const [result, applied] = dmp.patch_apply(patches, content);
            const failCount = (applied as boolean[]).filter((b) => !b).length;
            if (failCount > 0)
              return `Warning: ${failCount}/${applied.length} patch hunks failed to apply in ${filePath}`;
            await fs.writeFile(absPath, result, 'utf-8');
            const verify = await fs.readFile(absPath, 'utf-8');
            if (verify !== result) {
              return `Error: wrote ${filePath} but a re-read shows different content on disk — another process may be writing to this file concurrently. Re-read the file before retrying.`;
            }
            return `Done: all ${applied.length} patch hunks applied to ${filePath}`;
          } catch (err: unknown) {
            const e = err as NodeJS.ErrnoException;
            if (e?.code === 'ENOENT') return `Error: file not found: ${filePath}`;
            toolError(`Failed to patch ${filePath}: ${errorMessage(err)}`);
          }
        });
      },
    }),
  };
}
