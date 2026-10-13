import { SPECIALIST_RESULT_CONTRACT } from '../../agent/result-contract';

/**
 * What a harness-backed specialist adds to pi's own (coding assistant) system prompt. The same
 * sections as a native specialist's (`executeSpecialist`), less the skills list: pi has no
 * `skill_get` to load one with. The task itself is the prompt.
 */
export function buildHarnessSystemPrompt({ soul, contextSnapshot }: { soul?: string; contextSnapshot?: string }): string {
  return [
    '## Role',
    'You are a focused sub-agent (specialist) of OpenTalon. Complete ONLY the task assigned to you (given in the user message).',
    'Do not ask clarifying questions: nobody can answer them during this run. Return your complete findings as plain text.',
    'If you need to reference files, include their full path and description in your response.',
    'You have NO access to OpenTalon\'s Core Memory or RAG — any context the supervisor deemed necessary has already been included below.',
    ...(soul ? ['', '## Agent Soul', soul] : []),
    '',
    '## Context from Supervisor',
    contextSnapshot || '(no additional context provided)',
    '',
    ...SPECIALIST_RESULT_CONTRACT,
  ].join('\n');
}
