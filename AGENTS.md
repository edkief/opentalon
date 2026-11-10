# OpenTalon Agent Development Guide

Self-hosted AI personal agent: Telegram, email, web chat and embed channels; a Next.js dashboard; multi-agent orchestration with stateless specialists; hybrid-RAG vector memory; pg-boss scheduled tasks; React Flow workflows; MCP tools; hot-reload of config and AGENT.md files.

**Stack:** Node 22+, Next.js 16 (App Router), Vercel AI SDK `ai@6`, PostgreSQL + Drizzle, Qdrant, pg-boss, grammY v1, IMAP/SMTP (IDLE), MCP SDK, Tailwind v4 + shadcn/ui, React Flow, Pino. Optional coding harness: pi `>=1.1 <2` over `pi --mode rpc`. Package manager: **pnpm**.

## Running

```bash
pnpm deps            # docker compose up -d: postgres, qdrant, adminer, greenmail, fastembed
pnpm dev             # Next.js dev server
pnpm dev:bot         # Telegram bot (scripts/run-bot.ts)
pnpm chat            # CLI chat (scripts/chat.ts)
pnpm check           # eslint + tsc --noemit
pnpm db:generate | db:migrate | db:push
pnpm test:<name>     # tsx scripts in scripts/test-*.ts; see package.json
```

Env vars: `.env.example`.

## Layout

- `src/app/api/` route handlers; `src/app/dashboard/` dashboard pages
- `src/lib/agent/` LLM execution, specialists, log bus, turn parts, harness glue
- `src/lib/{telegram,email,embed,channels,threads,commands}/` channels and shared chat plumbing
- `src/lib/{memory,tools,scheduler,workflow,soul,config,db,harness,skills,lsp}/`
- `skills/` user skills, `system-skills/` built-in skills (Anthropic SKILL.md format)
- `drizzle/` migrations, `specs/` design docs, `docs/` channel docs, `extensions/pi/` pi extension

## Architecture

### Supervisor and specialists

The supervisor handles user turns and delegates via `spawn_specialist`. Specialists are **stateless**: no Core Memory, no automatic RAG, no memory tools. The supervisor must `memory_recall`/`memory_read` itself and paste relevant excerpts into `context_snapshot`.

Depth: specialists can't spawn specialists, except an agent with `canSpawnSubAgents` and a non-empty `allowedSubAgents` running as a background specialist: it gets `spawn_specialist`/`await_specialists` and may run one more level, waited on inline (hard cap depth 2). A specialist's volatile prompt block holds only the clock and its own todos (scoped to its specialist id); it never sees the supervisor's todos or the chat's running jobs, and `await_specialists` accepts only job ids it spawned.

### Agents

Each agent has `agents/<id>/AGENT.md` (`## Identity` / `## Soul`), a model with fallback chain, a tool allowlist, a RAG toggle, and `agent.yml` with `executor`: `native` (default, AI SDK loop) or `pi`.

### pi executor (epic #66)

An agent with `executor: pi` runs **every** turn in pi (requires `harness.pi.enabled`):

