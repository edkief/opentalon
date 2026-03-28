import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { sql, count, sum } from 'drizzle-orm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const period = Math.min(365, Math.max(1, parseInt(searchParams.get('period') ?? '30', 10)));

    const periodInterval = `${period} days`;

    // ── Summary ──────────────────────────────────────────────────────────────

    const [summaryRow] = await db
      .select({
        totalMessages: count(),
        totalInputTokens: sql<number>`coalesce(${sum(schema.conversations.inputTokens)}, 0)`,
        totalOutputTokens: sql<number>`coalesce(${sum(schema.conversations.outputTokens)}, 0)`,
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
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.createdAt} > now() - interval '${sql.raw(periodInterval)}'`)
      .groupBy(sql`date_trunc('day', ${schema.conversations.createdAt})`)
      .orderBy(sql`date_trunc('day', ${schema.conversations.createdAt})`);

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

    // ── By model ───────────────────────────────────────────────────────────────
    const byModel = await db
      .select({
        model: sql<string>`coalesce(${schema.conversations.model}, 'unknown')`,
        count: count(),
      })
      .from(schema.conversations)
      .where(sql`${schema.conversations.role} = 'assistant'`)
      .groupBy(sql`coalesce(${schema.conversations.model}, 'unknown')`)
      .orderBy(sql`count(*) desc`);

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

    return NextResponse.json({
      period,
      summary: {
        totalMessages: Number(summaryRow?.totalMessages ?? 0),
        totalInputTokens: Number(summaryRow?.totalInputTokens ?? 0),
        totalOutputTokens: Number(summaryRow?.totalOutputTokens ?? 0),
        uniqueChats: Number(summaryRow?.uniqueChats ?? 0),
        jobsRun,
        jobSuccessRate,
      },
      byDay: byDay.map((r) => ({
        day: r.day,
        messages: Number(r.messages),
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
      })),
      byAgent: byAgent.map((r) => ({ agentId: r.agentId, count: Number(r.count) })),
      byModel: byModel.map((r) => ({ model: r.model, count: Number(r.count) })),
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
