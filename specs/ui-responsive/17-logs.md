# 17 — System Logs

File: `src/app/dashboard/logs/page.tsx` · Severity: **Low**

Live SSE log stream (`react-virtuoso`) with level filters, component filter, text
search, pause/auto-scroll/clear. Includes special TODO log rows.

## Current state

- Root: `flex flex-col h-full gap-3 min-h-0`.
- Header: `flex items-center justify-between gap-2` — title + connection dot +
  paused state / Pause-Resume, auto-scroll toggle, Clear (icon buttons). Fits.
- **Filter bar:** `flex flex-wrap items-center gap-2` — a segmented level-filter
  control (ALL + 5 levels with counts), a component `<select>`, a text `<input>`
  (`flex-1 min-w-[160px]`), and an "N / N entries" counter. `flex-wrap` already
  handles narrow widths.
- Stream: `flex-1 min-h-0` Virtuoso of `LogRow` / `TodoLogRow`.
- `LogRow`: `flex items-start gap-2 px-3 py-1 font-mono text-xs` — fixed-width
  timestamp (`w-28`), level badge (`w-12`), component (`max-w-[120px] truncate`),
  message (`flex-1 whitespace-pre-wrap break-all`).

## Responsive issues

1. **Filter bar** is busy but already `flex-wrap`; on phones it stacks into ~2–3
   rows. The segmented level control (6 buttons with counts) is the widest element
   — it does not wrap internally and may slightly exceed 360px. Minor.
2. **Log rows** dedicate `w-28` (112px) to a millisecond timestamp + `w-12` badge +
   `max-w-[120px]` component before the message — on a 360px phone that leaves
   little room for the actual message (it wraps under, which is OK via `flex-1`
   `break-all`, but the layout is cramped).
3. `TodoLogRow` expanded items use `ml-[168px]` indent — off-screen on phones.

## Build tasks

1. **Level filter on phones:** allow the segmented control to shrink — drop the
   count numbers below `sm` (`<span className="hidden sm:inline">`) or let it
   scroll (`overflow-x-auto`). Keep ALL + level buttons tappable.
2. **Log row density:** below `sm`, shorten the timestamp to `HH:MM:SS` (drop `.ms`)
   and reduce the component column (`max-w-[80px]`) so the message gets more room;
   or stack the meta (ts + level + component) on one line and the message on the
   next at `< sm`.
3. **TodoLogRow indent:** replace `ml-[168px]` with a smaller indent on phones
   (`ml-6 sm:ml-[168px]`).
4. Header is fine.

## Acceptance criteria

- At 360px: filters reachable (level/component/search), stream readable with
  messages getting usable width, no page-level horizontal scroll.
- Pause/resume, auto-scroll, clear, and TODO row expansion work on a phone.
