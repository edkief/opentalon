# Cancel Button Bug — Test Plan

## Bug Description
On the dashboard orchestration page, a "Cancel" button appears for running background
jobs. Clicking it has no effect — the job continues running and the button stays visible
instead of being hidden.

## Root Causes Fixed

### 1. No SSE event emitted on cancel (frontend never updated)
When `schedulerService.cancelSpecialist()` cancelled a job in-process, it called
`cancellationRegistry.cancel()` but never emitted a `cancelled` SpecialistEvent
to the log-bus. The dashboard subscribes to SSE for live updates, so without this
event the frontend state was never updated.

**Fix:** Added `emitSpecialist({ kind: 'cancelled', ... })` in both:
- `schedulerService.cancelSpecialist()` — direct (bot-process) path
- The `op === 'cancel'` pg-boss handler — forwarded path

### 2. Cancelled state not handled in frontend applyEvent()
The `applyEvent()` function only handled `spawn | complete | error | max_steps`
event kinds. `cancelled` events fell through without updating the record's
status, so the card never transitioned from `running`.

**Fix:** Added `cancelled` branch to `applyEvent()` in `orchestration/page.tsx`
and added `cancelled` to the `SpecialistRecord.status` union type.

### 3. Spurious 'error' event emitted when AbortError propagates
When `executeSpecialist()` was cancelled via AbortController, the error's
try/catch block caught it and emitted a `kind: 'error'` event — overwriting
the 'cancelled' state that the scheduler had already emitted.

**Fix:** Added `if (err.name === 'AbortError') throw err` guards in all three
catch blocks in `specialist.ts` (`executeSpecialist`, top-level `spawnSpecialist`,
and inline background promise). The scheduler emits the 'cancelled' event; the
specialist no longer overwrites it.

---

## Test Scenarios

### TC-1: Cancel button disappears after cancellation (in-process path)
1. Open dashboard → Orchestration page
2. Trigger a background specialist job (e.g. via `/spawn` with `background: true`)
3. Confirm the job appears with a "Cancel" button
4. Click "Cancel" → confirm the button changes to "Cancelling…" briefly
5. Confirm the card transitions to "cancelled" status and the Cancel button is gone
6. Refresh the page — confirm "cancelled" state persists (from job history)

### TC-2: Cancel button disappears after cancellation (pg-boss forwarded path)
1. Same as TC-1 but trigger a depth-0 background specialist (dispatched via pg-boss)
2. Confirm the cancel flow still works end-to-end (bot receives forwarded message)

### TC-3: Dashboard badge and label for cancelled specialists
1. Cancel a running specialist
2. Confirm the badge shows "cancelled" (red destructive badge) instead of "running…"
3. Confirm the status label reads "cancelled" (not "error" or "complete")

### TC-4: Inline background specialists (depth=1) are also cancellable
1. Spawn a depth-0 background specialist with sub-agent permissions
2. Have that specialist spawn a depth-1 (inline) background specialist
3. Cancel the depth-1 specialist from the dashboard
4. Confirm it transitions to "cancelled" with no spurious "error" event

### TC-5: Job history survives page refresh
1. Cancel a specialist
2. Refresh the orchestration page
3. Confirm the specialist still shows "cancelled" status (loaded from `/api/specialist/history`)

### TC-6: Non-cancelled specialists unaffected
1. Run a specialist to completion naturally
2. Confirm it shows "complete" status with no cancel button
3. Run a specialist until it hits max steps
4. Confirm it shows "max steps" status with resume buttons (not cancel)

---

## Files Changed
- `src/lib/agent/log-bus.ts` — added `'cancelled'` to SpecialistEvent.kind union
- `src/lib/scheduler/index.ts` — emit 'cancelled' event in both direct and forwarded cancel paths
- `src/lib/agent/specialist.ts` — re-throw AbortError to avoid spurious 'error' events
- `src/app/dashboard/orchestration/page.tsx` — handle 'cancelled' event in applyEvent(),
  add 'cancelled' to status union, render badge/label for cancelled state
