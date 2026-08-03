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

/** Per-call timeout knobs shared by both transports. */
interface TimeoutConfig {
  /** Default per-call timeout (ms) for this server's tools. Falls back to the MCP SDK default (60000). */
  timeout?: number;
  /** Per-tool timeout overrides (ms), keyed by the bare tool name. Overrides `timeout`. */
  toolTimeouts?: Record<string, number>;
  /** Reset the timeout whenever the server reports progress, so long-running tools are not killed mid-flight. */
  resetTimeoutOnProgress?: boolean;
}

interface StdioServerConfig extends TimeoutConfig {
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Optional allowlist of bare tool names to register from this server; omit to register all. */
  tools?: string[];
}

interface HttpServerConfig extends TimeoutConfig {
  name: string;
  url: string;
  transport?: 'sse' | 'streamable-http';
  headers?: Record<string, string>;
  /** Optional allowlist of bare tool names to register from this server; omit to register all. */
  tools?: string[];
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
 * Detects the "no valid session ID provided" error that some Streamable HTTP
 * MCP servers return after a redeploy / session reset. The previous
 * `McpToolRegistry` had no recovery path: the captured `Client` instance kept
 * sending the stale `mcp-session-id` header forever and every subsequent call
 * failed with the same error. Now we detect the error and re-handshake.
 *
 * The SDK throws `StreamableHTTPError` (HTTP 400 here) with the JSON-RPC
 * error body in its message. We match on the message text so the check keeps
 * working if the SDK's class shape changes.
 */
export function isSessionExpiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code !== 400) return false;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  return message.includes('Bad Request: no valid session ID');
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
  /** Server name this tool came from, used to group MCP tools per server in
   *  the UI. Empty when the corresponding `mcpServers` entry has no `name`. */
  server: string;
  /** Key into the registry's serverStates map. The execute closure looks the
   *  active client up here at call time so a session-expiry reconnect can
   *  swap in a new Client without rebuilding every tool definition. */
  serverKey: string;
  description: string;
  paramSchema: Schema<Record<string, unknown>>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

// ─── Registry singleton ───────────────────────────────────────────────────────

/**
 * Per-server live state. The `client` field is mutable so a session-expiry
 * reconnect can swap in a fresh SDK `Client` (with a fresh transport and
 * freshly negotiated session ID) without rebuilding any tool definitions.
 */
interface ServerState {
  client: Client;
  config: McpServerConfig;
  /** In-flight reconnect promise, if any. Subsequent concurrent calls share
   *  the same reconnect rather than each opening their own. */
  reconnectInProgress?: Promise<void>;
}

