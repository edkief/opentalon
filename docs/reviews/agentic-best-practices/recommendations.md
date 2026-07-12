# Recommendations — Agentic Best Practices

Each item is written to be handed to an implementing agent: what's wrong, why it matters, and a
high-level plan. File references use `path:line` against branch `review/agentic-best-practices`
(forked from `main` @ `6dcb9b6`).

---

## 1. Fix `maxTokens` → `maxOutputTokens` (silently ignored) — 🔴 Bug

**Where:** `src/lib/agent/llm-executor.ts:317,416,593,680`, `src/lib/agent/specialist.ts:83,103`

**Problem:** The project uses `ai@6`. Since AI SDK v5, the output-token cap option is
`maxOutputTokens`; `maxTokens` no longer exists on `generateText`/`streamText`. Because `genArgs`
is an untyped object spread into the call, TypeScript's excess-property check never fires and the
option is **silently dropped**. The `llm.maxTokens` config (schema at
`src/lib/config/schema.ts:13`, documented as "Max output tokens per LLM request") currently does
nothing — users who raise it to fix `finishReason: length` see no effect, and there is no cap
protecting against runaway output.

**Plan:**
1. Rename the spread key to `maxOutputTokens` in all four call sites (`llm-executor.ts` main /
   finalise / todo-check args, `specialist.ts` genArgs). Keep the config key `llm.maxTokens`
   for backward compatibility, mapping it internally.
2. Type `genArgs` as `Parameters<typeof generateText>[0]` (or extract a typed builder) so future
   renames fail compilation instead of silently no-oping. The same weak typing also hides the
   `tc.args` / `tr.result` fallbacks (v4-era fields) sprinkled through step handling — clean those
   while there.
3. Verify with a low cap (e.g. 300) that responses actually truncate with `finishReason: 'length'`
   and the existing truncation notice path triggers.

---

## 2. Apply tool-result compression middleware to specialists — 🔴 High

**Where:** `src/lib/agent/specialist.ts:99` (`model: resolved.model`) vs
`src/lib/agent/llm-executor.ts:396-402` (`wrapModel`)

**Problem:** The main agent wraps its model with `wrapModelWithToolCompression` (window +
head/tail truncation + file offload). Specialists call `generateText` on the **raw model**: a
specialist that reads big files or gets large `run_command`/`web_fetch` output accumulates
uncompressed tool results across up to 15 steps. This is the highest-leverage context-bloat gap —
and specialists are exactly where heavy tool use happens (note the recent
`fix(agent): resolve OOM issues and improve tool truncation` commit; this path was left out).

**Plan:**
1. In `executeSpecialist`, wrap the resolved model:
   `model: wrapModelWithToolCompression(resolved.model, specialistId ?? chatId)` — using the
   specialistId as the offload scope keeps dump files per-run and lets the existing sweep clean
   them.
2. Consider also honoring `memory`/RAG wrapping deliberately (currently specialists skip RAG by
   design — keep that, but document it in the function docstring).
3. Test: specialist task that `read_file`s a >8k-char file twice; confirm prompt sent on step 3
   contains truncated results with recovery paths.

---

## 3. Abort specialist work on timeout — 🔴 High

**Where:** `src/lib/agent/specialist.ts:238-246` and inline path `:465-472`

**Problem:** `Promise.race([executeSpecialist(...), timeout])` rejects the caller after
`specialistTimeoutMs`, but nothing aborts the losing branch. The specialist keeps generating,
calling tools, burning tokens, and eventually emits `complete`/`max_steps` events and (inline
path) writes job status — potentially *after* the parent already reported a timeout failure.
Orphaned generations are both a cost leak and a state-consistency hazard (job flips from
failed-by-timeout narrative to `completed`).

**Plan:**
1. `executeSpecialist` already registers an `AbortController` in `cancellationRegistry` keyed by
   `specialistId`. On timeout, call `cancellationRegistry.cancel(specialistId)` (or fetch and
   `.abort()`) before/instead of merely rejecting; then await the aborted promise so cleanup
   (`finally` block: unregister + todo clear) completes deterministically.
2. Apply the same in the inline fork path.
3. Make sure the timeout path emits exactly one terminal specialist event (`error` with a
   "timed out" message) and one job-status update; the AbortError re-throw handling at `:166` and
   `:502` should be extended to distinguish cancel-by-user vs cancel-by-timeout.
4. Test: specialist with a `run_command sleep`-style long tool and a 2s timeout; assert no
   further step events after the timeout and job status is terminal.

---

## 4. Preserve full JSON Schema fidelity for MCP tools — 🟠 High

**Where:** `src/lib/tools/registry.ts:57-81` (`mcpSchemaToZod`)

