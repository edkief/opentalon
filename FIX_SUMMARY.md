# Fix Summary: Background Specialist Awaiting Issue

## Issue Description

When the main agent (depth-0, user-facing) spawns background specialists using `spawn_specialist` with `background: true`, it was returning its response immediately without waiting for the specialist jobs to complete. This caused multiple fragmented responses instead of one consolidated reply.

**Impact**: Users receive incomplete responses followed by separate specialist results, leading to a disjointed experience.

## Root Cause Analysis

### Architecture Overview

The opentalon agent system uses a multi-level architecture:

1. **Main Agent (depth-0)**: User-facing agent in `LLMExecutor.chat()`. Receives user messages and generates responses.
2. **Background Specialists (depth-0, background)**: Spawned via `spawn_specialist(background: true)`. Dispatched to pg-boss and run asynchronously.
3. **Nested Specialists (depth ≥ 1)**: Specialists spawned within other specialists. Have inline execution with `await_specialists` support.

### The Bug

In `src/lib/agent/llm-executor.ts`, the `tryGenerate()` method completes and returns immediately:

```typescript
// BEFORE (buggy):
return { type: 'text', text: maybeStrip(result.text), result, provider: resolved.modelString };
```

When the main agent calls `spawn_specialist(background: true)`:
1. The job is dispatched to pg-boss queue (`ONE_OFF_QUEUE`) and returns immediately
2. The main agent's `generateText()` loop ends (either step limit reached or natural completion)
3. The agent sends its response **without waiting** for specialist jobs

### Why Nested Specialists Worked

The nested specialist code (depth ≥ 1) had `await_specialists` implemented in `src/lib/agent/specialist.ts`:

```typescript
// In createSpecialistTools(), when currentSpecialistId is set:
// - Specialists run inline (not via pg-boss)
// - Results stored in `inFlight` Map
// - await_specialists reads from inFlight
```

But the depth-0 (main/user-facing) agent path had **no equivalent** waiting mechanism.

## Fix Implementation

### Changes Made

**File**: `src/lib/agent/llm-executor.ts`

Added two new methods:

1. **`awaitPendingSpecialists(chatId, maxWaitMs = 120_000)`**
   - Polls the jobs table every 2 seconds
   - Waits for all pending/running jobs for the chatId to complete
   - Returns consolidated results from completed specialists
   - Times out after `maxWaitMs` (default 2 minutes)
   - Safe fallback: returns empty string on timeout

2. **`finalizeResponseWithSpecialists(baseText, chatId, showThinking)`**
   - Wraps the LLM response with specialist results
   - Called before every return in `tryGenerate()`
   - Respects `showThinking` config

### Applied to All Return Paths

1. **Normal exit** (step completion): `await this.finalizeResponseWithSpecialists(result.text, chatId, showThinking)`
2. **Max steps hit**: `await this.finalizeResponseWithSpecialists(summary, chatId, showThinking)`
3. **Token limit hit**: `await this.finalizeResponseWithSpecialists(notice, chatId, showThinking)`

### Key Design Decisions

1. **Non-blocking polling**: Uses 2-second intervals instead of blocking. This allows other operations to proceed.

2. **Consolidated output format**: Results are formatted as:
   ```
   ## Specialist Results
   
   [Task Label 1]
   ...result...
   
   [Task Label 2]
   ...result...
   ```

3. **Truncation safety**: Results over 3000 chars are truncated with `...` to prevent huge responses.

4. **Fallback on timeout**: If specialists don't complete in 120s, the main response is still returned. This ensures the user isn't blocked indefinitely.

5. **Handles N specialists**: Works with any number of concurrent background jobs (1, 2, 3, ... N).

## PR Details

- **Branch**: `fix/await-background-specialists`
- **PR**: https://github.com/edkief/opentalon/pull/3
- **Commit**: `f2ae22b9acc2b179b9b1e4e6f77a978cc4e4bd3f`
- **Files changed**: 1 (`src/lib/agent/llm-executor.ts`)
- **Lines added/removed**: +76/-3

## Testing Notes

- No existing test suite found in the project
- TypeScript compilation passes (no new type errors introduced)
- The fix uses existing job status infrastructure (`getJobsByChatId`)
- Manual testing recommended to verify:
  - Single specialist spawn and wait
  - Multiple parallel specialist spawns
  - Specialist timeout behavior
  - Token limit edge case

## Related Code Locations

| File | Purpose |
|------|---------|
| `src/lib/agent/llm-executor.ts` | Main agent execution - FIXED |
| `src/lib/agent/specialist.ts` | Specialist spawning and awaiting (nested) |
| `src/lib/scheduler/index.ts` | pg-boss job scheduling |
| `src/lib/db/jobs.ts` | Job status management |
| `src/lib/telegram/handlers.ts` | Telegram bot entry point |

## Future Considerations

1. **Event-based waiting**: Replace polling with event-based notification when specialists complete (would require pub/sub or SSE infrastructure).

2. **Streaming results**: Could stream specialist results as they complete rather than waiting for all.

3. **Configurable timeout**: Make `maxWaitMs` configurable via `config.yaml`.

4. **Background-aware UI**: The non-blocking nature for the UI is preserved - specialists still run in background and can be polled separately. The fix only ensures the final response is consolidated.
