import { NextResponse } from 'next/server';
import { configManager } from '@/lib/config';

// No auth — always accessible so fail-safe banner can load even without credentials
export const dynamic = 'force-dynamic';

export async function GET() {
  const cfg = configManager.get();
  const memoryEnabled = (cfg.memory?.enabled ?? process.env.ENABLE_MEMORY === 'true');
  const dashboardPasswordConfigured = !!(
    configManager.getSecrets().dashboard?.password ??
    process.env.DASHBOARD_PASSWORD
  );

  return NextResponse.json({
    state: configManager.state,
    error: configManager.error,
    memoryEnabled,
    dashboardPasswordConfigured,
  });
}
