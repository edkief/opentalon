import { z } from 'zod';
import type { ModelMessage } from 'ai';
import type { ToolSet } from 'ai';

/**
 * Context-size attribution (issue #18).
 *
 * A brand-new conversation was observed consuming ~40k input tokens while the
 * assembled system prompt text only accounts for ~8k. The prime suspect is the
 * `tools` array: it never appears in the prompt text but is serialized as JSON
 * schemas and sent on every request, and with ~45 built-in tools (plus MCP) it
 * is easily the largest hidden contributor.
 *
 * This module serializes the exact outgoing payload — stable system prompt,
 * volatile system parts, message history, injected RAG context, and the full
 * per-tool schema array (built-in + MCP) — runs each section through a
 * tokenizer, and produces a ranked table so follow-up optimisations (#19 tool
 * surface, #20 description diet, #21 memory slimming) can be ranked by measured
 * impact rather than guessed at.
 *
 * Two counting methods:
 *   - `estimate` (default): a local, dependency-free heuristic. Consistent
 *     across sections, so the *ranking* — the thing we actually need to decide
 *     what to optimise first — is reliable even if absolute numbers drift a few
 *     percent from the provider's tokenizer.
 *   - `anthropic` (opt-in): the exact total from Anthropic's `count_tokens`
 *     endpoint, reported alongside the estimate so the estimate can be
 *     calibrated. Requires an Anthropic API key.
 */

export interface SectionTokens {
  /** Human-readable section label. */
  section: string;
  /** Estimated tokens for this section. */
  tokens: number;
  /** Character length of the serialized section. */
  chars: number;
  /** Optional extra detail (e.g. tool count). */
  detail?: string;
}

export interface AttributionReport {
  /** Sum of all section token estimates (the per-request payload size). */
  totalTokens: number;
  /** Top-level sections, ranked largest-first. */
  sections: SectionTokens[];
  /** Per-tool breakdown, ranked largest-first. */
  perTool: SectionTokens[];
  /** Built-in vs MCP tool subtotals. */
  toolGroups: SectionTokens[];
  /** Exact input-token total from Anthropic count_tokens, when available. */
  exactTotal?: number;
  /** Which counting method produced `tokens`. */
  method: 'estimate';
}

export interface AttributionInput {
  /** Cache-stable system block (identity, soul, core memory, framework, tools env). */
  stableSystem: string;
  /** Volatile system tail (date/time, todos, running jobs). */
  volatileSystem: string;
  /** The full mapped message list sent to the model. */
  messages: ModelMessage[];
  /** The tools object as passed to generateText (built-in + MCP + specialist). */
  tools?: ToolSet;
  /**
   * RAG context injected into the last user message this turn, if any. Passed
   * separately so it can be attributed distinctly from genuine chat history
   * (it is prepended into a user message, so it would otherwise hide there).
   */
  ragContext?: string;
}

/**
 * Local token estimate. English prose is ~4 chars/token; JSON schemas are
 * punctuation-dense and tokenize closer to ~3.3 chars/token. We blend a
 * character-rate estimate with a whitespace-delimited chunk count and take the
 * larger, which tracks real tokenizers within a few percent across both prose
 * and JSON without any dependency or network call.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const byChars = text.length / 3.8;
  // Split on whitespace and on runs of punctuation, since tokenizers usually
  // emit a token per word and per punctuation cluster.
  const chunks = text.match(/\w+|[^\s\w]+/g);
  const byChunks = chunks ? chunks.length * 1.15 : 0;
  return Math.ceil(Math.max(byChars, byChunks));
}

/**
 * Convert a single tool's stored input schema to the JSON-schema object the
 * provider actually sends on the wire. Tools in this codebase are defined with
 * `tool({ inputSchema: z.object(...) })`, so the common path is a Zod schema →
 * `z.toJSONSchema`. Falls back gracefully for tools whose schema is already a
 * plain JSON schema (some MCP tools) or is otherwise not convertible.
 */
function toolSchemaToJson(inputSchema: unknown): unknown {
  if (!inputSchema || typeof inputSchema !== 'object') return {};
  // Already a plain JSON schema (e.g. `{ type: 'object', properties: {...} }`).
  const asRecord = inputSchema as Record<string, unknown>;
  if (typeof asRecord.jsonSchema === 'object' && asRecord.jsonSchema) {
    return asRecord.jsonSchema;
  }
  // Zod schema — has a `_def` (v3/v4) or the standard-schema marker.
  const looksLikeZod = '_def' in asRecord || '~standard' in asRecord || 'def' in asRecord;
  if (looksLikeZod) {
    try {
      return z.toJSONSchema(inputSchema as z.ZodType, { target: 'draft-2020-12' });
    } catch {
      // Fall through to raw serialization.
    }
  }
  if (asRecord.type || asRecord.properties) return inputSchema;
  return {};
}

