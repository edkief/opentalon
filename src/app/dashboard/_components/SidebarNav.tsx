'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
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
  DatabaseZap,
  Key,
  Wrench,
  FolderOpen,
  LogOut,
} from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { useTheme } from '@/hooks/use-theme';

// ── Nav structure ──────────────────────────────────────────────────────────

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  target?: '_blank';
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
      { href: '/dashboard/memory',         label: 'Memory',          icon: NotebookPen },
      { href: '/dashboard/personas',      label: 'Personas',        icon: Layers },
    ],
  },
  { href: '/dashboard/knowledge',        label: 'Knowledge',  icon: DatabaseZap },
  { href: '/dashboard/skills',          label: 'Skills',          icon: Wrench },
  { href: '/dashboard/orchestration',   label: 'Orchestration',   icon: GitBranch },
  { href: '/dashboard/scheduled-tasks', label: 'Scheduled Tasks', icon: CalendarClock },
  { href: '/dashboard/metrics',         label: 'Metrics',         icon: BarChart3 },
  { href: '/dashboard/logs',            label: 'Logs',            icon: ScrollText },
  { href: '/dashboard/config',          label: 'Preferences',    icon: Settings2 },
  { href: '/dashboard/secrets',         label: 'Secrets',        icon: Key },
  { href: '/workspace/files',           label: 'Workspace',     icon: FolderOpen, target: '_blank' as const },
];

// ── Sub-components ─────────────────────────────────────────────────────────

function ThemeButton() {
  const { toggle } = useTheme();
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

function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleSignOut = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await fetch('/api/dashboard/logout', { method: 'POST' });
    } catch {
      // ignore errors; proxy will still enforce auth on next navigation
    } finally {
      setLoading(false);
      router.push('/dashboard/login');
      router.refresh();
    }
  };

  return (
    <button
      onClick={handleSignOut}
      className="mt-2 flex items-center gap-2 w-full rounded-md px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
    >
      <LogOut className="h-4 w-4" />
      {loading ? 'Signing out…' : 'Sign out'}
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
  target,
}: NavItem & { pathname: string; indent?: boolean; onNavigate?: () => void }) {
  const isExternal = target === '_blank';
  const isActive = isExternal ? false : (href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(href));
  const LinkComponent = isExternal ? 'a' : Link;
  const linkProps = isExternal
    ? { href, target: '_blank', rel: 'noopener noreferrer' }
    : { href };

  return (
    <LinkComponent
      {...linkProps}
      onClick={isExternal ? undefined : onNavigate}
      aria-current={isActive ? 'page' : undefined}
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
    </LinkComponent>
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
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    closeButtonRef.current?.focus();

    return () => document.removeEventListener('keydown', handleEscape);
  }, [open]);

  useEffect(() => {
    if (!open || !drawerRef.current) return;

    const drawer = drawerRef.current;
    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusables = drawer.querySelectorAll<HTMLElement>(focusableSelector);
    const firstFocusable = focusables[0];
    const lastFocusable = focusables[focusables.length - 1];

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstFocusable) {
          e.preventDefault();
          lastFocusable?.focus();
        }
      } else {
        if (document.activeElement === lastFocusable) {
          e.preventDefault();
          firstFocusable?.focus();
        }
      }
    };

    drawer.addEventListener('keydown', handleTab);
    return () => drawer.removeEventListener('keydown', handleTab);
  }, [open]);

  return (
    <>
      {/* ── Desktop sidebar (md+) ─────────────────────────────────────────── */}
      <aside className="hidden md:flex w-56 flex-col border-r border-border bg-background shrink-0 p-4">
        <div className="mb-3">
          <Link href="/">
            <img
              src="/opentalon_portrait.png"
              alt="OpenTalon"
              className="h-16 w-auto object-contain mx-auto"
            />
          </Link>
        </div>
        <Separator className="mb-3" />
        <NavLinks pathname={pathname} />
        <Separator className="my-3" />
        <ThemeButton />
        <SignOutButton />
      </aside>

      {/* ── Mobile: hamburger button (fixed top-right) ────────────────────── */}
      <button
        className="md:hidden fixed top-3 right-4 z-50 min-w-[44px] min-h-[44px] rounded-md p-2 bg-background border border-border shadow-sm hover:bg-accent transition-colors flex items-center justify-center"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
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
        ref={drawerRef}
        className={[
          'md:hidden fixed top-0 left-0 h-full w-64 z-50 flex flex-col border-r border-border bg-background p-4 shadow-xl transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <div className="flex items-center justify-between mb-3">
          <img
            src="/opentalon_portrait.png"
            alt="OpenTalon"
            className="h-10 w-auto object-contain"
          />
          <button
            ref={closeButtonRef}
            onClick={() => setOpen(false)}
            className="rounded-md p-2 min-w-[44px] min-h-[44px] flex items-center justify-center hover:bg-accent transition-colors"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <Separator className="mb-3" />
        <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
        <Separator className="my-3" />
        <ThemeButton />
        <SignOutButton />
      </aside>
    </>
  );
}
