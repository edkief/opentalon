'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { StepEvent, ConversationMessageEvent, TurnEvent } from '@/lib/agent/log-bus';
import { messageRoleLabel } from '@/lib/utils';
import { ChevronDown, ChevronRight, MoreHorizontal, RefreshCw, Square, Workflow } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ConversationSelect,
  type ConversationOption,
} from './_components/ConversationSelect';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConversationRow {
  id: number;
  chatId: string;
  messageId: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  agentId?: string;
  turnId?: string;
}

type StreamItem =
  | { kind: 'history'; row: ConversationRow }
  | { kind: 'step'; event: StepEvent };

// What Virtuoso actually renders. In collapsed mode contiguous step runs are
// merged into a single 'group' row up-front, so itemContent never returns null
// (a null/zero-height row triggers react-virtuoso "Zero-sized element").
type DisplayItem =
  | { kind: 'history'; row: ConversationRow }
  | { kind: 'step'; event: StepEvent }
  | { kind: 'group'; events: StepEvent[] };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function finishReasonVariant(reason: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (reason === 'stop') return 'default';
  if (reason === 'tool-calls') return 'secondary';
  if (reason === 'error') return 'destructive';
  return 'outline';
}

// Per-round (per-turn) token totals, summed across a turn's steps.
interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Compact token cost for one round, shown on the assistant/agent card. */
function RoundTokens({ totals }: { totals: TokenTotals }) {
  const { input, output, cacheRead, cacheWrite, reasoning } = totals;
  if (input + output + cacheRead + cacheWrite === 0) return null;
  const title =
    `Tokens this round — in ${input.toLocaleString()}, out ${output.toLocaleString()}` +
    (cacheRead ? `, cache read ${cacheRead.toLocaleString()}` : '') +
    (cacheWrite ? `, cache write ${cacheWrite.toLocaleString()}` : '') +
    (reasoning ? `, reasoning ${reasoning.toLocaleString()}` : '');
  return (
    <span title={title} className="inline-flex items-center gap-1.5 text-[10px] font-mono">
      <span className="text-emerald-600 dark:text-emerald-400">↑{formatCompact(input)}</span>
      <span className="text-sky-600 dark:text-sky-400">↓{formatCompact(output)}</span>
      {cacheRead > 0 && (
        <span className="text-teal-600 dark:text-teal-400">⚡{formatCompact(cacheRead)}</span>
      )}
    </span>
  );
}

// ─── Row components ───────────────────────────────────────────────────────────

/** Hover-revealed link to the turn deep-dive view. */
function InspectTurnLink({ turnId, chatId, agentId }: { turnId: string; chatId?: string; agentId?: string }) {
  const params = new URLSearchParams();
  if (chatId) params.set('chatId', chatId);
  if (agentId) params.set('agentId', agentId);
  const qs = params.toString();
  return (
    <Link
      href={`/dashboard/turns/${turnId}${qs ? `?${qs}` : ''}`}
      title="Inspect turn"
      aria-label="Inspect turn"
      className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0 p-1"
      onClick={(e) => e.stopPropagation()}
    >
      <Workflow className="h-3.5 w-3.5" />
    </Link>
  );
}

