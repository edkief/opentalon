# OpenTalon Embed Channel (host-app agent chat)

> **Integrating a host application?** Read
> [EMBED_CLIENT_GUIDE.md](EMBED_CLIENT_GUIDE.md) instead — it is the host-side integration contract
> (proxy, identity, panel, context, error reference, checklist). This document covers the
> OpenTalon-side architecture and is aimed at people changing the channel itself.

## Context

OpenTalon already publishes static packages to TalonPress through the
`@talonpress/mcp-tools` MCP toolkit (`src/lib/tools/talonpress.ts`). That flow is one-way: the agent
pushes pages out and never hears back. This channel closes the loop — a host application can put an
agent chat surface directly into its own pages, so a reader can say "add a section about X to this
page" or "where did this number come from?" and the agent answers with the page in view.

The channel is deliberately **generic**. TalonPress is the first client, but nothing in
`src/lib/embed/` knows what a TalonPress package is: a client declares itself in config, asserts who
its users are, and describes whatever resource its users are looking at.

**Key architectural facts this was built on:**

- A channel is implicit in the shape of `chatId`. Numeric = Telegram, `web` = dashboard,
  `email:<16-hex>` = an email thread, and now `embed:<clientId>:<16-hex>` = a host conversation.
- `src/lib/channels/registry.ts` is an **outbound-only** seam. There is no inbound abstraction; each
  channel hand-rolls its ingest → `llmExecutor.chat()` → `sendToChat()` pipeline. This one follows
  the email channel's shape (`src/lib/email/process-inbound.ts:207-296`).
- An HTTP host has no push address. Telegram and SMTP can be pushed to at any time; a web page
  cannot. So `sendToChat` on an `embed:` chatId writes to a **durable outbox** the client drains.
  That is what makes scheduled tasks, workflow notifications and `request_guidance` reach an
  embedded panel at all — the `web` chatId silently drops every one of them today
  (`src/lib/channels/registry.ts:14-15`).
