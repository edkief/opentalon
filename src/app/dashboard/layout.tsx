import Link from 'next/link';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/theme-toggle';

const navItems = [
  { href: '/dashboard', label: 'Thought Stream' },
  { href: '/dashboard/memory', label: 'Memory' },
  { href: '/dashboard/soul', label: 'Soul' },
  { href: '/dashboard/orchestration', label: 'Orchestration' },
  { href: '/dashboard/metrics', label: 'Metrics' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="w-52 flex flex-col border-r border-border p-4 shrink-0">
        <div className="mb-4">
          <span className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            OpenPincer
          </span>
        </div>
        <Separator className="mb-4" />
        <nav className="flex flex-col gap-1 flex-1">
          {navItems.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              {label}
            </Link>
          ))}
        </nav>
        <Separator className="my-3" />
        <ThemeToggle />
      </aside>
      <main className="flex-1 overflow-hidden p-6">{children}</main>
    </div>
  );
}
