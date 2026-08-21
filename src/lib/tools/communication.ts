import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import {
  createSecretRequest,
  getSecretRequest,
  clearSecretValue,
  expireSecretRequest,
} from '../db/secret-requests';
import { createUserInput, getUserInput, expireUserInput, GUIDANCE_TIMEOUT_MS } from '../db/user-inputs';
import { emitUserInputRequest } from '../agent/log-bus';
import { normalizeGuidanceOptions, TELEGRAM_BUTTON_TEXT_LIMIT } from '../guidance-options';
import type { BuiltInToolsOpts } from './types';
import { turnCancellation } from '../agent/cancellation';

export function getCommunicationTools(opts?: BuiltInToolsOpts): ToolSet {
  const tools: ToolSet = {};

  if (opts?.chatId && opts?.sendMessage) {
    tools.request_secret = tool({
      description:
        'Request a sensitive value (password, token, API key, or any credential) from the user ' +
        'via a secure one-time web link. Call this tool with a short name and a clear reason. ' +
        'The secure link is sent to the user automatically. This tool BLOCKS until the user ' +
        'submits, declines, or the 15-minute link expires, then returns the result to you in ' +
        'this same turn — do NOT do unrelated work expecting a later notification; there is none. ' +
        'The returned secret is redacted from stored history, so use it within this turn ' +
        '(e.g. write it to a file); it will not be available to recall in later turns.',
      inputSchema: z.object({
        name: z.string().describe('Short label for the requested secret, e.g. "GitHub token"'),
        reason: z
          .string()
          .describe('Clear explanation of why you need this secret and what it will be used for'),
        flavourText: z
          .string()
          .optional()
          .describe('Optional friendly message to include when prompting the user for the secret'),
      }),
      execute: async (input) => {
        const uid = crypto.randomUUID();
        const ttlMinutes = 15;
        const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
        const url = `${publicBaseUrl}/retrieve-secret/${uid}`;
        await createSecretRequest(uid, input.name, input.reason, opts.chatId!, ttlMinutes);

        const userMessage = `🔐 <b>Secret Request</b>\n\n` +
          `I need <b>${input.name}</b> for:\n${input.reason}\n\n` +
          `Please provide it securely here:\n${url}\n\n` +
          `<i>This link expires in ${ttlMinutes} minutes.</i>` +
          (input.flavourText ? `\n\n${input.flavourText}` : '');

        await opts.sendMessage!(opts.chatId!, userMessage, 'html');

        // Block-and-poll until the user responds via the secure link (handled by
        // the /retrieve-secret respond route, which sets status + value in the DB),
        // or the request's own TTL elapses. Polling the DB is the cross-process
        // channel: the respond route runs in Next.js, this tool in the bot/task
        // process. Keeping the wait inside this turn means the secret lands in the
        // requesting agent's context — no separate turn racing the main run.
        const pollInterval = 2000;
        const deadline = Date.now() + ttlMinutes * 60 * 1000;

        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval));

          // A `/cancel` while we're parked here must not wait out the 15-minute
          // TTL — the user who would have answered this prompt is the one who
          // just cancelled it.
          if (opts.chatId && turnCancellation.requested(opts.chatId)) {
            return 'Secret request abandoned — the user cancelled this turn.';
          }

          const req = await getSecretRequest(uid);
          if (!req) return 'Secret request expired or was cancelled.';

          if (req.status === 'fulfilled') {
            const secret = req.value ?? '';
            // Read-once: null the transient value so its at-rest lifetime is one
            // poll interval, not the row TTL.
            await clearSecretValue(uid).catch(() => {});
            return (
              `The user provided the secret for "${input.name}".\n\n` +
              `Secret: ${secret}\n\n` +
              `(This value is redacted from stored history — use it now; you cannot recall it later.)`
            );
          }

          if (req.status === 'guided') {
            const message = req.value ?? '';
            await clearSecretValue(uid).catch(() => {});
            return (
              `Instead of the secret for "${input.name}", the user sent instructions:\n\n${message}`
            );
          }

          if (req.status === 'declined') {
            return `The user declined to provide the secret for "${input.name}".`;
          }

          if (req.status === 'expired') {
            return `The secret request for "${input.name}" expired before the user responded.`;
          }
        }

        await expireSecretRequest(uid).catch(() => {});
        return `The secret request for "${input.name}" timed out after ${ttlMinutes} minutes with no response.`;
      },
    });
  }

  if (opts?.chatId) {
    const memoryChatId = opts.chatId;

    tools.request_guidance = tool({
      description:
        'Request guidance from the user before continuing. ' +
        'Use as a LAST RESORT when you need user confirmation or direction that you cannot determine autonomously. ' +
        'Examples: reviewing an implementation plan before executing, choosing between approaches, confirming sensitive operations. ' +
        'Before calling this, try to proceed with your best judgment or provide options. ' +
        'The agent should do as much work as possible before requesting input.',
      inputSchema: z.object({
        prompt: z.string().describe('Clear question or context for the user'),
        options: z
          .array(
            z.union([
              z.string(),
              z.object({
                label: z
                  .string()
                  .describe(`Short button text (keep under ${TELEGRAM_BUTTON_TEXT_LIMIT} characters)`),
                description: z.string().describe('Full explanation of this option, shown in the message body'),
              }),
            ]),
          )
          .optional()
          .describe(
            'If the user should choose from specific options. Prefer {label, description} pairs: ' +
              'the short label is what fits on a clickable button, the description gives the user the ' +
              'full context. A plain string is used as both label and description.',
          ),
      }),
      execute: async (input) => {
        const chatId = memoryChatId;
        if (!chatId) return 'Cannot determine chat ID for user input request';

        const options = normalizeGuidanceOptions(input.options);

        const inputId = await createUserInput({
          chatId,
          prompt: input.prompt,
          options,
        });

        emitUserInputRequest({
          id: crypto.randomUUID(),
          inputId,
          chatId,
          prompt: input.prompt,
          options,
          timestamp: new Date().toISOString(),
        });

        const startTime = Date.now();
        const pollInterval = 2000;

        while (Date.now() - startTime < GUIDANCE_TIMEOUT_MS) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));

          // Same as the secret-request wait: `/cancel` ends the poll rather
          // than leaving the turn parked on a question nobody will answer.
          if (turnCancellation.requested(chatId)) {
            return 'Guidance request abandoned — the user cancelled this turn.';
          }

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

          if (userInput.status === 'failed') {
            return (
              `Could not deliver the guidance request to the user (channel error: ${userInput.response ?? 'unknown'}). ` +
              'The user never saw the question. Do not wait for a reply; either proceed with your best judgment ' +
              'or retry with a shorter prompt/options.'
            );
          }
        }

        // Final check before giving up, in case a response landed on the last tick's edge.
        const finalInput = await getUserInput(inputId);
        if (finalInput?.status === 'responded' && finalInput.response) {
          return `User guidance provided: ${finalInput.response}`;
        }
        await expireUserInput(inputId);
        return 'User input request timed out after 5 minutes.';
      },
    });
  }

  return tools;
}
