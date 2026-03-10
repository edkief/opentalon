import 'dotenv/config';

import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db';

async function main() {
  try {
    // Backfill existing conversation rows that don't have a persona_id yet.
    await db.execute(
      sql`update conversations set persona_id = 'default' where persona_id is null`,
    );
    // eslint-disable-next-line no-console
    console.log('Backfill complete: set persona_id = default where null.');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  } finally {
    // postgres-js will exit when no more work is pending
  }
}

void main();

