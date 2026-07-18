import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const ConfigSchema = z.object({
  timezone: z.string().optional()
    .describe('Timezone for scheduled tasks (e.g. "America/New_York", "Europe/London", "UTC"). Default: UTC.'),
  llm: z
    .object({
      model: z.string().optional().describe('Primary model in "provider/model" format, e.g. "anthropic/claude-sonnet-4-5"'),
      fallbacks: z.array(z.string()).optional().describe('Ordered fallback models in "provider/model" format, e.g. ["openai/gpt-4o", "mistral/mistral-large-latest"]'),
      auxModel: z.string().optional().describe('Cheaper model in "provider/model" format used for auxiliary/control turns (todo-check, max-steps summary, and finalise unless the agent sets its own finaliseModel). Falls back to the primary model when unset. These turns are constrained instruction-following tasks, not full conversational turns, so a smaller/cheaper model is usually sufficient.'),
      temperature: z.number().min(0).max(2).optional().describe('Sampling temperature (0-2, default 0.7). Precedence: per-call executor override -> per-agent soul.yaml temperature -> this global value -> 0.7 default. Auxiliary control turns (max-steps summary, finalise, todo-check) always use a low fixed temperature (0.2) regardless of this setting, since they are instruction-following tasks rather than creative chat.'),
      maxSteps: z.number().int().min(1).max(200).optional().describe('Max tool-use steps per request (default 10)'),
      maxTokens: z.number().int().min(256).max(65536).optional().describe('Max output tokens per LLM request. Leave unset to use provider default. Increase if you see finishReason: length errors.'),
      maxResume: z.number().int().min(1).max(20).optional().describe('Max agent resume to prevent infinite resume loops (default 5)'),
      showThinking: z.boolean().optional().describe('Include <think>...</think> reasoning tokens in responses (default: false). Enable if you want to see the model\'s chain-of-thought.'),
      debugContextSize: z.boolean().optional().describe('Log a ranked per-section token attribution table for every outgoing LLM request (system prompt, message history, RAG context, and per-tool schema sizes incl. MCP). Dev/diagnostic aid for shrinking idle context; off by default. Also enabled by the DEBUG_CONTEXT_SIZE env var; set DEBUG_CONTEXT_EXACT to additionally calibrate against Anthropic\'s count_tokens API.'),
      progressiveSteps: z.boolean().optional().describe('Stream each agent step through thinking → responding → done stages in the thought stream / turn viewer, instead of one bundled event (default: false). Uses streamText under the hood.'),
      toolResultWindow: z.number().int().min(1).max(20).optional().describe('Number of most-recent tool-result messages to keep at full fidelity (default 3). Older results are compressed to toolResultHeadChars.'),
      toolResultMaxChars: z.number().int().min(256).max(100_000).optional().describe('Max chars for a tool result inside the recency window (default 8000). Oversized results are truncated with a suffix so the agent knows output was cut.'),
      toolResultHeadChars: z.number().int().min(0).max(20_000).optional().describe('Chars to retain from tool results outside the recency window (default 2000). 0 = replace with marker only. Keeps the head of old outputs for signal without filling context.'),
      toolResultDumpTtlHours: z.number().min(0.5).max(720).optional().describe('How long (hours) to keep offloaded full tool-result dumps in ephemeral temp storage before sweeping them (default 6). Truncated outputs point here via read_file; set high enough to outlast your longest turn.'),
      maxConcurrentSpecialists: z.number().int().min(1).max(20).optional().describe('Maximum number of background specialist jobs that can run concurrently (default 2).'),
      specialistTimeoutMs: z.number().int().min(60_000).optional().describe('Timeout for specialist sub-agents in milliseconds (default 600000 = 10 minutes). Increase for long-running agentic tasks.'),
      specialistResultTruncateChars: z.number().int().min(500).max(50_000).optional().describe('Max chars of a completed specialist\'s result to inline when merging into the parent response (default 3000). A trailing "## Result" section (summary + produced-file paths) is always kept intact even if the body above it is truncated.'),
      pricing: z
        .record(
          z.string(),
          z.object({
            input: z.number().min(0).describe('USD per 1M non-cached input tokens'),
            output: z.number().min(0).describe('USD per 1M output tokens (reasoning tokens are billed at this rate — do not add them separately)'),
            cacheRead: z.number().min(0).optional().describe('USD per 1M cached input tokens read (Anthropic ≈ 0.1× input; defaults to input rate if unset)'),
            cacheWrite: z.number().min(0).optional().describe('USD per 1M cache-creation tokens written (Anthropic ≈ 1.25× input; defaults to input rate if unset)'),
          }),
        )
        .optional()
        .describe('Cost rate card keyed by "provider/model" (e.g. "anthropic/claude-sonnet-4-5"). Rates in USD per 1,000,000 tokens. Used only for dashboard cost estimates. Seed from OpenRouter via the metrics page, then edit as needed.'),
    })
    .optional(),
  memory: z
    .object({
      enabled: z.boolean().optional().describe('Enable long-term vector memory (default true)'),
      coreSoftLimitTokens: z.number().int().min(200).max(20_000).optional().describe('Soft budget (estimated tokens) for Core Memory / MEMORY.md, which is injected into the system prompt on every request (default 1500). Above this, memory_append warns and the dashboard editor flags it, nudging episodic/dated content into the RAG layer instead. Not a hard cap — nothing is truncated.'),
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
  email: z
    .object({
      enabled: z.boolean().optional().describe('Enable the email (IMAP/SMTP) conversation channel (default false).'),
      address: z.string().optional().describe("The agent's own email address. Used as the From address and as a self-loop guard so the agent never replies to its own mail."),
      fromName: z.string().optional().describe('Display name for outgoing mail (e.g. "OpenTalon").'),
      imap: z
        .object({
          host: z.string().describe('IMAP server hostname (e.g. "imap.gmail.com").'),
          port: z.number().int().optional().describe('IMAP port (default 993).'),
          secure: z.boolean().optional().describe('Use TLS on connect (default true for port 993).'),
          mailbox: z.string().optional().describe('Mailbox to watch (default "INBOX").'),
        })
        .optional()
        .describe('Inbound IMAP configuration.'),
      smtp: z
        .object({
          host: z.string().describe('SMTP server hostname (e.g. "smtp.gmail.com").'),
          port: z.number().int().optional().describe('SMTP port (default 465 when secure, else 587).'),
          secure: z.boolean().optional().describe('Use implicit TLS (default true for port 465).'),
        })
        .optional()
        .describe('Outbound SMTP configuration. Credentials default to the IMAP credentials.'),
      whitelist: z
        .array(z.string())
        .optional()
        .describe('Sender addresses the agent will actually reply to. Non-whitelisted senders are stored as passive context only, never replied to.'),
      triggerMode: z
        .enum(['always', 'mention'])
        .optional()
        .describe('"always" replies to every whitelisted mail; "mention" only replies when mentionKeyword appears in the fresh reply text. Default "always".'),
      mentionKeyword: z.string().optional().describe('Keyword that must appear in the fresh text to trigger a reply when triggerMode is "mention".'),
      privacy: z
        .enum(['public', 'private'])
        .optional()
        .describe('"private" only replies when every From/To/Cc participant is whitelisted or the agent itself; "public" replies whenever the sender is whitelisted. Default "public".'),
      pollIntervalSec: z
        .number()
        .int()
        .min(30)
        .optional()
        .describe('Full-sync fallback interval in seconds, used alongside IMAP IDLE since servers can silently drop notifications (default 300).'),
      stripPlusAddressing: z
        .boolean()
        .optional()
        .describe('Strip "+tag" suffixes when comparing addresses for whitelist/self checks (comparison only, never rewrites send addresses). Default true.'),
    })
    .optional()
    .describe('Email (IMAP/SMTP) conversation channel.'),
  tools: z
    .object({
      allowlist: z
        .union([z.literal('*'), z.array(z.string())])
        .optional()
        .describe('"*" to allow all tools, or an array of tool names'),
      defaultProfile: z
        .union([
          z.literal('full'),
          z.literal('lean'),
          z.array(z.enum([
            'terminal', 'code-search', 'notebook', 'lsp', 'skills', 'web', 'memory',
            'workflows', 'browser', 'todos', 'agents', 'communication', 'files',
            'talonpress', 'scheduling',
          ])),
        ])
        .optional()
        .describe('Which built-in tool families are injected by default: "full" (all, default), "lean" (terminal, files, memory, todos), or an explicit array of family names. Shrinks the always-on tools array. A per-agent toolProfile in the agent config overrides this; an agent\'s explicit tool allowlist further restricts the result.'),
      dangerousTools: z
        .array(z.string())
        .optional()
        .describe('Tools that require explicit user approval before running. For MCP tools, which register under a server-prefixed name (e.g. "talonpress_publish_package"), either the bare name ("publish_package") or the full prefixed name matches.'),
      deferredTools: z
        .boolean()
        .optional()
        .describe('On-demand tool loading (default false). When true, only a core set plus the search_tools/load_tools meta-tools are exposed to the model each request; the rest are withheld until the model loads them, shrinking the always-on tools array without losing capability. Also enabled by the DEFERRED_TOOLS env var. Best paired with defaultProfile "full" so every tool is loadable.'),
      shell: z.string().optional().describe('Shell binary for run_command (default /bin/bash)'),
      commandTimeoutMs: z.number().int().min(1000).max(600_000).optional().describe('Timeout in milliseconds for run_command before it is killed (default 30000 = 30s). The concrete value is deliberately kept out of the run_command tool description (it is surfaced in the system prompt and at runtime instead) so the tools array stays byte-stable for prompt caching.'),
      approvalTimeoutMs: z.number().int().min(5_000).max(600_000).optional().describe('How long a HITL (human-in-the-loop) dangerous-tool approval request waits for a response before auto-denying (default 120000 = 2 minutes). The model is told when a denial was due to timeout vs an explicit user refusal, so it can offer to retry.'),
      agentWorkspace: z.string().optional().describe('Base workspace directory for agent tools'),
      skillsDir: z.string().optional().describe('Directory containing skill definitions'),
      agentBrowserEnabled: z.boolean().optional().describe('Enable agent-browser built-in tools (browser_navigate, browser_snapshot, etc.). Default: false. Requires agent-browser CLI installed globally.'),
      agentBrowserBin: z.string().optional().describe('Path or name of the agent-browser binary. Default: "agent-browser".'),
      languageServers: z
        .record(
          z.string(),
          z.object({
            command: z.string().describe('Language server executable'),
            args: z.array(z.string()).optional().describe('Command arguments'),
          }),
        )
        .optional()
        .describe('Override LSP server commands by language id (e.g. typescript, python). Defaults to typescript-language-server and pyright-langserver.'),
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
              tools: z.array(z.string()).optional().describe('Allowlist of bare tool names to register from this server (as the server exposes them, unprefixed). Omit to register all. Use this to keep verbose MCP tools you do not need off every request.'),
            }),
            z.object({
              name: z.string().describe('Unique server name'),
              url: z.string().url().describe('HTTP(S) endpoint for SSE or Streamable HTTP transport'),
              transport: z.enum(['sse', 'streamable-http']).optional().describe('Transport type: "sse" for legacy SSE, "streamable-http" for modern Streamable HTTP (default)'),
              headers: z.record(z.string(), z.string()).optional().describe('Additional HTTP headers (e.g. for auth)'),
              tools: z.array(z.string()).optional().describe('Allowlist of bare tool names to register from this server (as the server exposes them, unprefixed). Omit to register all. Use this to keep verbose MCP tools you do not need off every request.'),
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
  email: z.object({
    user: z.string().optional().describe('IMAP username (usually the full email address). Falls back to env EMAIL_USER.'),
    password: z.string().optional().describe('IMAP password or app-password. Falls back to env EMAIL_PASSWORD.'),
    smtpUser: z.string().optional().describe('SMTP username. Defaults to the IMAP user; falls back to env EMAIL_SMTP_USER.'),
    smtpPassword: z.string().optional().describe('SMTP password. Defaults to the IMAP password; falls back to env EMAIL_SMTP_PASSWORD.'),
  }).optional(),
  tools: z.object({
    braveApiKey: z.string().optional().describe('Brave Search API key for the web_search tool'),
  }).optional(),
  git: z.object({
    pat: z.string().optional().describe('Fine-grained Personal Access Token for git HTTPS authentication (written to .git-credentials). Preferred default — scope it to the repos the agent needs.'),
    classicPat: z.string().optional().describe('Classic Personal Access Token (ghp_…) for GitHub API features that require one, e.g. Projects v2 GraphQL. Exposed to run_command as GH_TOKEN/GITHUB_TOKEN. Classic tokens are coarse-grained; only set this when needed.'),
    patHost: z.string().optional().describe('Hostname the PAT applies to (default: github.com)'),
  }).optional(),
  dashboard: z.object({
    password: z.string().optional().describe('Bearer token protecting the dashboard (leave unset for open access)'),
  }).optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type AppSecrets = z.infer<typeof SecretsSchema>;

export const configJsonSchema = zodToJsonSchema(
  ConfigSchema as unknown as Parameters<typeof zodToJsonSchema>[0],
  'OpenTalonConfig',
);

export const secretsJsonSchema = zodToJsonSchema(
  SecretsSchema as unknown as Parameters<typeof zodToJsonSchema>[0],
  'OpenTalonSecrets',
);
