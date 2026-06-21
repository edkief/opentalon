import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { getWorkspaceDir } from './skills';
import type { BuiltInToolsOpts } from './types';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_LINES = 500;
const MAX_GLOB_RESULTS = 100;
const EXEC_TIMEOUT = 30_000;
const EXEC_BUFFER = 4 * 1024 * 1024; // 4 MB

let ripgrepAvailable: boolean | null = null;

/** Memoized check for a system `rg` binary on PATH. */
async function hasRipgrep(): Promise<boolean> {
  if (ripgrepAvailable !== null) return ripgrepAvailable;
  try {
    await execFileAsync('rg', ['--version'], { timeout: 5_000 });
    ripgrepAvailable = true;
  } catch {
    ripgrepAvailable = false;
  }
  return ripgrepAvailable;
}

function resolvePath(p?: string): string {
  const base = getWorkspaceDir();
  if (!p) return base;
  return path.isAbsolute(p) ? p : path.join(base, p);
}

/**
 * Run a search binary that exits 1 on "no matches" (rg, grep). Returns stdout
 * even when the exit code is 1 so an empty result isn't treated as an error.
 */
async function runSearch(cmd: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      timeout: EXEC_TIMEOUT,
      maxBuffer: EXEC_BUFFER,
    });
    return stdout;
  } catch (err: unknown) {
    // Exit code 1 = no matches (not an error for our purposes)
    const e = err as { code?: number; stdout?: string };
    if (e && e.code === 1) return e.stdout ?? '';
    throw err;
  }
}

function truncateLines(text: string, limit: number): string {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length <= limit) {
    return `${lines.length} result${lines.length === 1 ? '' : 's'}\n${lines.join('\n')}`;
  }
  const shown = lines.slice(0, limit);
  return `${lines.length} results (showing first ${limit})\n${shown.join('\n')}`;
}

export function getCodeSearchTools(_opts?: BuiltInToolsOpts): ToolSet {
  return {
    grep: tool({
      description:
        'Search file contents with a regular expression across the workspace. ' +
        'Uses ripgrep when available (respects .gitignore, skips VCS dirs) and falls back to grep. ' +
        'Use output_mode to control results: "content" (matching lines), "files_with_matches" ' +
        '(file paths only, the default), or "count" (per-file match counts).',
      inputSchema: z.object({
        pattern: z.string().describe('Regular expression to search for'),
        path: z.string().optional().describe('Directory or file to search in (absolute or workspace-relative). Defaults to the workspace root.'),
        glob: z.string().optional().describe('Glob to filter which files are searched, e.g. "*.ts" or "**/*.{js,tsx}"'),
        output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('Result format. Defaults to "files_with_matches".'),
        case_insensitive: z.boolean().optional().describe('Case-insensitive matching'),
        context: z.number().int().min(0).max(20).optional().describe('Lines of context before and after each match (content mode only)'),
        head_limit: z.number().int().min(1).optional().describe('Cap the number of result lines returned'),
      }),
      execute: async ({ pattern, path: searchPath, glob, output_mode, case_insensitive, context, head_limit }) => {
        const mode = output_mode ?? 'files_with_matches';
        const limit = Math.min(head_limit ?? MAX_OUTPUT_LINES, MAX_OUTPUT_LINES);
        const target = resolvePath(searchPath);
        const cwd = getWorkspaceDir();
        try {
          if (await hasRipgrep()) {
            const args: string[] = [];
            if (case_insensitive) args.push('-i');
            if (mode === 'files_with_matches') args.push('-l');
            else if (mode === 'count') args.push('-c');
            else {
              args.push('-n');
              if (context && context > 0) args.push('-C', String(context));
            }
            if (glob) args.push('-g', glob);
            args.push('-e', pattern, target);
            const out = await runSearch('rg', args, cwd);
            if (!out.trim()) return 'No matches found.';
            return truncateLines(out, limit);
          }
          // Fallback: POSIX grep -r
          const args: string[] = ['-r', '-E'];
          if (case_insensitive) args.push('-i');
          if (mode === 'files_with_matches') args.push('-l');
          else if (mode === 'count') args.push('-c');
          else {
            args.push('-n');
            if (context && context > 0) args.push('-C', String(context));
          }
          if (glob) args.push(`--include=${glob}`);
          // Skip common VCS/dependency dirs that rg would ignore by default
          for (const d of ['.git', 'node_modules', '.next']) args.push(`--exclude-dir=${d}`);
          args.push('-e', pattern, target);
          const out = await runSearch('grep', args, cwd);
          if (!out.trim()) return 'No matches found.';
          return truncateLines(out, limit);
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    glob: tool({
      description:
        'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.{js,tsx}"). ' +
        'Uses ripgrep when available (respects .gitignore) and falls back to find. ' +
        `Returns up to ${MAX_GLOB_RESULTS} matching file paths.`,
      inputSchema: z.object({
        pattern: z.string().describe('Glob pattern to match file paths against'),
        path: z.string().optional().describe('Directory to search in (absolute or workspace-relative). Defaults to the workspace root.'),
      }),
      execute: async ({ pattern, path: searchPath }) => {
        const target = resolvePath(searchPath);
        const cwd = getWorkspaceDir();
        try {
          let out: string;
          if (await hasRipgrep()) {
            out = await runSearch('rg', ['--files', '-g', pattern, target], cwd);
          } else {
            // Fallback: find with -path matching, translating ** loosely to *
            out = await runSearch('find', [target, '-type', 'f', '-name', path.basename(pattern)], cwd);
          }
          const files = out.split('\n').filter((l) => l.length > 0);
          if (files.length === 0) return 'No files matched.';
          if (files.length > MAX_GLOB_RESULTS) {
            return `${files.length} files matched (showing first ${MAX_GLOB_RESULTS})\n${files.slice(0, MAX_GLOB_RESULTS).join('\n')}`;
          }
          return `${files.length} file${files.length === 1 ? '' : 's'} matched\n${files.join('\n')}`;
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
