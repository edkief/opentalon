/**
 * Local stdio MCP server for OpenTalon.
 *
 * Exposes: read_file, list_directory, run_shell
 *
 * Usage: tsx scripts/mcp-server.ts
 *
 * Configure agent to use it:
 *   MCP_SERVERS='[{"type":"stdio","command":"tsx","args":["scripts/mcp-server.ts"],"name":"local"}]'
 *   DANGEROUS_TOOLS='run_shell'
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const server = new McpServer({
  name: 'opentalon-local',
  version: '1.0.0',
});

// ─── read_file ────────────────────────────────────────────────────────────────

server.tool(
  'read_file',
  'Read the contents of a file at the given absolute path',
  { path: z.string().describe('Absolute path to the file') },
  async ({ path: filePath }) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const preview = content.length > 8000 ? content.slice(0, 8000) + '\n… (truncated)' : content;
      return { content: [{ type: 'text', text: preview }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error reading file: ${message}` }] };
    }
  }
);

// ─── list_directory ───────────────────────────────────────────────────────────

server.tool(
  'list_directory',
  'List files and directories at the given absolute path',
  { path: z.string().describe('Absolute path to the directory') },
  async ({ path: dirPath }) => {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const lines = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
      return { content: [{ type: 'text', text: lines.join('\n') || '(empty directory)' }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Error listing directory: ${message}` }] };
    }
  }
);

// ─── run_shell ────────────────────────────────────────────────────────────────
// Marked as dangerous in the agent via DANGEROUS_TOOLS env var.

server.tool(
  'run_shell',
  'Run a shell command. Marked as dangerous — requires user approval via Telegram before execution.',
  {
    command: z.string().describe('The executable to run'),
    args: z.array(z.string()).optional().describe('Command arguments'),
    cwd: z.string().optional().describe('Working directory (defaults to current)'),
  },
  async ({ command, args = [], cwd }) => {
    try {
      // Safety: block obviously destructive commands
      const blocked = ['rm', 'dd', 'mkfs', 'fdisk', 'shred'];
      if (blocked.includes(path.basename(command))) {
        return { content: [{ type: 'text', text: `Command "${command}" is blocked for safety.` }] };
      }

      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: cwd ?? process.cwd(),
        timeout: 30_000,
        maxBuffer: 1024 * 512, // 512 KB
      });

      const output = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n');
      return { content: [{ type: 'text', text: output || '(no output)' }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `Command failed: ${message}` }] };
    }
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes
}

main().catch((err) => {
  console.error('[MCP Server] Fatal error:', err);
  process.exit(1);
});