function HistoryRow({ row, chatName, defaultAgentId, tokens }: { row: ConversationRow; chatName?: string; defaultAgentId?: string; tokens?: TokenTotals }) {
  const isUser = row.role === 'user';
  const displayName = chatName && chatName !== row.chatId ? `${chatName} (${row.chatId})` : row.chatId;
  return (
    <div
      className={[
        'group rounded-md p-3 mb-2 font-mono text-xs border',
        isUser
          ? 'bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800/40'
          : 'bg-sky-50 border-sky-200 dark:bg-sky-950/30 dark:border-sky-800/40',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <Badge
          variant="outline"
          className={isUser
            ? 'border-amber-400 text-amber-700 dark:text-amber-400 text-[10px]'
            : 'border-sky-400 text-sky-700 dark:text-sky-400 text-[10px]'}
        >
          {messageRoleLabel(row.role, row.agentId, defaultAgentId)}
        </Badge>
        <span className="text-muted-foreground font-mono">{displayName}</span>
        <span className="text-muted-foreground sm:ml-auto text-[10px]">
          {new Date(row.createdAt).toLocaleString()}
        </span>
        {!isUser && tokens && <RoundTokens totals={tokens} />}
        {row.turnId && (
          <InspectTurnLink turnId={row.turnId} chatId={row.chatId} agentId={row.agentId} />
        )}
      </div>
      <div className="text-foreground whitespace-pre-wrap break-words leading-relaxed">
        {row.content}
      </div>
    </div>
  );
}

function RagContextToggle({ context }: { context: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[10px] text-teal-600 dark:text-teal-400 hover:underline"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Memories used
      </button>
      {open && (
        <pre className="mt-1 whitespace-pre-wrap break-all text-[10px] text-teal-700 dark:text-teal-300 bg-teal-50/60 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-800/40 rounded p-2">
          {context}
        </pre>
      )}
    </div>
  );
}

function ReasoningToggle({ reasoning }: { reasoning: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[10px] text-purple-600 dark:text-purple-400 hover:underline"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Chain of thought
      </button>
      {open && (
        <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] text-purple-700 dark:text-purple-300 bg-purple-50/60 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800/40 rounded p-2">
          {reasoning}
        </pre>
      )}
    </div>
  );
}

// Label for an in-progress live stage (thinking → responding → running tools).
// 'done' steps and classic (non-progressive) steps fall back to finishReason.
function stageLabel(stage: NonNullable<StepEvent['stage']>): string {
  switch (stage) {
    case 'thinking': return 'thinking…';
    case 'responding': return 'responding…';
    case 'tools': return 'running tools…';
    default: return stage;
  }
}

function StepRow({ event, verbose }: { event: StepEvent; verbose: boolean }) {
  const [open, setOpen] = useState(verbose);
  // Summary steps ship without heavy bodies (reasoning / toolResults / text /
  // full toolCall inputs). StepRow is only mounted once its body is visible
  // (group expanded or tool-collapsing off), so fetch the full detail then.
  const needsDetail = event.summary === true;
  const [detail, setDetail] = useState<StepEvent | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(needsDetail);

  useEffect(() => {
    if (!needsDetail) return;
    let cancelled = false;
    fetch(`/api/logs/steps?stepId=${encodeURIComponent(event.id)}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && !d.error) setDetail(d as StepEvent); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingDetail(false); });
    return () => { cancelled = true; };
  }, [needsDetail, event.id]);

  // Effective event: the fetched detail once available, else the summary. The
  // body only renders once bodies are present (avoids stringifying stripped
  // toolCall inputs).
  const ev = detail ?? event;
  const bodyReady = !needsDetail || detail !== null;

  // Intermediate live stages carry an empty finishReason; show a pulsing stage
  // chip instead of an empty badge. 'done'/classic steps show finishReason.
  const pending = event.stage !== undefined && event.stage !== 'done';

  return (
    <div className="group border border-violet-500/30 rounded-md p-3 mb-2 font-mono text-xs bg-violet-50/50 dark:bg-violet-950/20">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        {pending ? (
          <Badge
            variant="outline"
            className="text-[10px] border-violet-400 text-violet-600 dark:text-violet-300 animate-pulse"
          >
            {stageLabel(event.stage!)}
          </Badge>
        ) : (
          <Badge variant={finishReasonVariant(event.finishReason)} className="text-[10px]">
            {event.finishReason}
          </Badge>
        )}
        <span className="text-muted-foreground">step {event.stepIndex}</span>
        <span className="text-violet-500 dark:text-violet-400 text-[10px] font-semibold">LIVE</span>
        {(ev.ragContext || event.hasRagContext) && (
          <Badge variant="outline" className="text-[10px] border-teal-400 text-teal-600 dark:text-teal-400">
            RAG
          </Badge>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="ml-2 text-[10px] text-violet-600 dark:text-violet-300 hover:underline"
        >
          {open ? 'Collapse' : 'Expand'}
        </button>
        <span className="text-muted-foreground sm:ml-auto text-[10px]">{new Date(event.timestamp).toLocaleTimeString()}</span>
        <span className="text-muted-foreground text-[10px] hidden sm:inline">{event.sessionId}</span>
        {event.turnId && (
          <InspectTurnLink turnId={event.turnId} chatId={event.sessionId} agentId={event.agentId} />
        )}
      </div>

      {!bodyReady ? (
        <div className="text-[10px] text-muted-foreground animate-pulse">
          {loadingDetail ? 'Loading step details…' : 'Details available on expand'}
        </div>
      ) : open ? (
        <pre className="whitespace-pre-wrap break-all text-[11px] text-foreground">
          {JSON.stringify(ev, null, 2)}
        </pre>
      ) : (
        <>
          {ev.reasoning && ev.reasoning !== '[object Object]' && (
            <ReasoningToggle reasoning={ev.reasoning} />
          )}
          {ev.toolCalls?.map((tc, i) => (
            <div key={i} className="text-blue-500 dark:text-blue-400">
              → {tc.toolName}({JSON.stringify(tc.input).slice(0, 120)})
            </div>
          ))}
          {ev.toolResults?.map((tr, i) => (
            <div
              key={i}
              className={tr.isError
                ? 'text-red-600 dark:text-red-400'
                : 'text-emerald-600 dark:text-emerald-400'}
            >
              {tr.isError ? '✕' : '←'} {tr.toolName}: {tr.output.slice(0, 120)}
            </div>
          ))}
          {ev.text && (
            <div className="text-foreground mt-1">{ev.text.slice(0, 300)}</div>
          )}
          {ev.errorMessage && (
            <div className="mt-1.5 rounded border border-red-300 dark:border-red-800/50 bg-red-50/70 dark:bg-red-950/30 p-2 text-red-700 dark:text-red-300">
              <span className="font-semibold">error:</span> {ev.errorMessage}
            </div>
          )}
          {ev.ragContext && <RagContextToggle context={ev.ragContext} />}
        </>
      )}
    </div>
  );
}

function ToolGroupRow({ events }: { events: StepEvent[] }) {
  const [open, setOpen] = useState(false);
  const first = events[0];
  const last = events[events.length - 1] ?? first;

  const counts = events.reduce<Record<string, number>>((acc, ev) => {
    ev.toolCalls?.forEach((tc) => {
      acc[tc.toolName] = (acc[tc.toolName] ?? 0) + 1;
    });
    return acc;
  }, {});

  const entries = Object.entries(counts);

  return (
    <div className="border border-violet-400/40 rounded-md p-2 mb-2 font-mono text-[11px] bg-violet-50/40 dark:bg-violet-950/10">
      <div className="flex items-center gap-2 mb-1">
        <Badge variant="secondary" className="text-[9px] uppercase tracking-wide">
          tool calls
        </Badge>
        <div className="flex flex-wrap items-center gap-1">
          {entries.length === 0 ? (
            <span className="text-violet-700 dark:text-violet-300">(no tools)</span>
          ) : (
            entries.map(([name, n]) => (
              <span key={name} className="inline-flex items-center gap-1">
                <Badge
                  variant="outline"
                  className="h-4 px-1.5 text-[9px] leading-none border-violet-400 text-violet-700 dark:text-violet-200"
                >
                  {n}
                </Badge>
                <span className="text-violet-800 dark:text-violet-200">{name}</span>
              </span>
            ))
          )}
        </div>
        <span className="ml-auto text-muted-foreground">
          {new Date(first.timestamp).toLocaleTimeString()}
          {first.timestamp !== last.timestamp && ` – ${new Date(last.timestamp).toLocaleTimeString()}`}
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="ml-2 text-[10px] text-violet-600 dark:text-violet-300 hover:underline"
        >
          {open ? 'Hide details' : 'Show details'}
        </button>
      </div>
      {open && (
        <div className="mt-1 space-y-1">
          {events.map((ev) => (
            <StepRow key={ev.id} event={ev} verbose={false} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Live row at the foot of the stream. Doubles as the Stop control: `onCancel`
 * is passed only while a cancellable turn is registered, so the button exists
 * for exactly as long as there is something to stop.
 *
 * The two-stage label mirrors Telegram's `/cancel`: the first press asks the
 * turn to stop after the step it is already running (nothing is lost, but a
 * slow tool call still has to finish), and the second forces it. Same
 * escalation, so the two surfaces behave identically.
 */
function TypingIndicator({
  agentLabel,
  onCancel,
  cancelState,
}: {
  agentLabel: string;
  onCancel?: () => void;
  cancelState?: 'idle' | 'graceful' | 'force';
}) {
  const stopping = cancelState === 'graceful';
  const forced = cancelState === 'force';
  return (
    <div className="rounded-md p-3 mb-2 font-mono text-xs border bg-sky-50 border-sky-200 dark:bg-sky-950/30 dark:border-sky-800/40">
      <div className="flex items-center gap-2 mb-1">
        <Badge variant="outline" className="border-sky-400 text-sky-700 dark:text-sky-400 text-[10px]">
          {agentLabel}
        </Badge>
        <span className="text-violet-500 dark:text-violet-400 text-[10px] font-semibold">
          {forced ? 'STOPPING' : stopping ? 'FINISHING STEP' : 'LIVE'}
        </span>
        {onCancel && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-6 px-2 text-[10px]"
            onClick={onCancel}
            disabled={forced}
            title={
              stopping
                ? 'Waiting on the current step — press again to drop it immediately'
                : 'Stop after the current step, then summarise what got done'
            }
          >
            <Square className="h-2.5 w-2.5 mr-1" />
            {forced ? 'Stopping…' : stopping ? 'Force stop' : 'Stop'}
          </Button>
        )}
      </div>
      {stopping || forced ? (
        <div className="h-4 flex items-center text-[10px] text-muted-foreground">
          {forced
            ? 'Dropping the in-flight step…'
            : 'Finishing the current step, then summarising what got done…'}
        </div>
      ) : (
        <div className="flex gap-1 items-center h-4">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400 dark:bg-sky-500 animate-bounce"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const WEB_CHAT_ID = 'web';

interface ChatOption extends ConversationOption {
  /** Legacy composed label (`agent: title`) still used in stream rows. */
  name: string;
}

function makeChatKey(chatId: string, agentId: string) {
  return `${agentId}:${chatId}`;
}

/**
 * Inverse of makeChatKey. Split on the FIRST colon only — agent ids never
 * contain one, but chat ids do (`email:…`, embed ids). Lets the live handlers
 * filter on the viewed chat even before it shows up in the picker list.
 */
function parseChatKey(key: string): { agentId: string; chatId: string } {
  const i = key.indexOf(':');
  if (i === -1) return { agentId: key, chatId: '' };
  return { agentId: key.slice(0, i), chatId: key.slice(i + 1) };
}

const HISTORY_PAGE_SIZE = 15;
const VIRTUOSO_START_INDEX = 100_000;
// A turn with steps but no assistant reply older than this is treated as
// abandoned (pod killed mid-turn) and its steps are not shown.
const STALE_TURN_MS = 10 * 60_000;
// Coalescing window for chat-list refreshes triggered by live events.
const CHATS_REFRESH_DEBOUNCE_MS = 500;

export default function ThoughtStreamPage() {
  const [items, setItems] = useState<StreamItem[]>([]);
  const [verbose, setVerbose] = useState(false);
  const [collapseTools, setCollapseTools] = useState(true);
  const [connected, setConnected] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [oldestConvId, setOldestConvId] = useState<number | null>(null);
  const [firstItemIndex, setFirstItemIndex] = useState(VIRTUOSO_START_INDEX);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Rows Virtuoso renders. In collapsed mode, merge contiguous step runs into a
  // single 'group' row here instead of returning null mid-render. Prepended
  // history (loadMoreHistory) is always non-step, so it never merges across the
  // boundary — firstItemIndex stays in sync 1:1 with prepended rows.
  const displayItems = useMemo<DisplayItem[]>(() => {
    if (!collapseTools) return items;
    const out: DisplayItem[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.kind !== 'step') { out.push(it); continue; }
      const events: StepEvent[] = [];
      while (i < items.length && items[i].kind === 'step') {
        events.push((items[i] as Extract<StreamItem, { kind: 'step' }>).event);
        i += 1;
      }
      i -= 1;
      out.push({ kind: 'group', events });
    }
    return out;
  }, [items, collapseTools]);

  // Per-round token totals, summed across each turn's steps. Steps carry token
  // counts in both summary and live payloads, so this stays live-accurate.
  const tokensByTurn = useMemo(() => {
    const map = new Map<string, TokenTotals>();
    for (const it of items) {
      if (it.kind !== 'step' || !it.event.turnId) continue;
      const ev = it.event;
      const cur = map.get(ev.turnId!) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      cur.input += ev.inputTokens ?? 0;
      cur.output += ev.outputTokens ?? 0;
      cur.cacheRead += ev.cacheReadTokens ?? 0;
      cur.cacheWrite += ev.cacheWriteTokens ?? 0;
      cur.reasoning += ev.reasoningTokens ?? 0;
      map.set(ev.turnId!, cur);
    }
    return map;
  }, [items]);

  // Chat widget state
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  // chatId → turnId of every cancellable turn currently running, fed by the
  // `turn` SSE events the executor emits around its cancellation registration.
  // Keyed by chatId alone (not chat+agent, unlike the step filter) because that
  // is exactly what cancellation acts on — better to offer Stop for the thing
  // that is really running than to hide it on an agent mismatch.
  const [runningTurns, setRunningTurns] = useState<Record<string, string>>({});
  // Escalation state of the Stop button for the *active* chat: press once to
  // stop after the current step, again to force. Reset whenever the turn ends
  // or the viewed chat changes.
  const [cancelState, setCancelState] = useState<'idle' | 'graceful' | 'force'>('idle');
  const [defaultAgentId, setDefaultAgentId] = useState<string>('default');
  const [activeChatId, setActiveChatId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      // localStorage so the selection survives across sessions; fall back to
      // the old sessionStorage key once for migration.
      const saved =
        localStorage.getItem('thoughtstream:activeChatId') ??
        sessionStorage.getItem('thoughtstream:activeChatId');
      if (saved) return saved;
    }
    return makeChatKey(WEB_CHAT_ID, 'default');
  });
  const [chatOptions, setChatOptions] = useState<ChatOption[]>([
    {
      key: makeChatKey(WEB_CHAT_ID, 'default'),
      chatId: WEB_CHAT_ID,
      agentId: 'default',
      name: 'default: Web Channel',
      title: 'Web Channel',
      channel: 'web',
      lastActivity: null,
      hasAgentResponse: true,
    },
  ]);

  // Refs that mirror the active chat state so the long-lived SSE handler
  // always sees the latest selection without needing to resubscribe.
  const chatOptionsRef = useRef(chatOptions);
  const activeChatIdRef = useRef(activeChatId);
  useEffect(() => { chatOptionsRef.current = chatOptions; }, [chatOptions]);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
    localStorage.setItem('thoughtstream:activeChatId', activeChatId);
    setCancelState('idle');
  }, [activeChatId]);

  // ── Load known chats with Telegram display names ────────────────────────────
  const loadChats = useCallback(() => {
    return Promise.all([
      fetch('/api/chats').then((r) => r.json()),
      fetch('/api/agents').then((r) => r.json()),
    ])
      .then(([data, agentsData]: [
        (Omit<ChatOption, 'key'>)[],
        { defaultAgent: string },
      ]) => {
        const realDefaultId: string = agentsData.defaultAgent ?? 'default';
        setDefaultAgentId(realDefaultId);

        const mapped: ChatOption[] = data.map((d) => ({
          ...d,
          key: makeChatKey(d.chatId, d.agentId || realDefaultId),
          agentId: d.agentId || realDefaultId,
        }));

        const webEntry: ChatOption = {
          key: makeChatKey(WEB_CHAT_ID, realDefaultId),
          chatId: WEB_CHAT_ID,
          agentId: realDefaultId,
          name: `${realDefaultId}: Web Channel`,
          title: 'Web Channel',
          channel: 'web',
          // Keep the web channel's real recency so it sorts honestly among
          // the other conversations.
          lastActivity:
            mapped.find((d) => d.chatId === WEB_CHAT_ID)?.lastActivity ?? null,
          hasAgentResponse: true,
        };

        // Always use the current default agent for the web channel — stale DB
        // entries from prior conversations (with an old agentId) are dropped.
        const nonWebOptions = mapped.filter((d) => d.chatId !== WEB_CHAT_ID);
        const nextOptions = [webEntry, ...nonWebOptions];
        setChatOptions(nextOptions);

        // Ensure activeChatId points to a valid option. Read through the ref so
        // this callback stays stable and can be called from the SSE handlers.
        const stillExists = nextOptions.some((o) => o.key === activeChatIdRef.current);
        if (!stillExists) {
          setActiveChatId(nextOptions[0]?.key ?? webEntry.key);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => { loadChats(); }, [activeChatId, loadChats]);

  // A chat only enters the picker via /api/chats, which resolves Telegram
  // display names over the network — so live events coalesce into at most one
  // refresh per window instead of one per event.
  const chatsRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshChatsSoon = useCallback(() => {
    if (chatsRefreshTimer.current) return;
    chatsRefreshTimer.current = setTimeout(() => {
      chatsRefreshTimer.current = null;
      loadChats();
    }, CHATS_REFRESH_DEBOUNCE_MS);
  }, [loadChats]);
  useEffect(() => () => {
    if (chatsRefreshTimer.current) clearTimeout(chatsRefreshTimer.current);
  }, []);

  // ── Load history for the active chat ID ────────────────────────────────────
  const loadHistory = useCallback((chatId: string | undefined, agentId: string | undefined) => {
    if (!chatId || !agentId) return;
    setLoadingHistory(true);
    setItems([]);
    setHasMoreHistory(false);
    setOldestConvId(null);
    setFirstItemIndex(VIRTUOSO_START_INDEX);
    const params = new URLSearchParams({
      limit: String(HISTORY_PAGE_SIZE),
      chatId,
      agentId,
    });
    // Fetch history first so we know which turnIds are in the current page,
    // then fetch only steps that belong to those turns. This prevents steps
    // from unrelated turns (outside the history window) appearing in the UI.
    fetch(`/api/logs/history?${params.toString()}`)
      .then((r) => r.json())
      .then(async (rows: unknown) => {
        const safeRows: ConversationRow[] = Array.isArray(rows) ? rows : [];
        const pageTurnIds = [...new Set(safeRows.map((r) => r.turnId).filter(Boolean) as string[])];

        const stepsParams = new URLSearchParams(params);
        // Light payload only — tool-call names, tokens, and presence flags.
        // Full step bodies load lazily when the user expands a step.
        stepsParams.set('summary', '1');
        if (pageTurnIds.length > 0) {
          stepsParams.set('turnIds', pageTurnIds.join(','));
        }
        const steps: StepEvent[] = pageTurnIds.length === 0
          ? []
          : await fetch(`/api/logs/steps?${stepsParams.toString()}`).then((r) => r.json()).then((s) => Array.isArray(s) ? s : []);

        const historyItems: StreamItem[] = safeRows.map((row) => ({ kind: 'history' as const, row }));
        const stepItems: StepEvent[] = steps.slice().sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        // Group steps by turnId for deterministic attachment. Steps without a
        // turnId (legacy rows from before turn grouping) fall back to the old
        // timestamp-window heuristic.
        const stepsByTurn = new Map<string, StepEvent[]>();
        const legacySteps: StepEvent[] = [];
        for (const s of stepItems) {
          if (s.turnId) {
            const arr = stepsByTurn.get(s.turnId) ?? [];
            arr.push(s);
            stepsByTurn.set(s.turnId, arr);
          } else {
            legacySteps.push(s);
          }
        }

        const combined: StreamItem[] = [];
        const emittedTurns = new Set<string>();
        let legacyIndex = 0;
        let lastAssistantCutoff = 0; // timestamp (ms) of the previous assistant message

        for (const item of historyItems) {
          if (item.kind !== 'history') continue;
          const row = item.row;
          const rowTs = new Date(row.createdAt).getTime();

          if (row.role === 'assistant') {
            // Deterministic: attach steps sharing this assistant row's turnId.
            const turnSteps = row.turnId ? stepsByTurn.get(row.turnId) : undefined;
            if (turnSteps && row.turnId) {
              for (const ev of turnSteps) combined.push({ kind: 'step', event: ev });
              emittedTurns.add(row.turnId);
            }
            // Legacy fallback: attach turnId-less steps in (lastAssistantCutoff, rowTs]
            while (
              legacyIndex < legacySteps.length &&
              new Date(legacySteps[legacyIndex].timestamp).getTime() <= rowTs &&
              new Date(legacySteps[legacyIndex].timestamp).getTime() > lastAssistantCutoff
            ) {
              combined.push({ kind: 'step', event: legacySteps[legacyIndex] });
              legacyIndex += 1;
            }
            lastAssistantCutoff = rowTs;
          }

          combined.push(item);
        }

        // Append steps for turns that have no assistant row yet on this page
        // (e.g., agent is still processing the latest user message). These
        // are real persisted steps that would otherwise be invisible.
        // Only turns still plausibly in flight: a pod killed mid-turn never
        // writes the assistant row, leaving orphaned steps that would
        // otherwise dangle at the bottom of the stream forever.
        const now = Date.now();
        const unemittedSteps = [...stepsByTurn.entries()]
          .filter(([turnId, steps]) => {
            if (emittedTurns.has(turnId)) return false;
            const newest = Math.max(...steps.map((s) => new Date(s.timestamp).getTime()));
            return now - newest < STALE_TURN_MS;
          })
          .flatMap(([, steps]) => steps)
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        for (const ev of unemittedSteps) combined.push({ kind: 'step', event: ev });

        setItems(combined);
        setHasMoreHistory(safeRows.length >= HISTORY_PAGE_SIZE);
        setOldestConvId(safeRows[0]?.id ?? null);
        if (combined.length > 0) {
          setTimeout(() => {
            virtuosoRef.current?.scrollToIndex({ index: combined.length - 1, behavior: 'auto' });
          }, 100);
        }
      })
      .catch(console.error)
      .finally(() => setLoadingHistory(false));
  }, []);

  // Keyed on the resolved chat's identity, not on the chatOptions array: the
  // list is now refreshed live when a new conversation appears, and reloading
  // history on every refresh would wipe the in-flight stream mid-turn.
  const activeChatOption = useMemo(
    () => chatOptions.find((o) => o.key === activeChatId),
    [chatOptions, activeChatId],
  );
  const activeHistoryChatId = activeChatOption?.chatId;
  const activeHistoryAgentId = activeChatOption?.agentId;
  useEffect(() => {
    loadHistory(activeHistoryChatId, activeHistoryAgentId);
  }, [activeHistoryChatId, activeHistoryAgentId, loadHistory]);

  // ── Load earlier pages of history (reverse infinite scroll) ────────────────
  const loadMoreHistory = useCallback(async () => {
    if (loadingMore || !hasMoreHistory || !oldestConvId) return;
    const activeChat = chatOptions.find((o) => o.key === activeChatId);
    if (!activeChat) return;

    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        limit:   String(HISTORY_PAGE_SIZE),
        chatId:  activeChat.chatId,
        agentId: activeChat.agentId,
        before:  String(oldestConvId),
      });
      const rows: ConversationRow[] = await fetch(`/api/logs/history?${params}`).then((r) => r.json());
      const safeRows = Array.isArray(rows) ? rows : [];
      if (safeRows.length === 0) { setHasMoreHistory(false); return; }

      const newItems: StreamItem[] = safeRows.map((row) => ({ kind: 'history' as const, row }));
      setFirstItemIndex((prev) => prev - newItems.length);
      setItems((prev) => [...newItems, ...prev]);
      setOldestConvId(safeRows[0].id);
      setHasMoreHistory(safeRows.length >= HISTORY_PAGE_SIZE);
    } catch { /* ignore */ }
    finally { setLoadingMore(false); }
  }, [loadingMore, hasMoreHistory, oldestConvId, chatOptions, activeChatId]);

  // ── SSE stream for live agent step events + new conversation messages ─────
  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as StepEvent;
        // Only show steps belonging to the currently viewed chat/agent. Derived
        // from the selection key rather than the picker list, so a chat that is
        // selected but not yet listed still filters correctly.
        // event.sessionId is the chatId; event.agentId may be absent for legacy events.
        const active = parseChatKey(activeChatIdRef.current);
        const chatMatches = event.sessionId === active.chatId;
        const agentMatches = !event.agentId || event.agentId === active.agentId;
        if (!chatMatches || !agentMatches) return;
        // A single step is emitted multiple times as it fills in (thinking →
        // responding → tools → done), all sharing one id. Replace the existing
        // row in place so the stream shows one evolving step, not duplicates.
        setItems((prev) => {
          const idx = prev.findIndex(
            (it) => it.kind === 'step' && it.event.id === event.id,
          );
          if (idx === -1) return [...prev, { kind: 'step' as const, event }];
          const next = [...prev];
          next[idx] = { kind: 'step' as const, event };
          return next;
        });
        if (event.finishReason === 'stop') {
          setSending(false);
        }
      } catch {
        // ignore malformed
      }
    };

    const onConversation = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data) as ConversationMessageEvent;
        const key = makeChatKey(msg.chatId, msg.agentId);

        // A chat's first message creates it: pull it into the picker now rather
        // than leaving it invisible until the next reload. Also refresh once the
        // agent answers a chat listed as unanswered, to clear the "no reply"
        // badge (and the filter that hides it).
        const listed = chatOptionsRef.current.find((o) => o.key === key);
        if (!listed || (msg.role === 'assistant' && listed.hasAgentResponse === false)) {
          refreshChatsSoon();
        }

        // Only show messages for the chat currently being viewed
        if (key !== activeChatIdRef.current) return;

        const row: ConversationRow = {
          id: msg.rowId,
          chatId: msg.chatId,
          messageId: msg.messageId,
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt,
          agentId: msg.agentId,
          turnId: msg.turnId,
        };

        setItems((prev) => {
          // Skip if the real row is already present
          if (prev.some((it) => it.kind === 'history' && it.row.id === row.id)) return prev;

          // Replace a matching optimistic row (same role + content, no real id collision)
          const optimisticIdx = prev.findIndex(
            (it) =>
              it.kind === 'history' &&
              it.row.role === row.role &&
              it.row.content === row.content &&
              it.row.chatId === row.chatId &&
              it.row.id !== row.id &&
              // Optimistic rows used Date.now() as a temporary id (large epoch ms).
              it.row.id > 1_000_000_000,
          );
          if (optimisticIdx >= 0) {
            const next = prev.slice();
            next[optimisticIdx] = { kind: 'history', row };
            return next;
          }

          return [...prev, { kind: 'history' as const, row }];
        });

        if (msg.role === 'assistant') setSending(false);
      } catch {
        // ignore malformed
      }
    };

    const onTurn = (e: MessageEvent) => {
      try {
        const evt = JSON.parse(e.data) as TurnEvent;
        // Backstop for the conversation-event refresh above: a turn can start in
        // a chat the picker has never seen (its user row raced the refetch).
        if (evt.kind === 'start' && !chatOptionsRef.current.some((o) => o.chatId === evt.chatId)) {
          refreshChatsSoon();
        }
        setRunningTurns((prev) => {
          if (evt.kind === 'start') return { ...prev, [evt.chatId]: evt.turnId };
          // Ignore a stale `end` from a turn that has already been superseded
          // on this chat, or the newer turn's Stop button would vanish.
          if (prev[evt.chatId] !== evt.turnId) return prev;
          const next = { ...prev };
          delete next[evt.chatId];
          return next;
        });
        if (evt.kind === 'end') {
          const chat = chatOptionsRef.current.find((o) => o.key === activeChatIdRef.current);
          if (chat?.chatId === evt.chatId) setCancelState('idle');
        }
      } catch {
        // ignore malformed
      }
    };

    es.addEventListener('conversation', onConversation);
    es.addEventListener('turn', onTurn);

    return () => {
      es.removeEventListener('conversation', onConversation);
      es.removeEventListener('turn', onTurn);
      es.close();
    };
  }, [refreshChatsSoon]);

  // ── Send a message via /api/chat ────────────────────────────────────────────
  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;

    setInputText('');
    setSending(true);

    // Optimistically add the user message to the stream
    const activeChat: ChatOption = chatOptions.find((o) => o.key === activeChatId) ?? {
      key: makeChatKey(WEB_CHAT_ID, defaultAgentId),
      chatId: WEB_CHAT_ID,
      agentId: defaultAgentId,
      name: `${defaultAgentId}: Web Channel`,
      title: 'Web Channel',
      channel: 'web',
      lastActivity: null,
      hasAgentResponse: true,
    };

    const optimisticRow: ConversationRow = {
      id: Date.now(),
      chatId: activeChat.chatId,
      messageId: Date.now(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    setItems((prev) => [...prev, { kind: 'history' as const, row: optimisticRow }]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          chatId: activeChat.chatId,
          agentId: activeChat.agentId,
        }),
      });
      // The assistant reply is delivered to the UI via the SSE conversation
      // event emitted by addMessage(), so no need to append it from the HTTP
      // response. Just consume the body to keep the connection clean.
      await res.json().catch(() => null);
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ConversationSelect hides chats the agent never replied in — a filter meant
  // for passive email threads, which also swallows a chat whose first turn is
  // still running. Force those visible while the turn is in flight so a new
  // conversation shows up as it starts, not only once it finishes.
  const pickerOptions = useMemo<ChatOption[]>(
    () =>
      chatOptions.map((o) =>
        o.hasAgentResponse === false && runningTurns[o.chatId]
          ? { ...o, hasAgentResponse: true }
          : o,
      ),
    [chatOptions, runningTurns],
  );

  // Label for the active chat in the textarea placeholder
  const activeChat = activeChatOption;
  const activeChatName = activeChat?.name ?? activeChatId;
  const turnRunning = !!activeChat && !!runningTurns[activeChat.chatId];

  /**
   * Stop the turn running in the viewed chat. First press is graceful, second
   * forces — the same escalation as pressing `/cancel` twice in Telegram, and
   * the same registry underneath, so a turn can be started in one surface and
   * stopped from the other.
   */
  const handleCancelTurn = useCallback(async () => {
    const chatId = activeChat?.chatId;
    if (!chatId || cancelState === 'force') return;
    const mode = cancelState === 'idle' ? 'graceful' : 'force';
    // Optimistic: the button must react on the click, not a round-trip later —
    // rolled back below if the turn turns out to have already finished.
    setCancelState(mode);
    try {
      const res = await fetch('/api/turn/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, mode }),
      });
      const outcome = (await res.json()) as { status?: string };
      if (outcome.status === 'none') {
        setCancelState('idle');
        setRunningTurns((prev) => {
          const next = { ...prev };
          delete next[chatId];
          return next;
        });
      }
    } catch {
      setCancelState('idle');
    }
  }, [activeChat?.chatId, cancelState]);

  return (
    <div className="flex flex-col h-full gap-3">

      {/* ── Live region for screen readers ─────────────────────────────────── */}
      {items.length > 0 && (
        <div aria-live="polite" aria-atomic="false" className="sr-only">
          {(() => {
            const last = items[items.length - 1];
            if (last.kind === 'step') return `Latest: ${last.event.finishReason}`;
            return `Latest: ${messageRoleLabel(last.row.role, last.row.agentId, defaultAgentId)}`;
          })()}
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5 shrink-0">
        {/* Tier 1: title + chat select + actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 shrink-0">
            <h1 className="text-lg font-semibold">Thought Stream</h1>
            <span
              className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-yellow-500'}`}
              title={connected ? 'Live' : 'Connecting…'}
            />
            {loadingHistory && (
              <span className="text-xs text-muted-foreground">Loading…</span>
            )}
          </div>

          {/* Chat selector */}
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <ConversationSelect
              options={pickerOptions}
              value={activeChatId}
              onChange={setActiveChatId}
            />
          </div>

          {/* Refresh — always visible */}
          <Button
            variant="outline"
            size="icon-sm"
            title="Refresh"
            onClick={() => {
              const current = chatOptions.find((o) => o.key === activeChatId);
              loadHistory(current?.chatId, current?.agentId);
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="sr-only">Refresh</span>
          </Button>

          {/* Secondary actions — inline on sm+, overflow menu on phones */}
          <div className="hidden sm:flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setVerbose((v) => !v)}>
              {verbose ? 'Simple' : 'Verbose'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCollapseTools((c) => !c)}>
              {collapseTools ? 'Expand tools' : 'Collapse tools'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setItems([])}>
              Clear
            </Button>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" className="sm:hidden" title="More actions">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">More actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setVerbose((v) => !v)}>
                {verbose ? 'Simple mode' : 'Verbose mode'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCollapseTools((c) => !c)}>
                {collapseTools ? 'Expand tools' : 'Collapse tools'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setItems([])}>
                Clear stream
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ── Stream ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        {items.length === 0 && !loadingHistory ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            No history yet — send a message or wait for agent activity…
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            className="h-full"
            data={displayItems}
            firstItemIndex={firstItemIndex}
            startReached={loadMoreHistory}
            followOutput="smooth"
            itemContent={(_virtualIndex, item) => {
              if (item.kind === 'history') {
                return (
                  <HistoryRow
                    row={item.row}
                    chatName={activeChat?.name}
                    defaultAgentId={defaultAgentId}
                    tokens={item.row.turnId ? tokensByTurn.get(item.row.turnId) : undefined}
                  />
                );
              }

              if (item.kind === 'group') {
                return <ToolGroupRow events={item.events} />;
              }

              return <StepRow event={item.event} verbose={verbose} />;
            }}
            components={{
              Header: () => loadingMore
                ? <div className="flex justify-center py-2 text-xs text-muted-foreground">Loading earlier messages…</div>
                : null,
              Footer: () => (sending || turnRunning)
                ? (
                  <TypingIndicator
                    agentLabel={messageRoleLabel('assistant', activeChat?.agentId, defaultAgentId)}
                    cancelState={cancelState}
                    {...(turnRunning ? { onCancel: handleCancelTurn } : {})}
                  />
                )
                : null,
            }}
          />
        )}
      </div>

      {/* ── Chat input ─────────────────────────────────────────────────────── */}
      <div className="border border-border rounded-lg p-3 flex gap-2 items-end bg-card shrink-0">
        <Textarea
          className="flex-1 min-w-0 min-h-[60px] max-h-40 resize-none text-sm"
          placeholder={`Message ${activeChatName} — Shift+Enter for newline`}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
        />
        <Button
          className="shrink-0"
          onClick={handleSend}
          disabled={sending || !inputText.trim()}
        >
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
