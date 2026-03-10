'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { AgentStepEvent } from '@/lib/agent/log-bus';
import { ChevronDown, ChevronRight } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConversationRow {
  id: number;
  chatId: string;
  messageId: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  personaId?: string;
}

type StreamItem =
  | { kind: 'history'; row: ConversationRow }
  | { kind: 'step'; event: AgentStepEvent };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function finishReasonVariant(reason: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (reason === 'stop') return 'default';
  if (reason === 'tool-calls') return 'secondary';
  if (reason === 'error') return 'destructive';
  return 'outline';
}

// ─── Row components ───────────────────────────────────────────────────────────

function HistoryRow({ row, chatName }: { row: ConversationRow; chatName?: string }) {
  const isUser = row.role === 'user';
  const displayName = chatName && chatName !== row.chatId ? `${chatName} (${row.chatId})` : row.chatId;
  return (
    <div
      className={[
        'rounded-md p-3 mb-2 font-mono text-xs border',
        isUser
          ? 'bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800/40'
          : 'bg-sky-50 border-sky-200 dark:bg-sky-950/30 dark:border-sky-800/40',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 mb-1">
        <Badge
          variant="outline"
          className={isUser
            ? 'border-amber-400 text-amber-700 dark:text-amber-400 text-[10px]'
            : 'border-sky-400 text-sky-700 dark:text-sky-400 text-[10px]'}
        >
          {row.role}
        </Badge>
        <span className="text-muted-foreground font-mono">{displayName}</span>
        <span className="text-muted-foreground ml-auto">
          {new Date(row.createdAt).toLocaleString()}
        </span>
      </div>
      <div className="text-foreground whitespace-pre-wrap break-words leading-relaxed">
        {row.content.slice(0, 600)}
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

function StepRow({ event, verbose }: { event: AgentStepEvent; verbose: boolean }) {
  const [open, setOpen] = useState(verbose);

  return (
    <div className="border border-violet-500/30 rounded-md p-3 mb-2 font-mono text-xs bg-violet-50/50 dark:bg-violet-950/20">
      <div className="flex items-center gap-2 mb-1">
        <Badge variant={finishReasonVariant(event.finishReason)} className="text-[10px]">
          {event.finishReason}
        </Badge>
        <span className="text-muted-foreground">step {event.stepIndex}</span>
        <span className="text-violet-500 dark:text-violet-400 text-[10px] font-semibold">LIVE</span>
        {event.ragContext && (
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
        <span className="text-muted-foreground ml-auto">{new Date(event.timestamp).toLocaleTimeString()}</span>
        <span className="text-muted-foreground">{event.sessionId}</span>
      </div>

      {open ? (
        <pre className="whitespace-pre-wrap break-all text-[11px] text-foreground">
          {JSON.stringify(event, null, 2)}
        </pre>
      ) : (
        <>
          {event.toolCalls?.map((tc, i) => (
            <div key={i} className="text-blue-500 dark:text-blue-400">
              → {tc.toolName}({JSON.stringify(tc.input).slice(0, 120)})
            </div>
          ))}
          {event.toolResults?.map((tr, i) => (
            <div key={i} className="text-emerald-600 dark:text-emerald-400">
              ← {tr.toolName}: {tr.output.slice(0, 120)}
            </div>
          ))}
          {event.text && (
            <div className="text-foreground mt-1">{event.text.slice(0, 300)}</div>
          )}
          {event.ragContext && <RagContextToggle context={event.ragContext} />}
        </>
      )}
    </div>
  );
}

function ToolGroupRow({ events }: { events: AgentStepEvent[] }) {
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

function TypingIndicator() {
  return (
    <div className="rounded-md p-3 mb-2 font-mono text-xs border bg-sky-50 border-sky-200 dark:bg-sky-950/30 dark:border-sky-800/40">
      <div className="flex items-center gap-2 mb-1">
        <Badge variant="outline" className="border-sky-400 text-sky-700 dark:text-sky-400 text-[10px]">
          assistant
        </Badge>
        <span className="text-violet-500 dark:text-violet-400 text-[10px] font-semibold">LIVE</span>
      </div>
      <div className="flex gap-1 items-center h-4">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400 dark:bg-sky-500 animate-bounce"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const WEB_CHAT_ID = 'web';
const DEFAULT_PERSONA_ID = 'default';

interface ChatOption {
  key: string; // personaId:chatId
  chatId: string;
  personaId: string;
  name: string;
}

function makeChatKey(chatId: string, personaId: string) {
  return `${personaId}:${chatId}`;
}

export default function ThoughtStreamPage() {
  const [items, setItems] = useState<StreamItem[]>([]);
  const [verbose, setVerbose] = useState(false);
  const [collapseTools, setCollapseTools] = useState(false);
  const [connected, setConnected] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Chat widget state
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [activeChatId, setActiveChatId] = useState(makeChatKey(WEB_CHAT_ID, DEFAULT_PERSONA_ID));
  const [chatOptions, setChatOptions] = useState<ChatOption[]>([
    {
      key: makeChatKey(WEB_CHAT_ID, DEFAULT_PERSONA_ID),
      chatId: WEB_CHAT_ID,
      personaId: DEFAULT_PERSONA_ID,
      name: `${DEFAULT_PERSONA_ID}: Web Channel`,
    },
  ]);

  // ── Load known chats with Telegram display names ────────────────────────────
  useEffect(() => {
    fetch('/api/chats')
      .then((r) => r.json())
      .then((data: { chatId: string; personaId: string; name: string }[]) => {
        const mapped: ChatOption[] = data.map((d) => ({
          key: makeChatKey(d.chatId, d.personaId || DEFAULT_PERSONA_ID),
          chatId: d.chatId,
          personaId: d.personaId || DEFAULT_PERSONA_ID,
          name: d.name,
        }));

        const hasWeb = mapped.some((d) => d.chatId === WEB_CHAT_ID);
        const webEntry: ChatOption = {
          key: makeChatKey(WEB_CHAT_ID, DEFAULT_PERSONA_ID),
          chatId: WEB_CHAT_ID,
          personaId: DEFAULT_PERSONA_ID,
          name: `${DEFAULT_PERSONA_ID}: Web Channel`,
        };

        const nextOptions = hasWeb ? mapped : [webEntry, ...mapped];
        setChatOptions(nextOptions);

        // Ensure activeChatId points to a valid option
        const stillExists = nextOptions.some((o) => o.key === activeChatId);
        if (!stillExists) {
          setActiveChatId(nextOptions[0]?.key ?? webEntry.key);
        }
      })
      .catch(() => {});
  }, [activeChatId]);

  // ── Load history for the active chat ID ────────────────────────────────────
  const loadHistory = useCallback((chat: ChatOption | undefined) => {
    if (!chat) return;
    setLoadingHistory(true);
    setItems([]);
    const params = new URLSearchParams({
      limit: '50',
      chatId: chat.chatId,
      personaId: chat.personaId,
    });
    Promise.all([
      fetch(`/api/logs/history?${params.toString()}`).then((r) => r.json()),
      fetch(`/api/logs/steps?${params.toString()}`).then((r) => r.json()),
    ])
      .then(([rows, steps]: [ConversationRow[], AgentStepEvent[]]) => {
        const historyItems: StreamItem[] = rows.map((row) => ({ kind: 'history' as const, row }));
        const stepItems: AgentStepEvent[] = steps.slice().sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        const combined: StreamItem[] = [];
        let stepIndex = 0;
        let lastAssistantCutoff = 0; // timestamp (ms) of the previous assistant message

        for (const item of historyItems) {
          if (item.kind !== 'history') continue;
          const row = item.row;
          const rowTs = new Date(row.createdAt).getTime();

          if (row.role === 'assistant') {
            // Attach all steps whose timestamps are in (lastAssistantCutoff, rowTs]
            while (
              stepIndex < stepItems.length &&
              new Date(stepItems[stepIndex].timestamp).getTime() <= rowTs &&
              new Date(stepItems[stepIndex].timestamp).getTime() > lastAssistantCutoff
            ) {
              combined.push({ kind: 'step', event: stepItems[stepIndex] });
              stepIndex += 1;
            }
            lastAssistantCutoff = rowTs;
          }

          combined.push(item);
        }

        // Any remaining steps (e.g. for an in-flight run without an assistant message yet)
        // are appended at the end.
        while (stepIndex < stepItems.length) {
          combined.push({ kind: 'step', event: stepItems[stepIndex] });
          stepIndex += 1;
        }

        setItems(combined);
        if (combined.length > 0) {
          setTimeout(() => {
            virtuosoRef.current?.scrollToIndex({ index: combined.length - 1, behavior: 'auto' });
          }, 100);
        }
      })
      .catch(console.error)
      .finally(() => setLoadingHistory(false));
  }, []);

  useEffect(() => {
    const activeChat = chatOptions.find((o) => o.key === activeChatId);
    loadHistory(activeChat);
  }, [activeChatId, chatOptions, loadHistory]);

  // ── SSE stream for live agent step events ──────────────────────────────────
  useEffect(() => {
    const es = new EventSource('/api/logs/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as AgentStepEvent;
        // Only append step events for the active chat (or always if watching 'web')
        setItems((prev) => [...prev.slice(-600), { kind: 'step' as const, event }]);
        // If the agent finished, also refresh history so the DB message appears
        if (event.finishReason === 'stop') {
          setSending(false);
        }
      } catch {
        // ignore malformed
      }
    };
    return () => es.close();
  }, []);

  // ── Send a message via /api/chat ────────────────────────────────────────────
  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;

    setInputText('');
    setSending(true);

    // Optimistically add the user message to the stream
    const activeChat = chatOptions.find((o) => o.key === activeChatId) ?? {
      key: makeChatKey(WEB_CHAT_ID, DEFAULT_PERSONA_ID),
      chatId: WEB_CHAT_ID,
      personaId: DEFAULT_PERSONA_ID,
      name: `${DEFAULT_PERSONA_ID}: Web Channel`,
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
          personaId: activeChat.personaId,
        }),
      });
      const data = await res.json() as { text?: string; chatId?: string };

      if (data.text) {
        const assistantRow: ConversationRow = {
          id: Date.now() + 1,
          chatId: activeChat.chatId,
          messageId: Date.now() + 1,
          role: 'assistant',
          content: data.text,
          createdAt: new Date().toISOString(),
        };
        setItems((prev) => [...prev, { kind: 'history' as const, row: assistantRow }]);
      }
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

  // Label for the active chat in the textarea placeholder
  const activeChat = chatOptions.find((o) => o.key === activeChatId);
  const activeChatName = activeChat?.name ?? activeChatId;

  return (
    <div className="flex flex-col h-full gap-3">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">Thought Stream</h1>
          <span
            className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-yellow-500'}`}
            title={connected ? 'Live' : 'Connecting…'}
          />
          {loadingHistory && (
            <span className="text-xs text-muted-foreground">Loading…</span>
          )}
        </div>

        {/* Chat selector — styled native select with Telegram names */}
        <div className="flex items-center gap-2">
          <label htmlFor="chat-select" className="text-xs text-muted-foreground shrink-0">
            Chat:
          </label>
          <select
            id="chat-select"
            value={activeChatId}
            onChange={(e) => setActiveChatId(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 pr-7 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 cursor-pointer"
          >
            {chatOptions.map(({ key, name }) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setVerbose((v) => !v)}>
            {verbose ? 'Simple' : 'Verbose'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCollapseTools((c) => !c)}>
            {collapseTools ? 'Expand tools' : 'Collapse tools'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const current = chatOptions.find((o) => o.key === activeChatId);
              loadHistory(current);
            }}
          >
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => setItems([])}>
            Clear
          </Button>
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
            data={items}
            followOutput="smooth"
            itemContent={(index, item) => {
              if (item.kind === 'history') {
                return (
                  <HistoryRow
                    row={item.row}
                    chatName={activeChat?.name}
                  />
                );
              }

              if (!collapseTools) {
                return <StepRow event={item.event} verbose={verbose} />;
              }

              // Collapse contiguous sequences of step events into a single summary row.
              const prev = index > 0 ? items[index - 1] : undefined;
              if (prev && prev.kind === 'step') {
                // Middle of a group — rendered by the first step.
                return null;
              }

              const group: AgentStepEvent[] = [];
              for (let i = index; i < items.length; i += 1) {
                const candidate = items[i];
                if (candidate.kind !== 'step') break;
                group.push(candidate.event);
              }

              return <ToolGroupRow events={group} />;
            }}
            components={{
              Footer: () => sending ? <TypingIndicator /> : null,
            }}
          />
        )}
      </div>

      {/* ── Chat input ─────────────────────────────────────────────────────── */}
      <div className="border border-border rounded-lg p-3 flex gap-2 items-end bg-card shrink-0">
        <Textarea
          className="flex-1 min-h-[60px] max-h-40 resize-none text-sm"
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
