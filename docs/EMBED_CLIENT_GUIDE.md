# Embedding OpenTalon agent chat in a host application

This guide is for engineers on a **host application** — any web app that wants an agent chat panel
inside its own pages, talking about whatever the user is currently looking at.

It is deliberately host-agnostic. TalonPress was the first integration, but nothing in the embed
channel knows what a TalonPress package is: you declare a client, assert who your users are, and
describe your own resources.

For the OpenTalon-side architecture — why delivery is async, how sequencing works, what the module
layout is — see [EMBED_CHANNEL.md](EMBED_CHANNEL.md). This document is the integration contract.

---

## 1. The shape of the integration

```
  ┌──────────────┐   your session cookie    ┌──────────────┐   shared secret   ┌───────────┐
  │   browser    │ ───────────────────────► │  your server │ ────────────────► │ OpenTalon │
  │  chat panel  │ ◄─────────────────────── │    (proxy)   │ ◄──────────────── │           │
  └──────────────┘      SSE, relayed        └──────────────┘                   └───────────┘
```

**Your server proxies. The browser never talks to OpenTalon and never sees the shared secret.**

That is the whole security model, and it has three consequences worth internalising before you write
any code:

- OpenTalon does not need to be reachable from the internet, only from your server. No CORS.
- OpenTalon has no idea who your users are. **You** authenticate them with your existing session
  mechanism and then *assert* their identity to OpenTalon. OpenTalon trusts that assertion because it
  trusts your shared secret — so an endpoint that forwards an unauthenticated request is a full
  authorisation bypass.
- Your proxy is on the hot path for streaming. If it buffers responses, the chat appears to hang.

A direct browser-to-OpenTalon topology (short-lived signed tokens, CORS) is designed for but **not
implemented**. A client configured for it fails closed with `501`.

---

## 2. OpenTalon-side setup

Someone with access to the OpenTalon workspace declares your client. You need them to do this once.

```yaml
# config.yaml
embed:
  enabled: true
  clients:
    - id: myapp                 # letters, digits, hyphens, underscores only
      label: "My App"           # shown in the OpenTalon dashboard
      allowedRoles: ["admin"]   # which of YOUR asserted roles may chat
      toolProfile: ["web", "memory", "todos", "files"]
      dangerousTools: deny
      rateLimitPerMinute: 20
```

```yaml
# secrets.yaml
embed:
  myapp:
    secret: "a-long-random-string"   # or the EMBED_SECRET_MYAPP env var
```

Three things to agree on up front:

| Setting | Why you care |
|---|---|
| `id` | Sent as `X-Embed-Client` and baked into every `chatId` your client owns. **Changing it later orphans every existing conversation.** Pick it once. |
| `allowedRoles` | OpenTalon rejects any actor whose `roles` do not intersect this list. Defaults to `["admin"]`. An empty list denies everyone — a legitimate way to park a client. |
| `toolProfile` | What the agent can *do* from inside your pages. Narrow it. The same agent can be broader over Telegram; this is the per-surface restriction. |

A client that is disabled or missing its secret does not resolve at all, and authentication then
fails with the **same uniform 401** as a wrong secret. That is intentional (it leaks nothing), but it
means a misconfiguration is indistinguishable from a bad credential — ask the operator to check the
embed status card on the OpenTalon dashboard, which shows a per-client `configured` flag.

---

## 3. Four decisions you have to make

Get these right before writing the proxy. Two of them are difficult to change later.

### 3.1 What is a "resource"? → `resource.id`

The thing the conversation is *about*: a page, a document, a dataset, a ticket. It scopes the
conversation, and the agent is told to treat "this page" / "here" in the user's message as meaning
this resource.

Use your own stable primary key. Not a URL path (those get rewritten), not a title (those get
edited).

### 3.2 Who is the user? → `actor.userKey`

**This is the one people get wrong.** The conversation id is derived as:

```
chatId = embed:<clientId>:<sha256(clientId | resourceId | userKey)[0..16]>
```

so `userKey` **must be stable across the user's sessions, logins, and devices**. A per-session id, a
regenerated UUID, or anything derived from a cookie means every login starts a brand-new
conversation with no memory of the last one, and the user will report it as "the agent forgot
everything".

Use your identity provider's subject claim, or your own users table primary key. It is opaque to
OpenTalon — it is only ever hashed — so it does not need to be human-readable, and you should prefer
that it is not.