**Problem:** The hand-rolled JSON-Schema→Zod conversion keeps only flat primitives. It drops:
`enum` values, nested object properties, array `items` types, `default`s, `format`, min/max
constraints, `anyOf`/`oneOf`, and descriptions on nested fields. The model therefore sees a
degraded tool signature and must guess argument shapes — the single biggest driver of malformed
MCP tool calls. Non-object schemas collapse to `z.record(z.unknown())`.

**Plan:**
1. Replace the conversion with AI SDK's native JSON Schema support: build tools with
   `tool({ description, inputSchema: jsonSchema(t.inputSchema), execute })` (`jsonSchema` from
   `ai`). This passes the server's schema through verbatim — zero fidelity loss and less code.
   (Alternative: AI SDK's `experimental_createMCPClient` handles listing + schema + calling
   wholesale, but the current Client gives you reconnect/reload control — keeping it and only
   swapping the schema layer is the smaller, safer change.)
2. Delete `mcpSchemaToZod`.
3. Validate against each configured server: list tools, confirm one call per server round-trips
   (a test MCP server with an enum + nested-object schema makes a good fixture).

---

## 5. Make the system prompt cache-friendly — 🟠 High

**Where:** `src/lib/agent/llm-executor.ts:88-195` (`getSystemPrompt`), `:368-370`
(additionalInstructions wrapper), `middleware.ts:76-88` (RAG appended to system)

**Problem:** The system prompt interleaves stable content (identity, soul, framework instructions,
tools-environment guide) with per-turn volatile content: a timestamp **to the second**, todo
summary, running background jobs, and (via RAG middleware) retrieved context appended to the
system message. Every provider prompt cache keys on a stable prefix; with a second-granularity
timestamp at position ~4 of the prompt, the cache is busted on **every request and every step**.
For a multi-step, multi-phase turn (main + finalise + todo-check) this is the dominant avoidable
cost and latency driver.

**Plan:**
1. Reorder `getSystemPrompt` into: (a) stable prefix — identity, soul, core memory, framework
   instructions, tools environment, agents/skills/workflows lists; (b) volatile tail — datetime,
   todos, running specialists. Emit them as two blocks with the volatile block last (or as a
   separate short system message appended after the stable one — AI SDK accepts multiple system
   messages).
