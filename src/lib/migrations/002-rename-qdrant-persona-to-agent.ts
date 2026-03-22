import type { WorkspaceMigration } from './runner';

const migration: WorkspaceMigration = {
  id: 'rename-qdrant-persona-to-agent',
  description: 'Rename "persona" payload field to "agent" in Qdrant memory collection',
  async run() {
    try {
      const { qdrantClient, COLLECTION_NAME } = await import('../memory/client');

      const exists = await qdrantClient.collectionExists(COLLECTION_NAME);
      if (!exists.exists) {
        console.log('[Migration] Qdrant collection does not exist — skipping');
        return;
      }

      let offset: string | number | undefined = undefined;
      let totalUpdated = 0;

      // Scroll through all points that have a "persona" payload field
      while (true) {
        const result = await qdrantClient.scroll(COLLECTION_NAME, {
          filter: {
            must: [{ key: 'persona', match: { except: [] as string[] } }],
          },
          limit: 100,
          offset,
          with_payload: true,
          with_vector: false,
        });

        if (result.points.length === 0) break;

        const pointIds = result.points.map((p) => p.id);
        const updates = result.points.map((p) => ({
          id: p.id,
          payload: {
            ...(p.payload as Record<string, unknown>),
            agent: (p.payload as Record<string, unknown>).persona,
            persona: undefined,
          },
        }));

        // Set the new "agent" field
        for (const update of updates) {
          await qdrantClient.setPayload(COLLECTION_NAME, {
            points: [update.id],
            payload: { agent: update.payload.agent },
          });
        }

        // Delete the old "persona" field
        await qdrantClient.deletePayload(COLLECTION_NAME, {
          points: pointIds,
          keys: ['persona'],
        });

        totalUpdated += pointIds.length;
        offset = typeof result.next_page_offset === 'string' || typeof result.next_page_offset === 'number'
          ? result.next_page_offset
          : undefined;
        if (!offset) break;
      }

      if (totalUpdated > 0) {
        console.log(`[Migration] Renamed "persona" → "agent" in ${totalUpdated} Qdrant points`);
      } else {
        console.log('[Migration] No Qdrant points with "persona" field found');
      }
    } catch (err) {
      // Non-fatal: Qdrant may not be running
      console.warn('[Migration] Qdrant migration skipped (not reachable):', (err as Error).message);
    }
  },
};

export default migration;
