'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { messageRoleLabel } from '@/lib/utils';
import { ChevronDown, ChevronRight, Copy, Check, ExternalLink } from 'lucide-react';
import type {
  MessageNodeData, SpecialistNodeData, StepNodeData, ToolNodeData, TurnNodeData,
} from './turn-graph';

// Tool outputs are truncated at persistence time (log-bus TOOL_OUTPUT_LIMIT).
const TOOL_OUTPUT_LIMIT = 10_000;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground shrink-0"
      title="Copy to clipboard"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // clipboard unavailable — no-op
        }
      }}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function Section({
  title,
  text,
  defaultOpen = false,
  mono = true,
  maxH = 'max-h-60',
  tone,
}: {
  title: string;
  text: string;
  defaultOpen?: boolean;
  mono?: boolean;
  maxH?: string;
  tone?: 'error' | 'reasoning' | 'rag';
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toneClass =
    tone === 'error'
      ? 'border-destructive/30 bg-destructive/10 text-destructive'
      : tone === 'reasoning'
        ? 'border-purple-200 dark:border-purple-800/40 bg-purple-50/60 dark:bg-purple-950/30 text-purple-700 dark:text-purple-300'
        : tone === 'rag'
          ? 'border-teal-200 dark:border-teal-800/40 bg-teal-50/60 dark:bg-teal-950/30 text-teal-700 dark:text-teal-300'
          : 'border-border bg-muted text-foreground';

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <button
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground text-[11px] font-medium"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {title}
        </button>
        <CopyButton text={text} />
      </div>
      {open && (
        <pre
          className={`mt-1 rounded border p-2 text-[10px] overflow-auto ${maxH} whitespace-pre-wrap break-words ${mono ? 'font-mono' : ''} ${toneClass}`}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

function MetaRow({ items }: { items: Array<[string, React.ReactNode] | null> }) {
  const visible = items.filter(Boolean) as Array<[string, React.ReactNode]>;
  if (visible.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px]">
      {visible.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-foreground break-all">{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function prettyJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ─── Per-kind detail views ────────────────────────────────────────────────────

function MessageDetail({ data }: { data: MessageNodeData }) {
  const { message } = data;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="font-semibold capitalize">{messageRoleLabel(message.role, message.agentId)} message</span>
        <CopyButton text={message.content} />
      </div>
      <MetaRow
        items={[
          ['Sent', new Date(message.createdAt).toLocaleString()],
          ['Chat', message.chatId],
          message.agentId ? ['Agent', message.agentId] : null,
        ]}
      />
      <div className="rounded border border-border bg-muted/40 p-2 text-[11px] whitespace-pre-wrap break-words leading-relaxed max-h-[50vh] overflow-auto">
        {message.content}
      </div>
    </>
  );
}

function StepDetail({ data }: { data: StepNodeData }) {
  const { step } = data;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="font-semibold">Step {step.stepIndex}</span>
        <Badge variant="outline" className="text-[10px]">{step.finishReason}</Badge>
      </div>
      <MetaRow
        items={[
          ['Time', new Date(step.timestamp).toLocaleString()],
          step.model ? ['Model', step.model] : null,
          step.durationMs !== undefined ? ['Duration', `${(step.durationMs / 1000).toFixed(1)}s`] : null,
          step.inputTokens !== undefined
            ? ['Tokens', `${step.inputTokens} in / ${step.outputTokens ?? 0} out`]
            : null,
          step.phase ? ['Phase', step.phase] : null,
        ]}
      />
      {step.errorMessage && (
        <div className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-destructive text-[11px] break-words">
          {step.errorMessage}
        </div>
      )}
      {step.reasoning && step.reasoning !== '[object Object]' && (
        <Section title="Chain of thought" text={step.reasoning} tone="reasoning" />
      )}
      {step.text && <Section title="Text output" text={step.text} defaultOpen mono={false} />}
      {step.ragContext && <Section title="Memories used (RAG)" text={step.ragContext} tone="rag" />}
    </>
  );
}

function ToolDetail({ data }: { data: ToolNodeData }) {
  const truncated = (data.output?.length ?? 0) >= TOOL_OUTPUT_LIMIT;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="font-semibold font-mono">{data.toolName}</span>
        {data.isError ? (
          <Badge variant="destructive" className="text-[10px]">error</Badge>
        ) : data.output !== undefined ? (
          <Badge className="text-[10px] bg-green-500/20 text-green-700 dark:text-green-400 border-green-500/30">ok</Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px]">running…</Badge>
        )}
      </div>
      <Section title="Input" text={prettyJson(data.input)} defaultOpen />
      {data.isError && data.output !== undefined && (
        <Section title="Error" text={data.output} defaultOpen tone="error" />
      )}
      {!data.isError && data.output !== undefined && (
        <Section title="Output" text={data.output} defaultOpen maxH="max-h-[40vh]" />
      )}
      {truncated && (
        <p className="text-[10px] text-muted-foreground italic">
          Output truncated to {TOOL_OUTPUT_LIMIT.toLocaleString()} characters at capture time.
        </p>
      )}
    </>
  );
}

function SpecialistDetail({ data }: { data: SpecialistNodeData }) {
  const { summary } = data;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="font-semibold">Specialist</span>
        <Badge variant="outline" className="text-[10px]">{summary.status}</Badge>
        {summary.background && <Badge variant="secondary" className="text-[10px]">background</Badge>}
      </div>
      <MetaRow
        items={[
          ['Spawned', new Date(summary.spawnedAt).toLocaleString()],
          summary.durationMs !== undefined ? ['Duration', `${(summary.durationMs / 1000).toFixed(1)}s`] : null,
          summary.agentId ? ['Agent', summary.agentId] : null,
          summary.modelUsed ? ['Model', summary.modelUsed] : null,
          summary.maxStepsUsed !== undefined ? ['Steps used', summary.maxStepsUsed] : null,
          ['ID', <span key="id" className="font-mono">{summary.specialistId}</span>],
        ]}
      />
      <Section title="Task" text={summary.taskDescription} defaultOpen mono={false} />
      {summary.contextSnapshot && <Section title="Context snapshot" text={summary.contextSnapshot} mono={false} />}
      {summary.result && (
        <Section
          title="Result"
          text={summary.result}
          defaultOpen
          mono={false}
          maxH="max-h-[40vh]"
          tone={summary.status === 'error' ? 'error' : undefined}
        />
      )}
      <Link
        href="/dashboard/orchestration"
        className="flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline"
      >
        <ExternalLink className="h-3 w-3" /> View in Orchestration Tree
      </Link>
    </>
  );
}

// ─── Inspector panel ──────────────────────────────────────────────────────────

export function TurnInspector({ data, systemPrompt }: { data: TurnNodeData | null; systemPrompt?: string }) {
  if (!data) {
    return (
      <div className="flex flex-col gap-3 p-3 text-xs">
        {systemPrompt ? (
          <Section title="System prompt" text={systemPrompt} mono={false} maxH="max-h-[80vh]" />
        ) : (
          <p className="text-muted-foreground">
            Click a node to inspect its details — tool inputs/outputs, reasoning, specialist results.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      {data.kind === 'message' && <MessageDetail data={data} />}
      {data.kind === 'step' && <StepDetail data={data} />}
      {data.kind === 'tool' && <ToolDetail data={data} />}
      {data.kind === 'specialist' && <SpecialistDetail data={data} />}
      {systemPrompt && (
        <Section title="System prompt (this turn)" text={systemPrompt} mono={false} maxH="max-h-[40vh]" />
      )}
    </div>
  );
}
