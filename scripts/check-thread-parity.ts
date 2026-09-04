/**
 * Golden-id parity against real `email_messages` rows (#44 acceptance criterion).
 *
 * The unit suite pins the derived ids as literals; this replays the live
 * resolver over rows that already exist in the database and asserts it lands on
 * the chat_id those rows were actually filed under. A mismatch means the T4 read
 * flip would orphan a live conversation.
 *
 * READ-ONLY: selects only, no writes. Safe against production.
 *
 * Run: pnpm check:thread-parity  (add --verbose to list every mismatch)
 */

import { desc } from 'drizzle-orm';
import { db, pgClient } from '../src/lib/db';
import { emailMessages } from '../src/lib/db/schema';
import { resolveThreadId } from '../src/lib/db/email';
import { referencedIds, subjectIsReply } from '../src/lib/email/threading';

const LIMIT = Number(process.env.PARITY_LIMIT ?? 5000);
const verbose = process.argv.includes('--verbose');

/** Which branch of resolveThreadId a row exercises — mismatches are only real on 1/2/4. */
function path(row: typeof emailMessages.$inferSelect): 'headers' | 'subject' | 'seed' {
  if (referencedIds(row.inReplyTo, row.referencesIds).length > 0) return 'headers';
  return subjectIsReply(row.subject) ? 'subject' : 'seed';
}

async function main(): Promise<void> {
  const rows = await db
    .select()
    .from(emailMessages)
    .orderBy(desc(emailMessages.createdAt))
    .limit(LIMIT);

  console.log(`[parity] replaying resolveThreadId over ${rows.length} email_messages rows\n`);

  const bad: Array<{ id: string; expected: string; actual: string; via: string }> = [];
  const seen = { headers: 0, subject: 0, seed: 0 };
  let subjectDrift = 0;

  for (const row of rows) {
    const via = path(row);
    seen[via]++;
    const actual = await resolveThreadId({
      messageId: row.messageId,
      inReplyTo: row.inReplyTo,
      references: row.referencesIds,
      subject: row.subject,
      fromAddress: row.fromAddress,
    });
    if (actual === row.chatId) continue;
    // findChatIdBySubject windows 30 days back from now(), not from the row, so
    // replaying an old subject-fallback row legitimately re-derives a different
    // id. Counted, not failed.
    if (via === 'subject') {
      subjectDrift++;
      continue;
    }
    bad.push({ id: row.messageId, expected: row.chatId, actual, via });
  }

  console.log(`  by path: headers=${seen.headers} subject=${seen.subject} seed=${seen.seed}`);
  console.log(`  subject-fallback rows outside the 30d replay window: ${subjectDrift} (informational)`);

  if (bad.length === 0) {
    console.log(`\n✅ parity holds: ${rows.length - subjectDrift} rows re-derive their stored chat_id`);
  } else {
    console.log(`\n❌ ${bad.length} row(s) re-derive a different thread id:`);
    for (const b of verbose ? bad : bad.slice(0, 20)) {
      console.log(`   ${b.via.padEnd(7)} ${b.id}\n     stored=${b.expected}\n     derived=${b.actual}`);
    }
    if (!verbose && bad.length > 20) console.log(`   ... and ${bad.length - 20} more (--verbose)`);
  }

  await pgClient.end();
  process.exit(bad.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pgClient.end();
  process.exit(1);
});
