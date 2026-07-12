import { tool, jsonSchema } from 'ai';
import type { ToolSet, Schema, JSONSchema7 } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';
import { waitForApproval } from '../agent/hitl';
import { configManager } from '../config';
import { getWorkspaceDir } from './skills';
import fs from 'node:fs/promises';
import path from 'node:path';

// ─── Server config ────────────────────────────────────────────────────────────

interface StdioServerConfig {
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HttpServerConfig {
  name: string;
  url: string;
  transport?: 'sse' | 'streamable-http';
  headers?: Record<string, string>;
}

type McpServerConfig = StdioServerConfig | HttpServerConfig;

function isHttpConfig(cfg: McpServerConfig): cfg is HttpServerConfig {
  return 'url' in cfg;
}

function getMcpServers(): McpServerConfig[] {
  // Prefer config.yaml mcpServers, fall back to MCP_SERVERS env JSON string
  const cfgServers = configManager.get().tools?.mcpServers;
  if (cfgServers && cfgServers.length > 0) return cfgServers;

  const raw = process.env.MCP_SERVERS;
  if (!raw) return [];
  try {
    return JSON.parse(raw) as McpServerConfig[];
  } catch {
    console.warn('[MCPRegistry] Failed to parse MCP_SERVERS env var');
    return [];
  }
}

function getDangerousToolNames(): Set<string> {
  const cfg = configManager.get().tools?.dangerousTools;
  if (cfg) return new Set(cfg);
  const raw = process.env.DANGEROUS_TOOLS ?? 'run_shell,run_command';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * Formats an MCP tool result's content parts into text.
 *
 * The previous implementation kept only `type === 'text'` parts and fell
 * back to `JSON.stringify(result.content)` only when there was NO text part
 * at all — so an image alongside a short text summary silently dropped the
 * image, and a lone image/resource with no text fell back to an unreadable
 * JSON blob (base64 image data dumped as a string). Image parts are now
 * saved to the workspace's tool-results dir (same recovery pattern the
 * tool-compression middleware uses) and returned as a file path; resource
 * parts are summarized as uri + description.
 */
async function formatMcpResult(
  content: unknown,
  toolName: string,
): Promise<string> {
  const parts = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
  const sections: string[] = [];

  for (const part of parts) {
    switch (part.type) {
      case 'text': {
        if (typeof part.text === 'string' && part.text) sections.push(part.text);
        break;
      }
      case 'image': {
        const data = typeof part.data === 'string' ? part.data : undefined;
        const mimeType = typeof part.mimeType === 'string' ? part.mimeType : 'image/png';
        if (!data) break;
        try {
          const ext = mimeType.split('/')[1]?.split(';')[0] ?? 'png';
          const dir = path.join(getWorkspaceDir(), 'tool-results', 'mcp-images');
          await fs.mkdir(dir, { recursive: true });
          const filePath = path.join(dir, `${toolName}-${crypto.randomUUID()}.${ext}`);
          await fs.writeFile(filePath, Buffer.from(data, 'base64'));
          sections.push(`[image saved to ${filePath} — use send_file or read the file to view it]`);
        } catch (err) {
          sections.push(`[image content received but could not be saved: ${err instanceof Error ? err.message : String(err)}]`);
        }
        break;
      }
      case 'resource': {
        const resource = part.resource as Record<string, unknown> | undefined;
        const uri = typeof resource?.uri === 'string' ? resource.uri : undefined;
        const text = typeof resource?.text === 'string' ? resource.text : undefined;
        if (text) sections.push(text);
        else if (uri) sections.push(`[resource: ${uri}]`);
        break;
      }
      default:
        // Unknown/future content part type — keep a compact JSON summary
        // rather than silently dropping it.
        sections.push(`[unsupported content part: ${JSON.stringify(part).slice(0, 500)}]`);
    }
  }

  return sections.length > 0 ? sections.join('\n') : JSON.stringify(content);
}

// ─── Stored tool definitions ──────────────────────────────────────────────────
//
// The MCP server's inputSchema is passed through verbatim via the AI SDK's
// native `jsonSchema()` support instead of a hand-rolled JSON-Schema→Zod
// conversion. The old conversion only handled flat primitives and silently
// dropped enum values, nested object properties, array item types, defaults,
// format/min/max constraints, and anyOf/oneOf — degrading the tool signature
// the model sees and driving malformed MCP tool calls.

interface McpToolDef {
  /** Prefixed name registered as the tool key, e.g. "talonpress_publish_package". */
  name: string;
  /** Bare name as the MCP server knows it, e.g. "publish_package" — used so
   *  `dangerousTools` config entries can list either form (see isDangerous). */
  bareName: string;
  description: string;
  paramSchema: Schema<Record<string, unknown>>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

// ─── Registry singleton ───────────────────────────────────────────────────────

class McpToolRegistry {
  private toolDefs: McpToolDef[] = [];
  private clients: Client[] = [];
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit().catch((err) => {
      console.error('[MCPRegistry] Initialization failed:', err);
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  async reload(): Promise<void> {
    console.log('[MCPRegistry] Reloading MCP connections…');
    await Promise.allSettled(this.clients.map((c) => c.close()));
    this.clients = [];
    this.toolDefs = [];
    this.initPromise = null;
    await this.initialize();
  }

  private async _doInit(): Promise<void> {
    const configs = getMcpServers();
    if (configs.length === 0) {
      console.log('[MCPRegistry] No MCP servers configured');
      return;
    }

    await Promise.allSettled(
      configs.map(async (config) => {
        const label = config.name ?? (isHttpConfig(config) ? config.url : config.command);
        try {
          const client = new Client({ name: 'opentalon', version: '1.0.0' });

          let transport;
          if (isHttpConfig(config)) {
            const url = new URL(config.url);
            const requestInit: RequestInit = config.headers
              ? { headers: config.headers }
              : {};
            if (config.transport === 'sse') {
              transport = new SSEClientTransport(url, { requestInit });
            } else {
              transport = new StreamableHTTPClientTransport(url, { requestInit });
            }
          } else {
            transport = new StdioClientTransport({
              command: config.command,
              args: config.args ?? [],
              env: config.env,
            });
          }

          await client.connect(transport);
          this.clients.push(client);

          const { tools } = await client.listTools();

          // Prefix tool names with the server name (single underscore) to
          // avoid collisions and make the source server clear to the LLM,
          // e.g. "talonpress_publish_package".
          const prefix = config.name ? `${config.name}_` : '';

          for (const t of tools) {
            const paramSchema = jsonSchema<Record<string, unknown>>(
              t.inputSchema as unknown as JSONSchema7,
            );

            this.toolDefs.push({
              name: `${prefix}${t.name}`,
              bareName: t.name,
              description: t.description ?? t.name,
              paramSchema,
              execute: async (input) => {
                const result = await client.callTool({
                  name: t.name,
                  arguments: input,
                });
                return formatMcpResult(result.content, `${prefix}${t.name}`);
              },
            });
          }

          console.log(`[MCPRegistry] Loaded ${tools.length} tools from "${label}"${prefix ? ` (prefix: ${prefix.slice(0, -1)})` : ''}`);
        } catch (err) {
          console.error(`[MCPRegistry] Failed to connect to "${label}":`, err);
        }
      })
    );
  }

  /**
   * Builds an AI SDK ToolSet from all registered MCP tools.
   *
   * @param sendApprovalRequest  Called before a dangerous tool executes.
   *   Should send a Telegram inline keyboard to the user.
   *   The tool's execute() blocks until resolveApproval() is called.
   */
  buildTools(opts?: {
    sendApprovalRequest?: (approvalId: string, toolName: string, input: unknown) => Promise<void>;
  }): ToolSet {
    const dangerous = getDangerousToolNames();
    const tools: ToolSet = {};

    for (const def of this.toolDefs) {
      // dangerousTools entries naturally list the bare tool name as the MCP
      // server exposes it (e.g. "publish_package"), but tools register under
      // the server-prefixed name (e.g. "talonpress_publish_package") to avoid
      // collisions — match against both forms so a dangerous MCP tool never
      // silently skips HITL approval because of the prefix.
      const isDangerous = dangerous.has(def.name) || dangerous.has(def.bareName);

      tools[def.name] = tool({
        description: def.description,
        inputSchema: def.paramSchema,
        execute: async (input: Record<string, unknown>) => {
          if (isDangerous && opts?.sendApprovalRequest) {
            const approvalId = crypto.randomUUID();
            await opts.sendApprovalRequest(approvalId, def.name, input);
            const approved = await waitForApproval(approvalId);
            if (!approved) {
              return `Error: action "${def.name}" was denied by the user.`;
            }
          }
          return def.execute(input);
        },
      });
    }

    return tools;
  }

  /** Return tool names registered from MCP servers. */
  listToolNames(): string[] {
    return this.toolDefs.map((d) => d.name);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.close()));
  }
}

export const mcpRegistry = new McpToolRegistry();

export async function getRegisteredTools(opts?: {
  sendApprovalRequest?: (approvalId: string, toolName: string, input: unknown) => Promise<void>;
}): Promise<ToolSet> {
  await mcpRegistry.initialize();
  return mcpRegistry.buildTools(opts);
}
