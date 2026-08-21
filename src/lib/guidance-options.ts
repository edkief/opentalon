/**
 * Shared shape for `request_guidance` options.
 *
 * An option has a short `label` (what a Telegram inline-keyboard button shows)
 * and a full `description` (what the message body enumerates). Agents may also
 * pass a plain string, which is treated as both label and description — that is
 * the pre-#40 behaviour and stays supported.
 */

export interface GuidanceOption {
  label: string;
  description: string;
}

export type GuidanceOptionInput = string | { label: string; description: string };

/**
 * Telegram rejects `InlineKeyboardButton.text` longer than 64 characters
 * (BUTTON_TEXT_INVALID), and clients visually truncate well before that.
 */
export const TELEGRAM_BUTTON_TEXT_LIMIT = 64;

/** Normalize the tool's loose input into `{label, description}` pairs. */
export function normalizeGuidanceOptions(
  options: GuidanceOptionInput[] | null | undefined,
): GuidanceOption[] | undefined {
  if (!options || options.length === 0) return undefined;
  return options.map((opt) => {
    if (typeof opt === 'string') return { label: opt, description: opt };
    // A missing/empty label falls back to the description so the button is
    // never blank (Telegram rejects empty button text).
    const description = opt.description ?? opt.label ?? '';
    const label = opt.label?.trim() ? opt.label : description;
    return { label, description };
  });
}

/** Rebuild options from the two parallel DB columns (`labels` may be null for legacy rows). */
export function guidanceOptionsFromRow(
  descriptions: string[] | null | undefined,
  labels: string[] | null | undefined,
): GuidanceOption[] | undefined {
  if (!descriptions || descriptions.length === 0) return undefined;
  return descriptions.map((description, i) => ({
    label: labels?.[i] ?? description,
    description,
  }));
}

/** Clamp a label to Telegram's button-text limit, keeping it visually intact. */
export function buttonText(label: string): string {
  return label.length > TELEGRAM_BUTTON_TEXT_LIMIT
    ? `${label.slice(0, TELEGRAM_BUTTON_TEXT_LIMIT - 1)}…`
    : label;
}

/**
 * Enumerate options as "N. label — description" lines for the message body,
 * where nothing is truncated. When label and description are identical (a
 * plain-string option) the label is dropped so the line doesn't read twice.
 */
export function formatGuidanceOptionList(options: GuidanceOption[]): string {
  return options
    .map((opt, i) =>
      opt.label === opt.description
        ? `${i + 1}. ${opt.description}`
        : `${i + 1}. ${opt.label} — ${opt.description}`,
    )
    .join('\n');
}
