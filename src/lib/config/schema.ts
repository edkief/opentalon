import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const ConfigSchema = z.object({
  timezone: z.string().optional()
    .describe('Timezone for scheduled tasks (e.g. "America/New_York", "Europe/London", "UTC"). Default: UTC.'),
  llm: z
    .object({
      model: z.string().optional().describe('Primary model in "provider/model" format, e.g. "anthropic/claude-sonnet-4-5"'),
      fallbacks: z.array(z.string()).optional().describe('Ordered fallback models in "provider/model" format, e.g. ["openai/gpt-4o", "mistral/mistral-large-latest"]'),
      temperature: z.number().min(0).max(2).optional().describe('Sampling temperature (0-2, default 0.7)'),
      maxSteps: z.number().int().min(1).max(100).optional().describe('Max tool-use steps per request (default 10)'),
      maxTokens: z.number().int().min(256).max(65536).optional().describe('Max output tokens per LLM request. Leave unset to use provider default. Increase if you see finishReason: length errors.'),
      maxResume: z.number().int().min(1).max(20).optional().describe('Max agent resume to prevent infinite resume loops (default 5)'),
      showThinking: z.boolean().optional().describe('Include <think>...</think> reasoning tokens in responses (default: false). Enable if you want to see the model\'s chain-of-thought.'),
      progressiveSteps: z.boolean().optional().describe('Stream each agent step through thinking → responding → done stages in the thought stream / turn viewer, instead of one bundled event (default: false). Uses streamText under the hood.'),
      toolResultWindow: z.number().int().min(1).max(20).optional().describe('Number of most-recent tool-result messages to keep at full fidelity (default 3). Older results are compressed to toolResultHeadChars.'),
      toolResultMaxChars: z.number().int().min(256).max(100_000).optional().describe('Max chars for a tool result inside the recency window (default 8000). Oversized results are truncated with a suffix so the agent knows output was cut.'),
      toolResultHeadChars: z.number().int().min(0).max(20_000).optional().describe('Chars to retain from tool results outside the recency window (default 2000). 0 = replace with marker only. Keeps the head of old outputs for signal without filling context.'),
      maxConcurrentSpecialists: z.number().int().min(1).max(20).optional().describe('Maximum number of background specialist jobs that can run concurrently (default 2).'),
      specialistTimeoutMs: z.number().int().min(60_000).optional().describe('Timeout for specialist sub-agents in milliseconds (default 600000 = 10 minutes). Increase for long-running agentic tasks.'),
    })
    .optional(),
  memory: z
    .object({
      enabled: z.boolean().optional().describe('Enable long-term vector memory (default true)'),
    })
    .optional(),
  telegram: z
    .object({
      useLongPolling: z.boolean().optional().describe('Use long-polling instead of webhook (useful in dev)'),
      ownerId: z
        .union([z.number().int(), z.array(z.number().int())])
        .optional()
        .describe('Restrict bot to these Telegram user ID(s). Accepts a single ID or a list of IDs. Leave unset to allow all.'),
    })
    .optional(),
  tools: z
    .object({
      allowlist: z
        .union([z.literal('*'), z.array(z.string())])
        .optional()
        .describe('"*" to allow all tools, or an array of tool names'),
      dangerousTools: z
        .array(z.string())
        .optional()
        .describe('Tools that require explicit user approval before running'),
      shell: z.string().optional().describe('Shell binary for run_command (default /bin/bash)'),
      agentWorkspace: z.string().optional().describe('Base workspace directory for agent tools'),
      skillsDir: z.string().optional().describe('Directory containing skill definitions'),
      agentBrowserEnabled: z.boolean().optional().describe('Enable agent-browser built-in tools (browser_navigate, browser_snapshot, etc.). Default: false. Requires agent-browser CLI installed globally.'),
      agentBrowserBin: z.string().optional().describe('Path or name of the agent-browser binary. Default: "agent-browser".'),
      toolCallMemoryLimit: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe(
          'Maximum number of recent agent step events (tool calls/results) to keep in memory for the Thought Stream dashboard. 0 disables history. Default: 500.',
        ),
      mcpServers: z
        .array(
          z.union([
            z.object({
              name: z.string().describe('Unique server name'),
              command: z.string().describe('Executable to launch (stdio transport)'),
              args: z.array(z.string()).optional().describe('Command arguments'),
              env: z.record(z.string(), z.string()).optional().describe('Extra environment variables for the process'),
            }),
            z.object({
              name: z.string().describe('Unique server name'),
              url: z.string().url().describe('HTTP(S) endpoint for SSE or Streamable HTTP transport'),
              transport: z.enum(['sse', 'streamable-http']).optional().describe('Transport type: "sse" for legacy SSE, "streamable-http" for modern Streamable HTTP (default)'),
              headers: z.record(z.string(), z.string()).optional().describe('Additional HTTP headers (e.g. for auth)'),
            }),
          ])
        )
        .optional()
        .describe('Model Context Protocol server configurations'),
      webSearch: z
        .object({
          provider: z
            .enum(['auto', 'ddgs', 'brave'])
            .optional()
            .describe('Which search provider to use: "ddgs" (self-hosted DDGS), "brave" (Brave Search API), or "auto" (DDGS if configured, else Brave). Default: auto.'),
          ddgs: z
            .object({
              url: z.string().optional().describe('Base URL of a self-hosted DDGS API instance (e.g. "http://kamrui.local").'),
            })
            .optional()
            .describe('Self-hosted DDGS (DuckDuckGo Search) configuration'),
        })
        .optional()
        .describe('Web search provider configuration'),
      talonpress: z
        .object({
          url: z
            .string()
            .optional()
            .describe('MCP API root of a TalonPress instance (e.g. "http://localhost:3000/api/mcp"). When set, the talonpress_publish helper plus list/status/visibility/delete tools are enabled.'),
          transport: z
            .enum(['sse', 'streamable-http'])
            .optional()
            .describe('MCP transport type (default: streamable-http).'),
          headers: z
            .record(z.string(), z.string())
            .optional()
            .describe('Extra HTTP headers for the TalonPress MCP endpoint (e.g. for auth).'),
        })
        .optional()
        .describe('TalonPress static web publishing integration'),
    })
    .optional(),
  onboarding: z
    .object({
      complete: z.boolean().optional().describe('Set to true after onboarding is finished'),
    })
    .optional(),
  git: z
    .object({
      userName: z.string().optional().describe('Git commit author name (e.g. "OpenTalon Bot")'),
      userEmail: z.string().optional().describe('Git commit author email (e.g. "bot@example.com")'),
    })
    .optional()
    .describe('Git identity used when the agent runs git commands in the workspace'),
}).strict();