/**
 * Serialize one tool the way it is sent to the provider: name + description +
 * input schema. The exact byte layout differs slightly per provider, but the
 * dominant cost — the description text and the JSON schema — is captured, which
 * is what matters for ranking.
 */
function serializeTool(name: string, toolDef: unknown): string {
  const t = (toolDef ?? {}) as Record<string, unknown>;
  const wire = {
    name,
    description: typeof t.description === 'string' ? t.description : '',
    input_schema: toolSchemaToJson(t.inputSchema),
  };
  return JSON.stringify(wire);
}

/** MCP tools register under a server-prefixed name (e.g. "talonpress_publish"). */
function isMcpTool(name: string, mcpPrefixes: string[]): boolean {
  return mcpPrefixes.some((p) => name.startsWith(p));
}

/**
 * Serialize the message history to a representative string. Tool-call and
 * tool-result parts are included since they are sent to the model too; the RAG
 * context (if any) is excluded here and attributed separately by the caller.
 */
function serializeMessages(messages: ModelMessage[], ragContext?: string): string {
  return messages
    .map((m) => {
      if (typeof m.content === 'string') {
        let content = m.content;
        // The RAG block is prepended into a user message; strip it so it is not
        // double-counted (it is reported as its own section).
        if (ragContext && content.includes(ragContext)) {
          content = content.replace(`## Past Relevant Context\n${ragContext}\n\n`, '');
        }
        return `${m.role}: ${content}`;
      }
      return `${m.role}: ${JSON.stringify(m.content)}`;
    })
    .join('\n');
}

export interface BuildAttributionOptions {
  /** Server prefixes used to classify a tool as MCP vs built-in. */
  mcpPrefixes?: string[];
}

/** Build the full attribution report from the assembled payload. */
export function buildAttributionReport(
  input: AttributionInput,
  opts: BuildAttributionOptions = {},
): AttributionReport {
  const { stableSystem, volatileSystem, messages, tools, ragContext } = input;
  const mcpPrefixes = opts.mcpPrefixes ?? [];

  const sections: SectionTokens[] = [];

  sections.push({
    section: 'System (stable / cached)',
    chars: stableSystem.length,
    tokens: estimateTokens(stableSystem),
  });
  sections.push({
    section: 'System (volatile)',
    chars: volatileSystem.length,
    tokens: estimateTokens(volatileSystem),
  });

  const messagesStr = serializeMessages(messages, ragContext);
  sections.push({
    section: 'Message history',
    chars: messagesStr.length,
    tokens: estimateTokens(messagesStr),
    detail: `${messages.length} message(s)`,
  });

  if (ragContext) {
    sections.push({
      section: 'Injected RAG context',
      chars: ragContext.length,
      tokens: estimateTokens(ragContext),
    });
  }

  // ── Per-tool breakdown ────────────────────────────────────────────────────
  const perTool: SectionTokens[] = [];
  let builtInTokens = 0;
  let builtInChars = 0;
  let builtInCount = 0;
  let mcpTokens = 0;
  let mcpChars = 0;
  let mcpCount = 0;

  if (tools) {
    for (const [name, def] of Object.entries(tools)) {
      const serialized = serializeTool(name, def);
      const tokens = estimateTokens(serialized);
      perTool.push({ section: name, chars: serialized.length, tokens });
      if (isMcpTool(name, mcpPrefixes)) {
        mcpTokens += tokens;
        mcpChars += serialized.length;
        mcpCount += 1;
      } else {
        builtInTokens += tokens;
        builtInChars += serialized.length;
        builtInCount += 1;
      }
    }
  }
  perTool.sort((a, b) => b.tokens - a.tokens);

  const toolGroups: SectionTokens[] = [];
  if (builtInCount > 0) {
    toolGroups.push({
      section: 'Tools: built-in',
      chars: builtInChars,
      tokens: builtInTokens,
      detail: `${builtInCount} tool(s)`,
    });
  }
  if (mcpCount > 0) {
    toolGroups.push({
      section: 'Tools: MCP',
      chars: mcpChars,
      tokens: mcpTokens,
      detail: `${mcpCount} tool(s)`,
    });
  }

  // Tools appear as one top-level section (the serialized array) so they rank
  // against the prompt sections.
  const totalToolTokens = builtInTokens + mcpTokens;
  const totalToolChars = builtInChars + mcpChars;
  if (tools && Object.keys(tools).length > 0) {
    sections.push({
      section: 'Tools array (all schemas)',
      chars: totalToolChars,
      tokens: totalToolTokens,
      detail: `${builtInCount + mcpCount} tool(s)`,
    });
  }

  sections.sort((a, b) => b.tokens - a.tokens);
  const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);

  return { totalTokens, sections, perTool, toolGroups, method: 'estimate' };
}

