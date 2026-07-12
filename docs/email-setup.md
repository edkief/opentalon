# Email Channel Setup (IMAP/SMTP)

OpenTalon can converse over standard email — no vendor lock-in. Inbound mail is
watched over IMAP (near-realtime via IDLE, with a polling fallback), and replies
are sent over SMTP, correctly threaded so they land in the same conversation in
Gmail/Thunderbird/Apple Mail.

## Quick start

1. **Credentials** → `secrets.yaml` (or the `EMAIL_*` env vars):

   ```yaml
   email:
     user: "agent@example.com"        # IMAP login (usually the full address)
     password: "your-app-password"
     # SMTP creds default to the IMAP creds; override only if different:
     # smtpUser: "agent@example.com"
     # smtpPassword: "your-app-password"
   ```

   Env fallbacks: `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_SMTP_USER`,
   `EMAIL_SMTP_PASSWORD`.

2. **Settings** → `config.yaml`:

   ```yaml
   email:
     enabled: true
     address: "agent@example.com"     # From address + self-loop guard
     fromName: "OpenTalon"
     imap:
       host: "imap.gmail.com"
       port: 993                       # default 993 (secure) / 143
       secure: true
       mailbox: "INBOX"                # default INBOX
     smtp:
       host: "smtp.gmail.com"
       port: 465                       # default 465 (secure) / 587
       secure: true
     whitelist:                        # only these senders get replies
       - "you@example.com"
     triggerMode: "always"             # or "mention"
     # mentionKeyword: "hey agent"     # required when triggerMode: mention
     privacy: "public"                 # or "private"
     pollIntervalSec: 300              # IMAP full-sync fallback (min 30)
     stripPlusAddressing: true         # compare user+tag@x as user@x
   ```

Email starts automatically on boot when `enabled: true`, and hot-reloads when
you change the config (it restarts on IMAP host/credential/mailbox changes and
starts when you flip `enabled` to true at runtime — no server restart needed).

## Behavior

- **Threading** — one conversation per email thread. The `chatId` is
  `email:<16-hex>`, derived from the Message-Id / References / In-Reply-To chain.
  A brand-new subject (no reply headers) starts a new conversation.
- **Whitelist** — mail from senders not in `whitelist` is **never replied to**;
  it is stored as passive context in the thread so the agent stays aware of it.
- **triggerMode: mention** — the agent only replies when `mentionKeyword`
  appears in the *fresh* reply text (quoted trails are ignored).
- **privacy: private** — the agent replies (and mails) only when every
  From/To/Cc participant is whitelisted or its own address; otherwise the mail is
  stored as passive context and no reply is sent.
- **Auto/bulk/list mail** (`Auto-Submitted`, `Precedence: bulk|junk|list`,
  `List-Id`) is never replied to.
- **Attachments** are deferred in v1 (both directions).

## Gmail note

Gmail (and Google Workspace) require an **App Password**, not your normal
password:

1. Enable 2-Step Verification on the Google account.
2. Visit <https://myaccount.google.com/apppasswords>, create an app password,
   and use it as `email.password`.
3. IMAP must be enabled in Gmail settings (Settings → Forwarding and POP/IMAP).

Hosts: `imap.gmail.com:993` (secure) and `smtp.gmail.com:465` (secure).

Outlook/Office 365 similarly require an app password (or modern auth). OAuth2 /
XOAUTH2 is a deferred enhancement; v1 uses password/app-password auth.

## IMAP IDLE requirements

Near-realtime delivery relies on the server supporting the IMAP **IDLE**
extension (Gmail, Outlook, Fastmail, Dovecot, etc. all do). Even with IDLE
active, OpenTalon runs a periodic full-sync every `pollIntervalSec` seconds —
some servers silently drop IDLE notifications, so the fallback poll guarantees no
mail is missed. If your server lacks IDLE, lower `pollIntervalSec` (minimum 30)
to poll more frequently.

Connection drops are handled with exponential backoff (1s → 60s + jitter),
resetting after 5 minutes of stability. During downtime, missed mail is caught up
by UID window on reconnect.

## Dashboard

The **Metrics** page shows an *Email channel* card (connection state, mailbox,
last sync, last error) whenever email is enabled. Email conversations appear in
the chat list titled by their latest subject.

## Testing

Unit tests (no services needed):

```bash
pnpm test:email-threading   # threading / chatId derivation / subject handling
pnpm test:email-address     # normalization, plus-addressing, whitelist/privacy
pnpm test:email-extract     # Gmail/Outlook/Apple quoting, signatures, HTML-only
                            # (incl. mention-keyword-in-quote-only must NOT trigger)
```

End-to-end against GreenMail (in-memory IMAP/SMTP with IDLE):

```bash
docker compose --profile email-test up -d greenmail postgres qdrant fastembed
# point config.yaml → email at GreenMail (imap :3143, smtp :3025, secure:false),
# start the app (pnpm dev), then:
E2E_ENABLE=1 pnpm test:email-e2e
```

Manual checklist (real mailbox): new thread, reply chain, non-whitelisted
passive storage, mention mode on/off, private mode with an outsider Cc'd,
self-mail loop doesn't spin, restart durability (kill mid-turn → exactly-once).
