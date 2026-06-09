import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';
import { configManager } from '../config';
import { getWorkspaceDir } from './skills';

// ─── Internal MCP client (lazy, cached per url) ───────────────────────────────

let cachedClient: Client | null = null;
let cachedUrl: string | null = null;

async function getClient(): Promise<Client> {
  const cfg = configManager.get().tools?.talonpress;
  if (!cfg?.url) throw new Error('TalonPress is not configured (set tools.talonpress.url in config.yaml).');

  if (cachedClient && cachedUrl === cfg.url) return cachedClient;

  const client = new Client({ name: 'opentalon', version: '1.0.0' });
  const url = new URL(cfg.url);
  const requestInit: RequestInit = cfg.headers ? { headers: cfg.headers } : {};

  const transport =
    cfg.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });

  await client.connect(transport);

  cachedClient = client;
  cachedUrl = cfg.url;
  return client;
}

async function callTalonpress(toolName: string, args: Record<string, unknown>): Promise<string> {
  try {
    const client = await getClient();
    const result = await client.callTool({ name: toolName, arguments: args });
    const textParts = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text as string);
    return textParts.join('\n') || JSON.stringify(result.content);
  } catch (err) {
    // Reset cached client so next call reconnects
    cachedClient = null;
    cachedUrl = null;
    throw err;
  }
}

// ─── Folder walker ────────────────────────────────────────────────────────────

interface FileEntry {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build']);

async function readFileEntry(full: string, base: string): Promise<FileEntry> {
  const relativePosix = path.relative(base, full).split(path.sep).join('/');
  const buf = await fs.readFile(full);
  // Binary detection: scan first 8 KB for null bytes
  const probe = buf.subarray(0, 8192);
  const isBinary = probe.includes(0x00);
  return isBinary
    ? { path: relativePosix, content: buf.toString('base64'), encoding: 'base64' }
    : { path: relativePosix, content: buf.toString('utf8'), encoding: 'utf8' };
}

async function walkDir(current: string, base: string, into: Map<string, FileEntry>): Promise<void> {
  const items = await fs.readdir(current, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(current, item.name);
    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name)) continue;
      await walkDir(full, base, into);
    } else if (item.isFile()) {
      const entry = await readFileEntry(full, base);
      into.set(entry.path, entry);
    }
  }
}

// Full recursive walk — used for the dry-run preview.
async function collectAll(dir: string): Promise<FileEntry[]> {
  const entries = new Map<string, FileEntry>();
  await walkDir(dir, dir, entries);
  return [...entries.values()];
}

