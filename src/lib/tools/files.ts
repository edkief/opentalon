import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFileShare, slugExists } from '../db/file-shares';
import { getWorkspaceDir } from './skills';
import type { BuiltInToolsOpts } from './types';

const execAsync = promisify(exec);

export function getFileTools(opts?: BuiltInToolsOpts): ToolSet {
  return {
    create_view_link: tool({
      description:
        'Share a file from the workspace as a public view link that the user can open in their browser. ' +
        'Supports markdown (.md), HTML (.html), and image files (.png/.jpg/.jpeg/.gif/.webp/.svg). ' +
        'Returns a URL to send to the user. Use a short, descriptive name for the slug.',
      inputSchema: z.object({
        path: z.string().describe('Workspace-relative path to the file, e.g. "reports/summary.md"'),
        name: z.string().describe('Short human-readable slug for the URL, e.g. "q1-report"'),
        expires_hours: z
          .number()
          .positive()
          .optional()
          .describe('Optional TTL in hours. Omit for no expiry.'),
      }) as any,
      execute: async (input: { path: string; name: string; expires_hours?: number }) => {
        // Resolve workspace to an absolute path so all comparisons are stable
        // regardless of whether config returns "./workspace", "workspace", or "/workspace".
        const workspaceDir = path.resolve(getWorkspaceDir());

        const pathExists = async (p: string) => fs.access(p).then(() => true).catch(() => false);

        // Resolve input: absolute paths are resolved as-is; relative paths are
        // resolved from the workspace root.
        let absPath = path.resolve(
          path.isAbsolute(input.path) ? input.path : path.join(workspaceDir, input.path),
        );

        if (!await pathExists(absPath) && !path.dirname(input.path).replace('.', '')) {
          // Bare filename — search workspace recursively for the first match
          const basename = path.basename(input.path);
          const { stdout } = await execAsync(
            `find ${JSON.stringify(workspaceDir)} -maxdepth 6 -name ${JSON.stringify(basename)} -not -path "*/.*" -print -quit`,
          ).catch(() => ({ stdout: '' }));
          const found = stdout.trim();
          if (found) absPath = path.resolve(found);
        }

        // Path traversal guard (both sides are now absolute)
        if (!absPath.startsWith(workspaceDir + path.sep) && absPath !== workspaceDir) {
          return `Error: path must be within the workspace directory (${workspaceDir}). Got: "${absPath}"`;
        }

        if (!await pathExists(absPath)) {
          return `Error: file not found. Resolved path: "${absPath}" (workspace: ${workspaceDir}). ` +
            `Provide a workspace-relative path, e.g. "reports/summary.md".`;
        }

        // Sanitize slug: lowercase, replace spaces and unsafe chars with hyphens
        const baseSlug = input.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (!baseSlug) return 'Error: invalid name — must contain alphanumeric characters.';

        // Ensure slug uniqueness
        let slug = baseSlug;
        if (await slugExists(slug)) {
          slug = `${baseSlug}-${Math.floor(Date.now() / 1000)}`;
        }

        // Always store workspace-relative path so the share survives workspace moves
        const storedPath = absPath.slice(workspaceDir.length + 1);

        const ext = path.extname(absPath).toLowerCase();
        const mimeHint =
          ext === '.md' ? 'markdown'
          : ext === '.html' || ext === '.htm' ? 'html'
          : ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext) ? 'image'
          : undefined;

        const id = crypto.randomUUID();
        const expiresAt = input.expires_hours
          ? new Date(Date.now() + input.expires_hours * 3600 * 1000)
          : undefined;

        await createFileShare(id, slug, storedPath, {
          mimeHint,
          agentId: undefined,
          chatId: opts?.telegramChatId,
          expiresAt,
        });

        const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
        const url = `${publicBaseUrl}/view/${slug}`;
        return `View link created: ${url}`;
      },
    } as any),
  };
}
