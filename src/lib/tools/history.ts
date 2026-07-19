import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { searchHistoryVectors, getHistoryScopes } from '../memory/history';
import { searchConversationContent, hydrateTurns, type HydratedTurn } from '../db/history-search';
import { agentRegistry } from '../soul';
import type { BuiltInToolsOpts } from './types';

const RRF_K = 60;

/** Fuse two ranked turnId lists into one ordered list via Reciprocal Rank Fusion. */
function rrfMerge(lists: string[][]): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((turnId, rank) => {
      scores.set(turnId, (scores.get(turnId) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

function formatHydrated(turns: HydratedTurn[], chatScope: 'current' | 'all'): string {
  return turns
    .map((t) => {
      const when = t.createdAt.toISOString().replace('T', ' ').slice(0, 16);
      const label = chatScope === 'all' ? ` · chat ${t.chatId}` : '';
      const marker = t.isMatch ? '▶ MATCH' : '  context';
      const body = t.messages
        .map((m) => {
          const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
          return `${role}: ${m.content}`;
        })
        .join('\n');
      return `[${when}${label}] ${marker}\n${body}`;
    })
    .join('\n\n---\n\n');
}

export function getHistoryTools(opts?: BuiltInToolsOpts): ToolSet {
  const scope = opts?.memoryScope ?? 'private';
  const chatId = opts?.chatId;
  const agentId = opts?.agentId;
  const agentFilter = agentId && !agentRegistry.isDefaultAgent(agentId) ? agentId : undefined;

  // Without a chatId there is no conversation context to search meaningfully.
  if (!chatId) return {};

  return {
    history_search: tool({
      description:
        'Search PAST CONVERSATION HISTORY (verbatim exchanges, across sessions) for what was discussed. ' +
        'Use this to answer "when did we last talk about X", "what did we decide about Y three weeks ago", ' +
        'or to recover an error string / decision / value from an earlier conversation. ' +
        'This is distinct from memory_recall: memory_recall returns curated notes you deliberately saved, ' +
        'while history_search searches the raw conversation log and returns DATED, VERBATIM excerpts ' +
        '(with ±1 neighboring turn for context). It combines semantic (gist) and keyword/substring matching.',
      inputSchema: z.object({
        query: z.string().describe('What to look for — a topic, decision, name, or exact string'),
        chat_scope: z
          .enum(['current', 'all'])
          .optional()
          .describe("'current' = only this conversation; 'all' = every conversation in the same scope (default 'all')"),
        from: z.string().optional().describe('ISO date/time lower bound (inclusive), e.g. 2026-06-01'),
        to: z.string().optional().describe('ISO date/time upper bound (inclusive)'),
        limit: z.number().int().min(1).max(20).optional().describe('Max matching turns to return (default 5)'),
      }),
      execute: async (input: {
        query: string;
        chat_scope?: 'current' | 'all';
        from?: string;
        to?: string;
        limit?: number;
      }) => {
        const chatScope = input.chat_scope ?? 'all';
        const limit = input.limit ?? 5;
        const from = input.from ? new Date(input.from) : undefined;
        const to = input.to ? new Date(input.to) : undefined;
        if (from && isNaN(from.getTime())) return 'Invalid `from` date.';
        if (to && isNaN(to.getTime())) return 'Invalid `to` date.';

        const restrictChatId = chatScope === 'current' ? chatId : undefined;

        try {
          const [vectorHits, ftsHits] = await Promise.all([
            searchHistoryVectors({ query: input.query, scope, chatId: restrictChatId, agent: agentFilter, limit }),
            searchConversationContent({ query: input.query, chatId: restrictChatId, from, to, limit }),
          ]);

          const vectorTurnIds = vectorHits.map((h) => h.turnId);
          let ftsTurnIds = ftsHits.map((h) => h.turnId);

          // Scope enforcement for cross-chat keyword hits: Postgres does not store
          // scope, so drop FTS turns whose indexed scope differs from the current
          // one. (For chat_scope='current' every hit is in-scope by construction.)
          if (chatScope === 'all' && ftsTurnIds.length > 0) {
            const scopeMap = await getHistoryScopes(ftsTurnIds);
            ftsTurnIds = ftsTurnIds.filter((id) => scopeMap.get(id) === scope);
          }

          const merged = rrfMerge([vectorTurnIds, ftsTurnIds]).slice(0, limit);
          if (merged.length === 0) return 'No matching conversation history found.';

          let hydrated = await hydrateTurns(merged, 1);

          // Apply the date window to MATCH turns (neighbors kept for context).
          if (from || to) {
            hydrated = hydrated.filter((t) => {
              if (!t.isMatch) return true;
              if (from && t.createdAt < from) return false;
              if (to && t.createdAt > to) return false;
              return true;
            });
          }

          if (hydrated.every((t) => !t.isMatch)) return 'No matching conversation history found.';
          return formatHydrated(hydrated, chatScope);
        } catch (err) {
          console.error('[history_search] failed:', err);
          return 'History search failed.';
        }
      },
    }),
  };
}