// Selection-aware collector. Each selection entry is a file, a subdirectory
// (uploaded recursively), or "." for the whole folder. Paths that escape the
// base folder or do not exist are reported via `missing` instead of throwing.
async function collectSelected(
  baseDir: string,
  selection: string[],
): Promise<{ files: FileEntry[]; missing: string[] }> {
  const entries = new Map<string, FileEntry>();
  const missing: string[] = [];

  for (const raw of selection) {
    const entry = raw.trim();
    const abs = path.resolve(baseDir, entry);
    // Containment check: reject anything resolving outside baseDir.
    const rel = path.relative(baseDir, abs);
    if (path.isAbsolute(entry) || rel.startsWith('..')) {
      missing.push(`${entry} (outside publish folder)`);
      continue;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch {
      missing.push(entry);
      continue;
    }

    if (stat.isDirectory()) {
      await walkDir(abs, baseDir, entries);
    } else if (stat.isFile()) {
      const fe = await readFileEntry(abs, baseDir);
      entries.set(fe.path, fe);
    } else {
      missing.push(entry);
    }
  }

  return { files: [...entries.values()], missing };
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function getTalonpressTools(): ToolSet {
  const url = configManager.get().tools?.talonpress?.url;
  if (!url) return {};

  return {
    talonpress_publish: tool({
      description:
        'Publish or update a static web package on TalonPress by uploading selected files from a local folder. ' +
        'Pass `files` to publish exactly the paths you intend (a folder often holds unrelated leftovers from earlier tasks). ' +
        'Omit `files` to do a dry run: the tool lists what it WOULD publish without uploading anything — review it, then ' +
        'call again with the paths you want (use "." to publish the whole folder once you have confirmed it is clean). ' +
        'Omit package_id to create a new package; provide it to update an existing one (overwrites matching file paths). ' +
        'Handles text and binary files automatically.',
      inputSchema: z.object({
        folder: z
          .string()
          .describe('Path to the local folder to publish from (absolute, or relative to the agent workspace).'),
        files: z
          .array(z.string())
          .optional()
          .describe(
            'Relative paths (to `folder`) to publish. Each entry may be a file or a subdirectory ' +
              '(uploaded recursively); use "." to publish the entire folder. Omit this to do a dry run ' +
              'that lists what WOULD be published without uploading — then call again with the paths you want.',
          ),
        name: z
          .string()
          .describe('Display name for the package. Required when creating a new package (no package_id).'),
        visibility: z
          .enum(['public', 'private'])
          .optional()
          .describe('Access visibility (default: public). Only used when creating a new package.'),
        package_id: z
          .string()
          .optional()
          .describe('Existing package ID to update. Omit to create a new package.'),
        default_page: z
          .string()
          .optional()
          .describe(
            'Entry-point file served at the package root (default: index.html). ' +
              'Useful when the main file has a different name.',
          ),
      }) as any,
      execute: async (input: {
        folder: string;
        files?: string[];
        name: string;
        visibility?: 'public' | 'private';
        package_id?: string;
        default_page?: string;
      }) => {
        try {
          const absFolder = path.isAbsolute(input.folder)
            ? input.folder
            : path.join(getWorkspaceDir(), input.folder);

          let stat: Awaited<ReturnType<typeof fs.stat>>;
          try {
            stat = await fs.stat(absFolder);
          } catch {
            return `Error: folder not found: ${input.folder}`;
          }
          if (!stat.isDirectory()) return `Error: not a directory: ${input.folder}`;

          // ── Dry run: no selection given — preview, never upload ──────────────
          if (!input.files || input.files.length === 0) {
            const all = await collectAll(absFolder);
            if (all.length === 0) return `Error: folder is empty: ${input.folder}`;

            const totalKb = Math.round(all.reduce((s, f) => s + f.content.length, 0) / 1024);
            const MAX_LIST = 100;
            const listed = all
              .slice(0, MAX_LIST)
              .map((f) => `  ${f.path}`)
              .join('\n');
            const more = all.length > MAX_LIST ? `\n  …and ${all.length - MAX_LIST} more` : '';

            return (
              `Dry run — nothing was published. ` +
              `'${input.folder}' contains ${all.length} file(s) (~${totalKb} KB):\n` +
              `${listed}${more}\n\n` +
              `Call talonpress_publish again with \`files\` listing only the paths to publish ` +
              `(each may be a file or subdirectory). Use \`files: ["."]\` to publish the entire folder.`
            );
          }

          // ── Publish: explicit selection ──────────────────────────────────────
          const { files, missing } = await collectSelected(absFolder, input.files);
          if (missing.length > 0) {
            return `Error: these selected paths were not found or are invalid: ${missing.join(', ')}`;
          }
          if (files.length === 0) {
            return `Error: selection resolved to no files: ${input.files.join(', ')}`;
          }

          const totalBytes = files.reduce((sum, f) => sum + f.content.length, 0);
          const manifest = files.map((f) => `  ${f.path}`).join('\n');
          const summary =
            `Uploading ${files.length} file(s) (~${Math.round(totalBytes / 1024)} KB):\n${manifest}`;

          let result: string;
          if (input.package_id) {
            result = await callTalonpress('update_package', {
              package_id: input.package_id,
              files,
              ...(input.default_page ? { default_page: input.default_page } : {}),
            });
          } else {
            result = await callTalonpress('publish_package', {
              name: input.name,
              visibility: input.visibility ?? 'public',
              files,
              ...(input.default_page ? { default_page: input.default_page } : {}),
            });
          }

          return `${summary}\n${result}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    } as any),

    talonpress_list_packages: tool({
      description: 'List available TalonPress packages with their visibility status and access URLs.',
      inputSchema: z.object({
        visibility: z
          .enum(['public', 'private'])
          .optional()
          .describe('Filter by visibility.'),
        limit: z
          .number()
          .int()
          .optional()
          .describe('Maximum number of results.'),
      }) as any,
      execute: async (input: { visibility?: 'public' | 'private'; limit?: number }) => {
        try {
          return await callTalonpress('list_packages', input as Record<string, unknown>);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    } as any),

    talonpress_get_package_status: tool({
      description:
        'Fetch the live status, route configuration, file manifest, and active tokens for a TalonPress package.',
      inputSchema: z.object({
        package_id: z.string().describe('Package ID.'),
      }),
      execute: async (input: { package_id: string }) => {
        try {
          return await callTalonpress('get_package_status', input as Record<string, unknown>);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    talonpress_update_visibility: tool({
      description:
        'Modify the access visibility of a TalonPress package. ' +
        'Transitioning to "private" automatically generates a new secure token.',
      inputSchema: z.object({
        package_id: z.string().describe('Package ID.'),
        visibility: z.enum(['public', 'private']).describe('New visibility.'),
      }),
      execute: async (input: { package_id: string; visibility: 'public' | 'private' }) => {
        try {
          return await callTalonpress('update_visibility', input as Record<string, unknown>);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    talonpress_delete_package: tool({
      description: 'Permanently delete a TalonPress package and purge its deployment files.',
      inputSchema: z.object({
        package_id: z.string().describe('Package ID to delete.'),
      }),
      execute: async (input: { package_id: string }) => {
        try {
          return await callTalonpress('delete_package', input as Record<string, unknown>);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