class McpToolRegistry {
  private toolDefs: McpToolDef[] = [];
  private serverStates: Map<string, ServerState> = new Map();
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
    await this._closeAll();
    this.serverStates.clear();
    this.toolDefs = [];
    this.initPromise = null;
    await this.initialize();
  }

  private async _closeAll(): Promise<void> {
    const states = Array.from(this.serverStates.values());
    await Promise.allSettled(states.map((s) => s.client.close()));
  }

  private _serverKey(config: McpServerConfig): string {
    return config.name ?? (isHttpConfig(config) ? config.url : config.command);
  }

  /**
   * Builds an SDK Client + transport pair, runs the initialize handshake,
   * and returns both. Used by both the initial connect and the
   * session-expiry reconnect path so they stay in sync.
   */
  private async _createConnectedClient(
    config: McpServerConfig,
  ): Promise<{ client: Client }> {
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
    return { client };
  }

  /**
   * Re-handshakes a single MCP server after the existing session ID was
   * rejected by the server (typically a redeploy / session reset). Run
   * concurrently by tool calls; the per-server `reconnectInProgress` promise
   * acts as a single-flight latch so a flood of parallel calls triggers
   * exactly one reconnect.
   */
  private async _reconnectServer(key: string): Promise<void> {
    const state = this.serverStates.get(key);
    if (!state) throw new Error(`MCP server "${key}" not registered`);
    if (state.reconnectInProgress) return state.reconnectInProgress;

    const label = state.config.name ?? (isHttpConfig(state.config) ? state.config.url : state.config.command);
    const startedAt = Date.now();

    state.reconnectInProgress = (async () => {
      try {
        // Don't close the old client here. The SDK's Transport.close()
        // synchronously rejects every pending request on the client via
        // its onclose hook, which would kill concurrent calls that have
        // not yet observed the session-expired error. Once state.client
        // is reassigned below, the old Client and its transport become
        // unreachable and are garbage-collected normally.
        const { client: newClient } = await this._createConnectedClient(state.config);
        state.client = newClient;
        console.log(
          `[MCPRegistry] Reconnected to "${label}" after session expiry (${Date.now() - startedAt}ms)`,
        );
      } catch (err) {
        console.error(`[MCPRegistry] Reconnect to "${label}" failed:`, err);
        throw err;
      } finally {
        state.reconnectInProgress = undefined;
      }
    })();

    return state.reconnectInProgress;
  }

  private async _doInit(): Promise<void> {
    const configs = getMcpServers();
    if (configs.length === 0) {
      console.log('[MCPRegistry] No MCP servers configured');
      return;
    }

    await Promise.allSettled(
      configs.map(async (config) => {
        const key = this._serverKey(config);
        const label = config.name ?? (isHttpConfig(config) ? config.url : config.command);
        try {
          const { client } = await this._createConnectedClient(config);
          this.serverStates.set(key, { client, config });

          const { tools } = await client.listTools();

          // Per-server tool allowlist (#19 part 4): MCP servers often export
          // verbose schemas we don't control, all of which otherwise stack onto
          // every request. When `tools` is set, register only those (matched by
          // the bare name the server exposes); omit it to register all.
          const allow = config.tools;
          const selectedTools =
            allow && allow.length > 0 ? tools.filter((t) => allow.includes(t.name)) : tools;

          // Prefix tool names with the server name (single underscore) to
          // avoid collisions and make the source server clear to the LLM,
          // e.g. "talonpress_publish_package".
          const prefix = config.name ? `${config.name}_` : '';

          for (const t of selectedTools) {
            const paramSchema = jsonSchema<Record<string, unknown>>(
              t.inputSchema as unknown as JSONSchema7,
            );

            // Per-tool override wins over the server default; undefined lets the
            // SDK apply its own default (60s).
            const timeout = config.toolTimeouts?.[t.name] ?? config.timeout;
            const callOpts =
              timeout != null || config.resetTimeoutOnProgress != null
                ? { timeout, resetTimeoutOnProgress: config.resetTimeoutOnProgress }
                : undefined;

            this.toolDefs.push({
              name: `${prefix}${t.name}`,
              bareName: t.name,
              server: config.name ?? '',
              serverKey: key,
              description: t.description ?? t.name,
              paramSchema,
              execute: async (input) => {
                const state = this.serverStates.get(key);
                if (!state) {
                  throw new Error(`MCP server "${key}" no longer registered`);
                }
                const callToolOnce = () =>
                  state.client.callTool(
                    { name: t.name, arguments: input },
                    undefined,
                    callOpts,
                  );
                try {
                  const result = await callToolOnce();
                  return formatMcpResult(result.content, `${prefix}${t.name}`);
                } catch (err) {
                  if (isSessionExpiredError(err)) {
                    await this._reconnectServer(key);
                    // The reconnect swaps state.client for the freshly
                    // handshaken one; retry once. If the retry also fails,
                    // propagate — the operator will see it in the tool
                    // result instead of silently looping.
                    const result = await callToolOnce();
                    return formatMcpResult(result.content, `${prefix}${t.name}`);
                  }
                  throw err;
                }
              },
            });
          }

          const skipped = tools.length - selectedTools.length;
          console.log(`[MCPRegistry] Loaded ${selectedTools.length} tools from "${label}"${prefix ? ` (prefix: ${prefix.slice(0, -1)})` : ''}${skipped > 0 ? ` (${skipped} not in allowlist)` : ''}`);
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
            if (approved === 'timeout') {
              return `Error: approval request for action "${def.name}" timed out — the user did not respond in time. You may ask them to retry.`;
            }
            if (approved !== 'approved') {
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

  /** Return tool entries (name + originating server) for MCP tools. Used by
   *  the dashboard to group MCP tools per server, mirroring how built-in
   *  tools are grouped by category. */
  listToolEntries(): { name: string; server: string }[] {
    return this.toolDefs.map((d) => ({ name: d.name, server: d.server }));
  }

  async close(): Promise<void> {
    await this._closeAll();
  }

  /** Test-only: peek at the per-server registry state. */
  _getServerStateForTesting(key: string): ServerState | undefined {
    return this.serverStates.get(key);
  }
}

export const mcpRegistry = new McpToolRegistry();

export async function getRegisteredTools(opts?: {
  sendApprovalRequest?: (approvalId: string, toolName: string, input: unknown) => Promise<void>;
}): Promise<ToolSet> {
  await mcpRegistry.initialize();
  return mcpRegistry.buildTools(opts);
}
