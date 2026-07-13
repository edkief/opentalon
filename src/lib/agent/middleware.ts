import { wrapLanguageModel } from 'ai';
import type { LanguageModelMiddleware, LanguageModel } from 'ai';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configManager } from '../config';

/** Minimal views over AI SDK v2 tool-result content used by the compression middleware. */
type ToolResultOutput = { type?: string; value?: unknown };
type ToolResultPart = { type?: string; toolCallId?: string; toolName?: string; output?: ToolResultOutput };

/**
 * Directory for offloaded full tool outputs. Lives in the persistent /workspace PVC.
 * The agent can re-read any file here via the `read_file` tool, which accepts absolute paths.
 */
const getToolDumpDir = (chatId?: string) => {
  const workspace = process.env.AGENT_WORKSPACE ?? process.cwd();
  return path.join(workspace, 'tool-results', chatId ?? 'global');
};

/**
 * Write the full tool output to an ephemeral file so the agent can recover it
 * after compression truncates the in-context copy. Keyed by toolCallId so the
 * write is idempotent across the many LLM calls within one turn (middleware runs
 * on every step). Returns the absolute path, or null if the write failed (in
 * which case the caller falls back to plain truncation with no recovery path).
 */
async function offloadToolResult(toolCallId: string, fullText: string, chatId?: string): Promise<string | null> {
  try {
    // toolCallId is model-supplied — strip anything that isn't a safe filename char.
    const safeId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'result';
    const dumpDir = getToolDumpDir(chatId);
    const filePath = path.join(dumpDir, `${safeId}.txt`);
    await fs.mkdir(dumpDir, { recursive: true });
    // Idempotent: only write if absent (content for a given toolCallId is fixed).
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, fullText, 'utf8');
    }
    return filePath;
  } catch (err) {
    console.error('[toolCompression] offload failed', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool result compression middleware
//
// (RAG context injection used to live here as a per-doGenerate middleware —
// see rec #6 in docs/reviews/agentic-best-practices: transformParams ran on
// every step of the multi-step loop and again in finalise/todo-check,
// re-running hybrid retrieval up to `maxSteps + 2` times for one result, and
// re-mutating the system prompt mid-turn which also defeated prompt caching
// (rec #5). Retrieval is now done once per turn in LLMExecutor.chat() and
// injected directly into the message list — see retrieveTurnContext there.)
// ---------------------------------------------------------------------------

/** Extract a plain string from any tool-result output variant. */
function extractText(output: ToolResultOutput | null | undefined): string {
  if (!output) return '';
  switch (output.type) {
    case 'text':
    case 'error-text':
      return typeof output.value === 'string' ? output.value : '';
    case 'json':
    case 'error-json':
      try { return JSON.stringify(output.value); } catch { return ''; }
    case 'content': {
      const parts: Array<{ type?: string; text?: string }> = Array.isArray(output.value)
        ? (output.value as Array<{ type?: string; text?: string }>)
        : [];
      return parts
        .filter((p) => p?.type === 'text')
        .map((p) => p.text ?? '')
        .join('');
    }
    default:
      return '';
  }
}

/** Wrap a plain string back as a text output, replacing whatever was there. */
function asTextOutput(value: string): { type: 'text'; value: string } {
  return { type: 'text', value };
}

/**
 * Apply a char limit to a tool-result part, returning a (possibly cloned) part.
 * Before truncating, the full output is offloaded to an ephemeral file and the
 * retained head is suffixed with the path so the agent can `read_file` to recover
 * the dropped tail. If offload fails, falls back to a plain truncation marker.
 */
async function applyLimit(
  part: ToolResultPart,
  limit: number,
  marker: (remaining: number, recoverPath: string | null) => string,
  chatId?: string,
): Promise<ToolResultPart> {
  const text = extractText(part.output);
  if (text.length <= limit) return part;
  const remaining = text.length - limit;
  const headLimit = Math.floor(limit * 0.8);
  const tailLimit = limit - headLimit;

  const recoverPath = part.toolCallId ? await offloadToolResult(part.toolCallId, text, chatId) : null;
  const truncatedText = text.slice(0, headLimit) + '\n\n' + marker(remaining, recoverPath) + '\n\n' + text.slice(-tailLimit);

  return {
    ...part,
    output: asTextOutput(truncatedText),
  };
}

export function createToolCompressionMiddleware(chatId?: string): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      const cfg = configManager.get().llm ?? {};
      const window = cfg.toolResultWindow ?? 3;
      const maxChars = cfg.toolResultMaxChars ?? 8_000;
      const headChars = cfg.toolResultHeadChars ?? 2_000;

      const prompt = params.prompt;

      // Collect indices of all tool-role messages in order
      const toolIndices: number[] = [];
      for (let i = 0; i < prompt.length; i++) {
        if (prompt[i].role === 'tool') toolIndices.push(i);
      }

      if (toolIndices.length === 0) return params;

      // Split into window set (last N) and old set (the rest)
      const windowSet = new Set(toolIndices.slice(-window));
      const oldSet = new Set(toolIndices.slice(0, Math.max(0, toolIndices.length - window)));

      // Recovery hint appended after the char-count marker, pointing the agent
      // at the ephemeral file holding the full, untruncated output.
      const recoverHint = (recoverPath: string | null) =>
        recoverPath ? ` — full output saved to ${recoverPath}, use read_file to retrieve it` : '';

      // Only rebuild the prompt array if at least one message needs changing.
      // applyLimit is async (it offloads oversized outputs to disk), so build the
      // new content arrays with Promise.all rather than a sync .map.
      let modified = false;
      const newPrompt = await Promise.all(
        prompt.map(async (msg, idx) => {
          if (msg.role !== 'tool') return msg;

          const inWindow = windowSet.has(idx);
          const limit = inWindow ? maxChars : headChars;
          const marker = inWindow
            ? (n: number, p: string | null) => ` …[${n} chars truncated${recoverHint(p)}]`
            : (n: number, p: string | null) => ` …[${n} chars, outside context window${recoverHint(p)}]`;

          let msgModified = false;
          const newContent = await Promise.all(
            (msg.content as ToolResultPart[]).map(async (part) => {
              if (part.type !== 'tool-result') return part;
              const text = extractText(part.output);
              if (text.length <= limit) return part;
              modified = true;
              msgModified = true;
              return applyLimit(part, limit, marker, chatId);
            }),
          );

          if (!msgModified) return msg;
          return { ...msg, content: newContent };
        }),
      );

      if (!modified) return params;
      return { ...params, prompt: newPrompt as typeof params.prompt };
    },
  };
}

