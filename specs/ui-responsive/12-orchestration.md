# 12 — Orchestration Tree

File: `src/app/dashboard/orchestration/page.tsx` · Severity: **Medium**

Live tree of specialist (sub-agent) runs with search, pagination, per-card
expand/cancel/resume, and a Restart-Services modal.

## Current state

- Root: `flex flex-col h-full gap-4`.
- Header: a single `flex items-center gap-3 flex-wrap` row containing **many**
  items: title, live dot, "N running" badge, a search `Input`
  (`flex-1 min-w-[160px] max-w-xs`), "N specialist(s)" count, **Clear**, **Restart
  Services**.
- Body: `flex-1 overflow-auto` list of `SpecialistCard`s. Nested children are
  rendered via `renderTree` with `style={{ marginLeft: depth*20 }}`.
- `SpecialistCard`: `font-mono text-xs`, header zone `flex-wrap`, metadata footer
  `flex-wrap`, expandable Context/Steps/Result `<pre>` blocks, Cancel/Resume
  buttons. Uses `window.confirm`/`alert` for cancel/resume.

## Responsive issues

1. **P1 — overcrowded header.** Seven items in one row; even with `flex-wrap` it
   wraps into a tall, noisy block on phones (search input + two buttons + counts).
2. **P6 — `marginLeft: depth*20` indent.** Deep specialist trees push cards off the
   right edge on a 360px phone, causing horizontal scroll / clipped content.
3. The cards themselves are already `flex-wrap` heavy and degrade OK; `<pre>` blocks
   use `break-all`.
4. `alert()`/`confirm()` are native and work on mobile (acceptable, though a
   styled dialog would be nicer — out of scope).

## Build tasks

1. **Header (P1):** split into two rows on phones:
   - Row 1: title + live dot + "N running" + count.
   - Row 2: full-width search `Input` (drop `max-w-xs` on phones → `w-full`), with
     Clear + Restart moved into a `⋯` overflow menu `< sm` (Restart Services is
     rare/destructive — fine to hide behind overflow).
2. **Indent cap (P6):** replace `depth*20` with
   `Math.min(depth, 3) * 12` on phones (or always), and wrap the tree container in
   `overflow-x-auto` so deeper nesting scrolls within the list region rather than
   the whole page. Alternatively, below `md` render depth as a small "sub-agent
   • L{depth}" badge (already have a `sub-agent` badge) and drop the margin
   entirely.
3. Verify Cancel/Resume buttons keep ≥ 32px height on phones (currently
   `h-6 text-[10px]` — bump to `h-8` on touch).

## Acceptance criteria

- At 360px: header is compact (≤ 2 rows); search is full-width and usable.
- Nested specialist cards remain on-screen (no whole-page horizontal scroll);
  deep nesting is legible.
- Expand/Cancel/Resume usable via touch.
- Desktop unchanged.
