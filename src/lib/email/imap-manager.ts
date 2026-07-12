// Node.js-only module — never imported by Edge runtime code.
// Manages the lifecycle of the inbound IMAP connection (mirrors bot-manager.ts).

import { ImapFlow } from 'imapflow';
import { registerChannelSender } from '../channels/registry';
import { getSyncState, setSyncState } from '../db/email';
import { getEmailConfig, type ResolvedEmailConfig } from './config';
import { processInboundEmail } from './process-inbound';
import { sendEmailToChat } from './send';

export interface EmailStatus {
  enabled: boolean;
  connected: boolean;
  mailbox: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  backoffMs: number;
}

type EmailGlobals = typeof globalThis & {
  __emailStarted?: boolean;
  __emailClient?: ImapFlow | null;
  __emailConfigListener?: boolean;
  __emailStatus?: EmailStatus;
  __emailConfigKey?: string;
  __emailPollTimer?: ReturnType<typeof setInterval> | null;
  __emailDebounce?: ReturnType<typeof setTimeout> | null;
  __emailStopping?: boolean;
  __emailBackoffMs?: number;
  __emailBackoffTimer?: ReturnType<typeof setTimeout> | null;
  __emailStableTimer?: ReturnType<typeof setTimeout> | null;
  __emailSyncChain?: Promise<void>;
  __emailLastUid?: number;
  __emailChannelRegistered?: boolean;
};

function g(): EmailGlobals {
  return globalThis as EmailGlobals;
}

const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 60_000;

function status(): EmailStatus {
  const gl = g();
  if (!gl.__emailStatus) {
    gl.__emailStatus = { enabled: false, connected: false, mailbox: null, lastSyncAt: null, lastError: null, backoffMs: 0 };
  }
  return gl.__emailStatus;
}

export function getEmailStatus(): EmailStatus {
  return { ...status() };
}

/** Serialize processing so IDLE-triggered fetches, catch-up, and full-sync never overlap. */
function runSerialized(fn: () => Promise<void>): Promise<void> {
  const gl = g();
  const prev = gl.__emailSyncChain ?? Promise.resolve();
  const next = prev.then(fn, fn); // run regardless of prior outcome
  gl.__emailSyncChain = next.catch(() => {});
  return next;
}

/** Fetch and process all messages with UID greater than the stored cursor. */
async function fetchNew(client: ImapFlow, cfg: ResolvedEmailConfig): Promise<void> {
  const gl = g();
  const mailbox = cfg.imap.mailbox;
  const lastUid = gl.__emailLastUid ?? 0;

  // `${lastUid+1}:*` — IMAP returns the last message when the range start exceeds
  // uidNext; the isMessageProcessed / Message-Id dedup makes that harmless.
  for await (const msg of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true, envelope: true }, { uid: true })) {
    const uid = Number(msg.uid);
    if (uid <= lastUid) continue;
    const source = msg.source;
    if (!source) continue;
    try {
      await processInboundEmail(source, uid, mailbox);
    } catch (err) {
      console.error('[email] processInboundEmail failed for uid', uid, err);
    }
    // Advance the cursor after each message so a crash mid-batch doesn't re-run
    // earlier ones (processed flag + dedup still guard the current message).
    gl.__emailLastUid = Math.max(gl.__emailLastUid ?? 0, uid);
    await setSyncState(mailbox, String(client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.uidValidity : 0), gl.__emailLastUid).catch(() => {});
  }
  status().lastSyncAt = new Date().toISOString();
}

/** Reconcile the stored UID cursor against the mailbox's current UIDVALIDITY. */
async function reconcileUidValidity(client: ImapFlow, cfg: ResolvedEmailConfig): Promise<void> {
  const gl = g();
  const mailbox = cfg.imap.mailbox;
  const current = client.mailbox && typeof client.mailbox === 'object' ? String(client.mailbox.uidValidity) : '0';
  const stored = await getSyncState(mailbox);
  if (!stored || stored.uidValidity !== current) {
    // New mailbox or UIDVALIDITY changed → reset cursor; Message-Id dedup covers
    // the full re-scan.
    gl.__emailLastUid = 0;
    await setSyncState(mailbox, current, 0);
  } else {
    gl.__emailLastUid = stored.lastUid;
  }
}

function scheduleDebouncedFetch(client: ImapFlow, cfg: ResolvedEmailConfig): void {
  const gl = g();
  if (gl.__emailDebounce) clearTimeout(gl.__emailDebounce);
  // Batch notification bursts (a 2s debounce) into a single fetch.
  gl.__emailDebounce = setTimeout(() => {
    gl.__emailDebounce = null;
    runSerialized(() => fetchNew(client, cfg)).catch((err) => console.error('[email] fetchNew failed:', err));
  }, 2_000);
}