/**
 * Exact input-token count for the assembled payload via Anthropic's
 * `count_tokens` endpoint. Returns undefined (never throws) when no key is
 * configured or the call fails — this is a best-effort calibration figure, not
 * a hot-path dependency.
 */
export async function countTokensAnthropic(
  input: AttributionInput,
  model = 'claude-sonnet-4-5',
): Promise<number | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  try {
    const system = [input.stableSystem, input.volatileSystem].filter(Boolean).join('\n\n');
    // count_tokens requires a non-empty messages array. Map our messages to the
    // Anthropic shape (string content only; structured tool parts are best-effort
    // flattened to text so the call still succeeds).
    const messages = input.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
    if (messages.length === 0) messages.push({ role: 'user', content: '.' });

    const tools = input.tools
      ? Object.entries(input.tools).map(([name, def]) => {
          const t = (def ?? {}) as Record<string, unknown>;
          return {
            name,
            description: typeof t.description === 'string' ? t.description : '',
            input_schema: toolSchemaToJson(t.inputSchema),
          };
        })
      : undefined;

    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, system, messages, ...(tools ? { tools } : {}) }),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { input_tokens?: number };
    return typeof json.input_tokens === 'number' ? json.input_tokens : undefined;
  } catch {
    return undefined;
  }
}

/** Render the attribution report as a fixed-width table for the logs. */
export function formatAttributionTable(report: AttributionReport, maxTools = 15): string {
  const pct = (t: number) => (report.totalTokens > 0 ? `${((t / report.totalTokens) * 100).toFixed(1)}%` : '—');
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string, n: number) => s.padStart(n);

  lines.push('');
  lines.push('┌─ Context-size attribution (per outgoing request) ─────────────────────');
  lines.push(`│ Method: estimate (local heuristic)${report.exactTotal !== undefined ? ` · Anthropic exact total: ${report.exactTotal} tokens` : ''}`);
  lines.push('│ NOTE: this is ONE LLM call. A turn with maxSteps=N issues up to N such');
  lines.push('│ calls plus finalise/todo-check aux turns; usage dashboards sum them.');
  lines.push('├───────────────────────────────────────────────────────────────────────');
  lines.push(`│ ${pad('Section', 32)}${padL('Tokens', 10)}${padL('%', 8)}${padL('Chars', 10)}`);
  lines.push('├───────────────────────────────────────────────────────────────────────');
  for (const s of report.sections) {
    const label = s.detail ? `${s.section} (${s.detail})` : s.section;
    lines.push(`│ ${pad(label.slice(0, 32), 32)}${padL(String(s.tokens), 10)}${padL(pct(s.tokens), 8)}${padL(String(s.chars), 10)}`);
  }
  lines.push('├───────────────────────────────────────────────────────────────────────');
  lines.push(`│ ${pad('TOTAL', 32)}${padL(String(report.totalTokens), 10)}${padL('100%', 8)}`);
  if (report.exactTotal !== undefined) {
    const ratio = report.totalTokens > 0 ? (report.exactTotal / report.totalTokens) : 1;
    lines.push(`│ ${pad('Anthropic exact (calibration)', 32)}${padL(String(report.exactTotal), 10)}${padL(`${ratio.toFixed(2)}×`, 8)}`);
  }

  if (report.toolGroups.length > 0) {
    lines.push('├─ Tool groups ─────────────────────────────────────────────────────────');
    for (const g of report.toolGroups) {
      const label = g.detail ? `${g.section} (${g.detail})` : g.section;
      lines.push(`│ ${pad(label, 32)}${padL(String(g.tokens), 10)}${padL(pct(g.tokens), 8)}${padL(String(g.chars), 10)}`);
    }
  }

  if (report.perTool.length > 0) {
    lines.push(`├─ Top ${Math.min(maxTools, report.perTool.length)} tools by schema size ${'─'.repeat(30)}`);
    for (const t of report.perTool.slice(0, maxTools)) {
      lines.push(`│ ${pad(t.section.slice(0, 32), 32)}${padL(String(t.tokens), 10)}${padL(pct(t.tokens), 8)}${padL(String(t.chars), 10)}`);
    }
    if (report.perTool.length > maxTools) {
      lines.push(`│ … and ${report.perTool.length - maxTools} more tool(s)`);
    }
  }
  lines.push('└───────────────────────────────────────────────────────────────────────');
  return lines.join('\n');
}