export function wrapModelWithToolCompression(model: LanguageModel, chatId?: string): LanguageModel {
  return wrapLanguageModel({ model: model as Parameters<typeof wrapLanguageModel>[0]['model'], middleware: createToolCompressionMiddleware(chatId) }) as LanguageModel;
}

/**
 * Delete offloaded tool-result dumps older than maxAgeMs. tmp is wiped on pod
 * restart, so this only matters for long-lived pods where dumps would otherwise
 * accumulate within a single process lifetime. Best-effort: a missing dir is a
 * no-op and individual stat/unlink failures are skipped, never thrown.
 */
export async function sweepToolResultDumps(maxAgeMs = 6 * 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  const workspace = process.env.AGENT_WORKSPACE ?? process.cwd();
  const rootDir = path.join(workspace, 'tool-results');

  async function sweepDir(dirPath: string) {
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await sweepDir(fullPath);
          try {
            await fs.rmdir(fullPath);
          } catch {
            // ignore if not empty or missing
          }
        } else {
          try {
            const stat = await fs.stat(fullPath);
            if (stat.mtimeMs < cutoff) {
              await fs.unlink(fullPath);
              removed++;
            }
          } catch {
            // file vanished or unreadable — ignore
          }
        }
      }),
    );
  }

  await sweepDir(rootDir);
  return removed;
}
