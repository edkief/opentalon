import { wrapLanguageModel } from 'ai';
import type { LanguageModelMiddleware, LanguageModel } from 'ai';
import { retrieveContext } from '../memory';
import type { MemoryScope } from '../memory';
import { setRagContext } from './rag-store';

export function createRagMiddleware(scope: MemoryScope, chatId: string): LanguageModelMiddleware {
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

      const memoryContext = await retrieveContext({ query, scope, chatId, limit: 5 });
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
  chatId: string
): LanguageModel {
  return wrapLanguageModel({ model: model as any, middleware: createRagMiddleware(scope, chatId) }) as LanguageModel;
}
