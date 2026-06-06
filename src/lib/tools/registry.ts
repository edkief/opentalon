import { tool } from 'ai';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';
import { waitForApproval } from '../agent/hitl';
import { configManager } from '../config';

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

// ─── JSON Schema → Zod ────────────────────────────────────────────────────────

function mcpSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  if (schema.type !== 'object' || !schema.properties) {
    return z.record(z.string(), z.unknown());
  }

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const required = (schema.required as string[]) ?? [];
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let field: z.ZodTypeAny;
    switch (prop.type) {
      case 'string':  field = z.string(); break;
      case 'number':
      case 'integer': field = z.number(); break;
      case 'boolean': field = z.boolean(); break;
      case 'array':   field = z.array(z.unknown()); break;
      default:        field = z.unknown();
    }
    if (prop.description) field = field.describe(String(prop.description));
    shape[key] = required.includes(key) ? field : field.optional();
  }

  return z.object(shape);
}

// ─── Stored tool definitions ──────────────────────────────────────────────────

interface McpToolDef {
  name: string;
  description: string;
  paramSchema: z.ZodTypeAny;
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

          // Prefix tool names with the server name to avoid collisions and make
          // the source server clear to the LLM (e.g. "talonpress__publish_package").
          const prefix = config.name ? `${config.name}_` : '';

          for (const t of tools) {
            const paramSchema = mcpSchemaToZod(
              t.inputSchema as Record<string, unknown>
            );

            this.toolDefs.push({
              name: `${prefix}${t.name}`,
              description: t.description ?? t.name,
              paramSchema,
              execute: async (input) => {
                const result = await client.callTool({
                  name: t.name,
                  arguments: input,
                });
                const textParts = (result.content as any[])
                  .filter((c) => c.type === 'text')
                  .map((c) => c.text as string);
                return textParts.join('\n') || JSON.stringify(result.content);
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
      const isDangerous = dangerous.has(def.name);

      tools[def.name] = tool({
        description: def.description,
        inputSchema: def.paramSchema as any,
        execute: async (input: Record<string, unknown>) => {
          if (isDangerous && opts?.sendApprovalRequest) {
            const approvalId = crypto.randomUUID();
            await opts.sendApprovalRequest(approvalId, def.name, input);
            const approved = await waitForApproval(approvalId);
            if (!approved) {
              return `Action "${def.name}" was denied by the user.`;
            }
          }
          return def.execute(input);
        },
      } as any);
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