- `ChatOptions.context` is appended to the **stable** (prompt-cached) half of the system prompt
  (`src/lib/agent/llm-executor.ts:177`). The page-context block therefore has to be a pure function
  of the stored context version — see [Prompt caching](#prompt-caching).

**Decisions taken:**

| Decision | Choice |
|---|---|
| Topology | The host application's **server proxies**. A browser talks to the host with the host's own session; the host calls OpenTalon with a shared secret and asserts the end user. OpenTalon is never browser-facing and needs no CORS. |
| Direct browser access | **Not implemented**, but the seam exists — see [Adding the direct topology](#adding-the-direct-topology). |
| Delivery | **Async.** `POST /message` returns 202 and the turn runs on; replies land in the outbox and are drained over SSE (or polling). |
| Audience | **Admin only** by default, via a host-asserted role checked against `allowedRoles`. Memory scope `private`. |

---

## Configuration

```yaml
# config.yaml
embed:
  enabled: true
  historyLimit: 20            # messages replayed into each turn
  outboxRetentionHours: 168   # 7 days; swept hourly
  maxMessageChars: 8000
  clients:
    - id: talonpress          # sent as X-Embed-Client; baked into every chatId this client owns
      label: "TalonPress"
      allowedRoles: ["admin"] # host-asserted roles permitted to chat
      agentId: "default"      # optional pin; omit to use the chat's active agent
      toolProfile: ["talonpress", "web", "memory", "todos", "files"]
      memoryScope: private
      dangerousTools: deny    # no approval UI in a chat panel
      maxContextChars: 4000
      rateLimitPerMinute: 20
```

```yaml
# secrets.yaml
embed:
  talonpress:
    secret: "a-long-random-string"
```

The secret also falls back to `EMBED_SECRET_TALONPRESS` (id upper-cased, non-alphanumerics as
underscores). Everything is resolved at point of use, so edits take effect on the next request with
no restart.

**Changing a client `id` orphans its conversations** — the id is part of every chatId it owns.

### Notable defaults

- `allowedRoles` defaults to `["admin"]`. An explicitly empty array denies everyone, which is a
  legitimate way to park a client without deleting its config.
- `dangerousTools: deny` posts a notice into the chat and denies. There is no interactive approval in
  an embedded panel; approve from the dashboard, or ask the same thing over Telegram.
- A client with no secret, or with `enabled: false`, does not resolve at all. Authentication then
  fails with the same uniform 401 as a wrong secret — which is why the dashboard status card
  surfaces a per-client `configured` flag.

---

## The HTTP contract

All routes live under `/api/embed`. They are **absent from `PROTECTED_PREFIXES` in `src/proxy.ts` on
purpose**: their callers are host servers, not dashboard users, so each route authenticates itself.
Every route must go through `withEmbedAuth` or `withStreamToken` — there is no ambient protection.

Every POST carries the same identity block:

```jsonc
{
  "resource": { "id": "demo-abc123", "title": "Widget Handbook", "url": "https://…", "visibility": "private" },
  "actor":    { "userKey": "auth0|42", "userLabel": "Ed", "roles": ["admin"] },
  "context":  { "version": "v3", "summary": "…", "outline": ["…"], "facts": { "…": "…" } }  // optional
}
```

with headers `X-Embed-Client: <id>` and `Authorization: Bearer <secret>`.

| Route | Purpose | Returns |
|---|---|---|
| `POST /api/embed/session` | Open or resume a conversation when the panel mounts | `{ chatId, agentId, cursor, streamToken, expiresAt, contextVersion, history[] }` |
| `POST /api/embed/message` | Send a user message (`message`, optional `clientMessageId`) | `202 { chatId, turnId, cursor }` |
| `POST /api/embed/context` | Push a fresh page context out of band (`context`, optional `announce`) | `{ ok, chatId, version, changed }` |
| `GET /api/embed/stream?token=&since=` | SSE: outbox replay, then live messages + step progress | `event: message` / `status` / `error` |
| `GET /api/embed/messages?token=&since=` | Polling equivalent of `/stream` | `{ chatId, cursor, hasMore, messages[] }` |

### Conversation identity

`chatId = embed:<clientId>:<sha256(clientId|resourceId|userKey)[0..16]>`, derived from the
**authenticated principal only**. A caller-supplied `chatId` is compared and a mismatch is a 403;
accepting one would let any host address any conversation on the instance. This derivation is the
entire isolation story for the channel.

`userKey` **must be stable across the host user's sessions**. A host that rotates it per login mints
a new conversation every time and loses all continuity.

Unlike `/api/chat`, no caller-supplied system-prompt `context` string ever reaches `llmExecutor` —
the block is built server-side from the validated envelope.

### Why 202 and an outbox

An agent turn with tools routinely runs longer than a host proxy will hold a request open, so the
reply cannot be the POST response. `POST /message` queues the turn and returns immediately; the
reply is delivered through the outbox.

The outbox cursor (`seq`) is a **per-chat counter held on `embed_threads.lastSeq`**, allocated with a
single atomic `UPDATE … SET last_seq = last_seq + 1 RETURNING last_seq`. Not a global serial (which
can commit out of order and strand a row behind a cursor the client already passed) and not
`max(seq)` over the outbox (which would restart numbering once retention sweeps an idle chat clean).

Turns are **serialized per chat** via an in-process promise chain, so a user double-sending cannot
interleave two turns over the same history. Different chats run in parallel.

`clientMessageId` makes `POST /message` idempotent: a host proxy that timed out and retried gets
`{ duplicate: true }` and the original `turnId`, not a second turn.

### Streaming

`GET /stream` replays outbox rows past the client's cursor, then streams new ones, plus coarse
`status` events derived from the agent's step events (`StepEvent.sessionId` is the chatId,
`llm-executor.ts:718`) so the panel can show what the agent is doing during a long turn.

Set `X-Accel-Buffering: no` and disable response buffering **in the host's reverse proxy too** —
the stream is relayed through it. `GET /messages` exists for hosts where that is not achievable.

---

## Page context

The host owns the context. OpenTalon validates, caps and renders it; it never invents it.

```ts
{
  version?: string;    // hash or counter; the cache key. Derived from content if omitted.
  title?: string;
  url?: string;
  visibility?: string;
  summary?: string;    // what this page is and who it is for
  outline?: string[];  // section headings
  facts?: Record<string, string | number | boolean>;
  excerpt?: string;    // the current view or the user's selection
  updatedAt?: string;
}
```

Unknown keys are stripped. It can arrive on any POST, or on its own via `POST /context` — the
dedicated "the page changed" operation. A POST that carries **no** `context` leaves the stored one
alone, so a plain message never wipes context an earlier call established.

`POST /context` with `announce: true` also writes a passive-context row into the conversation
(role `user`, explicitly marked "context only, not an instruction" — the same convention the email
channel uses for non-whitelisted senders) so a mid-conversation change is visible to the model in
history rather than silently swapping under it.

### Prompt caching

`renderContextBlock()` output goes into the **cached stable prefix** of the system prompt. It must be
a pure function of the resource plus the stored context version: **no timestamps, no message text, no
per-request state**. Anything that varies per turn costs a full cache miss on every single request.
`scripts/test-embed-context.ts` asserts byte-identical rendering for equal inputs so a future edit
that interpolates a clock fails there rather than silently in production.

Content past `maxContextChars` is truncated with a pointer telling the model to fetch the rest with
the host's own tools, rather than being silently dropped.

---

## File map

| File | Purpose |
|---|---|
| `src/lib/embed/config.ts` | `getEmbedConfig()`, `getEmbedClient()` — config + secrets + env, resolved per call |
| `src/lib/embed/auth.ts` | `EmbedPrincipal`, the authenticator dispatch table, stream tokens, CORS |
| `src/lib/embed/threads.ts` | chatId derivation and parsing |
| `src/lib/embed/context.ts` | Envelope schema, version derivation, system-prompt rendering |
| `src/lib/embed/tools.ts` | `buildEmbedTools()` — mirrors `email/tools.ts`; per-client tool profile |
| `src/lib/embed/send.ts` | The `embed:` `ChannelSender` — outbox write + live event |
| `src/lib/embed/process-message.ts` | The per-chat serialized turn runner |
| `src/lib/embed/http.ts` | `withEmbedAuth`, `withStreamToken`, preflight |
| `src/lib/embed/rate-limit.ts` | Per-conversation token bucket |
| `src/lib/embed/index.ts` | `setupEmbedChannel()`, `getEmbedStatus()` |
| `src/lib/db/embed.ts` | Thread, idempotency and outbox queries |
| `src/app/api/embed/*` | The five routes |

The host-facing contract for all of this — request shapes, error codes, panel behaviour, the
integration checklist — is in [EMBED_CLIENT_GUIDE.md](EMBED_CLIENT_GUIDE.md). Keep the two in sync
when changing a route.

Startup is `setupEmbedChannel()` in `src/instrumentation.ts`, called unconditionally inside the
core-services guard: the sender is a no-op while the channel is disabled, so registering regardless
means enabling it in config.yaml needs no restart and no hot-reload listener.

---

## Testing

```bash
pnpm test:embed-auth      # identity, auth, role gate, stream tokens, CORS, rate limit, route wrapper
pnpm test:embed-context   # envelope validation, version derivation, rendering, cacheability
pnpm test:embed-outbox    # threads, idempotency, sequencing, retention — needs Postgres
```

`test:embed-outbox` skips cleanly (exit 0) when Postgres is unreachable. Bring it up with
`pnpm deps:up && pnpm db:push`.

Manual end-to-end without a host, using curl in place of the proxy:

```bash
# 1. open a session
curl -s localhost:3000/api/embed/session \
  -H 'X-Embed-Client: talonpress' -H 'Authorization: Bearer <secret>' \
  -H 'Content-Type: application/json' \
  -d '{"resource":{"id":"demo-abc123","title":"Demo"},"actor":{"userKey":"u1","roles":["admin"]}}'

# 2. attach the stream (second terminal), using the streamToken from step 1
curl -N 'localhost:3000/api/embed/stream?token=<streamToken>&since=0'

# 3. send a message
curl -s localhost:3000/api/embed/message \
  -H 'X-Embed-Client: talonpress' -H 'Authorization: Bearer <secret>' \
  -H 'Content-Type: application/json' \
  -d '{"resource":{"id":"demo-abc123"},"actor":{"userKey":"u1","roles":["admin"]},"message":"What is this page about?","clientMessageId":"m1"}'
```

Worth checking by hand:

- The chat appears in the dashboard picker as `🧩 talonpress: Demo`.
- A second message reuses the chatId and the model sees the earlier exchange.
- "Remind me in 2 minutes to check X" — the scheduled task's reply arrives **on the same stream**.
  This is the proof that registering the `ChannelSender` was worth doing.
- Repeating step 3 verbatim returns `duplicate: true` and runs no second turn.
- A wrong secret is 401; `roles: ["viewer"]` is 403; another user's `chatId` is 403.

---

## Adding the direct topology

If a deployment wants the browser to call OpenTalon directly instead of proxying:

1. Implement `jwtAuthenticator` in `src/lib/embed/auth.ts` — the dispatch table entry already exists
   and currently returns 501, so a misconfigured client fails closed rather than degrading.
2. Set `auth.mode: jwt` and populate `allowedOrigins` for the client. `corsHeadersFor()` is already
   wired into every route and its `OPTIONS` handler, and returns nothing while `allowedOrigins` is
   empty — so this is a config change plus one function.
3. Stream tokens need no work: `POST /session` already mints exactly the short-lived handle a
   browser would hold.

---

## Deferred

- **Crash recovery.** `recordPendingTurn` exists, but `recoverPendingTurns`
  (`src/lib/telegram/resume-turn.ts:181`) hardcodes a Telegram context string and only runs inside
  the long-polling branch, so recording embed turns there would resume them with the wrong prompt.
  Generalising `resume-turn.ts` is the follow-up; until then an embed turn in flight when the process
  dies is lost, and the user sees no reply.
- **Attachments**, both directions.
- **Interactive tool approval** in the panel. v1 posts a notice and denies.
- **Multi-replica rate limiting.** The limiter is in-process, so a replicated deployment limits per
  replica. It exists to stop a runaway page loop, not as a billing control.
