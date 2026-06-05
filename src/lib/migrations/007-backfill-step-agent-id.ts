import type { WorkspaceMigration } from './runner';

const migration: WorkspaceMigration = {
  id: 'backfill-step-agent-id',
  description:
    'Backfill conversation_steps.agent_id for legacy main-agent steps that were stored with a NULL agentId under the old default-agent convention',
  async run() {
    const { and, isNull } = await import('drizzle-orm');
    const { db, schema } = await import('../db');
    const { agentRegistry } = await import('../soul');

    // Anchor on whichever agent is the default at migration time: legacy rows
    // with a NULL agentId belonged to the default agent under the old
    // convention (emitStep nulled the default agent's id).
    const defaultAgent = agentRegistry.getDefaultAgent();
    if (!defaultAgent) return;

    // Only main-agent steps. Specialist steps legitimately carry a NULL agentId
    // (they are keyed by specialistId), so they must be left untouched.
    const result = await db
      .update(schema.conversationSteps)
      .set({ agentId: defaultAgent })
      .where(
        and(
          isNull(schema.conversationSteps.agentId),
          isNull(schema.conversationSteps.specialistId),
        ),
      );

    const count = (result as unknown as { count?: number }).count ?? 0;
    console.log(
      `[Migration] Backfilled ${count} legacy main-agent step(s) to "${defaultAgent}"`,
    );
  },
};

export default migration;
