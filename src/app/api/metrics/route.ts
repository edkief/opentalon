import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { sql, count, sum } from 'drizzle-orm';
import { configManager } from '@/lib/config';
import { estimateCost, type PricingMap, type TokenBuckets } from '@/lib/metrics/cost';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const period = Math.min(365, Math.max(1, parseInt(searchParams.get('period') ?? '30', 10)));

    const periodInterval = `${period} days`;

    const pricing: PricingMap = configManager.get().llm?.pricing ?? {};
    const hasPricing = Object.keys(pricing).length > 0;

    // ── Summary ──────────────────────────────────────────────────────────────

    const [summaryRow] = await db
      .select({
        totalMessages: count(),
        totalInputTokens: sql<number>`coalesce(${sum(schema.conversations.inputTokens)}, 0)`,
        totalOutputTokens: sql<number>`coalesce(${sum(schema.conversations.outputTokens)}, 0)`,
        totalCacheReadTokens: sql<number>`coalesce(${sum(schema.conversations.cacheReadTokens)}, 0)`,
        totalCacheWriteTokens: sql<number>`coalesce(${sum(schema.conversations.cacheWriteTokens)}, 0)`,
        totalReasoningTokens: sql<number>`coalesce(${sum(schema.conversations.reasoningTokens)}, 0)`,
        uniqueChats: sql<number>`count(distinct ${schema.conversations.chatId})`,
      })
      .from(schema.conversations);

    const [jobSummaryRow] = await db
      .select({
        jobsRun: count(),
        jobsCompleted: sql<number>`count(*) filter (where ${schema.jobs.status} = 'completed')`,
        jobsFailed: sql<number>`count(*) filter (where ${schema.jobs.status} in ('failed', 'timed_out'))`,
      })
      .from(schema.jobs);

    const jobsRun = Number(jobSummaryRow?.jobsRun ?? 0);
    const jobsCompleted = Number(jobSummaryRow?.jobsCompleted ?? 0);
    const jobsFailed = Number(jobSummaryRow?.jobsFailed ?? 0);
    const jobSuccessRate =
      jobsCompleted + jobsFailed > 0
        ? Math.round((jobsCompleted / (jobsCompleted + jobsFailed)) * 100)
        : null;

    // ── By day (within period, for trend charts) ─────────────────────────────

    const byDay = await db
      .select({
        day: sql<string>`date_trunc('day', ${schema.conversations.createdAt})::date::text`,
        messages: count(),
        inputTokens: sql<number>`coalesce(sum(${schema.conversations.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${schema.conversations.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`coalesce(sum(${schema.conversations.cacheReadTokens}), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${schema.conversations.cacheWriteTokens}), 0)`,
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.createdAt} > now() - interval '${sql.raw(periodInterval)}'`)
      .groupBy(sql`date_trunc('day', ${schema.conversations.createdAt})`)
      .orderBy(sql`date_trunc('day', ${schema.conversations.createdAt})`);

    // ── Per (day, model): needed for cost, since rates differ per model ────────
    const byDayModel = await db
      .select({
        day: sql<string>`date_trunc('day', ${schema.conversations.createdAt})::date::text`,
        model: sql<string>`coalesce(${schema.conversations.model}, 'unknown')`,
        inputTokens: sql<number>`coalesce(sum(${schema.conversations.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${schema.conversations.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`coalesce(sum(${schema.conversations.cacheReadTokens}), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${schema.conversations.cacheWriteTokens}), 0)`,
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.createdAt} > now() - interval '${sql.raw(periodInterval)}'`)
      .groupBy(sql`date_trunc('day', ${schema.conversations.createdAt})`, sql`coalesce(${schema.conversations.model}, 'unknown')`);

    // Cost per day (sum over that day's models, each priced by its own rate).
    const bucketsOf = (r: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): TokenBuckets => ({
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
      cacheWriteTokens: Number(r.cacheWriteTokens),
    });
    const dayCost = new Map<string, number>();
    for (const r of byDayModel) {
      const c = estimateCost(r.model, bucketsOf(r), pricing);
      if (c !== undefined) dayCost.set(r.day, (dayCost.get(r.day) ?? 0) + c);
    }

    // ── By agent ──────────────────────────────────────────────────────────────
    const byAgent = await db
      .select({
        agentId: sql<string>`coalesce(${schema.conversations.agentId}, 'default')`,
        count: count(),
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.role} = 'assistant'`)
      .groupBy(sql`coalesce(${schema.conversations.agentId}, 'default')`)
      .orderBy(sql`count(*) desc`);

    // ── By model (all-time; token sums drive cost) ─────────────────────────────
    const byModel = await db
      .select({
        model: sql<string>`coalesce(${schema.conversations.model}, 'unknown')`,
        count: count(),
        inputTokens: sql<number>`coalesce(sum(${schema.conversations.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${schema.conversations.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`coalesce(sum(${schema.conversations.cacheReadTokens}), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${schema.conversations.cacheWriteTokens}), 0)`,
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.role} = 'assistant'`)
      .groupBy(sql`coalesce(${schema.conversations.model}, 'unknown')`)
      .orderBy(sql`count(*) desc`);

    // All-time cost per model + grand total (only models with a rate card).
    let totalCostUsd = 0;
    const byModelWithCost = byModel.map((r) => {
      const costUsd = estimateCost(r.model, bucketsOf(r), pricing);
      if (costUsd !== undefined) totalCostUsd += costUsd;
      return { model: r.model, count: Number(r.count), costUsd: costUsd ?? null };
    });

    // ── By day of week ─────────────────────────────────────────────────────────
    const byDayOfWeek = await db
      .select({
        dayOfWeek: sql<number>`extract(dow from ${schema.conversations.createdAt})`,
        count: count(),
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.createdAt} > now() - interval '${sql.raw(periodInterval)}'`)
      .groupBy(sql`extract(dow from ${schema.conversations.createdAt})`)
      .orderBy(sql`extract(dow from ${schema.conversations.createdAt})`);

    // ── By hour (within period) ───────────────────────────────────────────────

    const byHour = await db
      .select({
        hour: sql<number>`extract(hour from ${schema.conversations.createdAt})`,
        count: count(),
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.createdAt} > now() - interval '${sql.raw(periodInterval)}'`)
      .groupBy(sql`extract(hour from ${schema.conversations.createdAt})`)
      .orderBy(sql`extract(hour from ${schema.conversations.createdAt})`);

    // ── By chat ID (top 8, within period) ────────────────────────────────────

    const byChatId = await db
      .select({
        chatId: schema.conversations.chatId,
        count: count(),
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.createdAt} > now() - interval '${sql.raw(periodInterval)}'`)
      .groupBy(schema.conversations.chatId)
      .orderBy(sql`count(*) desc`)
      .limit(8);

    // ── Job stats (all time) ──────────────────────────────────────────────────

    const jobStats = await db
      .select({
        status: schema.jobs.status,
        count: count(),
      })
      .from(schema.jobs)
      .groupBy(schema.jobs.status);

    // ── Heatmap (last 365 days, always) ──────────────────────────────────────

    const heatmap = await db
      .select({
        date: sql<string>`date_trunc('day', ${schema.conversations.createdAt})::date::text`,
        count: count(),
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.createdAt} > now() - interval '365 days'`)
      .groupBy(sql`date_trunc('day', ${schema.conversations.createdAt})`)
      .orderBy(sql`date_trunc('day', ${schema.conversations.createdAt})`);

    // ── Cost tiles: yesterday / today / projected-today ───────────────────────
    // Days are UTC-bucketed to match every other chart here (created_at is stored
    // UTC). Independent of `period` so the tiles always have 2 days to work with.
    const tileRows = await db
      .select({
        day: sql<string>`date_trunc('day', ${schema.conversations.createdAt})::date::text`,
        model: sql<string>`coalesce(${schema.conversations.model}, 'unknown')`,
        inputTokens: sql<number>`coalesce(sum(${schema.conversations.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${schema.conversations.outputTokens}), 0)`,
        cacheReadTokens: sql<number>`coalesce(sum(${schema.conversations.cacheReadTokens}), 0)`,
        cacheWriteTokens: sql<number>`coalesce(sum(${schema.conversations.cacheWriteTokens}), 0)`,
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.createdAt} >= date_trunc('day', now() at time zone 'UTC') - interval '1 day'`)
      .groupBy(sql`date_trunc('day', ${schema.conversations.createdAt})`, sql`coalesce(${schema.conversations.model}, 'unknown')`);

    const nowDate = new Date();
    const todayKey = nowDate.toISOString().slice(0, 10);
    const yesterdayKey = new Date(nowDate.getTime() - 86_400_000).toISOString().slice(0, 10);
    const msIntoDay = nowDate.getTime() - Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
    // Floor at 1h so early-morning extrapolation doesn't explode.
    const dayFraction = Math.min(1, Math.max(msIntoDay / 86_400_000, 1 / 24));

    const tileCost = new Map<string, number>();
    for (const r of tileRows) {
      const c = estimateCost(r.model, bucketsOf(r), pricing);
      if (c !== undefined) tileCost.set(r.day, (tileCost.get(r.day) ?? 0) + c);
    }
    const costToday = hasPricing ? (tileCost.get(todayKey) ?? 0) : null;
    const costYesterday = hasPricing ? (tileCost.get(yesterdayKey) ?? 0) : null;
    const costProjectedToday = costToday !== null ? costToday / dayFraction : null;

    return NextResponse.json({
      period,
      hasPricing,
      cost: {
        totalUsd: hasPricing ? totalCostUsd : null,
        yesterdayUsd: costYesterday,
        todayUsd: costToday,
        projectedTodayUsd: costProjectedToday,
      },
      summary: {
        totalMessages: Number(summaryRow?.totalMessages ?? 0),
        totalInputTokens: Number(summaryRow?.totalInputTokens ?? 0),
        totalOutputTokens: Number(summaryRow?.totalOutputTokens ?? 0),
        totalCacheReadTokens: Number(summaryRow?.totalCacheReadTokens ?? 0),
        totalCacheWriteTokens: Number(summaryRow?.totalCacheWriteTokens ?? 0),
        totalReasoningTokens: Number(summaryRow?.totalReasoningTokens ?? 0),
        uniqueChats: Number(summaryRow?.uniqueChats ?? 0),
        jobsRun,
        jobSuccessRate,
      },
      byDay: byDay.map((r) => {
        const cacheReadTokens = Number(r.cacheReadTokens);
        const cacheWriteTokens = Number(r.cacheWriteTokens);
        return {
          day: r.day,
          messages: Number(r.messages),
          inputTokens: Number(r.inputTokens),
          outputTokens: Number(r.outputTokens),
          cacheReadTokens,
          cacheWriteTokens,
          // Non-cached input = total − cache read − cache write (clamped ≥0).
          nonCachedInputTokens: Math.max(0, Number(r.inputTokens) - cacheReadTokens - cacheWriteTokens),
          costUsd: dayCost.has(r.day) ? dayCost.get(r.day)! : null,
        };
      }),
      byAgent: byAgent.map((r) => ({ agentId: r.agentId, count: Number(r.count) })),
      byModel: byModelWithCost,
      byDayOfWeek: byDayOfWeek.map((r) => ({ dayOfWeek: Number(r.dayOfWeek), count: Number(r.count) })),
      byHour: byHour.map((r) => ({ hour: Number(r.hour), count: Number(r.count) })),
      byChatId: byChatId.map((r) => ({ chatId: r.chatId, count: Number(r.count) })),
      jobStats: jobStats.map((r) => ({ status: r.status, count: Number(r.count) })),
      heatmap: heatmap.map((r) => ({ date: r.date, count: Number(r.count) })),
    });
  } catch (error) {
    console.error('[Metrics] Error:', error);
    return NextResponse.json({ error: 'Failed to load metrics' }, { status: 500 });
  }
}
