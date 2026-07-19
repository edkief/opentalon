import { db } from './index';
import { conversations } from './schema';
import { and, eq, gte, lte, lt, gt, desc, asc, sql, isNotNull, inArray } from 'drizzle-orm';

/**
 * #27: keyword/substring leg of history_search, plus verbatim hydration from
 * Postgres. Postgres is the source of truth for conversation content; the vector
 * store (see memory/history.ts) is only a semantic index pointing back here.
 */

/**
 * Ensure the trigram substring index on conversations.content exists. Idempotent
 * — safe to run on every startup. pg_trgm + GIN gives near-free ILIKE '%…%'
 * matching for the exact/substring queries agents are good at (error strings,
 * IDs, names).
 */
export async function ensureHistorySearchIndex(): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS conversations_content_trgm_idx ON conversations USING gin (content gin_trgm_ops)`,
  );
}

export interface ContentSearchOptions {
  query: string;
  chatId?: string; // restrict to one chat (chat_scope: 'current')
  from?: Date;
  to?: Date;
  limit: number;
}

export interface ContentHit {
  turnId: string;
  chatId: string;
  createdAt: Date;
}

/**
 * Substring/keyword leg: distinct turns whose content matches the query,
 * newest first. Only active (non-archived) rows with a turnId are considered.
 */
export async function searchConversationContent(opts: ContentSearchOptions): Promise<ContentHit[]> {
  const { query, chatId, from, to, limit } = opts;
  const q = query.trim();
  if (!q) return [];

  const conditions = [
    eq(conversations.active, true),
    isNotNull(conversations.turnId),
    sql`${conversations.content} ILIKE ${'%' + q + '%'}`,
  ];
  if (chatId) conditions.push(eq(conversations.chatId, chatId));
  if (from) conditions.push(gte(conversations.createdAt, from));
  if (to) conditions.push(lte(conversations.createdAt, to));

  const rows = await db
    .selectDistinctOn([conversations.turnId], {
      turnId: conversations.turnId,
      chatId: conversations.chatId,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(and(...conditions))
    .orderBy(conversations.turnId, desc(conversations.createdAt))
    .limit(limit * 4);

  return rows
    .filter((r): r is { turnId: string; chatId: string; createdAt: Date } => r.turnId != null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit * 4);
}

// ── Hydration ────────────────────────────────────────────────────────────────

export interface HydratedTurn {
  turnId: string;
  chatId: string;
  createdAt: Date;
  isMatch: boolean; // false for ±1 neighbor-context turns
  messages: { role: string; content: string; agentId: string | null; createdAt: Date }[];
}

/** Fetch the active rows for a single turn, ordered chronologically. */
async function fetchTurnRows(turnId: string) {
  return db
    .select({
      role: conversations.role,
      content: conversations.content,
      agentId: conversations.agentId,
      chatId: conversations.chatId,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(and(eq(conversations.turnId, turnId), eq(conversations.active, true)))
    .orderBy(asc(conversations.createdAt));
}

/** The turnId of the neighbor turn immediately before/after a boundary time in a chat. */
async function neighborTurnId(
  chatId: string,
  boundary: Date,
  direction: 'before' | 'after',
): Promise<string | null> {
  const rows = await db
    .select({ turnId: conversations.turnId, createdAt: conversations.createdAt })
    .from(conversations)
    .where(
      and(
        eq(conversations.chatId, chatId),
        eq(conversations.active, true),
        isNotNull(conversations.turnId),
        direction === 'before'
          ? lt(conversations.createdAt, boundary)
          : gt(conversations.createdAt, boundary),
      ),
    )
    .orderBy(direction === 'before' ? desc(conversations.createdAt) : asc(conversations.createdAt))
    .limit(1);
  return rows[0]?.turnId ?? null;
}

/**
 * Hydrate matched turns into verbatim history, each with ±1 neighboring turn for
 * context. Respects active = true. Neighbor turns are marked isMatch=false.
 * Returns turns in chronological order per match, de-duplicated by turnId.
 */
export async function hydrateTurns(turnIds: string[], neighborTurns = 1): Promise<HydratedTurn[]> {
  const out: HydratedTurn[] = [];
  const seen = new Set<string>();

  for (const turnId of turnIds) {
    const rows = await fetchTurnRows(turnId);
    if (rows.length === 0) continue;
    const chatId = rows[0].chatId;
    const first = rows[0].createdAt;
    const last = rows[rows.length - 1].createdAt;

    const ids: { id: string; isMatch: boolean }[] = [];
    if (neighborTurns > 0) {
      const prev = await neighborTurnId(chatId, first, 'before');
      if (prev) ids.push({ id: prev, isMatch: false });
    }
    ids.push({ id: turnId, isMatch: true });
    if (neighborTurns > 0) {
      const next = await neighborTurnId(chatId, last, 'after');
      if (next) ids.push({ id: next, isMatch: false });
    }

    for (const { id, isMatch } of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const turnRows = id === turnId ? rows : await fetchTurnRows(id);
      if (turnRows.length === 0) continue;
      out.push({
        turnId: id,
        chatId: turnRows[0].chatId,
        createdAt: turnRows[0].createdAt,
        isMatch,
        messages: turnRows.map((r) => ({ role: r.role, content: r.content, agentId: r.agentId, createdAt: r.createdAt })),
      });
    }
  }

  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * Fetch a single turn's concatenated text + metadata for gist indexing, or null
 * if the turn has no active rows (e.g. archived by /reset before the job ran).
 */
export async function getTurnForIndex(
  turnId: string,
): Promise<{ chatId: string; agentId: string | null; createdAt: Date; content: string } | null> {
  const rows = await fetchTurnRows(turnId);
  if (rows.length === 0) return null;
  const content = rows
    .map((r) => {
      const label = r.role === 'assistant' ? 'Assistant' : r.role === 'system' ? 'System' : 'User';
      return `${label}: ${r.content}`;
    })
    .join('\n');
  return { chatId: rows[0].chatId, agentId: rows[0].agentId, createdAt: rows[0].createdAt, content };
}

// ── Backfill helpers ─────────────────────────────────────────────────────────

export interface BackfillTurn {
  turnId: string;
  chatId: string;
  agentId: string | null;
  createdAt: Date;
  content: string;
}

/** Count of distinct indexable turns (active, has turnId) — for the cost estimate. */
export async function countIndexableTurns(): Promise<number> {
  const rows = await db.execute<{ count: string }>(
    sql`SELECT COUNT(DISTINCT turn_id)::text AS count FROM conversations WHERE active = true AND turn_id IS NOT NULL`,
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * A page of distinct turns for backfill, ordered oldest-first by the turn's first
 * row. Each turn's text is the concatenation of its rows. The cursor is the
 * `firstAt` of the last turn returned (exclusive) so the scan is resumable across
 * restarts. Selects the turn list first (bounded), then only those turns' rows.
 */
export async function getTurnsForBackfill(
  afterCreatedAt: Date | null,
  batchSize: number,
): Promise<{ turns: BackfillTurn[]; nextCursor: Date | null }> {
  const turnList = await db.execute<{ turn_id: string; first_at: Date }>(sql`
    SELECT turn_id, MIN(created_at) AS first_at
    FROM conversations
    WHERE active = true AND turn_id IS NOT NULL
    ${afterCreatedAt ? sql`AND created_at > ${afterCreatedAt}` : sql``}
    GROUP BY turn_id
    ORDER BY first_at ASC
    LIMIT ${batchSize}
  `);

  if (turnList.length === 0) return { turns: [], nextCursor: null };

  const ids = turnList.map((t) => t.turn_id);
  const firstAtById = new Map(turnList.map((t) => [t.turn_id, new Date(t.first_at)]));

  const rows = await db
    .select({
      turnId: conversations.turnId,
      chatId: conversations.chatId,
      agentId: conversations.agentId,
      role: conversations.role,
      content: conversations.content,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(and(eq(conversations.active, true), inArray(conversations.turnId, ids)))
    .orderBy(asc(conversations.createdAt));

  const byTurn = new Map<string, BackfillTurn>();
  for (const r of rows) {
    if (!r.turnId) continue;
    let t = byTurn.get(r.turnId);
    if (!t) {
      t = {
        turnId: r.turnId,
        chatId: r.chatId,
        agentId: r.agentId,
        createdAt: firstAtById.get(r.turnId) ?? r.createdAt,
        content: '',
      };
      byTurn.set(r.turnId, t);
    }
    const label = r.role === 'assistant' ? 'Assistant' : r.role === 'system' ? 'System' : 'User';
    t.content += `${label}: ${r.content}\n`;
  }

  const turns = ids.map((id) => byTurn.get(id)!).filter(Boolean);
  const nextCursor = firstAtById.get(ids[ids.length - 1]) ?? null;
  return { turns, nextCursor };
}
