import { NextRequest, NextResponse } from 'next/server';
import { CronExpressionParser } from 'cron-parser';
import { agentRegistry } from '@/lib/soul';
import type { HeartbeatConfig } from '@/lib/soul/soul-manager';
import { schedulerService } from '@/lib/scheduler';

const HEARTBEAT_TASK_PREFIX = 'heartbeat-';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  const sm = agentRegistry.getSoulManager(id);
  const config: HeartbeatConfig = {
    enabled: false,
    cron: '0 * * * *',
    chatId: '',
    ...sm.getHeartbeatConfig(),
  };
  const content = sm.getHeartbeatContent();
  return NextResponse.json({ config, content });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!agentRegistry.agentExists(id)) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }
  try {
    const body = await req.json() as { config?: Partial<HeartbeatConfig>; content?: string };
    const config = body.config ?? {};
    const content = typeof body.content === 'string' ? body.content : '';

    // Validate cron if provided and non-empty
    if (config.cron) {
      try {
        CronExpressionParser.parse(config.cron);
      } catch {
        return NextResponse.json({ error: 'Invalid cron expression' }, { status: 400 });
      }
    }

    const sm = agentRegistry.getSoulManager(id);
    sm.writeHeartbeat(content, config);

    // Schedule or unschedule based on enabled state
    const taskId = `${HEARTBEAT_TASK_PREFIX}${id}`;
    if (config.enabled && config.cron && config.chatId) {
      await schedulerService.scheduleTask(taskId, config.chatId, '__heartbeat__', config.cron, id);
    } else {
      await schedulerService.unschedule(taskId);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
