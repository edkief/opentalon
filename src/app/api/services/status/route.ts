import { NextResponse } from 'next/server';
import { getRunningJobs } from '@/lib/db/jobs';
import { getSpecialistHistory } from '@/lib/agent/log-bus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const [running_jobs, history] = await Promise.all([
    getRunningJobs(),
    Promise.resolve(getSpecialistHistory()),
  ]);

  const running_specialists = history.filter((e) => e.kind === 'spawn').reduce(
    (count, spawn) => {
      const completed = history.some(
        (e) => e.specialistId === spawn.specialistId && (e.kind === 'complete' || e.kind === 'error')
      );
      return completed ? count : count + 1;
    },
    0
  );

  return NextResponse.json({
    running_jobs: running_jobs.map((j) => ({
      id: j.id,
      chatId: j.chatId,
      status: j.status,
      taskDescription: j.taskDescription,
      createdAt: j.createdAt,
    })),
    running_specialists,
  });
}