async function connect(): Promise<void> {
  const gl = g();
  const cfg = getEmailConfig();
  if (!cfg) return;

  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth: { user: cfg.imap.user, pass: cfg.imap.password },
    logger: false,
  });
  gl.__emailClient = client;

  client.on('error', (err: Error) => {
    console.error('[email] IMAP error:', err.message);
    status().lastError = err.message;
  });
  client.on('close', () => {
    status().connected = false;
    if (!gl.__emailStopping) scheduleReconnect();
  });
  client.on('exists', () => scheduleDebouncedFetch(client, cfg));

  await client.connect();
  await client.mailboxOpen(cfg.imap.mailbox);

  status().connected = true;
  status().mailbox = cfg.imap.mailbox;
  status().lastError = null;

  // Connection is healthy; after 5 minutes of stability reset the backoff.
  if (gl.__emailStableTimer) clearTimeout(gl.__emailStableTimer);
  gl.__emailStableTimer = setTimeout(() => {
    gl.__emailBackoffMs = MIN_BACKOFF;
    status().backoffMs = 0;
  }, 5 * 60_000);
  gl.__emailStableTimer.unref?.();

  await reconcileUidValidity(client, cfg);
  await runSerialized(() => fetchNew(client, cfg)); // catch-up

  // Periodic full-sync even while IDLE looks healthy (servers silently drop
  // IDLE notifications; imapflow re-IDLEs but the fallback is still required).
  if (gl.__emailPollTimer) clearInterval(gl.__emailPollTimer);
  gl.__emailPollTimer = setInterval(() => {
    runSerialized(() => fetchNew(client, cfg)).catch((err) => console.error('[email] poll fetch failed:', err));
  }, cfg.pollIntervalSec * 1_000);
  gl.__emailPollTimer.unref?.();
}

function scheduleReconnect(): void {
  const gl = g();
  if (gl.__emailStopping) return;
  const backoff = gl.__emailBackoffMs ?? MIN_BACKOFF;
  const jitter = Math.floor(Math.random() * 500);
  status().backoffMs = backoff;
  console.log(`[email] Reconnecting in ${backoff + jitter}ms...`);
  if (gl.__emailBackoffTimer) clearTimeout(gl.__emailBackoffTimer);
  gl.__emailBackoffTimer = setTimeout(() => {
    connect().catch((err) => {
      console.error('[email] Reconnect failed:', err instanceof Error ? err.message : err);
      status().lastError = err instanceof Error ? err.message : String(err);
      scheduleReconnect();
    });
  }, backoff + jitter);
  gl.__emailBackoffTimer.unref?.();
  gl.__emailBackoffMs = Math.min(backoff * 2, MAX_BACKOFF);
}

export async function startEmail(): Promise<void> {
  const gl = g();
  if (gl.__emailStarted) return;
  const cfg = getEmailConfig();
  if (!cfg) return;

  gl.__emailStarted = true;
  gl.__emailStopping = false;
  gl.__emailBackoffMs = MIN_BACKOFF;
  gl.__emailConfigKey = emailConfigKey(cfg);
  status().enabled = true;

  // Register the outbound sender so app-wide pushes reach email threads.
  if (!gl.__emailChannelRegistered) {
    registerChannelSender('email:', sendEmailToChat);
    gl.__emailChannelRegistered = true;
  }

  try {
    await connect();
  } catch (err) {
    console.error('[email] Initial connect failed:', err instanceof Error ? err.message : err);
    status().lastError = err instanceof Error ? err.message : String(err);
    scheduleReconnect();
  }
}

export async function stopEmail(): Promise<void> {
  const gl = g();
  gl.__emailStopping = true;
  if (gl.__emailPollTimer) { clearInterval(gl.__emailPollTimer); gl.__emailPollTimer = null; }
  if (gl.__emailDebounce) { clearTimeout(gl.__emailDebounce); gl.__emailDebounce = null; }
  if (gl.__emailBackoffTimer) { clearTimeout(gl.__emailBackoffTimer); gl.__emailBackoffTimer = null; }
  if (gl.__emailStableTimer) { clearTimeout(gl.__emailStableTimer); gl.__emailStableTimer = null; }
  const client = gl.__emailClient;
  if (client) {
    try { await client.logout(); } catch { /* ignore */ }
  }
  gl.__emailClient = null;
  gl.__emailStarted = false;
  status().connected = false;
  status().enabled = false;
}

export async function restartEmail(): Promise<void> {
  await stopEmail();
  await startEmail();
}

/** Serialized snapshot of the settings that require a reconnect when they change. */
function emailConfigKey(cfg: ResolvedEmailConfig): string {
  return JSON.stringify({ imap: cfg.imap, enabled: cfg.enabled });
}

/** Restart on IMAP host/creds/mailbox changes; start when `enabled` flips true. */
export function setupEmailHotReload(): void {
  const gl = g();
  if (gl.__emailConfigListener) return;
  gl.__emailConfigListener = true;

  import('../agent/log-bus').then(({ logBus }) => {
    logBus.on('config-changed', async () => {
      const cfg = getEmailConfig();
      if (!cfg) {
        // Disabled or creds removed at runtime.
        if (gl.__emailStarted) await stopEmail();
        return;
      }
      const key = emailConfigKey(cfg);
      if (!gl.__emailStarted) {
        console.log('[email] Enabled at runtime, starting...');
        await startEmail();
      } else if (key !== gl.__emailConfigKey) {
        console.log('[email] IMAP config changed, restarting...');
        gl.__emailConfigKey = key;
        await restartEmail();
      }
    });
  });
}
