# OpenTalon

A self-hosted AI personal assistant framework combining Telegram messaging, a web-based control plane dashboard, multi-agent orchestration, persistent vector memory (RAG), scheduled task automation, and visual workflow editing.

## Features

- **Telegram Bot Interface** — Command handlers, message processing, and rich HTML formatting via grammY v1.x
- **Multi-Agent System** — Multiple simultaneous agents, each with their own Soul.md personality and Identity.md config, hot-reloadable without restart
- **Hybrid RAG Memory** — Dense + sparse (BM25) vector search with Reciprocal Rank Fusion retrieval via Qdrant; scoped private/shared memories
- **Visual Workflow Editor** — React Flow canvas with agent, parallel, condition, HITL, and code node types; stateless engine safe across pod restarts
- **Specialist Sub-Agents** — Supervisor spawns transient stateless specialists via pg-boss job queue; max depth 1 to prevent runaway recursion
- **MCP Tool Registry** — Model Context Protocol for extensible custom tools alongside 30+ built-in tools
- **Skill Library** — File-based skill definitions (SKILL.md format) with supporting scripts
- **Web Dashboard** — Config editor, log viewer, memory explorer, metrics, soul editor, workflow builder, and more
- **Scheduled Tasks** — pg-boss-backed cron and one-shot job scheduling
- **Secure Secrets** — One-time web links for requesting sensitive values from users; secrets.yaml for persistent credentials
- **Real-Time Streaming** — SSE log streaming, specialist event streaming, and workflow execution streaming
- **Multi-Provider LLM** — Anthropic, OpenAI, Mistral, Google, Minimax, and OpenAI-compatible backends via Vercel AI SDK with fallback chains

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 22+ |
| Framework | Next.js 16.x (App Router) |
| LLM SDK | Vercel AI SDK (`ai@6.x`) |
| Vector DB | Qdrant |
| Relational DB | PostgreSQL via Drizzle ORM |
| Telegram | grammY v1.x |
| Tool Standard | Model Context Protocol (MCP) SDK |
| Task Queue | pg-boss |
| Styling | Tailwind CSS v4 + Shadcn/ui |
| Workflow | React Flow |
| Logging | Pino |
| Embeddings | BAAI/bge-large-en-v1.5 via local FastEmbed service |

## Architecture

### Supervisor-Specialist Pattern

The main agent ("Supervisor") handles user interactions and delegates complex tasks to transient "Specialist" sub-agents. Specialists receive a context snapshot plus tool access but do not persist memory across calls. Depth is limited to 1 — specialists cannot spawn further specialists.

### Hybrid RAG

Vector memory uses dense + sparse (BM25) hybrid search with Reciprocal Rank Fusion (RRF) for retrieval. Memories are scoped (`private` for DMs, `shared` for groups) and tagged per agent.

### Event-Driven Design

- `logBus` (EventEmitter) streams step events, specialist events, and workflow events via SSE
- `pg-boss` handles async job queuing and reliable scheduling across processes
- `config.yaml` and `Soul.md` hot-reload without requiring a server restart

## Prerequisites

