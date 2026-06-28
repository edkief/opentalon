# 20 — Dashboard Login

File: `src/app/dashboard/login/page.tsx` · Severity: **Done (no work)**

Single centered token-entry form. Rendered outside the dashboard shell.

## Current state

- Root: `min-h-screen flex flex-col items-center justify-center bg-gradient … px-4`.
- Card: `w-full max-w-sm space-y-6` — logo, title/subtitle, a bordered form with a
  full-width password `<input>`, error text, and a full-width submit button.

## Responsive issues

- None. `max-w-sm` + `w-full` + `px-4` is a textbook responsive centered form.
  Inputs and button are full-width; touch targets adequate.

## Build tasks

1. **No changes.** Optionally verify the logo (`h-16`) + form fit above the fold on
   the shortest target phone with the keyboard open (it will scroll if not — fine).

## Acceptance criteria

- Login works and looks correct at 360px (already satisfied).
