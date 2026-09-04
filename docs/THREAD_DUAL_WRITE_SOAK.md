# Thread dual-write soak validation (#44 / T3)

The T3 dual write ([PR #51](https://github.com/edkief/opentalon/pull/51)) shipped as
`Part of #44` rather than `Closes`, because four of the ticket's acceptance criteria
are production-soak checks that cannot be answered from a branch: they are about rows
a *deployed* pod wrote. This is how to run them.

`thread_id` is populated but unread until the T4 read flip (#45), so the whole point
of this window is that a failure found here is cheap — nothing depends on the column
yet.

**Artifacts**

| What | Where |
|---|---|
| Post-deploy SQL (6 queries) | `scripts/thread-soak.sql` |
| Golden email id parity | `scripts/check-thread-parity.ts` → `pnpm check:thread-parity` |

Both are read-only — selects only, safe against production.

## Step 1 — let it soak first

Do not run these immediately after deploy. The criteria are about rows a deployed pod
*wrote*, so they need traffic through every channel first.

Wait until there has been at least one real turn on each of telegram, email, web and
embed, plus:

- **one specialist spawn**, and
- **one `/compact`**

Those last two are worth deliberately exercising rather than waiting for: they are
writers the ticket's own dual-write table omitted, and they are the ones most likely
to be missing in a future regression.

## Step 2 — the null check (criterion 1)

```bash
psql "$DATABASE_URL" -v deploy="'2026-09-04 09:00:00+00'" -f scripts/thread-soak.sql
```

Set `deploy` to when the image **started serving**, not when the PR merged.

Everything in the file is scoped to that timestamp because pre-deploy rows are
*expected* to be backfilled-or-null. `pending_turns` in particular has a deliberate
null fallback for rows written by a pod predating the dual write, so an unscoped query
reports a failure that isn't one.

**Query 1 is the acceptance criterion: four zeros** across `conversations`,
`conversation_steps`, `pending_turns` and `agent_state`.

**Query 2** only matters if query 1 is non-zero. It splits the nulls by channel and by
`agent_id IS NULL`, which is what distinguishes a missed call site from missed
specialist plumbing.

## Step 3 — three checks the ticket does not ask for

Queries 3–6 in the same file. Worth reading even when query 1 is clean, because each
of these fails *silently* today and only surfaces as a missing conversation at the T4
read flip.

- **3 — orphans.** A `thread_id` stamped with no matching `threads` row. There is no FK
  from `thread_id` to `threads.id` by design, so a resolver that returns an id without
  the ensure step creating the row passes query 1 and still breaks reads.
- **5 — non-root threads.** Before T6 mints per-thread web ids, essentially every live
  thread should still satisfy `thread_id = chat_id`. Anything else written since deploy
  is either a resolver bug or writes landing on an archived agent's thread.
- **6 — divergence.** A chat filing its messages under one thread and its steps under
  another splits a transcript in half at the flip.

(Query 4 is a shape check on threads minted since deploy: origin should be
`inbound`/`dashboard`, never `backfill`; a channel of `system` means a `chat_id` shape
the resolver did not recognise.)

## Step 4 — golden id parity (criterion 2)

```bash
pnpm check:thread-parity            # --verbose to list every mismatch
PARITY_LIMIT=50000 pnpm check:thread-parity
```

The unit suite pins the derived ids as literals; this replays the **live resolver**
over rows that already exist in `email_messages` and asserts it lands on the `chat_id`
those rows were actually filed under. A mismatch is a live conversation the read flip
would orphan.

Expected caveat in the output: `findChatIdBySubject` windows 30 days back from `now()`,
not from the row, so replaying an old subject-fallback row legitimately re-derives a
different id. The script counts those separately as informational. **Only the `headers`
and `seed` paths are hard failures.**

Defaults to the most recent 5000 rows.

## Step 5 — gate #45

Green on both is the go signal for the read flip.

If query 1 is non-zero, the fix is a T3 follow-up, **not** something to carry into #45.
Finding it while nothing reads the column is the entire reason this shipped write-only.

## Related

- `scripts/thread-preflight.sql` — the earlier pre/post-migration queries for the 0026
  backfill (T2, #43). Different window, different questions; still useful for
  understanding how a chat's primary thread was chosen.
- `pnpm test:thread-resolver` — unit suite, including the pinned golden ids.
- `pnpm test:thread-backfill` — 0026 backfill parity against a fixture database.
