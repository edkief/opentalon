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

/** The most of the conversation so far a direct turn hands pi; the oldest messages go first. */
export const HARNESS_TRANSCRIPT_LIMIT = 40_000;

export interface TranscriptMessage {
  role: string;
  content: string;
}

/**
 * The conversation before the current message, as pi reads it: one labelled block per message,
 * newest kept whole within `limit`, and a note when older ones were left out. pi starts afresh
 * every turn (#93), so this is all it knows of earlier turns.
 */
export function renderTranscript(messages: TranscriptMessage[], limit = HARNESS_TRANSCRIPT_LIMIT): string {
  const blocks: string[] = [];
  let used = 0;
  let dropped = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const { role, content } = messages[i];
    if (role !== 'user' && role !== 'assistant') continue;
    const text = content.trim();
    if (!text) continue;
    const block = `### ${role === 'user' ? 'User' : 'You'}\n${text}`;
    if (used + block.length > limit) {
      dropped = messages.slice(0, i + 1).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim()).length;
      break;
    }
    blocks.unshift(block);
    used += block.length + 2;
  }
  if (dropped > 0) blocks.unshift(`(${dropped} earlier message${dropped === 1 ? '' : 's'} left out)`);
  return blocks.join('\n\n');
}

export interface HarnessChatPromptParts {
  soul?: string;
  /** Core Memory (MEMORY.md), read-only for pi. */
  coreMemory?: string;
  /** What the channel tells the agent about where it is talking (chat id, workspace, ...). */
  context?: string;
  /** Notes RAG recalled for the current message. */
  recalledNotes?: string;
  /** renderTranscript() of the conversation before the current message. */
  transcript?: string;
}

/**
 * What a pi agent talked to directly (#93) adds to pi's own system prompt: it is the agent, in a
 * conversation, and its last message is the reply. No Result Contract: there is no supervisor to
 * report to. The current message itself is the prompt.
 */
export function buildHarnessChatPrompt({ soul, coreMemory, context, recalledNotes, transcript }: HarnessChatPromptParts): string {
  return [
    '## Role',
    'You are an OpenTalon agent, talking with the user directly. The prompt is their latest message.',
    'Do the work it asks for, then end with your reply to them: your last message is delivered to the user as it stands.',
    'Nobody can answer questions while you work. If the request is too unclear to act on, reply with your question instead of guessing.',
    'You do not have OpenTalon\'s own tools: you cannot save to memory, delegate to other agents, schedule tasks or keep a todo list.',
    ...(soul ? ['', '## Agent Soul', soul] : []),
    ...(coreMemory ? ['', '## Core Memory (read-only)', coreMemory] : []),
    ...(context ? ['', '## Context', context] : []),
    ...(recalledNotes ? ['', '## Recalled notes', recalledNotes] : []),
    '',
    '## Conversation so far',
    transcript || '(this is the first message)',
  ].join('\n');
}
