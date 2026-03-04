import { NextResponse } from 'next/server';
import { getRunningJobs, cancelRunningJobs } from '@/lib/db/jobs';
import { getSpecialistHistory } from '@/lib/agent/log-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function countRunningSpecialists(): number {
  const history = getSpecialistHistory();
  return history.filter((e) => e.kind === 'spawn').reduce((count, spawn) => {
    const completed = history.some(
      (e) => e.specialistId === spawn.specialistId && (e.kind === 'complete' || e.kind === 'error')
    );
    return completed ? count : count + 1;
  }, 0);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { force?: boolean };
  const force = body.force === true;

  if (!force) {
    const [running_jobs, running_specialists] = await Promise.all([
      getRunningJobs(),
      Promise.resolve(countRunningSpecialists()),
    ]);

    if (running_jobs.length > 0 || running_specialists > 0) {
      return NextResponse.json(
        {
          blocked: true,
          running_jobs: running_jobs.map((j) => ({
            id: j.id,
            chatId: j.chatId,
            status: j.status,
            taskDescription: j.taskDescription,
            createdAt: j.createdAt,
          })),
          running_specialists,
        },
        { status: 409 }
      );
    }
  }

  // Cancel running jobs in DB
  await cancelRunningJobs();

  // Restart the bot
  try {
    const { restartBot } = await import('@/lib/bot-manager');
    // Fire-and-forget — restart happens async, response returns immediately
    restartBot().catch((err: unknown) => {
      console.error('[services/restart] restartBot error:', err);
    });
  } catch (err) {
    console.error('[services/restart] Failed to import restartBot:', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
