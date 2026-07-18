import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { retrieveContext } from '../memory/retrieve';
import { ingestMemory } from '../memory/ingest';
import { memoryManager, CORE_MEMORY_SOFT_LIMIT_TOKENS } from '../agent/memory-manager';
import { configManager } from '../config';
import type { BuiltInToolsOpts } from './types';

export function getMemoryTools(opts?: BuiltInToolsOpts): ToolSet {
  const memoryScope = opts?.memoryScope ?? 'private';
  const memoryChatId = opts?.chatId;
  const agentId = opts?.agentId;

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
        'Persist a fact across conversations. Two destinations:\n' +
        "- store:'core' (default) → MEMORY.md, injected into the system prompt on EVERY request. " +
        'Reserve for DURABLE identity, standing rules, and stable environment facts. Keep it lean.\n' +
        "- store:'recall' → the RAG vector store, retrieved only when relevant. Use for EPISODIC/dated " +
        'content: findings, per-client incident logs, analysis summaries, one-off gotchas. This keeps ' +
        'always-on context small while the information stays reachable via search/rag_search.\n' +
        'Multiple core fragments are separated by blank lines. Use memory_delete to remove core entries.',
      inputSchema: z.object({
        content: z.string().describe('The fact to persist'),
        store: z
          .enum(['core', 'recall'])
          .optional()
          .describe("Where to store it: 'core' (MEMORY.md, always-on — durable facts only) or 'recall' (RAG, retrieved on demand — episodic/dated content). Default 'core'."),
      }),
      execute: async (input: { content: string; store?: 'core' | 'recall' }) => {
        const store = input.store ?? 'core';
        if (store === 'recall') {
          if (!memoryChatId) {
            // No conversation to scope the vector entry to — fall back to core
            // rather than silently dropping the fact.
            memoryManager.append(input.content);
            return "No conversation context available for 'recall' storage — appended to Core Memory (MEMORY.md) instead.";
          }
          await ingestMemory({
            chatId: memoryChatId,
            scope: memoryScope,
            author: 'note',
            text: input.content,
            ...(agentId ? { agent: agentId } : {}),
          });
          return 'Fact stored in retrievable memory (RAG). It will surface via search when relevant, and is not carried in every request.';
        }

        memoryManager.append(input.content);
        const softLimit =
          configManager.get().memory?.coreSoftLimitTokens ?? CORE_MEMORY_SOFT_LIMIT_TOKENS;
        const stats = memoryManager.getStats(softLimit);
        if (stats.overBudget) {
          return (
            'Fragment appended to MEMORY.md. ' +
            `⚠️ Core Memory is now ~${stats.approxTokens} tokens, over the soft budget of ${softLimit} — ` +
            "it is injected into every request. Move episodic/dated entries to RAG with store:'recall' " +
            'and keep Core Memory for durable identity and standing rules.'
          );
        }
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