2. Reduce timestamp granularity to minutes and note the timezone; second-precision buys nothing.
3. Move RAG-retrieved context out of the system message: inject it as a synthetic user-adjacent
   block (e.g. part of the last user message or a preceding `user`-role context message) so the
   system prefix stays byte-stable. (Coordinates with rec #6.)
4. For Anthropic models, add a cache breakpoint after the stable block via
   `providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }` on the stable system
   message.
5. Verify with step logs: `inputTokens` on step ≥2 should show cache reads (add
   `cachedInputTokens` from `step.usage` to the emit while there — useful metric regardless).

---

## 6. Retrieve RAG context once per turn, not once per step — 🟠 Medium

**Where:** `src/lib/agent/middleware.ts:51-91` (`createRagMiddleware`)

**Problem:** `transformParams` runs on **every `doGenerate` call**, i.e. every step of the
multi-step loop and again in finalise/todo-check phases. Each run re-executes hybrid retrieval
(Qdrant dense+sparse+RRF) with the same last-user-message query, re-appends the same context, and
re-sets the rag-store. That's up to `maxSteps + finalise + todo-check` retrievals per turn for
one result — wasted latency per step and the reason the system prompt mutates mid-turn (see #5).

**Plan:**
1. Add a per-turn memo: key retrieval on `(chatId, turnId, queryHash)` in a small LRU/Map so the
   first step retrieves and later steps reuse the cached string. `turnId` already exists in the
   executor — pass it into `wrapModelWithMemory`.
2. Alternatively (cleaner): lift retrieval out of the middleware entirely — do it once in
   `chat()` before building `fullMessages` and inject as a context block (aligns with #5.3). The
   middleware then disappears.
3. Keep `setRagContext`/`consumeRagContext` semantics intact so step logs still show what was
   retrieved on the step that used it.

---

## 7. Classify errors before falling back across models — 🟠 Medium

**Where:** `src/lib/agent/llm-executor.ts:738-758`, `specialist.ts:95-172`

**Problem:** Any error except `AbortError` triggers fallback to the next model. Two failure
classes are mishandled:
- **Retryable-on-same-model** (429/529, transient network): better served by backoff on the
  primary than by hopping to a weaker fallback model mid-conversation. (AI SDK does 2 retries
  internally, but with no visibility and then the executor still hops.)
- **Non-retryable-anywhere** (invalid request from a bad replayed message, auth failure, content
  policy): will fail identically on every fallback, adding N useless full-context calls (each with
  full input-token cost if they get partway) and N× latency before the user sees the error.

Also, tool-call/result parts replayed from history are provider-shaped; a cross-provider fallback
mid-conversation can fail for that structural reason — worth detecting and reporting distinctly.

**Plan:**
1. Import `APICallError` from `ai`. In the catch: if `APICallError.isInstance(err)` and
   `!err.isRetryable` and status is 400/401/403 → don't iterate fallbacks that share the same
   provider; surface the error early with a clear message. Rate-limit/overload errors → allow the
   SDK's `maxRetries` (make it explicit in genArgs, e.g. `maxRetries: 2`) and only then fall back.
2. Record which class caused each fallback hop in the `errors[]` list (already user-visible on
   total failure) — e.g. `(rate-limited)` / `(invalid request)` suffixes.
3. Keep behavior conservative: when in doubt, fall back (current behavior). This change only
   short-circuits provably deterministic failures.

---

## 8. Fix temperature precedence & default for tool loops — 🟡 Medium

**Where:** `src/lib/agent/llm-executor.ts:197-205`

**Problem:** Precedence is `executor config → global config.yaml → agent soul config → 0.7`. A
per-agent temperature can never take effect once the global `llm.temperature` is set — backwards
from every other per-agent setting in the codebase (model, fallbacks, skills all let the agent
override). Separately, 0.7 is a chat-tuned default; multi-step tool-calling loops are more
reliable at low temperature (fewer malformed/creative tool arguments), and auxiliary control
turns (todo-check, max-steps summary) definitely want ~0–0.3.

**Plan:**
1. Swap precedence to: executor config → **agent config** → global config → default.
2. Split defaults: keep 0.7 for plain-chat turns if desired, but pass a low temperature (0.2)
   explicitly for the max-steps summary, finalise, and todo-check calls, which are
   instruction-following turns, not creative ones.
3. Document the precedence order in `config.yaml` schema descriptions.

---

## 9. Route auxiliary turns to a cheaper model — 🟡 Medium

**Where:** `llm-executor.ts:525-540` (max-steps summary), `:560-641` (finalise), `:654-730`
(todo-check)

**Problem:** Each auxiliary turn re-sends the **entire** conversation (`fullMessages`) plus the
main result to the same top-tier model. A single user turn can therefore cost 2–4 full-context
generations. The todo-check turn in particular is a constrained "write a status update via one
tool call" task — ideal for a small model. This is the standard model-routing best practice:
match model capability to phase difficulty.

**Plan:**
1. Add optional config `llm.auxModel` (fallback: primary model) and resolve it once in `chat()`.
2. Use it for todo-check and the max-steps summary unconditionally; make finalise configurable
   per-agent (`agentConfig.finaliseModel`) since finalise may do real tool work.
3. Trim the context for auxiliary turns: the todo-check needs the last user message, the todo
   list, and the draft response — not the whole history. Build a reduced message list instead of
   `...fullMessages` (biggest saving of the three).
4. Verify amend-tool behavior is unchanged with the smaller model on a scripted incomplete-todo
   scenario.

---

## 10. Standardize tool error semantics — 🟡 Medium

**Where:** all of `src/lib/tools/*` (e.g. `terminal.ts:44-49,77-79`, `skills.ts`,
`registry.ts:209-219`), executor step handling

**Problem:** Every tool catches errors and returns free-form strings: `"Failed: …"`,
`"Command failed: …"`, `"Error: old_str not found…"`, `"Skill … not found."`, or a denial
sentence. The model can't reliably distinguish success from failure (a `read_file` of a file whose
content starts with "Failed:" is indistinguishable from an error), and metrics/step logs can't
count tool failures. AI SDK v6 propagates thrown tool errors as typed `tool-error` parts the model
sees explicitly — the framework already has the right channel.

**Plan:**
1. Define one convention and apply it everywhere. Recommended: keep returning strings for
   *expected, recoverable* conditions the model should react to (not-found, denial, validation)
   but with a single canonical prefix (`Error: …`), and **throw** for unexpected/infrastructure
   failures so the SDK surfaces `tool-error` parts (multi-step loop continues; the model sees a
   structured failure).
2. Sweep the tool modules to conform; extract a `toolError(msg)` helper.
3. In `emitStep`, map `tool-error` parts into `toolResults` with an `isError` flag so the
   dashboard/logs can count failures per tool — the input for future reliability tuning of tool
   descriptions.

---

## 11. Close MCP integration gaps — 🟡 Medium

**Where:** `src/lib/tools/registry.ts`, `src/lib/telegram/tools.ts:100-110`

Three related gaps:

**(a) Per-agent allowlists don't apply to MCP tools.** `telegram/tools.ts` deliberately passes
all MCP tools through the agent tool filter (comment says "future iteration"). An agent locked
down to `read_file` still gets every MCP tool. Plan: apply the same allowlist to MCP names
(prefixed form), keeping the current pass-through only when the agent has no filter configured.

**(b) Dangerous-tool names don't account for the server prefix.** Tools register as
`${serverName}_${toolName}` (`registry.ts:157`), but `dangerousTools` config entries naturally
list the bare tool name — the `Set.has(def.name)` check at `:204` misses them, so a dangerous MCP
tool skips HITL approval. Plan: match against both prefixed and bare names (or normalize at
config load), and add a config-schema description clarifying the format. Also note CLAUDE.md
documents a double-underscore prefix (`talonpress__publish_package`) while code uses a single
`_` — pick one and align docs.

**(c) Non-text MCP results are dropped.** `execute` keeps only `type === 'text'` content parts;
images/resources silently vanish (falling back to `JSON.stringify` only when there is *no* text).
Plan: for image parts, save to the workspace tool-results dir and return the path (the same
recovery pattern the compression middleware uses); for resource parts, return uri + description.

---

## 12. Event-driven specialist await + structured result contract — 🟡 Medium

**Where:** `llm-executor.ts:264-303` (`awaitPendingSpecialists`), `specialist.ts:64-79` (system
prompt), `:286` (plain-string result)

**Problem:**
- `awaitPendingSpecialists` polls the jobs table every 2s for up to 120s inside the request path.
  pg-boss supports completion notification; polling adds up to 2s latency per specialist batch
  and DB load per tick.
- Specialist results are plain prose truncated at 3000 chars (`llm-executor.ts:288`) when merged —
  losing exactly the file paths/artifacts the supervisor needs, with no signal that truncation
  happened beyond `"..."`.
- The task description is duplicated verbatim in both the specialist's system prompt (`## Your
  Task`) and its user message, and the inline path additionally concatenates context into the
  description (`enrichedDescription`), so context appears twice too.

**Plan:**
1. Replace the polling loop with `pg-boss` completion events or a `LISTEN/NOTIFY`-backed wait
   keyed by jobId (the scheduler module already owns the pg-boss singleton — add a
   `waitForJobs(ids, timeoutMs)` API there).
2. Define a lightweight result contract for specialists: instruct them (in the specialist system
   prompt) to end with a `## Result` section containing summary + produced-file paths. When
   merging into the parent, keep the `## Result` section intact and truncate only the body above
   it. Make the 3000-char cap configurable.
3. De-duplicate the prompt: task in the user message, role/context/skills in the system prompt.
   The inline path should pass `context_snapshot` through as the `contextSnapshot` argument rather
   than concatenating into the description.

---

## 13. Smaller hardening items (batch) — 🟢 Low

One PR of small fixes:

1. **`originalRequest` assumes string content** (`llm-executor.ts:330`): `m.content as string`
   breaks for multimodal user messages (arrays). Extract text parts like the RAG middleware does.
2. **`stripThinkingTokens` leaves unclosed tags** (`llm-executor.ts:29-36`): a model cut off
   mid-`<think>` block leaks the whole partial block. Add a final rule stripping an unterminated
   opening tag to end-of-string.
3. **`run_command` limits hardcoded** (`terminal.ts:19-20`): 30s timeout / 512KB buffer are not
   configurable and undocumented in the tool description — the model can't plan around them.
   Add `tools.commandTimeoutMs` config and state the timeout in the description; return a
   distinguishable "timed out after Ns" message.
4. **HITL 30s auto-deny is short for a human on Telegram** (`hitl.ts:23`): make TTL configurable
   (e.g. `tools.approvalTimeoutMs`, default 120s) and tell the model the denial was a *timeout*
   (`"denied (approval timed out)"`) so it can offer to retry rather than concluding the user
   refused.
5. **Duplicated depth/permission checks** (`specialist.ts:206-220` vs `:450-463`): extract
   `assertSpawnAllowed(depth, spawningAgentId, targetAgentId)` used by both paths.
6. **Skills summary for specialists ignores agent `allowedSkills`** (`specialist.ts:60`):
   `getSkillsSummary()` lists all skills even when the agent is restricted; pass the allowlist
   through (the `skill_get` tool built for the parent enforces it, so this is a prompt/behavior
   inconsistency, not an access hole — but the specialist will try skills it can't load).
7. **Step-count telemetry drift in progressive mode**: `stepIndex` is incremented in
   `onStepFinish` closures shared across phases but reset per phase — confirm `streamed-step.ts`
   and classic paths report identical `stepIndex` sequences (spot-check; no known bug, just an
   invariant worth a test).
