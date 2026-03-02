import { generateText, stepCountIs, tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import { emitSpecialist } from './log-bus';
import { configManager } from '../config';
import { createJob, updateJobStatus } from '../db/jobs';
import { getSkillsSummary } from '../tools';

const MINIMAX_BASE_URL = 'https://api.minimaxi.chat/v1';

export class DepthLimitError extends Error {
  constructor() {
    super('Specialists cannot spawn further specialists (max depth reached)');
    this.name = 'DepthLimitError';
  }
}

function resolveModel() {
  const cfg = configManager.get().llm ?? {};
  const secrets = configManager.getSecrets();

  const pref = cfg.provider ?? process.env.LLM_PROVIDER?.toLowerCase();
  const modelId = cfg.model ?? process.env.LLM_MODEL;

  const anthropicKey = secrets.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  const openaiKey    = secrets.openaiApiKey    ?? process.env.OPENAI_API_KEY;
  const mistralKey   = secrets.mistralApiKey   ?? process.env.MISTRAL_API_KEY;
  const minimaxKey   = secrets.minimaxApiKey   ?? process.env.MINIMAX_API_KEY;

  if (pref === 'anthropic' && anthropicKey) return createAnthropic({ apiKey: anthropicKey })(modelId ?? 'claude-sonnet-4-20250514');
  if (pref === 'mistral'   && mistralKey)   return createMistral({ apiKey: mistralKey })(modelId ?? 'mistral-large-latest');
  if (pref === 'openai'    && openaiKey)    return createOpenAI({ apiKey: openaiKey })(modelId ?? 'gpt-4o');
  if (pref === 'minimax'   && minimaxKey)   return createOpenAICompatible({ name: 'minimax', baseURL: MINIMAX_BASE_URL, apiKey: minimaxKey })(modelId ?? 'MiniMax-M2.5');

  if (anthropicKey) return createAnthropic({ apiKey: anthropicKey })('claude-sonnet-4-20250514');
  if (openaiKey)    return createOpenAI({ apiKey: openaiKey })('gpt-4o');
  if (mistralKey)   return createMistral({ apiKey: mistralKey })('mistral-large-latest');
  if (minimaxKey)   return createOpenAICompatible({ name: 'minimax', baseURL: MINIMAX_BASE_URL, apiKey: minimaxKey })('MiniMax-M2.5');

  throw new Error('No LLM provider available for specialist');
}

async function executeSpecialist(
  taskDescription: string,
  contextSnapshot: string,
  tools?: ToolSet
): Promise<string> {
  const model = resolveModel();

  const skillsSummary = await getSkillsSummary();

  const system = [
    '## Role',
    'You are a focused sub-agent (specialist). Complete ONLY the task assigned to you.',
    'Do not ask clarifying questions. Return your complete findings as plain text.',
    '',
    '## Context from Supervisor',
    contextSnapshot || '(no additional context provided)',
    ...(skillsSummary ? ['', '## Available Skills', skillsSummary] : []),
    '',
    '## Your Task',
    taskDescription,
  ].join('\n');

  const toolKeys = tools ? Object.keys(tools) : [];

  const result = await generateText({
    model,
    system,
    messages: [{ role: 'user', content: taskDescription }],
    ...(toolKeys.length > 0
      ? { tools, toolChoice: 'auto', stopWhen: stepCountIs(15) }
      : {}),
  });

  if (result.text) return result.text;

  // If the final step had no text (e.g. hit maxSteps mid-tool-chain), collect
  // any text produced across all steps as a fallback.
  const stepTexts = result.steps
    .map((s) => s.text)
    .filter(Boolean)
    .join('\n\n');
  return stepTexts || '(specialist returned no output)';
}

export interface SpecialistOptions {
  taskDescription: string;
  contextSnapshot: string;
  depth: number;
  tools?: ToolSet;
  timeoutMs?: number;
}

/**
 * Spawns a stateless, constrained sub-agent to handle a focused task.
 * No RAG, no memory ingestion. Result is returned as a plain string.
 */
export async function spawnSpecialist(options: SpecialistOptions & { parentSessionId?: string }): Promise<string> {
  const { taskDescription, contextSnapshot, depth, tools, timeoutMs = 60_000, parentSessionId = 'unknown' } = options;

  if (depth > 1) throw new DepthLimitError();

  const specialistId = crypto.randomUUID();
  const startMs = Date.now();

  emitSpecialist({
    id: crypto.randomUUID(),
    kind: 'spawn',
    specialistId,
    parentSessionId,
    taskDescription,
    contextSnapshot,
    timestamp: new Date().toISOString(),
  });

  const timeout = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error('Specialist timed out after 60s')), timeoutMs)
  );

  try {
    const result = await Promise.race([
      executeSpecialist(taskDescription, contextSnapshot, tools),
      timeout,
    ]);

    emitSpecialist({
      id: crypto.randomUUID(),
      kind: 'complete',
      specialistId,
      parentSessionId,
      taskDescription,
      result: result.slice(0, 500),
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Specialist] Task failed:', message);

    emitSpecialist({
      id: crypto.randomUUID(),
      kind: 'error',
      specialistId,
      parentSessionId,
      taskDescription,
      result: message,
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    });

    return `Specialist failed: ${message}`;
  }
}

