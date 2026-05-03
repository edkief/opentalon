/**
 * Interactive CLI chat harness for local agent testing.
 *
 * Features:
 *   - Agent selection at startup (--agent <id> or interactive picker)
 *   - Displays the full system prompt before first turn
 *   - Rich step-by-step output: reasoning (CoT), tool calls, tool results, text
 *   - Conversation history maintained across turns
 *   - Slash commands: /reset /agent /prompt /agents /help /quit
 */

import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { agentRegistry } from '../src/lib/soul';
import { getBuiltInTools, getRegisteredTools, getWorkspaceDir } from '../src/lib/tools';
import { getConversationHistory, addMessage, clearConversationForAgent } from '../src/lib/db';
import { llmExecutor } from '../src/lib/agent';
import { logBus } from '../src/lib/agent/log-bus';
import type { StepEvent } from '../src/lib/agent/log-bus';
import type { Message } from '../src/lib/agent/types';
import { createSpecialistTools } from '../src/lib/agent/specialist';
import { resolveApproval } from '../src/lib/agent/hitl';
import { configManager } from '../src/lib/config';

// ─── ANSI colour helpers ──────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  // foregrounds
  gray:    '\x1b[90m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  // bright
  bBlue:   '\x1b[94m',
  bPurple: '\x1b[95m',
  bGreen:  '\x1b[92m',
  bYellow: '\x1b[93m',
};

function paint(color: string, text: string) { return `${color}${text}${c.reset}`; }
function hr(char = '─', width = 80) { return paint(c.dim, char.repeat(width)); }

// ─── Step event printer ───────────────────────────────────────────────────────

function printStep(ev: StepEvent) {
  const idx = paint(c.dim, `step ${ev.stepIndex}`);
  const reason = ev.finishReason === 'stop'       ? paint(c.green,   ev.finishReason)
               : ev.finishReason === 'tool-calls' ? paint(c.yellow,  ev.finishReason)
               : ev.finishReason === 'error'       ? paint(c.red,    ev.finishReason)
               :                                     paint(c.dim,    ev.finishReason);

  console.log(`\n${hr('·')}`);
  console.log(`${paint(c.bPurple, '◆ STEP')} ${idx}  ${reason}`);

  if (ev.reasoning) {
    console.log(paint(c.magenta, '\n  ⟳ Chain of thought'));
    const lines = ev.reasoning.split('\n');
    for (const line of lines) {
      console.log(paint(c.dim, `    ${line}`));
    }
  }

  if (ev.toolCalls?.length) {
    for (const tc of ev.toolCalls) {
      const args = JSON.stringify(tc.input, null, 2)
        .split('\n')
        .map((l, i) => (i === 0 ? l : `      ${l}`))
        .join('\n');
      console.log(`  ${paint(c.bBlue, '→')} ${paint(c.bold, tc.toolName)}(${paint(c.blue, args)})`);
    }
  }

  if (ev.toolResults?.length) {
    for (const tr of ev.toolResults) {
      const out = tr.output.length > 600 ? tr.output.slice(0, 600) + paint(c.dim, ' … [truncated]') : tr.output;
      console.log(`  ${paint(c.bGreen, '←')} ${paint(c.bold, tr.toolName)}: ${paint(c.green, out)}`);
    }
  }

  if (ev.text) {
    const snippet = ev.text.length > 400 ? ev.text.slice(0, 400) + paint(c.dim, ' … [truncated]') : ev.text;
    console.log(`  ${paint(c.bYellow, '✎')} ${snippet}`);
  }

  if (ev.ragContext) {
    console.log(paint(c.cyan, `  ◈ RAG context attached (${ev.ragContext.length} chars)`));
  }
}

// ─── Prompt display ───────────────────────────────────────────────────────────

async function printSystemPrompt(agentId: string, chatId: string) {
  const agentCfg = agentRegistry.getSoulManager(agentId).getConfig();
  const model = agentCfg.model ?? configManager.get().llm?.model ?? '(from config)';
  const temp  = agentCfg.temperature ?? configManager.get().llm?.temperature ?? 0.7;
  const maxSteps = configManager.get().llm?.maxSteps ?? 10;

  const systemPrompt = await llmExecutor.getSystemPrompt(
    `CLI test harness. Agent workspace: ${getWorkspaceDir()}.`,
    agentId,
    chatId,
  );

  console.log(`\n${hr('═')}`);
  console.log(paint(c.bold, '  SYSTEM PROMPT'));
  console.log(hr('═'));
  console.log(paint(c.dim, systemPrompt));
  console.log(hr('═'));
  console.log(paint(c.cyan, `  model: ${model}  temp: ${temp}  maxSteps: ${maxSteps}  rag: ${agentCfg.ragEnabled ?? true}`));
  console.log(`${hr('═')}\n`);
}