export const SecretsSchema = z.object({
  auth: z.record(z.string(), z.string()).optional()
    .describe('API keys keyed by provider name, e.g. { anthropic: "sk-ant-...", openai: "sk-..." }'),
  providers: z.array(z.object({
    name: z.string().describe('Provider prefix used in "name/model" strings, e.g. "groq"'),
    type: z.enum(['openai']).describe('Protocol type for this provider'),
    baseURL: z.string().describe('API base URL'),
    apiKey: z.string().optional().describe('API key for this provider (can also be set in auth.<name>)'),
  })).optional().describe('Custom provider backends (Groq, Together, Ollama, etc.)'),
  telegram: z.object({
    botToken: z.string().optional().describe('Bot token from @BotFather'),
  }).optional(),
  tools: z.object({
    braveApiKey: z.string().optional().describe('Brave Search API key for the web_search tool'),
  }).optional(),
  git: z.object({
    pat: z.string().optional().describe('Personal Access Token for git HTTPS authentication (stored as https://<token>@<host> credential)'),
    patHost: z.string().optional().describe('Hostname the PAT applies to (default: github.com)'),
  }).optional(),
  dashboard: z.object({
    password: z.string().optional().describe('Bearer token protecting the dashboard (leave unset for open access)'),
  }).optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type AppSecrets = z.infer<typeof SecretsSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const configJsonSchema = zodToJsonSchema(ConfigSchema as any, 'OpenTalonConfig');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const secretsJsonSchema = zodToJsonSchema(SecretsSchema as any, 'OpenTalonSecrets');
