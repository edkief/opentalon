# 08 — Skills

File: `src/app/dashboard/skills/page.tsx` · Severity: **Medium**

Two-pane skill browser: a left tree (skills → files) and a Monaco editor for the
selected file. New-skill and delete-skill dialogs.

## Current state

- Root: `flex flex-col md:flex-row h-full gap-4` — **already responsive-aware**.
- Left `aside`: `w-full md:w-60 … border-b md:border-b-0 md:border-r …
  max-h-40 md:max-h-none overflow-y-auto` — on phones it becomes a short
  (160px) horizontally-full, vertically-scrolling panel above the editor. Good.
- Tree uses `FileTreeNode` with `style={{ paddingLeft: depth*12 + 8 }}`.
- Right: editor column `flex-1 flex flex-col min-w-0`; header with filename +
  Unsaved + Save; `MonacoEditor` in `min-h-[300px] md:min-h-[400px]`.
- Skill rows reveal a delete button on `group-hover:opacity-100`.

## Responsive issues

1. **Hover-only delete.** `opacity-0 group-hover:opacity-100` on the per-skill
   trash button — invisible/unusable on touch. (Delete is still reachable via… it
   isn't, on touch.)
2. **P6 (minor) tree indent.** `paddingLeft: depth*12+8` is modest; deep skill
   trees could still push names off the 160px-tall mobile panel, but skills are
   shallow in practice. Low risk.
3. **`max-h-40` (160px) mobile skill panel** is quite short when a skill is
   expanded with many files — it scrolls, but finding a file means scrolling a
   tiny box. Consider a larger share or a collapsible section.

## Build tasks

1. **Touch-visible delete:** change the per-skill delete button to
   `opacity-100 sm:opacity-0 sm:group-hover:opacity-100`; ensure ≥ 32px tap area
   (`p-1.5`). Same for any other hover-only control here.
2. **Mobile tree height:** bump the phone panel to `max-h-56` (or make it a
   collapsible `<details>`-style section so the editor can reclaim space). Keep
   `md:max-h-none`.
3. **Empty/selection states** already good ("Select a skill, then choose a file").
4. Keep New/Delete dialogs (already `sm:max-w-*`).

## Acceptance criteria

- A skill can be selected, a file opened/edited/saved, and a skill deleted entirely
  on a 360px phone (no hover required).
- No horizontal page scroll; desktop two-pane layout unchanged.
