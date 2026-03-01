import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const ConfigSchema = z.object({
  llm: z
    .object({
      provider: z.enum(['anthropic', 'openai', 'mistral']).optional().describe('Primary LLM provider'),
      model: z.string().optional().describe('Model override (leave unset to use provider default)'),
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
  anthropicApiKey: z.string().optional().describe('Anthropic API key (sk-ant-...)'),
  openaiApiKey: z.string().optional().describe('OpenAI API key (sk-...)'),
  mistralApiKey: z.string().optional().describe('Mistral API key'),
  telegramBotToken: z.string().optional().describe('Telegram bot token from @BotFather'),
  braveApiKey: z.string().optional().describe('Brave Search API key for web_search tool'),
  dashboardPassword: z.string().optional().describe('Bearer token protecting the dashboard (leave unset for open access)'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type AppSecrets = z.infer<typeof SecretsSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const configJsonSchema = zodToJsonSchema(ConfigSchema as any, 'OpenPincerConfig');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const secretsJsonSchema = zodToJsonSchema(SecretsSchema as any, 'OpenPincerSecrets');
