# 03 — Identity Editor

File: `src/app/dashboard/identity/page.tsx` · Severity: **Low**

Single MDEditor for the agent identity card (`/api/identity`). Structurally
identical to Core Memory (02).

## Current state

- `flex flex-col h-full gap-4`; header `flex items-center justify-between`
  (title + subtitle / Saved-Failed status + Save); body `flex-1 overflow-auto`
  with full-height `MDEditor`.

## Responsive issues

1. Same minor header crowding as Core Memory — one button, fits phones.
2. MDEditor markdown toolbar wraps below ~340px.

## Build tasks

1. Add `gap-2 flex-wrap` to the header row.
2. Guarantee a minimum editor height on short viewports (`min-h-[50vh]` on the
   editor wrapper) so the keyboard doesn't collapse it.
3. Apply the same fix to Core Memory (02) so the two stay identical — consider
   extracting a shared `<MarkdownDocEditor title subtitle apiPath />` component
   used by both Identity and Core Memory to avoid drift.

## Acceptance criteria

- Editor usable and Save reachable at 360px; no horizontal scroll.
