'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Globe, Mail, Search, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export type ChatChannel = 'web' | 'email' | 'telegram';

export interface ConversationOption {
  key: string; // agentId:chatId
  chatId: string;
  agentId: string;
  title: string;
  channel: ChatChannel;
  /** ISO timestamp of the latest message, null when the chat has no history yet. */
  lastActivity: string | null;
}

const RECENT_LIMIT = 8;

const CHANNEL_META: Record<ChatChannel, { label: string; Icon: typeof Globe }> = {
  web: { label: 'Web', Icon: Globe },
  telegram: { label: 'Telegram', Icon: Send },
  email: { label: 'Email', Icon: Mail },
};

function ChannelIcon({ channel, className }: { channel: ChatChannel; className?: string }) {
  const { Icon } = CHANNEL_META[channel];
  return <Icon className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', className)} />;
}

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

/** Most recent first; chats without any activity sink to the bottom. */
function byRecency(a: ConversationOption, b: ConversationOption): number {
  const ta = a.lastActivity ? Date.parse(a.lastActivity) : 0;
  const tb = b.lastActivity ? Date.parse(b.lastActivity) : 0;
  return tb - ta;
}

/** Shared inner layout for a conversation row (menu item and dialog list). */
function OptionContent({ option, selected }: { option: ConversationOption; selected: boolean }) {
  return (
    <>
      <ChannelIcon channel={option.channel} />
      <span className="flex-1 min-w-0">
        <span className="block truncate">{option.title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {option.agentId}
          {option.channel === 'telegram' && ` · ${option.chatId}`}
        </span>
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {relativeTime(option.lastActivity)}
      </span>
      <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
    </>
  );
}

function OptionRow({
  option,
  selected,
  onSelect,
}: {
  option: ConversationOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
        'hover:bg-accent hover:text-accent-foreground focus:outline-none focus-visible:bg-accent',
        selected && 'bg-accent/60',
      )}
    >
      <OptionContent option={option} selected={selected} />
    </button>
  );
}

export function ConversationSelect({
  options,
  value,
  onChange,
}: {
  options: ConversationOption[];
  value: string;
  onChange: (key: string) => void;
}) {
  const [browseOpen, setBrowseOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [channelFilter, setChannelFilter] = useState<ChatChannel | 'all'>('all');

  const sorted = useMemo(() => [...options].sort(byRecency), [options]);
  const recent = sorted.slice(0, RECENT_LIMIT);
  const active = options.find((o) => o.key === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((o) => {
      if (channelFilter !== 'all' && o.channel !== channelFilter) return false;
      if (!q) return true;
      return (
        o.title.toLowerCase().includes(q) ||
        o.chatId.toLowerCase().includes(q) ||
        o.agentId.toLowerCase().includes(q)
      );
    });
  }, [sorted, query, channelFilter]);

  const presentChannels = useMemo(
    () => (['telegram', 'email', 'web'] as ChatChannel[]).filter((c) => options.some((o) => o.channel === c)),
    [options],
  );

  const select = (key: string) => {
    onChange(key);
    setBrowseOpen(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 flex-1 min-w-0 max-w-md justify-between gap-2 px-2 font-normal"
          >
            <span className="flex items-center gap-2 min-w-0">
              {active && <ChannelIcon channel={active.channel} />}
              <span className="truncate">{active?.title ?? 'Select conversation'}</span>
              {active && (
                <Badge variant="outline" className="hidden sm:inline-flex shrink-0 text-[10px] px-1.5 py-0">
                  {active.agentId}
                </Badge>
              )}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 p-1">
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Recent conversations
          </DropdownMenuLabel>
          {recent.map((o) => (
            <DropdownMenuItem
              key={o.key}
              onSelect={() => select(o.key)}
              className={cn('gap-2', o.key === value && 'bg-accent/60')}
            >
              <OptionContent option={o} selected={o.key === value} />
            </DropdownMenuItem>
          ))}
          {sorted.length > RECENT_LIMIT && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  setQuery('');
                  setChannelFilter('all');
                  setBrowseOpen(true);
                }}
                className="justify-center gap-2 text-xs text-muted-foreground"
              >
                <Search className="h-3.5 w-3.5" />
                Browse all {sorted.length} conversations…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={browseOpen} onOpenChange={setBrowseOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>All conversations</DialogTitle>
            <DialogDescription>Search and filter across every channel.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, chat id or agent…"
                className="h-8 pl-8 text-sm"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <Button
                variant={channelFilter === 'all' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setChannelFilter('all')}
              >
                All
              </Button>
              {presentChannels.map((c) => {
                const { label, Icon } = CHANNEL_META[c];
                return (
                  <Button
                    key={c}
                    variant={channelFilter === c ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-6 gap-1 px-2 text-xs"
                    onClick={() => setChannelFilter((prev) => (prev === c ? 'all' : c))}
                  >
                    <Icon className="h-3 w-3" />
                    {label}
                  </Button>
                );
              })}
            </div>

            <ScrollArea className="h-72 rounded-md border">
              <div className="p-1">
                {filtered.length === 0 && (
                  <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                    No conversations match.
                  </p>
                )}
                {filtered.map((o) => (
                  <OptionRow
                    key={o.key}
                    option={o}
                    selected={o.key === value}
                    onSelect={() => select(o.key)}
                  />
                ))}
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
