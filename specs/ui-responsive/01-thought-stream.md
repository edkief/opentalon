# 01 — Thought Stream (Dashboard Home)

File: `src/app/dashboard/page.tsx` · Severity: **High**

The default landing screen: a live SSE stream of conversation + agent steps with a
chat selector, four toolbar buttons, and a sticky chat composer at the bottom.

## Current state

- Root: `flex flex-col h-full gap-3`.
- Header: `flex items-center justify-between gap-2 flex-wrap` containing:
  1. Title + live-status dot + "Loading…".
  2. Chat `<select>` with a `Chat:` label.
  3. A `flex gap-2` group of **four** buttons: Verbose, Expand/Collapse tools,
     Refresh, Clear.
- Stream: `react-virtuoso` list, `flex-1 min-h-0`.
- Composer: `border rounded-lg p-3 flex gap-2 items-end` with a `Textarea`
  (`min-h-[60px] max-h-40`) + Send button.
- Rows (`HistoryRow`, `StepRow`) use `InspectTurnLink` revealed on
  `group-hover:opacity-100` — invisible on touch (see P-conventions).

## Responsive issues

1. **P1 header overflow.** Four buttons + a labelled select + title. `flex-wrap`
   keeps it from clipping but on a 360px phone it wraps into 3–4 cramped rows that
   push the stream down and look chaotic.
2. **Hover-only inspect link.** `InspectTurnLink` is `opacity-0
   group-hover:opacity-100` — on phones there is no way to open the turn deep-dive.
3. **Dense `font-mono text-xs` rows** with many inline badges/timestamps wrap
   awkwardly; the `ml-auto` timestamps collide with the inspect icon < 360px.
4. **Composer** is fine, but the `Textarea` + Send sit side by side; at very narrow
   widths the Send button squeezes the textarea. Acceptable, low priority.

## Build tasks

1. **Restructure the header into two tiers on phones:**
   - Tier 1 (always): title + status dot + chat `<select>` (`<select>` becomes
     `flex-1 min-w-0` so it takes the row; drop the `Chat:` label on phones or keep
     as `sr-only`).
   - Tier 2 (actions): move Verbose, Expand/Collapse tools, Clear into a `⋯`
     overflow `DropdownMenu` shown `sm:hidden`; keep Refresh as a visible icon
     button. On `sm+` keep the current inline button row.
2. **Make the inspect link touch-visible:** change `InspectTurnLink` to
   `opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100`.
   Ensure the tap target is ≥ 32px (wrap icon in `p-1`).
3. **Row layout at < 360px:** allow the meta line
   (`flex items-center gap-2 mb-1`) to `flex-wrap`; move the timestamp to its own
   wrapped line instead of `ml-auto` when wrapped (it already has `flex-wrap` on the
   tool-group row — apply the same to `HistoryRow`/`StepRow` meta rows).
4. **Composer:** on phones, stack is unnecessary; keep side-by-side but set
   `Textarea` `min-w-0` and Send `shrink-0` (Send already `shrink-0`; add `min-w-0`
   to Textarea).

## Acceptance criteria

- At 360px: header occupies ≤ 2 visual rows; chat selector is tappable and full
  width; primary actions reachable (overflow menu or visible).
- The turn "Inspect" affordance is visible and tappable without hover.
- Sending a message and receiving the streamed reply works with the on-screen
  keyboard open (composer stays pinned, stream scrolls).
- No horizontal page scroll at 360/390/414px.