// ─── Agent picker ─────────────────────────────────────────────────────────────

async function pickAgent(rl: readline.Interface, initial?: string): Promise<string> {
  const agents = agentRegistry.listAgents();
  if (agents.length === 0) {
    console.log(paint(c.yellow, 'No agents found — using "default"'));
    return 'default';
  }

  if (initial) {
    if (agentRegistry.agentExists(initial)) return initial;
    console.log(paint(c.red, `Agent "${initial}" not found.`));
  }

  console.log(paint(c.bold, '\nAvailable agents:'));
  agents.forEach((a, i) => {
    const desc = a.description ? paint(c.dim, `  — ${a.description}`) : '';
    const preview = a.soulPreview.replace(/\n/g, ' ').slice(0, 60);
    console.log(`  ${paint(c.yellow, String(i + 1))}. ${paint(c.bold, a.id)}${desc}`);
    console.log(`     ${paint(c.dim, preview)}`);
  });

  if (agents.length === 1) {
    console.log(paint(c.dim, `\nOnly one agent — using "${agents[0].id}"`));
    return agents[0].id;
  }

  const answer = await rl.question(paint(c.cyan, '\nChoose agent (number or id): '));
  const num = parseInt(answer.trim(), 10);
  if (!isNaN(num) && num >= 1 && num <= agents.length) return agents[num - 1].id;
  if (agentRegistry.agentExists(answer.trim())) return answer.trim();

  console.log(paint(c.yellow, `Unrecognised — using "${agents[0].id}"`));
  return agents[0].id;
}

// ─── Slash command handler ────────────────────────────────────────────────────