- **Specialist runs**: all spawn paths (sync, inline background, pg-boss background) call `runHarnessSpecialist` (`src/lib/agent/harness-run.ts`) and get back what a native run returns, so lifecycle events, job records, cancel and truncation are unchanged. pi events become the same `StepEvent`s (`harness-steps.ts`), tagged `harness: 'pi'`.
- **Direct turns** (#93): `LLMExecutor.chat()` hands every non-specialist turn (Telegram, web, email, embed, scheduled tasks, heartbeats, crash recovery) to `runHarnessChat`. It starts a fresh pi with soul, read-only Core Memory, recalled notes, channel context and the transcript (newest `HARNESS_TRANSCRIPT_LIMIT` = 40,000 chars). pi's final answer is the reply, its steps are the turn's `main` steps, `/cancel` aborts it. A pi that can't run is a `[Harness]` error; **never** fall back to the native loop.
- pi has none of OpenTalon's tools (memory writes, delegation, scheduling, todos, skills) and stores no `parts` for replay.
- `agent.yml` also takes `workdir` and `harnessTimeoutMs`.

**Permission gate (#70)**: every pi tool call passes through `harnessTrust` (`harness-gate.ts`):
- `gate` (default): `bash` is asked as `run_shell`; `write`/`edit` behave like the built-in file tools unless `dangerousTools` lists `write_file`/`str_replace_based_edit`; unknown tools are asked as `pi:<tool>`.
- `workdir`: unattended; writes outside workdir blocked (bash not confined).
- `full`: unattended.

"Asked" goes through the spawning channel's `sendApprovalRequest` (from `createSpecialistTools`; for direct turns `ChatOptions.sendApprovalRequest`, else `createChatApprover(chatId)`). pg-boss background specialists (native and pi) ask their origin chat via `createChatApprover` (`src/lib/channels/approval.ts`). Cron/heartbeat runs and workflow agent nodes auto-approve.

### Memory and events

- RAG: dense + sparse (BM25) hybrid search fused with RRF (`memory/retrieve.ts`, `memory/ingest.ts`). Memories are scoped (`private` for DMs, `shared` for groups) and agent-tagged.
- `logBus` (EventEmitter) streams step/specialist/workflow events over SSE. pg-boss queues async jobs. Editing `config.yaml` triggers hot reconfiguration.

## Key modules and invariants

| File | Notes |
|------|-------|
| `agent/llm-executor.ts` | Core chat loop: cache-friendly prompts, fallback chains, aux routing, RAG injection. tsx can't load it, so tests check it as source invariants |
| `agent/specialist.ts` | Spawns specialists (sync, or async via pg-boss) |
| `agent/turn-parts.ts` | `buildTurnParts` stores tool calls/results on the assistant row (`conversations.parts`); `toModelMessages` replays them. Replay capped (#85): 2,000 chars per output, 20,000 per turn, newest first; cuts are marked and call/result pairs stay matched. Stored row keeps everything |
| `agent/harness-steps.ts` | `HarnessStepFolder`: one `StepEvent` per model call; retry/compaction/failure/abort become marker steps (finishReason `retry`/`compaction`/`error`/`aborted`); gate decisions land on the tool call as `permission` |
| `db/pg-safe.ts` | `pgSafe`/`pgSafeText` replace NUL bytes and unpaired surrogates with U+FFFD before every `conversations`/`conversation_steps` write; `truncateText` never splits a surrogate pair (#83) |
| `db/conversation.ts` | `addMessage` never throws: on failure retries without `parts`, then emits an error step (`Reply could not be stored: …`) so the turn shows **failed** (#84) |
| `telegram/scheduled-task.ts` | `runScheduledTask`: scheduled tasks, heartbeats, pg-boss background specialists |
| `telegram/scheduled-resume.ts` | Step-limit resume (#86): `resume_run_<runId>_<n>` queues a one-off run of the same task/agent/chat replaying the stopped turn with `n` steps (`TaskData.resumeOfRunId`/`maxSteps`). Heartbeats get **Close task** only; legacy `resume_main_*` buttons say resume isn't available |
| `email/imap-manager.ts`, `email/process-inbound.ts` | IMAP IDLE, resync; inbound dedup and threading |
| `tools/built-in.ts` | Resolves which built-in tool families are injected per request |
| `tools/registry.ts` | MCP client registry; also registers Playwright MCP (`@playwright/mcp`, stdio) when `tools.browser.enabled` |
| `tools/loop-breaker.ts` | Blocks repeated identical tool calls, per execution context |
| `workflow/engine.ts` | Stateless workflow engine. Node types: `agent`, `parallel`, `condition` (JS expression), `hitl`, `input`, `output` |
| `soul/soul-manager.ts` | AGENT.md parsing, snapshots, hot-reload |
| `config/config-manager.ts` | config/secrets hot-reload; `config/secret-refs.ts` resolves `${secrets.…}` |
| `scheduler/index.ts` | pg-boss singleton and scheduling API |

### Harness (`src/lib/harness/`)

The pi adapter is vendored from edkief/ralph; keep each file's provenance header and stay close to Ralph so fixes flow both ways.

| File | Notes |
|------|-------|
| `events.ts` | Harness-neutral events and `HarnessError` |
| `pi/rpc.ts` | `PiProcess`: JSONL client for `pi --mode rpc`; child tied to OpenTalon's lifetime (`process-guard.ts`) |
| `pi/translate.ts` | pi frames → harness events (pi 1.1 `agent_settled`, retry, overflow compaction) |
| `pi/session.ts` | `PiSession`: one process per session; cancels extension dialogs |
| `pi/task.ts` | `runPiTask`: one task per pi process; system prompt via `--append-system-prompt` file, first model pi accepts, summed usage, `AbortError` on cancel |
| `pi/prompt.ts` | Specialist prompt (Role / Soul / Context from Supervisor / Result Contract from `agent/result-contract.ts`) and direct-turn prompt (Role / Soul / Core Memory / Context / Recalled notes / Conversation; no Result Contract) |
| `pi/gate.ts` | `extensions/pi/opentalon-gate.mjs` (`--extension`) sends each tool call as an `opentalon:gate` dialog answered by a `GateHandler`. Refuses a pi lacking `opentalon-gate` in `get_commands`. **Fails closed**: no handler blocks every call |
| `pi/version.ts` | `PI_VERSION_RANGE` and `checkPi()`; `pi/startup.ts` warns at boot if enabled but unusable |
| `pi/provider-env.ts` | Provider → pi key env var (google is `GEMINI_API_KEY`); custom `secrets.providers[]` unsupported |

Tests: `test:pi-translate`, `test:pi-session`, `test:pi-task`, `test:pi-gate`, `test:agent-executor`, `test:harness-steps`, `test:harness-chat` (fixtures and `fake-pi.mjs` in `scripts/fixtures/pi/`). Real pi smoke test: `pnpm pi:smoke "<prompt>"`. New pi version: re-record fixtures (`scripts/fixtures/pi/README.md`) and widen `PI_VERSION_RANGE`.

Other tests: `test:scheduled-resume` (pure fakes), `test:turn-data` (pure), `test:turn-data-db` (needs a migrated Postgres in `DATABASE_URL`, else skips).

## Configuration

YAML in the workspace dir (`config.yaml`, `secrets.yaml`). Non-obvious keys:

```yaml
llm:
  model: "anthropic/claude-sonnet-4-5"
  fallbacks: [...]
  maxSteps: 10
  pricing:                          # USD per 1M tokens, keyed "provider/model"
    "anthropic/claude-sonnet-4-5": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 }
    # reasoning billed as output; cacheRead/cacheWrite default to input rate
tools:
  allowlist: "*"
  dangerousTools: ["run_shell"]     # need approval (MCP tools; pi write/edit as write_file/str_replace_based_edit). Built-in run_shell always asks unless allowlisted
  commandTimeoutMs: 30000           # run_shell foreground kill
  maxWaitMs: 600000                 # max single wait_for
  agentWorkspace: "/workspace"
  skillsDir: "/workspace/skills"
  loopBreaker: { enabled: true, repeats: 3, window: 6, requireIdenticalOutput: true, outputHashChars: 0 }
  browser: { enabled: false }
  mcpServers: [...]
harness:
  pi:
    enabled: false                  # required for executor: pi; startup check is warn-only
    binary: "pi"
    thinking: medium                # off|minimal|low|medium|high|xhigh
    trustProject: false             # true passes --approve (loads the checkout's .pi extensions)
    sessionDir: ...                 # default <agentWorkspace>/.harness/pi/sessions
```

**Secret references**: `config.yaml` is plaintext and dashboard-visible, so put credentials in `secrets.yaml` (user-defined ones under `custom:`) and reference them as `${secrets.custom.mcp.myservice.token}`. Resolved in memory at load; the file keeps the reference. An exact single reference keeps the secret's type; embedded references are stringified; unresolved ones stay verbatim and are logged.

## Built-in tools

| Family | Tools |
|--------|-------|
| Terminal | `run_shell` (returns when the shell exits, so `cmd > log 2>&1 &` doesn't block), `wait_for` (pid exit / file / log match, up to `maxWaitMs`; timeouts don't count toward the loop breaker), `read_file`, `str_replace_based_edit`, `fuzzy_patch` |
| Skills | `skill_list`, `skill_get`, `skill_save`, `skill_add_script`, `skill_delete` |
| Web | `web_search` (Brave), `web_fetch` |
| Memory | `memory_recall`, `memory_read`, `memory_append`, `memory_delete` |
| Scheduling | `schedule_task`, `schedule_once`, `list_scheduled_tasks`, `delete_scheduled_task`, `enable_/disable_scheduled_task`, `execute_scheduled_task_now` |
| Todo | `todo_create`, `todo_add` (strings or `{text}`), `todo_update`, `todo_clear` |
| Other | `request_secret`, `resume_specialist`, `request_guidance` |

## API notes

- `/api/specialist/*`: the Orchestration page prefers stored status over a stale live `running` entry and re-fetches on stream reconnect (#87).
- `/api/turn/cancel`: graceful or force cancel of a chat's running turn.
- `/api/metrics`: counts `conversations` plus `conversation_steps` with phase `specialist` (native and pi); pg-boss background specialists aren't counted yet.

## Design decisions

- Drizzle over Prisma; pg-boss over Redis; YAML config; MCP for tools; SSE over WebSockets.
- `/workspace` is a persistent volume that survives pod restarts.
- **Restart = dead jobs.** Jobs run in-process. At startup `failInterruptedJobs` (`src/lib/db/jobs.ts`) fails any job left `running` (or `pending` but no longer in pg-boss), errors its `specialist_runs` row and lets its batch dispatch. Assumes one worker process per deployment. The leak reaper (`scheduler/leak-reaper.ts`) runs every 10 min and fails any `running` job missing from `cancellationRegistry` on two consecutive sweeps.
