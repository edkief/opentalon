'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Brain,
  Ghost,
  GitBranch,
  CalendarClock,
  BarChart3,
  Settings2,
  Menu,
  X,
  Sun,
  Moon,
} from 'lucide-react';
import { Separator } from '@/components/ui/separator';

const navItems = [
  { href: '/dashboard',                   label: 'Thought Stream',   icon: Activity },
  { href: '/dashboard/memory',            label: 'Memory',           icon: Brain },
  { href: '/dashboard/soul',              label: 'Soul',             icon: Ghost },
  { href: '/dashboard/orchestration',     label: 'Orchestration',    icon: GitBranch },
  { href: '/dashboard/scheduled-tasks',   label: 'Scheduled Tasks',  icon: CalendarClock },
  { href: '/dashboard/metrics',           label: 'Metrics',          icon: BarChart3 },
  { href: '/dashboard/config',            label: 'Config',           icon: Settings2 },
];

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

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5 flex-1">
      {navItems.map(({ href, label, icon: Icon }) => {
        // Active if exact match for root dashboard, prefix match for sub-pages
        const isActive =
          href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={[
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            ].join(' ')}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* ── Desktop sidebar (md+) ─────────────────────────────────────────── */}
      <aside className="hidden md:flex w-56 flex-col border-r border-border bg-background shrink-0 p-4">
        <div className="mb-3">
          <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            OpenPincer
          </span>
        </div>
        <Separator className="mb-3" />
        <NavLinks pathname={pathname} />
        <Separator className="my-3" />
        <ThemeButton />
      </aside>

      {/* ── Mobile: hamburger button (fixed top-left) ────────────────────── */}
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
            OpenPincer
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