/**
 * Returns an AI SDK tool that the Supervisor can call to delegate tasks.
 * Depth is captured in closure so specialists cannot recursively spawn specialists.
 * Supports optional background mode: returns a job ID immediately and delivers
 * results via onJobComplete callback when the specialist finishes.
 */
export function createSpawnSpecialistTool(
  currentDepth: number,
  availableTools: ToolSet,
  parentSessionId?: string,
  onJobComplete?: (jobId: string, taskDescription: string, result: string) => void,
) {
  return tool({
    description:
      'Delegate a focused analysis or data-processing task to a specialist sub-agent. ' +
      'Use when you need deep analysis, log parsing, or multi-step reasoning on a specific topic ' +
      'and want to keep the main conversation clean. The specialist works independently and returns a summary. ' +
      'Set background: true to run asynchronously — you get a job ID immediately and the result is delivered ' +
      'in a follow-up turn, allowing you to run multiple specialists in parallel.',
    inputSchema: z.object({
      task_description: z
        .string()
        .describe('Clear, self-contained description of what the specialist must do'),
      context_snapshot: z
        .string()
        .describe('Relevant context the specialist needs (facts, data, constraints). Be concise.'),
      background: z
        .boolean()
        .optional()
        .describe(
          'If true, run the specialist asynchronously. Returns a job ID immediately so you can ' +
          'respond to the user right away. Results arrive in a follow-up turn. ' +
          'Use for long tasks or to run multiple specialists in parallel.',
        ),
    }) as any,
    execute: async (input: { task_description: string; context_snapshot: string; background?: boolean }) => {
      if (!input.background) {
        // Synchronous path — blocks until the specialist finishes
        return spawnSpecialist({
          taskDescription: input.task_description,
          contextSnapshot: input.context_snapshot,
          depth: currentDepth + 1,
          tools: availableTools,
          parentSessionId,
        });
      }

      // Asynchronous path — create a job record and fire-and-forget
      const chatId = parentSessionId ?? 'unknown';
      const jobId = await createJob({
        chatId,
        status: 'running',
        taskDescription: input.task_description,
      });

      spawnSpecialist({
        taskDescription: input.task_description,
        contextSnapshot: input.context_snapshot,
        depth: currentDepth + 1,
        tools: availableTools,
        parentSessionId,
      }).then((result) => {
        updateJobStatus(jobId, 'completed', result).catch(console.error);
        onJobComplete?.(jobId, input.task_description, result);
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        updateJobStatus(jobId, 'failed', undefined, msg).catch(console.error);
        onJobComplete?.(jobId, input.task_description, `Specialist failed: ${msg}`);
      });

      return JSON.stringify({
        jobId,
        status: 'started',
        message: `Specialist is running in the background (job ${jobId}). I'll deliver the results when it completes.`,
      });
    },
  } as any);
}