`actor.userLabel` is separate, optional, and purely for display in the OpenTalon dashboard.

### 3.3 Who is allowed to chat? → `actor.roles`

You decide server-side; OpenTalon checks the result against `allowedRoles`. Start with admins only.

Opening this to anonymous or public visitors is a much bigger change than it looks — it needs
per-visitor conversation keys, real abuse controls, and a deliberately narrowed agent — so treat
"admins only" as the default and widen consciously.

### 3.4 What should the agent know about the resource? → `context`

See [§6](#6-page-context). You can defer this and send nothing at first; the integration works
without it, the agent just knows less.

---

## 4. Server side: the proxy

Five OpenTalon endpoints, all under `/api/embed`. You will typically expose four routes of your own
that mirror them.

### 4.1 A shared forwarder

```ts
const OPENTALON = process.env.OPENTALON_URL!;        // e.g. http://opentalon.internal:3000
const SECRET    = process.env.OPENTALON_EMBED_SECRET!;
const CLIENT_ID = 'myapp';

async function callOpenTalon(path: string, payload: unknown): Promise<Response> {
  return fetch(`${OPENTALON}/api/embed/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Embed-Client': CLIENT_ID,
      Authorization: `Bearer ${SECRET}`,
    },
    body: JSON.stringify(payload),
  });
}
```

### 4.2 Build the identity block server-side

Every POST carries the same envelope. **Never** take `resource`, `actor` or `chatId` from the
browser's request body — derive them from your own session and your own database.

```ts
async function identityFor(req: Request, resourceId: string) {
  const user = await getSessionUser(req);              // YOUR auth
  if (!user?.isAdmin) throw new HttpError(403);        // YOUR gate — do not skip

  const resource = await loadResource(resourceId);     // YOUR data
  if (!resource) throw new HttpError(404);

  return {
    resource: {
      id: resource.id,
      title: resource.title,
      url: `${PUBLIC_BASE_URL}/r/${resource.id}`,
      visibility: resource.visibility,
    },
    actor: {
      userKey: user.subject,                           // STABLE across logins — see §3.2
      userLabel: user.displayName,
      roles: user.isAdmin ? ['admin'] : ['viewer'],
    },
  };
}
```

If a caller-supplied `chatId` reaches OpenTalon and does not match the one derived from the
principal, the request is rejected with `403`. That check exists precisely so a proxy bug cannot leak
one user's conversation to another — but do not rely on it as your only defence.

### 4.3 Open a session when the panel mounts

```ts
// POST /api/resources/:id/agent/session
const body = await identityFor(req, params.id);
const res  = await callOpenTalon('session', { ...body, context: await buildContext(params.id) });
const data = await res.json();
// → { chatId, agentId, cursor, streamToken, expiresAt, contextVersion, history: [...] }
```

Return `chatId`, `cursor`, `streamToken`, `expiresAt` and `history` to the browser. The stream token
is scoped to exactly one conversation and expires in **one hour** — it is safe to give the browser,
and it is the only thing a `GET` can use to name a chat.

### 4.4 Send a message

```ts
// POST /api/resources/:id/agent/message
const body = await identityFor(req, params.id);
const res  = await callOpenTalon('message', {
  ...body,
  message: userText,
  clientMessageId,                    // see below
});
// → 202 { chatId, turnId, cursor }
```

**`202` means queued, not answered.** The reply does not come back on this response — an agent turn
that runs tools routinely takes longer than a proxy will hold a request open. The reply arrives on
the stream.

Generate `clientMessageId` **once per user message** (a UUID minted in the browser, or derived from
your own message row) and reuse it on retries. It makes the endpoint idempotent: a retry after a
timeout returns `{ duplicate: true }` and the original `turnId` instead of running a second turn over
the same history. Skipping it means a flaky network can make the agent answer twice.

### 4.5 Relay the stream

```ts
// GET /api/resources/:id/agent/stream?token=…&since=…
const upstream = await fetch(
  `${OPENTALON}/api/embed/stream?token=${encodeURIComponent(token)}&since=${since}`,
);

