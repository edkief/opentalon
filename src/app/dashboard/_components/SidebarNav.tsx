'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Brain,
  GitBranch,
  CalendarClock,
  BarChart3,
  Settings2,
  Menu,
  NotebookPen,
  X,
  Sun,
  Moon,
  ScrollText,
  ChevronDown,
  ChevronRight,
  Layers,
} from 'lucide-react';
import { Separator } from '@/components/ui/separator';

// ── Nav structure ──────────────────────────────────────────────────────────

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
}

interface NavGroup {
  label: string;
  icon: React.ElementType;
  items: NavItem[];
}

type NavEntry = NavItem | NavGroup;

function isGroup(entry: NavEntry): entry is NavGroup {
  return 'items' in entry;
}

const nav: NavEntry[] = [
  { href: '/dashboard',                 label: 'Thought Stream',  icon: Activity },
  {
    label: 'Agent',
    icon: Brain,
    items: [
      { href: '/dashboard/agent-memory',  label: 'Core Memory',     icon: NotebookPen },
      { href: '/dashboard/personas',      label: 'Personas',        icon: Layers },
    ],
  },
  { href: '/dashboard/memory',          label: 'Memory',          icon: Brain },
  { href: '/dashboard/orchestration',   label: 'Orchestration',   icon: GitBranch },
  { href: '/dashboard/scheduled-tasks', label: 'Scheduled Tasks', icon: CalendarClock },
  { href: '/dashboard/metrics',         label: 'Metrics',         icon: BarChart3 },
  { href: '/dashboard/logs',            label: 'Logs',            icon: ScrollText },
  { href: '/dashboard/config',          label: 'Config',          icon: Settings2 },
];

// ── Sub-components ─────────────────────────────────────────────────────────

function ThemeButton() {
  const toggle = () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  };
  return (
    <button
      onClick={toggle}
      className="flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
      aria-label="Toggle theme"
    >
      <Sun className="h-4 w-4 dark:hidden" />
      <Moon className="h-4 w-4 hidden dark:block" />
      <span className="dark:hidden">Light mode</span>
      <span className="hidden dark:block">Dark mode</span>
    </button>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  pathname,
  indent = false,
  onNavigate,
}: NavItem & { pathname: string; indent?: boolean; onNavigate?: () => void }) {
  const isActive =
    href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href);
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={[
        'flex items-center gap-3 rounded-md py-2 text-sm font-medium transition-colors',
        indent ? 'pl-7 pr-3' : 'px-3',
        isActive
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      ].join(' ')}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </Link>
  );
}

function NavGroupSection({
  group,
  pathname,
  onNavigate,
}: {
  group: NavGroup;
  pathname: string;
  onNavigate?: () => void;
}) {
  const GroupIcon = group.icon;
  const isAnyChildActive = group.items.some((item) => pathname.startsWith(item.href));
  const [open, setOpen] = useState(isAnyChildActive);
  const ChevronIcon = open ? ChevronDown : ChevronRight;

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className={[
          'flex items-center gap-3 w-full rounded-md px-3 py-2 text-sm font-medium transition-colors',
          isAnyChildActive
            ? 'text-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        ].join(' ')}
      >
        <GroupIcon className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">{group.label}</span>
        <ChevronIcon className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {group.items.map((item) => (
            <NavLink
              key={item.href}
              {...item}
              pathname={pathname}
              indent
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5 flex-1">
      {nav.map((entry) =>
        isGroup(entry) ? (
          <NavGroupSection
            key={entry.label}
            group={entry}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ) : (
          <NavLink
            key={entry.href}
            {...entry}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        ),
      )}
    </nav>
  );
}

// ── Main export ────────────────────────────────────────────────────────────

export function SidebarNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* ── Desktop sidebar (md+) ─────────────────────────────────────────── */}
      <aside className="hidden md:flex w-56 flex-col border-r border-border bg-background shrink-0 p-4">
        <div className="mb-3">
          <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            
          </span>
        </div>
        <Separator className="mb-3" />
        <NavLinks pathname={pathname} />
        <Separator className="my-3" />
        <ThemeButton />
      </aside>

      {/* ── Mobile: hamburger button (fixed top-right) ────────────────────── */}
      <button
        className="md:hidden fixed top-3 right-4 z-50 rounded-md p-2 bg-background border border-border shadow-sm hover:bg-accent transition-colors"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* ── Mobile: backdrop ─────────────────────────────────────────────── */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/40"
          onClick={() => setOpen(false)}
        />
      )}

      {/* ── Mobile: slide-in sidebar ─────────────────────────────────────── */}
      <aside
        className={[
          'md:hidden fixed top-0 left-0 h-full w-64 z-50 flex flex-col border-r border-border bg-background p-4 shadow-xl transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            
          </span>
          <button
            onClick={() => setOpen(false)}
            className="rounded-md p-1 hover:bg-accent transition-colors"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <Separator className="mb-3" />
        <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
        <Separator className="my-3" />
        <ThemeButton />
      </aside>
    </>
  );
}
