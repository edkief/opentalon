# 19 — Onboarding

File: `src/app/dashboard/onboarding/page.tsx` · Severity: **Low**

Setup wizard: landing → expert (template) or guided (4-step) flows. Card-based,
centered, already mobile-friendly.

## Current state

- Landing: `max-w-2xl mx-auto space-y-8` — Skip card, Initial Setup card, status
  text. Cards (`@/components/ui/card`) are full-width and stack. Good.
- Expert mode: `max-w-2xl mx-auto space-y-6` — header (`flex justify-between`
  title + Back), a card with two `<pre>` config samples (`overflow-x-auto`).
- Guided mode: `max-w-xl mx-auto space-y-6` — header + a 4-segment progress bar +
  one card per step (provider select, API key, telegram, dashboard pw, review).
  Step nav buttons use `flex gap-4` with `flex-1` Back/Continue. Good.

## Responsive issues

1. Essentially responsive already — single centered column, full-width cards,
   `flex-1` buttons, `<pre>` blocks scroll internally.
2. **`<pre>` config samples** (expert mode) use `overflow-x-auto` — long lines like
   the bot-token example scroll horizontally inside the block. Fine.
3. Inputs are full-width (`Input` defaults). Selects are `w-full`. Good.

## Build tasks

1. **No structural changes required.** Verify at 360px:
   - Landing/expert/guided columns fit with `<main>` padding (the `max-w-*
     mx-auto` adds no padding on phones).
   - Progress bar (`flex gap-2`, 4 segments) renders without overflow.
   - `<pre>` samples scroll internally, not the page.
2. (Optional) Wrap the page content in a `min-h-full flex items-start justify-center`
   so short steps are nicely centered rather than top-stuck — cosmetic.

## Acceptance criteria

- All three modes complete-able on a 360px phone; no horizontal page scroll;
  buttons and inputs full-width and tappable.
