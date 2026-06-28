# 02 — Core Memory

File: `src/app/dashboard/memory/page.tsx` · Severity: **Low**

Single full-height MDEditor for the agent's always-in-prompt scratchpad
(`/api/agent-memory`). Sibling of Identity (03) — identical structure.

## Current state

- `flex flex-col h-full gap-4`.
- Header: `flex items-center justify-between` — title + subtitle on the left,
  Saved/Failed status + **Save** button on the right.
- Body: `flex-1 overflow-auto` wrapping `MDEditor` with `height="100%"`,
  `preview="edit"`.

## Responsive issues

1. **Header** is title + one button — fits phones fine. The only risk is the
   two-line title/subtitle block plus the Save button on a very narrow screen;
   `justify-between` keeps Save pinned right, acceptable.
2. **MDEditor toolbar** wraps poorly below ~340px (the markdown toolbar has many
   icons). Minor.
3. No P-pattern violations.

## Build tasks

1. Add `gap-2 flex-wrap` to the header row for safety (lets the status text wrap
   under the title rather than crushing Save).
2. Ensure the editor container keeps a usable height with the on-screen keyboard
   open: confirm `flex-1 overflow-auto` parent + `min-h-[50vh]` fallback so the
   editor never collapses to near-zero on short viewports.
3. No other changes — this screen is essentially responsive already.

## Acceptance criteria

- Editor is usable and scrollable at 360px; Save always reachable.
- No horizontal page scroll.
