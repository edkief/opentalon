import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const ConfigSchema = z.object({
  llm: z
    .object({
      model: z.string().optional().describe('Primary model in "provider/model" format, e.g. "anthropic/claude-sonnet-4-5"'),
      fallbacks: z.array(z.string()).optional().describe('Ordered fallback models in "provider/model" format, e.g. ["openai/gpt-4o", "mistral/mistral-large-latest"]'),
      temperature: z.number().min(0).max(2).optional().describe('Sampling temperature (0-2, default 0.7)'),
      maxSteps: z.number().int().min(1).max(50).optional().describe('Max tool-use steps per request (default 10)'),
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
      ownerId: z.number().int().optional().describe('Restrict bot to this Telegram user ID (leave unset to allow all)'),
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
      mcpServers: z
        .array(
          z.object({
            name: z.string().describe('Unique server name'),
            command: z.string().describe('Executable to launch'),
            args: z.array(z.string()).optional().describe('Command arguments'),
            env: z.record(z.string(), z.string()).optional().describe('Extra environment variables for the process'),
          })
        )
        .optional()
        .describe('Model Context Protocol server configurations'),
    })
    .optional(),
});

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
  dashboard: z.object({
    password: z.string().optional().describe('Bearer token protecting the dashboard (leave unset for open access)'),
  }).optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type AppSecrets = z.infer<typeof SecretsSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const configJsonSchema = zodToJsonSchema(ConfigSchema as any, 'OpenPincerConfig');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const secretsJsonSchema = zodToJsonSchema(SecretsSchema as any, 'OpenPincerSecrets');