return new Response(upstream.body, {
  headers: {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',      // and disable buffering in your reverse proxy too
  },
});
```

Two failure modes to check for explicitly, because both look like "the agent never replies":

- **Your framework buffers the response.** Stream the body through; do not `await res.text()`.
- **Your reverse proxy buffers it.** nginx needs `proxy_buffering off;`. Some serverless platforms
  cannot stream at all — use the polling endpoint (`/api/embed/messages`) there instead. It returns
  the same data.

Validate the session before relaying, the same as any other route. The stream token authorises the
*conversation*; your own gate still decides whether this browser may reach it.

### 4.6 Push context updates

When the resource changes outside a conversation — an edit, a re-publish, a visibility change:

```ts
await callOpenTalon('context', {
  ...await identityFor(req, resourceId),
  context: await buildContext(resourceId),
  announce: true,        // also drop a note into any live conversation
});
// → { ok: true, chatId, version, changed }
```

`announce: true` writes a passive note into the conversation history (marked "context only, not an
instruction") so the model notices the change mid-conversation rather than having it swapped underneath
it. It only fires when the version actually moved and a conversation already exists.

---

## 5. Client side: the panel

The panel needs three pieces of state: `chatId`, `cursor`, and the message list.

### 5.1 Mount

```js
const s = await fetch(`/api/resources/${id}/agent/session`, { method: 'POST' }).then(r => r.json());
render(s.history);                 // prior conversation, oldest first
let cursor = s.cursor;             // everything up to here is already in `history`
```

The `cursor` from `/session` is the outbox high-water mark, so subscribing with `since=cursor` gives
you only what happens *next* — no duplicates with the history you just rendered.

### 5.2 Subscribe

```js
const es = new EventSource(`/api/resources/${id}/agent/stream?token=${s.streamToken}&since=${cursor}`);

es.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  cursor = Math.max(cursor, m.seq);   // ← max(), not assignment. See below.
  appendMessage(m);
});

