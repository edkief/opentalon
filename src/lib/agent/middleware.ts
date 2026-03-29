import { wrapLanguageModel } from 'ai';
import type { LanguageModelMiddleware, LanguageModel } from 'ai';
import { retrieveContext } from '../memory';
import type { MemoryScope } from '../memory';
import { setRagContext } from './rag-store';
import { configManager } from '../config';

export function createRagMiddleware(scope: MemoryScope, chatId: string, agent?: string): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }: { type: 'generate' | 'stream'; params: any; model: any }) => {
      const messages = params.prompt as Array<{ role: string; content: unknown }>;

      // Extract text from the last user message to use as the retrieval query
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) return params;

      const query = Array.isArray(lastUser.content)
        ? (lastUser.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join(' ')
        : String(lastUser.content);

      if (!query.trim()) return params;

      const memoryContext = await retrieveContext({ query, scope, chatId, limit: 5, agent });
      if (!memoryContext) return params;

      // Make retrieved context available to onStepFinish via the rag-store
      setRagContext(chatId, memoryContext);

      const contextSection = `\n\n## Past Relevant Context\n${memoryContext}`;

      // Append context to the existing system message, or prepend a new one
      const hasSystem = messages.some((m) => m.role === 'system');
      const newPrompt = hasSystem
        ? messages.map((m) =>
            m.role === 'system'
              ? { ...m, content: (m.content as string) + contextSection }
              : m
          )
        : [{ role: 'system' as const, content: `## Past Relevant Context\n${memoryContext}` }, ...messages];

      return { ...params, prompt: newPrompt };
    },
  };
}

export function wrapModelWithMemory(
  model: LanguageModel,
  scope: MemoryScope,
  chatId: string,
  agent?: string,
): LanguageModel {
  return wrapLanguageModel({ model: model as any, middleware: createRagMiddleware(scope, chatId, agent) }) as LanguageModel;
}

// ---------------------------------------------------------------------------
// Tool result compression middleware
// ---------------------------------------------------------------------------

/** Extract a plain string from any tool-result output variant. */
function extractText(output: any): string {
  if (!output) return '';
  switch (output.type) {
    case 'text':
    case 'error-text':
      return typeof output.value === 'string' ? output.value : '';
    case 'json':
    case 'error-json':
      try { return JSON.stringify(output.value); } catch { return ''; }
    case 'content': {
      const parts: unknown[] = Array.isArray(output.value) ? output.value : [];
      return parts
        .filter((p: any) => p?.type === 'text')
        .map((p: any) => p.text ?? '')
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

/** Apply a char limit to a tool-result part, returning a (possibly cloned) part. */
function applyLimit(part: any, limit: number, suffix: (n: number) => string): any {
  const text = extractText(part.output);
  if (text.length <= limit) return part;
  const remaining = text.length - limit;
  return {
    ...part,
    output: asTextOutput(text.slice(0, limit) + suffix(remaining)),
  };
}

export function createToolCompressionMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }: { type: 'generate' | 'stream'; params: any; model: any }) => {
      const cfg = configManager.get().llm ?? {};
      const window = cfg.toolResultWindow ?? 3;
      const maxChars = cfg.toolResultMaxChars ?? 8_000;
      const headChars = cfg.toolResultHeadChars ?? 2_000;

      const prompt: any[] = params.prompt;

      // Collect indices of all tool-role messages in order
      const toolIndices: number[] = [];
      for (let i = 0; i < prompt.length; i++) {
        if (prompt[i].role === 'tool') toolIndices.push(i);
      }

      if (toolIndices.length === 0) return params;

      // Split into window set (last N) and old set (the rest)
      const windowSet = new Set(toolIndices.slice(-window));
      const oldSet = new Set(toolIndices.slice(0, Math.max(0, toolIndices.length - window)));

      // Only rebuild the prompt array if at least one message needs changing
      let modified = false;
      const newPrompt = prompt.map((msg: any, idx: number) => {
        if (msg.role !== 'tool') return msg;

        const inWindow = windowSet.has(idx);
        const limit = inWindow ? maxChars : headChars;
        const suffix = inWindow
          ? (n: number) => ` …[${n} chars truncated]`
          : (n: number) => ` …[${n} chars, outside context window]`;

        const newContent = (msg.content as any[]).map((part: any) => {
          if (part.type !== 'tool-result') return part;
          const text = extractText(part.output);
          if (text.length <= limit) return part;
          modified = true;
          return applyLimit(part, limit, suffix);
        });

        if (!modified) return msg;
        return { ...msg, content: newContent };
      });

      if (!modified) return params;
      return { ...params, prompt: newPrompt };
    },
  };
}

export function wrapModelWithToolCompression(model: LanguageModel): LanguageModel {
  return wrapLanguageModel({ model: model as any, middleware: createToolCompressionMiddleware() }) as LanguageModel;
}
