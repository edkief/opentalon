import { db } from '@/lib/db';
import { workflowRunNodes, workflowRuns, workflows } from '@/lib/db/schema';
import type { CodeNodeConfig, WorkflowNodeDef } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function executeCodeNode(
  runId: string,
  runNodeId: string,
  config: CodeNodeConfig,
  inputData: Record<string, unknown>,
  chatId: string,
  onComplete: (runNodeId: string, outputData: Record<string, unknown>, chatId: string) => Promise<void>,
): Promise<void> {
  const context = await buildRunContext(runId);
  const timeoutMs = config.timeoutMs ?? 5000;

  const { result, consoleLogs } = await Promise.race([
    runUserCode(config.code, inputData, context),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Code node timed out after ${timeoutMs / 1000}s`)), timeoutMs),
    ),
  ]);

  // Plain objects are spread so downstream {{key}} templates work directly;
  // primitives and arrays are wrapped under 'output'.
  const outputData: Record<string, unknown> =
    result !== null && typeof result === 'object' && !Array.isArray(result)
      ? { output: result, ...(result as Record<string, unknown>) }
      : { output: result };

  if (consoleLogs.length > 0) {
    outputData.__logs = consoleLogs;
  }

  await onComplete(runNodeId, outputData, chatId);
}

interface CodeRunResult {
  result: unknown;
  consoleLogs: string[];
}

async function runUserCode(
  code: string,
  input: Record<string, unknown>,
  context: Record<string, unknown>,
): Promise<CodeRunResult> {
  const consoleLogs: string[] = [];

  // Intercept console calls so user output is captured, not leaked to the server log.
  const stringify = (...args: unknown[]) =>
    args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');

  const capturedConsole = {
    log:   (...args: unknown[]) => consoleLogs.push(stringify(...args)),
    info:  (...args: unknown[]) => consoleLogs.push(`[info] ${stringify(...args)}`),
    warn:  (...args: unknown[]) => consoleLogs.push(`[warn] ${stringify(...args)}`),
    error: (...args: unknown[]) => consoleLogs.push(`[error] ${stringify(...args)}`),
  };

  // AsyncFunction constructor enables top-level await in user code.
  // Only 'input', 'context', and 'console' are exposed — no process/require/globalThis.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;
  const fn = new AsyncFunction('input', 'context', 'console', `"use strict";\n${code}`);
  const result = await fn(input, context, capturedConsole);
  return { result, consoleLogs };
}

async function buildRunContext(runId: string): Promise<Record<string, unknown>> {
  const [run] = await db
    .select({ workflowId: workflowRuns.workflowId })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  if (!run) return {};

  const [workflow] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, run.workflowId))
    .limit(1);
  if (!workflow) return {};

  const { nodes } = workflow.definition as { nodes: WorkflowNodeDef[] };
  const labelById = new Map(nodes.map((n) => [n.id, n.label]));

  const runNodes = await db
    .select()
    .from(workflowRunNodes)
    .where(eq(workflowRunNodes.runId, runId));

  const ctx: Record<string, unknown> = {};
  for (const rn of runNodes) {
    if (rn.status === 'completed' && rn.outputData) {
      const label = labelById.get(rn.nodeId) ?? rn.nodeId;
      ctx[label] = rn.outputData;
    }
  }
  return ctx;
}
