import Link from 'next/link';
import Image from 'next/image';

const FEATURES = [
  {
    icon: '🤖',
    title: 'Telegram-native',
    description: 'Responds to messages, handles group chats, and supports human-in-the-loop approval flows.',
  },
  {
    icon: '🧠',
    title: 'Persistent memory',
    description: 'Hybrid dense + sparse RAG over Qdrant so the agent remembers context across every conversation.',
  },
  {
    icon: '🔧',
    title: 'Extensible tooling',
    description: 'Built-in web search, terminal access, skill library, and a live MCP tool registry.',
  },
  {
    icon: '🕐',
    title: 'Scheduled tasks',
    description: 'The agent runs proactive, cron-driven tasks and delivers results directly to any chat.',
  },
  {
    icon: '🔬',
    title: 'Specialist agents',
    description: 'Long-running background jobs dispatched to specialist sub-agents with full observability.',
  },
  {
    icon: '📊',
    title: 'Control plane',
    description: 'Live thought stream, memory explorer, soul editor, metrics, and YAML-driven configuration.',
  },
];

export default function HeroPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-border/50 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Image src="/opentalon_portrait_notext.png" alt="OpenTalon" width={48} height={48} className="shrink-0" />
          <span className="text-lg font-bold tracking-tight">OpenTalon</span>
          <span className="rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 text-[10px] font-semibold px-2 py-0.5 uppercase tracking-wider">
            beta
          </span>
        </div>
        <div className="flex gap-2">
          <Link
            href="/dashboard"
            className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Dashboard →
          </Link>
          <Link
            href="/workspace/files"
            target="_blank"
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
          >
            Open Workspace →
          </Link>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-6 text-center">

        {/* Logo */}
        <Image
          src="/opentalon.png"
          alt="OpenTalon"
          width={320}
          height={320}
          className="mb-4 drop-shadow-md"
          priority
        />

        {/* Badge */}
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Open-source · Self-hosted · Multi-provider LLM
        </div>

        {/* Heading */}
        <h1 className="max-w-3xl text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-tight">
          Your personal AI agent,{' '}
          <span className="bg-gradient-to-r from-indigo-500 via-violet-500 to-sky-500 bg-clip-text text-transparent">
            always on
          </span>
        </h1>

        <p className="mt-6 max-w-xl text-base sm:text-lg text-muted-foreground leading-relaxed">
          OpenTalon is a self-hosted AI assistant that lives in your Telegram and works for you around the clock — with memory, tools, scheduled tasks, and a full control-plane dashboard.
        </p>

        {/* CTAs */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="rounded-xl bg-primary text-primary-foreground px-6 py-3 text-sm font-semibold shadow-sm hover:opacity-90 transition-opacity"
          >
            Open dashboard
          </Link>
          <a
            href="https://github.com/edkief/opentalon"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xl border border-border bg-card px-6 py-3 text-sm font-semibold text-foreground hover:bg-muted transition-colors"
          >
            GitHub ↗
          </a>
        </div>

        {/* ── Feature grid ─────────────────────────────────────────────── */}
        <div className="mt-20 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl w-full text-left">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-xl border border-border bg-card p-5 flex flex-col gap-2 hover:border-indigo-400/50 dark:hover:border-indigo-600/50 transition-colors"
            >
              <div className="text-2xl">{f.icon}</div>
              <h3 className="text-sm font-semibold text-foreground">{f.title}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </main>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="shrink-0 border-t border-border/50 px-6 py-4 text-center text-xs text-muted-foreground">
          OpenTalon — self-hosted AI assistant framework
      </footer>
    </div>
  );
}
