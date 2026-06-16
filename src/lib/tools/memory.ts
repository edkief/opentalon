import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { retrieveContext } from '../memory/retrieve';
import { memoryManager } from '../agent/memory-manager';
import type { BuiltInToolsOpts } from './types';

export function getMemoryTools(opts?: BuiltInToolsOpts): ToolSet {
  const memoryScope = opts?.memoryScope ?? 'private';
  const memoryChatId = opts?.telegramChatId;

  return {
    rag_search: tool({
      description:
        'Search long-term memory (Qdrant vector store) for information relevant to a query. ' +
        'Use this when the user references something from a past conversation or asks about ' +
        'something you might have stored. Returns the most relevant memory excerpts. ' +
        'This is semantic search — it finds conceptually similar content, not exact matches.',
      inputSchema: z.object({
        query: z.string().describe('Natural-language search query'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Max results to return (default 5)'),
      }),
      execute: async (input: { query: string; limit?: number }) => {
        const results = await retrieveContext({
          query: input.query,
          scope: memoryScope,
          limit: input.limit ?? 5,
          chatId: memoryChatId,
        });
        return results || 'No relevant memories found.';
      },
    }),

    memory_read: tool({
      description:
        'Read the contents of MEMORY.md — the persistent scratchpad for important user ' +
        'preferences and facts. Always available in the system prompt, but call this tool ' +
        'to get the latest version mid-conversation.',
      inputSchema: z.object({}),
      execute: async () => memoryManager.getContent() || '(MEMORY.md is empty)',
    }),

    memory_append: tool({
      description:
        'Append a fragment to MEMORY.md. Use this to add new preferences, facts, or ' +
        'instructions that should persist across conversations. Multiple fragments are ' +
        'separated by blank lines. Prefer this over overwriting — use memory_delete to remove.',
      inputSchema: z.object({
        content: z.string().describe('The fragment to append to MEMORY.md'),
      }),
      execute: async (input: { content: string }) => {
        memoryManager.append(input.content);
        return 'Fragment appended to MEMORY.md.';
      },
    }),

    memory_delete: tool({
      description:
        'Delete a fragment from MEMORY.md by exact text match. Use this to remove outdated ' +
        'or incorrect information. The fragment must match exactly (including whitespace).',
      inputSchema: z.object({
        fragment: z.string().describe('The exact fragment to delete from MEMORY.md'),
      }),
      execute: async (input: { fragment: string }) => {
        const deleted = memoryManager.delete(input.fragment);
        return deleted ? 'Fragment deleted from MEMORY.md.' : 'Fragment not found in MEMORY.md.';
      },
    }),
  };
}
