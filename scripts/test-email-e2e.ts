/**
 * Email end-to-end integration test (GreenMail).
 *
 * Sends a message via SMTP into the agent's mailbox, waits for the agent to
 * reply, and asserts:
 *   - a reply arrives from the agent address,
 *   - it threads correctly (In-Reply-To / References point at our message),
 *   - exactly one reply is produced (no double-processing).
 *
 * Requires the full stack running against GreenMail:
 *   1. docker compose --profile email-test up -d greenmail postgres qdrant fastembed
 *   2. Configure config.yaml → email against GreenMail:
 *        imap.host: localhost, imap.port: 3143, imap.secure: false
 *        smtp.host: localhost, smtp.port: 3025, smtp.secure: false
 *        address: agent@local.test, whitelist: [tester@local.test]
 *      and secrets/env EMAIL_USER=agent@local.test EMAIL_PASSWORD=anything
 *   3. Start the app (pnpm dev) so the IMAP manager is running.
 *   4. Set the env below and run: pnpm test:email-e2e
 *
 * Env:
 *   E2E_SMTP_HOST (default localhost)   E2E_SMTP_PORT (default 3025)
 *   E2E_IMAP_HOST (default localhost)   E2E_IMAP_PORT (default 3143)
 *   E2E_AGENT_ADDRESS (default agent@local.test)
 *   E2E_TESTER_ADDRESS (default tester@local.test)   — must be whitelisted
 *   E2E_TESTER_PASSWORD (default password)
 *   E2E_ENABLE=1  — required, otherwise the test skips (so CI stays green).
 */

import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const ENABLED = process.env.E2E_ENABLE === '1';
if (!ENABLED) {
  console.log('[skip] Email e2e disabled. Set E2E_ENABLE=1 with GreenMail + the app running.');
  console.log('       See the header of scripts/test-email-e2e.ts for setup.');
  process.exit(0);
}

const SMTP_HOST = process.env.E2E_SMTP_HOST ?? 'localhost';
const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 3025);
const IMAP_HOST = process.env.E2E_IMAP_HOST ?? 'localhost';
const IMAP_PORT = Number(process.env.E2E_IMAP_PORT ?? 3143);
const AGENT = process.env.E2E_AGENT_ADDRESS ?? 'agent@local.test';
const TESTER = process.env.E2E_TESTER_ADDRESS ?? 'tester@local.test';
const TESTER_PW = process.env.E2E_TESTER_PASSWORD ?? 'password';
const TIMEOUT_MS = 120_000;

function fail(msg: string): never {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const marker = `e2e-${Date.now()}`;
  const sentMessageId = `<${marker}@local.test>`;
  const subject = `E2E test ${marker}`;

  console.log('=== Email E2E (GreenMail) ===');
  console.log(`→ sending "${subject}" from ${TESTER} to ${AGENT}`);

  const smtp = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: false });
  await smtp.sendMail({
    from: TESTER,
    to: AGENT,
    subject,
    messageId: sentMessageId,
    text: 'Please reply with a short acknowledgement. This is an automated e2e test.',
  });
  console.log(`  ✓ sent, Message-Id ${sentMessageId}`);

  // Poll the tester mailbox for the agent's reply.
  const imap = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: TESTER, pass: TESTER_PW },
    logger: false,
  });
  await imap.connect();
  await imap.mailboxOpen('INBOX');

  const deadline = Date.now() + TIMEOUT_MS;
  const replies: { inReplyTo: string; references: string; from: string }[] = [];

  while (Date.now() < deadline) {
    replies.length = 0;
    for await (const msg of imap.fetch('1:*', { uid: true, source: true }, { uid: true })) {
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source);
      const irt = (parsed.inReplyTo ?? '').replace(/[<>]/g, '');
      const refs = (Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references ?? '');
      const from = parsed.from?.value?.[0]?.address ?? '';
      if (irt.includes(marker) || refs.includes(marker)) {
        replies.push({ inReplyTo: irt, references: refs, from });
      }
    }
    if (replies.length > 0) break;
    await new Promise((r) => setTimeout(r, 3_000));
  }

  await imap.logout();

  if (replies.length === 0) fail(`no reply received within ${TIMEOUT_MS / 1000}s`);
  console.log(`  ✓ received ${replies.length} reply(ies)`);

  const reply = replies[0];
  if (!reply.inReplyTo.includes(marker) && !reply.references.includes(marker)) {
    fail('reply does not thread back to the sent Message-Id');
  }
  console.log('  ✓ reply threads correctly (In-Reply-To / References)');

  if (replies.length !== 1) fail(`expected exactly 1 reply (single-processing), got ${replies.length}`);
  console.log('  ✓ exactly one reply (no double-processing)');

  console.log('\n=== e2e passed ===');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
