import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { retrieveContext } from '../memory/retrieve';
import { ingestMemory, deleteRecallMemory } from '../memory/ingest';
import { RECALL_CATEGORIES, RECALL_CATEGORY_DESCRIPTIONS, DEFAULT_RECALL_CATEGORY } from '../memory/types';
import { memoryManager, CORE_MEMORY_SOFT_LIMIT_TOKENS } from '../agent/memory-manager';
import { configManager } from '../config';
import type { BuiltInToolsOpts } from './types';

// Rendered once into the memory_append / memory_recall descriptions so the code
// enum (#26) is the single source of truth the model sees.
const CATEGORY_HELP = RECALL_CATEGORIES.map(
  (c) => `'${c}' (${RECALL_CATEGORY_DESCRIPTIONS[c]})`,
).join(', ');

/**
 * One-line write-side nudge (#25), appended to tool results after events that
 * typically produce durable knowledge (specialist completion, resolved secret,
 * error-then-success). Mirrors the Core-Memory soft-budget-warning pattern (#21):
 * a gentle reminder, not a mandate. Models under-use memory tools without it.
 */
export const RECALL_WRITE_NUDGE =
  "\n\n(Reminder: if this produced a durable finding or non-obvious fix worth recalling later, save it with memory_append store:'recall'.)";

export function getMemoryTools(opts?: BuiltInToolsOpts): ToolSet {
  const memoryScope = opts?.memoryScope ?? 'private';
  const memoryChatId = opts?.chatId;
  const agentId = opts?.agentId;

  return {
    memory_recall: tool({
      description:
        "Search the notes you previously saved with memory_append store:'recall' for information " +
        'relevant to a query. Use this when the user references something from a past conversation ' +
        'or asks about something you might have stored. Returns the most relevant memory excerpts. ' +
        'This is semantic search — it finds conceptually similar content, not exact matches. ' +
        'This store holds EPISODIC knowledge only (findings, events, learned facts, gotchas); ' +
        'durable preferences and standing rules live in Core Memory (memory_read). ' +
        `Optionally narrow by category: ${CATEGORY_HELP}.`,
      inputSchema: z.object({
        query: z.string().describe('Natural-language search query'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Max results to return (default 5)'),
        category: z
          .enum(RECALL_CATEGORIES)
          .optional()
          .describe('Optional: restrict results to one category of episodic knowledge'),
      }),
      execute: async (input: { query: string; limit?: number; category?: (typeof RECALL_CATEGORIES)[number] }) => {
        const results = await retrieveContext({
          query: input.query,
          scope: memoryScope,
          limit: input.limit ?? 5,
          ...(input.category ? { category: input.category } : {}),
          // No chatId filter (#25): notes are recalled across chats; the
          // boundary is scope + agent tag.
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
        'Reserve for DURABLE identity, standing rules, and stable preferences/environment facts. Keep it lean.\n' +
        "- store:'recall' → the RAG vector store, retrieved only when relevant. Use for EPISODIC content: " +
        'findings, dated events, learned facts about a system/person, one-off gotchas. This keeps ' +
        'always-on context small while the information stays reachable via search/memory_recall.\n' +
        'Boundary: preferences and standing rules belong in CORE, not recall — recall is episodic only.\n' +
        `When store:'recall', tag it with a category: ${CATEGORY_HELP}. Default '${DEFAULT_RECALL_CATEGORY}'.\n` +
        "A store:'recall' write returns the note's ID; pass it to memory_delete (store:'recall') to supersede/remove a stale note.\n" +
        'Multiple core fragments are separated by blank lines. Use memory_delete to remove core entries.',
      inputSchema: z.object({
        content: z.string().describe('The fact to persist'),
        store: z
          .enum(['core', 'recall'])
          .optional()
          .describe("Where to store it: 'core' (MEMORY.md, always-on — durable facts only) or 'recall' (RAG, retrieved on demand — episodic content). Default 'core'."),
        category: z
          .enum(RECALL_CATEGORIES)
          .optional()
          .describe(`For store:'recall' only — kind of episodic knowledge: ${CATEGORY_HELP}. Default '${DEFAULT_RECALL_CATEGORY}'. Ignored for core.`),
      }),
      execute: async (input: { content: string; store?: 'core' | 'recall'; category?: (typeof RECALL_CATEGORIES)[number] }) => {
        const store = input.store ?? 'core';
        if (store === 'recall') {
          if (!memoryChatId) {
            // No conversation to scope the vector entry to — fall back to core
            // rather than silently dropping the fact.
            memoryManager.append(input.content);
            return "No conversation context available for 'recall' storage — appended to Core Memory (MEMORY.md) instead.";
          }
          const id = await ingestMemory({
            chatId: memoryChatId,
            scope: memoryScope,
            text: input.content,
            category: input.category ?? DEFAULT_RECALL_CATEGORY,
            ...(agentId ? { agent: agentId } : {}),
          });
          if (!id) {
            return 'Failed to store the note in retrievable memory (RAG). Nothing was persisted.';
          }
          return (
            `Fact stored in retrievable memory (RAG) as category '${input.category ?? DEFAULT_RECALL_CATEGORY}'. ` +
            `It surfaces via search when relevant and is not carried in every request. Note ID: ${id} ` +
            "(pass to memory_delete store:'recall' to supersede it later)."
          );
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
        'Remove a stored fact. Two modes:\n' +
        "- store:'core' (default) → delete a fragment from MEMORY.md by EXACT text match " +
        '(including whitespace). Provide `fragment`.\n' +
        "- store:'recall' → delete a note from the RAG vector store by its ID (returned when you " +
        "saved it with memory_append store:'recall', or shown by memory_recall provenance). Provide `id`. " +
        'Use this to supersede a stale or contradicted note.',
      inputSchema: z.object({
        store: z
          .enum(['core', 'recall'])
          .optional()
          .describe("Which store to delete from: 'core' (MEMORY.md, by fragment) or 'recall' (RAG, by id). Default 'core'."),
        fragment: z.string().optional().describe("For store:'core' — the exact fragment to delete from MEMORY.md"),
        id: z.string().optional().describe("For store:'recall' — the note ID to delete from the RAG store"),
      }),
      execute: async (input: { store?: 'core' | 'recall'; fragment?: string; id?: string }) => {
        const store = input.store ?? 'core';
        if (store === 'recall') {
          if (!input.id) return "store:'recall' requires an `id` (the note ID returned when it was saved).";
          const ok = await deleteRecallMemory(input.id);
          return ok
            ? `Recall note ${input.id} deleted from the RAG store.`
            : `Could not delete recall note ${input.id} (not found, reserved, or the store errored).`;
        }
        if (!input.fragment) return "store:'core' requires a `fragment` (exact text to delete from MEMORY.md).";
        const deleted = memoryManager.delete(input.fragment);
        return deleted ? 'Fragment deleted from MEMORY.md.' : 'Fragment not found in MEMORY.md.';
      },
    }),
  };
}