- Node.js 22+ (use [nvm](https://github.com/nvm-sh/nvm): `nvm use 22`)
- pnpm (`npm install -g pnpm`)
- Docker + Docker Compose

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url>
cd openpincer
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your values (see Environment Variables below)

# 3. Start infrastructure services
pnpm run deps

# 4. Run database migrations
npx drizzle-kit push

# 5. Start the Next.js dashboard
pnpm run dev

# 6. Start the Telegram bot (separate terminal)
pnpm run dev:bot
```

Open [http://localhost:3000](http://localhost:3000) to access the dashboard.

## Environment Variables

Credentials are preferably managed via `secrets.yaml` in your workspace (editable from the dashboard). The following `.env` variables are required for infrastructure:

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `QDRANT_URL` | Qdrant REST API URL | Yes |
| `FASTEMBED_URL` | Local embedding service URL | Yes |
| `FASTEMBED_DIM` | Embedding dimensions (must match model) | Yes |
| `AGENT_WORKSPACE` | Path for agent files; defaults to `cwd` | No |
| `DASHBOARD_PASSWORD` | Web dashboard authentication password | Yes |
| `ANTHROPIC_API_KEY` | Fallback if not set in secrets.yaml | No |
| `OPENAI_API_KEY` | Fallback if not set in secrets.yaml | No |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | Yes (bot) |
| `TELEGRAM_OWNER_ID` | Your Telegram user ID | Yes (bot) |
| `TELEGRAM_USE_LONG_POLLING` | Set `true` for local dev without a public URL | No |
| `BRAVE_API_KEY` | For `web_search` tool | No |

See `.env.example` for the full list.

## Infrastructure Services (Docker Compose)

| Service | Port | Purpose |
|---------|------|---------|
| PostgreSQL 16 | 5432 | Relational data, job queue |
| Qdrant | 6333 (REST), 6334 (gRPC) | Vector memory |
| FastEmbed | 8000 | Local embedding generation |
| Adminer | 8080 | Database GUI (optional) |

```bash
pnpm run deps        # Start all services
pnpm run deps:down   # Stop all services
```

## Dashboard

Access at [http://localhost:3000/dashboard](http://localhost:3000/dashboard) after setting `DASHBOARD_PASSWORD`.

| Page | Purpose |
|------|---------|
| `/dashboard/agents` | Create and manage agents; configure model, tools, RAG, soul |
| `/dashboard/config` | Edit `config.yaml` and `secrets.yaml` via Monaco editor |
| `/dashboard/logs` | Splunk-like real-time log viewer with level/component filters |
| `/dashboard/memory` | Browse, search, and delete vector memories |
| `/dashboard/metrics` | Usage metrics: token counts, heatmap, charts, job outcomes |
| `/dashboard/orchestration` | Workflow overview and run monitoring |
| `/dashboard/scheduled-tasks` | View and manage cron/one-shot scheduled jobs |
| `/dashboard/secrets` | Manage credentials via secure one-time links |
| `/dashboard/skills` | Browse the skill library |
| `/dashboard/soul` | Edit Soul.md personality with snapshot support |
| `/dashboard/workflows` | Visual workflow builder, run history, HITL approval |

## Telegram Bot

```bash
# Development (long-polling, no public URL needed)
TELEGRAM_USE_LONG_POLLING=true pnpm run dev:bot

# Production (webhook mode, runs inside Next.js process)
pnpm run start
```

**Bot Commands:**

| Command | Description |
|---------|-------------|
| `/listagents` | List all available agents |
| `/agent <name>` | Switch active agent for this chat |
| `/help` | Show help information |

## Multi-Agent System

Each agent has:
- `agents/<id>/Soul.md` — Personality, response style, and system prompt
- `agents/<id>/Identity.md` — Name, description, and configuration
- Configurable LLM model with fallback chain
- Per-agent tool allowlists
- Per-agent RAG toggle

Agents are managed from the dashboard at `/dashboard/agents`. The active agent per chat is persisted in PostgreSQL.

## Visual Workflow Editor

Build automated pipelines at `/dashboard/workflows` using React Flow.

| Node Type | Description |
|-----------|-------------|
| `agent` | Spawns a specialist with a task template and optional context |
| `parallel` | Fan-out signal — enqueues all downstream nodes simultaneously |
| `condition` | Evaluates a JavaScript boolean expression to route the workflow |
| `hitl` | Pauses execution until a human approves or rejects via the dashboard |
| `code` | Executes arbitrary JavaScript against accumulated run context |

Workflow runs are tracked in PostgreSQL and can be streamed in real-time via SSE.

## Built-in Tools

| Category | Tools |
|----------|-------|
| Shell | `run_command`, `apply_patch` |
| Skills | `skill_list`, `skill_get`, `skill_save`, `skill_add_script`, `skill_delete` |
| Web | `web_search` (Brave), `web_fetch` |
| Memory | `rag_search`, `memory_read`, `memory_append`, `memory_delete` |
| Secrets | `request_secret` |
| Scheduling | `schedule_once`, `schedule_cron`, `scheduled_tasks_list`, `scheduled_tasks_cancel` |
| Browser | `browser_navigate`, `browser_snapshot`, `browser_get`, `browser_act`, `browser_screenshot`, `browser_close` |
| Todo | `todo_create`, `todo_add`, `todo_update`, `todo_clear` |
| Guidance | `request_guidance` |
| Specialist | `resume_specialist` |

Additional tools can be registered via MCP servers configured in `config.yaml`.

## Skill Library

Skills extend agent capabilities using the SKILL.md format. Each skill lives in `skills/<name>/`:

```
skills/
├── my-skill/
│   ├── SKILL.md     # Skill definition (name, description, tool definitions)
│   └── script.sh   # Supporting scripts
```

Skills can be browsed, created, and edited via the dashboard or the built-in skill tools.

## Configuration

Two YAML files live in `AGENT_WORKSPACE`:

- **`config.yaml`** — LLM model, temperature, memory settings, tool allowlists, MCP servers; safe to commit
- **`secrets.yaml`** — API keys and credentials; gitignored

Both files support hot-reload — changes take effect without restarting the server.

```yaml
# config.yaml example
llm:
  model: "anthropic/claude-sonnet-4-5"
  fallbacks: ["openai/gpt-4o"]
  temperature: 0.7
  maxSteps: 10
memory:
  enabled: true
tools:
  allowlist: "*"
  dangerousTools: ["run_command"]
```

## Database

Key Drizzle ORM tables:

| Table | Purpose |
|-------|---------|
| `conversations` | Chat history per chatId/agentId with token tracking |
| `jobs` | Background specialist and scheduled task jobs |
| `agent_state` | Active agent per chat |
| `workflows` | Workflow definitions (JSONB nodes/edges) |
| `workflow_runs` | Workflow execution runs |
| `workflow_run_nodes` | Per-node execution state |
| `workflow_hitl_requests` | Human-in-the-loop approval requests |
| `secret_requests` | Secure one-time secret request flow |
| `user_inputs` | User guidance request queue |

```bash
npx drizzle-kit generate   # Generate migration files
npx drizzle-kit push       # Apply migrations to database
```

## Development Scripts

```bash
pnpm run dev          # Start Next.js dev server (port 3000)
pnpm run dev:bot      # Start Telegram bot (long-polling)
pnpm run build        # Production build
pnpm run start        # Production server
pnpm run check        # Lint + type check
pnpm run mcp:server   # Run MCP server
pnpm run deps         # Start Docker services
pnpm run deps:down    # Stop Docker services
```

## Project Structure

```
openpincer/
├── assets/                    # Static assets (soul snapshots, etc.)
├── drizzle/                   # Database migration files
├── scripts/
│   ├── run-bot.ts            # Telegram bot entry point
│   └── mcp-server.ts         # MCP server entry point
├── skills/                   # Agent skill definitions (SKILL.md format)
├── specs/                    # Project specification documents
├── src/
│   ├── app/
│   │   ├── api/              # 50+ REST API route handlers
│   │   └── dashboard/        # Web dashboard pages
│   ├── components/           # Shared React components + Shadcn/ui
│   ├── hooks/                # Custom React hooks
│   └── lib/
│       ├── agent/            # LLM executor, specialist, middleware, log-bus
│       ├── config/           # YAML config management + hot-reload
│       ├── db/               # Drizzle ORM schema and queries
│       ├── memory/           # Qdrant hybrid RAG (dense + sparse + RRF)
│       ├── scheduler/        # pg-boss singleton + scheduling API
│       ├── skills/           # Skills manager
│       ├── soul/             # Soul.md + identity management + agent registry
│       ├── tools/            # MCP registry + 30+ built-in tools
│       ├── telegram/         # grammY bot handlers
│       └── workflow/         # Stateless workflow orchestration engine
├── docker-compose.yaml
├── drizzle.config.ts
└── package.json
```

## License

MIT