es.addEventListener('status', (e) => setThinkingLabel(JSON.parse(e.data).status));
es.addEventListener('error',  (e) => showError(JSON.parse(e.data).message));
```

Note that `error` here is a **stream-level** fault (replay failed), not a failed turn. A turn that
blows up still arrives as a `message` event carrying `kind: 'error'`, because the failure is written
to the durable outbox like any other output. Handle both, and don't treat a quiet `error` listener as
evidence that turns are succeeding.

### 5.2.1 Status events

```jsonc
{ "turnId": "…", "kind": "tool", "tool": "web_search", "status": "Running web_search" }
```

| Field | Notes |
|---|---|
| `kind` | `thinking`, `tool`, or `responding`. **Switch on this**, and treat an unrecognised value as "still working" — the set may grow. |
| `tool` | Present only when `kind` is `tool`. The tool name, also embedded in `status`. |
| `status` | A prebuilt English label. Convenient, but not a stable contract — build your own from `kind`/`tool` if you localise or show icons. |
| `turnId` | Ties the progress to a turn. Optional: a step emitted outside a user turn has none. |

**There is no terminal or idle status.** A turn emits many steps, so an idle signal would flicker the
indicator off mid-turn whenever the agent takes more than one step. Clear your indicator when the
`message` event for that `turnId` arrives, and add a timeout as a backstop in case the server dies
mid-turn — that is the only case where a turn produces no outbox row at all.

**Take `max(seq)`, never assign directly.** Two messages can be assigned sequence numbers 4 and 5 and
commit in the other order, so 4 may arrive after 5. Sorting is your job; OpenTalon guarantees it will
not *drop* anything, but it does not guarantee arrival order. Assigning blindly would move your cursor
backwards and replay messages on the next reconnect.

### 5.3 Send

```js
await fetch(`/api/resources/${id}/agent/message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: text, clientMessageId: crypto.randomUUID() }),
});
// Render the user's own message immediately; the reply arrives on the stream.
```

### 5.4 Reconnect and expiry

`EventSource` reconnects on its own, but it reuses the original URL — including the now-stale
`since`. Handle both cases explicitly:

- **On reconnect**, close and reopen with the current `cursor`. Anything written while you were
  disconnected is replayed from the outbox (kept for `outboxRetentionHours`, default 7 days).
- **On expiry**, the stream token lasts one hour. A panel left open longer must call `/session`
  again for a fresh token. Watch `expiresAt` and refresh before it lapses.

Messages arrive as `{ seq, kind, role, content, format, turnId, createdAt }`:

| Field | Notes |
|---|---|
| `kind` | `message` (agent output), `notice` (channel-level, e.g. a denied tool), `error` (the turn failed) |
| `role` | `assistant` or `system` |
| `format` | `markdown` or `html` — render accordingly, and **sanitise** either way |
| `turnId` | Groups a user message with the reply it produced |

Not everything on the stream is a reply to something the user just typed. Scheduled tasks, workflow
completions and guidance prompts arrive unprompted, because the panel is a real conversation channel
rather than a request/response widget. Design the UI for messages appearing with nobody having asked.

---

## 6. Page context

Context is the envelope describing your resource. You own it; OpenTalon validates, caps and renders
it into the agent's system prompt.

```jsonc
{
  "version": "sha256-of-content",   // the cache key — see below
  "title": "Widget Handbook",
  "url": "https://example.com/r/demo-abc123",
  "visibility": "private",
  "summary": "Assembly and maintenance guide for the 2024 widget line.",
  "outline": ["Introduction", "Assembly", "Maintenance"],
  "facts": { "author": "Ed", "sections": 3, "draft": false },
  "excerpt": "…the part of the page the user is currently looking at…",
  "updatedAt": "2026-08-16T10:00:00Z"
}
```

All fields are optional and unknown keys are stripped.

### Set `version` deliberately

`version` is the **prompt cache key**. The rendered context block is a pure function of it, and that
block sits in the cached prefix of the system prompt. Two rules follow:

- **Make it change when the content changes.** A content hash is ideal. If you omit `version`,
  OpenTalon derives one by fingerprinting the envelope, which is correct but coarser.
- **Do not make it change when the content has not.** A timestamp, a request id, or a counter bumped
  on every page view busts the cache on every single turn. That is a real and measurable cost.

For the same reason, keep volatile data out of the envelope entirely. `updatedAt` is fine — it moves
with the content. A "last viewed at" would not be.

### Keep it small and pointed

The rendered block is capped at `maxContextChars` (default 4000) and truncated past that, with a note
telling the model to fetch the rest with tools. So context is a **briefing, not a copy of the
document**: what this resource is, who it is for, how it is structured, which facts matter.

If the agent needs the actual content, give it a tool that reads it. An MCP server exposing your
resources is the natural way, and it scales to documents that could never fit in a prompt. Schema
ceilings, for reference: `summary` and `excerpt` 20,000 chars each, `outline` 200 entries of 500,
`title` 500, `url` 2,000. Those are hard limits; `maxContextChars` is the practical one.

---

## 7. API reference

Base: `POST|GET <opentalon>/api/embed/<route>`.
Headers on every POST: `X-Embed-Client: <id>`, `Authorization: Bearer <secret>`, `Content-Type: application/json`.

Shared POST body:

```jsonc
{
  "resource": { "id": "…", "title": "…", "url": "…", "visibility": "…" },  // id required
  "actor":    { "userKey": "…", "userLabel": "…", "roles": ["admin"] },    // userKey required
  "context":  { … }                                                        // optional
}
```

| Route | Extra fields | Success |
|---|---|---|
| `POST /session` | — | `200 { chatId, agentId, cursor, streamToken, expiresAt, contextVersion, history[] }` |
| `POST /message` | `message` (required), `clientMessageId` | `202 { chatId, turnId, cursor }`, plus `duplicate: true` on a replay |
| `POST /context` | `context` (required), `announce` | `200 { ok, chatId, version, changed }` |
| `GET /stream?token=&since=` | — | `text/event-stream` |
| `GET /messages?token=&since=` | — | `200 { chatId, cursor, hasMore, messages[] }` |

`history` entries are `{ role, content, createdAt }`, oldest first, capped at `historyLimit`
(default 20). There is no endpoint for older history — persist your own if you need a full archive.

SSE events: `message` (see §5.4), `status` (`{ turnId?, kind, tool?, status }` — see §5.2.1), `error`
(`{ message }`, stream-level only; a failed turn arrives as a `message` with `kind: 'error'`). Lines beginning `:`
are keepalive comments (`: connected`, `: ping` every 15s) — `EventSource` ignores them; a hand-rolled
parser must too.

### Errors

All errors are `{ "error": "<code>", "message": "<human text>" }`.

| Status | Code | Meaning and what to do |
|---|---|---|
| 400 | `bad_request` | Malformed JSON or a schema violation. Fix the payload; do not retry. |
| 401 | `unauthorized` | Unknown client, wrong secret, disabled client, or missing secret — **deliberately indistinguishable**. Check config with the operator. |
| 403 | `forbidden` | Actor holds none of `allowedRoles`, required identity fields are missing, or a supplied `chatId` does not belong to this actor. |
| 413 | `too_large` | Message exceeds `maxMessageChars` (default 8000). Truncate or split. |
| 429 | `rate_limited` | Past `rateLimitPerMinute` for this conversation. Honour `Retry-After`. |
| 501 | `not_implemented` | Client is configured for the unimplemented direct-browser auth mode. |
| 503 | `channel_disabled` / `config_invalid` | Channel is off, or OpenTalon's config is broken. Retry later; surface a degraded state. |
| 500 | `internal_error` | Retry once with the same `clientMessageId`, then surface it. |

Field limits: `resource.id` ≤200, `actor.userKey` ≤400, `roles` ≤50 entries of ≤100,
`clientMessageId` ≤200, `message` ≤ `maxMessageChars`.

---

## 8. Integration checklist

- [ ] Client id, `allowedRoles` and `toolProfile` agreed with the OpenTalon operator
- [ ] Secret stored in your secret manager, injected as an env var, never in the browser bundle
- [ ] `resource.id` is your stable primary key
- [ ] `userKey` is stable across logins and devices — **verify by logging out, back in, and checking
      the conversation still has its history**
- [ ] `resource` and `actor` are built server-side from your session, never from the request body
- [ ] Your own authorisation gate runs before every forward, including the stream route
- [ ] `clientMessageId` is generated once per message and reused on retry
- [ ] Streaming is unbuffered end to end (framework *and* reverse proxy), or you use polling
- [ ] Panel takes `max(seq)` as its cursor
- [ ] Panel reconnects with the current cursor and refreshes the token before `expiresAt`
- [ ] Panel renders unprompted messages (scheduled tasks, notifications) sensibly
- [ ] `context.version` changes with content and *only* with content
- [ ] Markdown and HTML message content is sanitised before rendering

---

## 9. Common mistakes

| Symptom | Cause |
|---|---|
| "The agent forgot everything" after logging out and back in | `userKey` is not stable — §3.2 |
| Replies never arrive; `202` looks fine | Response buffering in the framework or reverse proxy — §4.5 |
| Duplicate replies to one question | No `clientMessageId`, so a retry ran a second turn — §4.4 |
| Messages replay on every reconnect | Cursor assigned instead of `max()`-ed — §5.2 |
| Panel stops updating after about an hour | Stream token expired; no `/session` refresh — §5.4 |
| Token costs far higher than expected | `context.version` changes every request, busting the prompt cache — §6 |
| `401` no matter what you send | Client disabled or missing its secret; looks identical to a bad secret — §2 |
| Agent answers about the wrong page | `resource.id` derived from a URL that got rewritten — §3.1 |

---

## 10. Testing your integration

Start against OpenTalon directly with curl, standing in for your proxy, before wiring up any UI:

```bash
# 1. open a session
curl -s $OPENTALON/api/embed/session \
  -H "X-Embed-Client: myapp" -H "Authorization: Bearer $SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"resource":{"id":"res-1","title":"Demo"},"actor":{"userKey":"u1","roles":["admin"]}}'

# 2. attach the stream in another terminal, with the streamToken from step 1
curl -N "$OPENTALON/api/embed/stream?token=$TOKEN&since=0"

# 3. send a message
curl -s $OPENTALON/api/embed/message \
  -H "X-Embed-Client: myapp" -H "Authorization: Bearer $SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"resource":{"id":"res-1"},"actor":{"userKey":"u1","roles":["admin"]},"message":"What is this page about?","clientMessageId":"m1"}'
```

Then work through these, in roughly this order:

1. **Continuity** — send a second message; the reply should reference the first exchange.
2. **Identity stability** — repeat step 1 with the same `userKey`; `chatId` must be identical and
   `history` non-empty.
3. **Isolation** — repeat with a different `userKey`; `chatId` must differ and `history` must be empty.
4. **Idempotency** — repeat step 3 verbatim; expect `duplicate: true` and no second reply.
5. **Unprompted delivery** — ask "remind me in 2 minutes to check X". The scheduled task's reply must
   arrive on the same stream. This is the single best end-to-end check: it exercises the durable
   outbox and proves the panel is a real channel rather than a request/response widget.
6. **Replay** — kill the stream, send a message, reconnect with your old cursor. The missed reply
   must arrive.
7. **Rejection paths** — wrong secret → 401; `roles: ["viewer"]` → 403; another user's `chatId` → 403.

Only once all seven pass is it worth debugging the UI.
