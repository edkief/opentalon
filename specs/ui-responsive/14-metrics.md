# 14 — Metrics

File: `src/app/dashboard/metrics/page.tsx` · Severity: **Low**

Analytics dashboard: KPI cards, an activity heatmap, and several Recharts charts
(trend, pies, bars). Already built with responsive grids.

## Current state — mostly good

- Root: `flex flex-col gap-6 overflow-auto pb-6`.
- Header: `flex items-center justify-between … flex-wrap gap-2` — title + period
  toggle (7/30/90d) + Refresh icon button. Fine.
- KPI cards: `grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3` — 2-up on
  phones. Good.
- Charts wrapped in `ChartCard` (`overflow-x-auto`) + Recharts
  `ResponsiveContainer width="100%"`. Trend/agent/model grids use
  `grid-cols-1 lg:grid-cols-(2|3)` so they stack on phones. Good.
- Activity heatmap is fixed-cell (12px) inside `overflow-x-auto` — scrolls
  horizontally on phones by design (GitHub-style). Acceptable.

## Responsive issues

1. **KPI value font** `text-2xl` in a 2-col grid at 360px: a value like "1.2M" plus
   a long label ("Success Rate") can get tight but `truncate` on the label handles
   it. Verify no clipping.
2. **Heatmap** requires horizontal scroll on phones — expected, but make sure the
   scroll is discoverable (it's inside `overflow-x-auto`). Low priority.
3. Pie chart legends (`fontSize: 10`) can crowd at narrow widths but Recharts
   reflows. Acceptable.

## Build tasks

1. **No structural changes required.** Verify at 360px:
   - KPI grid: 2 columns, no value/label clipping (tighten to `text-xl` on phones
     if needed: `text-xl sm:text-2xl`).
   - Each chart card fits within viewport width (no page-level horizontal scroll;
     only the heatmap scrolls internally).
2. (Optional) Add a subtle scroll hint/shadow on the heatmap container so phone
   users know it scrolls.

## Acceptance criteria

- At 360px: KPI cards 2-up and legible; all charts stack and render within the
  viewport; only the heatmap scrolls horizontally (internally); no page-level
  horizontal scroll.
