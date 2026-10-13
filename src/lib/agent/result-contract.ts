/**
 * The closing section of every specialist's system prompt, native or harness-backed (#68).
 * Kept on its own, free of runtime imports, so both prompts share one text and the
 * "## Result" marker `truncateSpecialistResult` (llm-executor.ts) keeps intact can't drift.
 */
export const SPECIALIST_RESULT_CONTRACT: readonly string[] = [
  '## Result Contract',
  'End your response with a "## Result" section (must be the last section) containing: ' +
    '(1) a concise summary of what you did and found, and ' +
    '(2) a list of any files/artifacts you produced or modified, with full paths. ' +
    'This section is never truncated when your result is merged back into the supervisor\'s ' +
    'conversation, so put everything the supervisor needs to act on your work inside it — ' +
    'earlier exploratory/working text may be cut if long.',
];
