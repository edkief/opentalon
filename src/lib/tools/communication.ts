import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { createSecretRequest } from '../db/secret-requests';
import { createUserInput, getUserInput } from '../db/user-inputs';
import { emitUserInputRequest } from '../agent/log-bus';
import type { BuiltInToolsOpts } from './types';

export function getCommunicationTools(opts?: BuiltInToolsOpts): ToolSet {
  const tools: ToolSet = {};

  if (opts?.telegramChatId && opts?.sendTelegramMessage) {
    tools.request_secret = tool({
      description:
        'Request a sensitive value (password, token, API key, or any credential) from the user ' +
        'via a secure one-time web link. Call this tool with a short name and a clear reason. ' +
        'The secure link will be sent to the user automatically. You will receive a unique request ID. ' +
        'When the user submits or declines, you will be notified automatically in this conversation. ' +
        'You do NOT need to poll or call any other tool to retrieve the value.',
      inputSchema: z.object({
        name: z.string().describe('Short label for the requested secret, e.g. "GitHub token"'),
        reason: z
          .string()
          .describe('Clear explanation of why you need this secret and what it will be used for'),
        flavourText: z
          .string()
          .optional()
          .describe('Optional friendly message to include when prompting the user for the secret'),
      }) as any,
      execute: async (input: { name: string; reason: string; flavourText?: string }) => {
        const uid = crypto.randomUUID();
        const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
        const url = `${publicBaseUrl}/retrieve-secret/${uid}`;
        await createSecretRequest(uid, input.name, input.reason, opts.telegramChatId!);

        const userMessage = `🔐 <b>Secret Request</b>\n\n` +
          `I need <b>${input.name}</b> for:\n${input.reason}\n\n` +
          `Please provide it securely here:\n${url}\n\n` +
          `<i>This link expires in 15 minutes.</i>` +
          (input.flavourText ? `\n\n${input.flavourText}` : '');

        await opts.sendTelegramMessage!(opts.telegramChatId!, userMessage, 'html');

        return `Secret request sent. Request ID: ${uid}`;
      },
    } as any);
  }

  if (opts?.telegramChatId) {
    const memoryChatId = opts.telegramChatId;

    tools.request_guidance = tool({
      description:
        'Request guidance from the user before continuing. ' +
        'Use as a LAST RESORT when you need user confirmation or direction that you cannot determine autonomously. ' +
        'Examples: reviewing an implementation plan before executing, choosing between approaches, confirming sensitive operations. ' +
        'Before calling this, try to proceed with your best judgment or provide options. ' +
        'The agent should do as much work as possible before requesting input.',
      inputSchema: z.object({
        prompt: z.string().describe('Clear question or context for the user'),
        options: z.array(z.string()).optional().describe('If user should choose from specific options'),
      }) as any,
      execute: async (input: { prompt: string; options?: string[] }, params?: { chatId?: string }) => {
        const chatId = params?.chatId ?? memoryChatId;
        if (!chatId) return 'Cannot determine chat ID for user input request';

        const inputId = await createUserInput({
          chatId,
          prompt: input.prompt,
          options: input.options,
        });

        emitUserInputRequest({
          id: crypto.randomUUID(),
          inputId,
          chatId,
          prompt: input.prompt,
          options: input.options,
          timestamp: new Date().toISOString(),
        });

        const startTime = Date.now();
        const pollInterval = 2000;

        while (Date.now() - startTime < 300000) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));

          const userInput = await getUserInput(inputId);
          if (!userInput) {
            return 'User input request expired or was cancelled.';
          }

          if (userInput.status === 'responded' && userInput.response) {
            return `User guidance provided: ${userInput.response}`;
          }

          if (userInput.status === 'expired') {
            return 'User input request timed out.';
          }
        }

        return 'User input request timed out after 5 minutes.';
      },
    } as any);
  }

  return tools;
}