async function handleSlash(
  cmd: string,
  rl: readline.Interface,
  state: { agentId: string; history: Message[]; chatId: string },
): Promise<'quit' | 'continue'> {
  const [verb, ...rest] = cmd.slice(1).split(' ');

  switch (verb) {
    case 'quit':
    case 'exit':
    case 'q':
      console.log(paint(c.dim, 'Bye!'));
      return 'quit';

    case 'reset':
      state.history = [];
      await clearConversationForAgent(state.chatId, state.agentId);
      console.log(paint(c.yellow, 'Conversation reset.'));
      return 'continue';

    case 'agents': {
      const all = agentRegistry.listAgents();
      console.log(paint(c.bold, '\nAgents:'));
      all.forEach(a => console.log(`  • ${paint(c.bold, a.id)}${a.description ? paint(c.dim, ` — ${a.description}`) : ''}`));
      return 'continue';
    }

    case 'agent': {
      const id = rest.join(' ').trim();
      const chosen = await pickAgent(rl, id || undefined);
      state.agentId = chosen;
      state.history = [];
      console.log(paint(c.green, `\nSwitched to agent "${chosen}". History cleared.`));
      await printSystemPrompt(chosen, state.chatId);
      return 'continue';
    }

    case 'prompt':
      await printSystemPrompt(state.agentId, state.chatId);
      return 'continue';

    case 'help':
      console.log(`
  ${paint(c.bold, 'Commands:')}
  ${paint(c.yellow, '/agent [id]')}   — switch agent (interactive picker if no id)
  ${paint(c.yellow, '/agents')}       — list all agents
  ${paint(c.yellow, '/prompt')}       — re-display current system prompt
  ${paint(c.yellow, '/reset')}        — clear conversation history
  ${paint(c.yellow, '/help')}         — show this help
  ${paint(c.yellow, '/quit')}         — exit
      `);
      return 'continue';

    default:
      console.log(paint(c.red, `Unknown command: /${verb}. Type /help for commands.`));
      return 'continue';
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  configManager.load();
  agentRegistry.ensureDefaults();

  const args = process.argv.slice(2);
  const agentFlagIdx = args.findIndex(a => a === '--agent' || a === '-a');
  const agentArg = agentFlagIdx !== -1 ? args[agentFlagIdx + 1] : undefined;

  const rl = readline.createInterface({ input, output, terminal: true });

  console.log(`\n${hr('═')}`);
  console.log(paint(c.bold, '  OpenTalon Chat Harness'));
  console.log(hr('═'));

  const agentId = await pickAgent(rl, agentArg);

  const chatId = `cli-test-${agentId}`;

  const state = {
    agentId,
    chatId,
    history: [] as Message[],
  };

  // Load existing DB history so the session is resumable across restarts
  try {
    const rows = await getConversationHistory(chatId, agentId, 20);
    state.history = rows.map(r => ({ role: r.role as Message['role'], content: r.content }));
    if (state.history.length > 0) {
      console.log(paint(c.dim, `\nLoaded ${state.history.length} message(s) from previous session. /reset to clear.\n`));
    }
  } catch {
    // DB might not be running — fine, start fresh
  }

  console.log(paint(c.dim, `Config:  ${configManager.configPath} (${configManager.state})`));
  console.log(paint(c.dim, `Secrets: ${configManager.secretsPath} (${configManager.isValid() ? 'valid' : 'invalid'})`));

  await printSystemPrompt(agentId, chatId);

  console.log(paint(c.dim, 'Type /help for commands. Ctrl+C or /quit to exit.\n'));

  // Subscribe to step events so we get real-time output during the LLM call
  const onStep = (ev: StepEvent) => {
    if (ev.sessionId === chatId) printStep(ev);
  };
  logBus.on('step', onStep);

  // Ctrl+C handler
  rl.on('close', () => {
    logBus.off('step', onStep);
    process.exit(0);
  });

  while (true) {
    let userInput: string;
    try {
      userInput = await rl.question(paint(c.bold + c.cyan, '\nYou › '));
    } catch {
      break;
    }

    const trimmed = userInput.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('/')) {
      const result = await handleSlash(trimmed, rl, state);
      if (result === 'quit') break;
      continue;
    }

    // ── Build tools (same as real Telegram handler, minus Telegram-specific ones) ──
    const agentCfg = agentRegistry.getSoulManager(state.agentId).getConfig();

    // CLI approval callback: prompt synchronously, then resolve the HITL gate
    const makeApprovalCallback = (label: string) =>
      async (approvalId: string, toolName: string, input: unknown): Promise<void> => {
        const preview = JSON.stringify(input, null, 2).slice(0, 400);
        const answer = await rl.question(
          paint(c.red, `\n⚠ ${label} "${toolName}" requested:\n`) +
          paint(c.dim, preview) +
          paint(c.yellow, '\n  Approve? [y/N] '),
        );
        resolveApproval(approvalId, answer.trim().toLowerCase() === 'y');
      };

    const [builtInTools, mcpTools] = await Promise.all([
      Promise.resolve(getBuiltInTools({
        sendApprovalRequest: makeApprovalCallback('Dangerous tool'),
        telegramChatId: chatId,
        memoryScope: 'private',
        sendTelegramMessage: async (_chatId: string, text: string) => {
          // Specialist messages surface here — print them clearly
          console.log(`\n${paint(c.bGreen, '◈ Specialist message:')} ${text}`);
        },
        allowedSkills: agentCfg.allowedSkills ?? null,
        allowedWorkflows: agentCfg.allowedWorkflows ?? null,
      })),
      getRegisteredTools({
        sendApprovalRequest: makeApprovalCallback('MCP tool'),
      }),
    ]);

    const merged = { ...builtInTools, ...mcpTools };
    const agentToolFilter = agentCfg.tools;
    const allTools = agentToolFilter && agentToolFilter.length > 0
      ? Object.fromEntries(Object.entries(merged).filter(([k]) => (agentToolFilter as string[]).includes(k)))
      : merged;
    const specialistTools = createSpecialistTools(0, allTools, chatId, state.agentId);
    const tools = { ...allTools, ...specialistTools };

    // ── Print what we're sending ──
    console.log(`\n${hr()}`);
    console.log(`${paint(c.bold, '▶ SENDING')}  agent=${paint(c.yellow, state.agentId)}  tools=${paint(c.dim, Object.keys(tools).join(', '))}`);
    console.log(hr());

    state.history.push({ role: 'user', content: trimmed });

    // ── Call LLM ──
    let response: string;
    try {
      const result = await llmExecutor.chat({
        messages: state.history,
        context: `CLI test harness. Agent workspace: ${getWorkspaceDir()}.`,
        memoryScope: 'private',
        chatId,
        tools,
        agentId: state.agentId,
      });

      if (result.type === 'error') {
        console.log(paint(c.red, `\nError: ${result.error}`));
        state.history.pop();
        continue;
      }

      response = result.text;
    } catch (err) {
      console.log(paint(c.red, `\nException: ${err instanceof Error ? err.message : String(err)}`));
      state.history.pop();
      continue;
    }

    state.history.push({ role: 'assistant', content: response });

    // Persist to DB (best-effort — DB may not be running)
    addMessage(chatId, 0, 'user', trimmed, state.agentId).catch(() => {});
    addMessage(chatId, 0, 'assistant', response, state.agentId).catch(() => {});

    console.log(`\n${hr()}`);
    console.log(`${paint(c.bold + c.bGreen, '◆ RESPONSE')}`);
    console.log(hr());
    console.log(response);
    console.log(hr());
  }

  logBus.off('step', onStep);
  rl.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
