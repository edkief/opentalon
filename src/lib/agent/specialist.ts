import { generateText, stepCountIs, tool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import { emitSpecialist } from './log-bus';
import { configManager } from '../config';
import { schedulerService } from '../scheduler';
import { getSkillsSummary } from '../tools';
import { personaRegistry } from '../soul';

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
  tools?: ToolSet,
  personaId: string = 'default',
): Promise<string> {
  const model = resolveModel();

  const skillsSummary = await getSkillsSummary();
  const sm = personaRegistry.getSoulManager(personaId);
  const personaSoul = sm.getContent();

  const system = [
    '## Role',
    'You are a focused sub-agent (specialist). Complete ONLY the task assigned to you.',
    'Do not ask clarifying questions. Return your complete findings as plain text.',
    'If you need to reference files, include their full path and description in your response.',
    'You have skills at your disposal, use them if they help with your task.',
    ...(personaSoul ? ['', '## Persona Soul', personaSoul] : []),
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
  personaId?: string;
}

/**
 * Spawns a stateless, constrained sub-agent to handle a focused task.
 * No RAG, no memory ingestion. Result is returned as a plain string.
 */
export async function spawnSpecialist(options: SpecialistOptions & { parentSessionId?: string }): Promise<string> {
  const { taskDescription, contextSnapshot, depth, tools, timeoutMs = 60_000, parentSessionId = 'unknown', personaId = 'default' } = options;

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
      executeSpecialist(taskDescription, contextSnapshot, tools, personaId),
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
 * Background mode dispatches to pg-boss (same queue as scheduled tasks) so there
 * is no in-process timeout and results survive process restarts.
 */
export function createSpawnSpecialistTool(
  currentDepth: number,
  availableTools: ToolSet,
  parentSessionId?: string,
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
      persona_id: z
        .string()
        .optional()
        .describe('Persona to use for this specialist. Defaults to the current active persona.'),
    }) as any,
    execute: async (input: { task_description: string; context_snapshot: string; background?: boolean; persona_id?: string }) => {
      if (!input.background) {
        // Synchronous path — blocks until the specialist finishes
        return spawnSpecialist({
          taskDescription: input.task_description,
          contextSnapshot: input.context_snapshot,
          depth: currentDepth + 1,
          tools: availableTools,
          parentSessionId,
          personaId: input.persona_id,
        });
      }

      // Asynchronous path — dispatch via pg-boss (same queue as scheduled tasks).
      // This avoids the in-process 60 s timeout and keeps a single worker code path.
      const chatId = parentSessionId ?? 'unknown';
      const specialistId = crypto.randomUUID();

      // Embed context into the description so the handler doesn't need a separate field.
      const enrichedDescription = input.context_snapshot
        ? `${input.task_description}\n\nContext:\n${input.context_snapshot}`
        : input.task_description;

      // Emit spawn event so the Orchestration dashboard shows the task immediately.
      emitSpecialist({
        id: crypto.randomUUID(),
        kind: 'spawn',
        specialistId,
        parentSessionId: parentSessionId ?? 'unknown',
        taskDescription: input.task_description,
        contextSnapshot: input.context_snapshot,
        timestamp: new Date().toISOString(),
      });

      await schedulerService.scheduleOnce(specialistId, chatId, enrichedDescription, 0, { specialistId, personaId: input.persona_id });

      return JSON.stringify({
        jobId: specialistId,
        status: 'started',
        message: `Specialist is running in the background (ID: ${specialistId}). I'll deliver the results when it completes.`,
      });
    },
  } as any);
}
