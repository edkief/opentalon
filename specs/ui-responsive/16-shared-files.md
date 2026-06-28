# 16 — Shared Files

File: `src/app/dashboard/shared-files/page.tsx` · Severity: **Medium**

Table of agent-shared file links (slug, path, type, created, expires) with open +
delete actions and pagination.

## Current state

- Root: `flex flex-col gap-6 p-6 max-w-5xl`.
- Header: `flex items-center justify-between` — icon + title + subtitle / Refresh.
- **Table** (`@/components/ui/table`): Slug, File (path, `max-w-xs truncate`), Type,
  Created, Expires, actions (open ↗ + delete 🗑, `h-7 w-7` ghost icon buttons).
  Expired rows are `opacity-50`.
- Pagination footer: range text + Prev/Next icon buttons.

## Responsive issues

1. **P4 — double padding.** Page adds `p-6` on top of `<main>`'s padding; plus
   `max-w-5xl` (no `mx-auto`, so left-aligned). Wastes width on phones.
2. **P3 — table doesn't reflow.** Six columns; on a 360px phone the path/created/
   expires columns overflow horizontally. `path` truncates but the row as a whole
   scrolls sideways.
3. **`h-7 w-7` (28px) icon actions** are below the 44px touch guideline and sit at
   the far right of a horizontally-scrolled row.

## Build tasks

1. **Padding (P4):** drop `p-6`; keep `max-w-5xl` (optionally add `mx-auto` to
   center on desktop). Rely on `<main>` padding.
2. **Responsive rows (P3):**
   - `md+`: keep the table.
   - `< md`: `md:hidden` card per share:
     - Title: `slug` (mono) + expired badge if applicable.
     - Lines: `File:` path (`break-all`), `Type:`, `Created:`, `Expires:`.
     - Actions: Open (↗, if not expired) + Delete (🗑) as ≥ 36px buttons.
   - Drive both from the same `shares` array + `formatDate`/`isExpired` helpers.
3. **Touch targets:** in the mobile cards use `h-9 w-9` (or labelled buttons) for
   open/delete.
4. Pagination footer is fine (`justify-between`, small).

## Acceptance criteria

- At 360px: full width used; each share readable as a card with slug, path, type,
  dates, and open/delete actions; no horizontal scroll.
- Open and delete work via touch; pagination works.
- Desktop table unchanged.
