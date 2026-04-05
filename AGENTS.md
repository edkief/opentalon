# OpenTalon Agent Development Guide

## Project Overview

OpenTalon is a self-hosted AI personal assistant framework that combines Telegram messaging, a web-based control plane dashboard, multi-agent orchestration, persistent vector memory (RAG), scheduled task automation, and visual workflow editing. The system acts as an intelligent agent with persistent memory, tool use capabilities, and the ability to delegate tasks to specialized sub-agents.

**Key Features:**
- Telegram bot interface (gramMY v1.x) with command handlers and message processing
- Web dashboard for configuration, monitoring, and management
- Multi-agent system where each agent has its own SOUL.md personality and IDENTITY.md config
- Hybrid RAG with dense + sparse (BM25) vectors and Reciprocal Rank Fusion retrieval
- Visual workflow orchestration using React Flow
- MCP (Model Context Protocol) tool registry for extensibility
- pg-boss for reliable PostgreSQL-backed job scheduling
- Hot-reload of configuration and soul files without restart

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

## Architecture

### Supervisor-Specialist Pattern

The main agent ("Supervisor") handles user interactions and can delegate complex tasks to transient "Specialist" sub-agents. Specialists are stateless—they receive a context snapshot plus tool access but do not persist memory across calls. The supervisor limits specialist depth to 1 level (specialists cannot spawn further specialists).

### Multi-Agent System

Multiple agents run simultaneously, each with:
- Own `SOUL.md` (personality/prompts)
- Own `IDENTITY.md` (identity configuration)
- Configurable model with fallback chain
- Per-agent tool allowlists
- Per-agent RAG toggle

### RAG with Hybrid Search

Vector memory uses **dense + sparse (BM25) hybrid search** with **Reciprocal Rank Fusion (RRF)** for retrieval. Memories are scoped (`private` for DMs, `shared` for groups) and agent-tagged.

### Event-Driven Architecture

- `logBus` (EventEmitter) streams step events, specialist events, and workflow events via SSE
- `pg-boss` handles async job queuing across processes
- Hot-reload of `config.yaml` triggers reconfiguration events

## Folder Structure

```
/home/ekieffer/Dev/openpincer/
├── assets/                    # Static assets
├── drizzle/                   # Database migration files (SQL + journal)
│   └── meta/                  # Drizzle migration metadata
├── public/                    # Next.js static assets
├── scripts/                   # Utility scripts
│   ├── run-bot.ts            # Starts the Telegram bot
│   └── test-soul.ts          # Tests Soul.md loading
├── skills/                   # Agent skill definitions (Anthropic SKILL.md format)
│   ├── kokoro_tts/
│   ├── flux/
│   └── ping_host/
├── specs/                    # Project specification documents
│   ├── OVERVIEW.md
│   └── PHASE-*.md            # Implementation phases
├── src/
│   ├── app/                 # Next.js App Router
│   │   ├── api/            # REST API routes (~50+ endpoints)
│   │   ├── dashboard/      # Web dashboard pages
│   │   │   ├── _components/ # Shared dashboard components
│   │   │   ├── agents/     # Multi-agent management UI
│   │   │   ├── config/     # Configuration editor
│   │   │   ├── identity/   # Agent identity settings
│   │   │   ├── knowledge/  # RAG knowledge management
│   │   │   ├── logs/       # Real-time log viewer (SSE)
│   │   │   ├── memory/     # Core memory editor
│   │   │   ├── metrics/    # Usage metrics
│   │   │   ├── onboarding/ # Setup wizard
│   │   │   ├── orchestration/ # Workflow orchestration view
│   │   │   ├── scheduled-tasks/ # Cron task management
│   │   │   ├── secrets/    # Secret management
│   │   │   ├── skills/     # Skill library browser
│   │   │   ├── soul/       # Soul.md editor
│   │   │   └── workflows/  # Visual workflow editor
│   │   ├── page.tsx        # Landing page
│   │   └── layout.tsx      # Root layout
│   ├── components/          # Shared React components
│   │   ├── ui/             # Shadcn/ui base components
│   │   ├── workflow/       # Workflow canvas (React Flow)
│   │   ├── error-boundary.tsx
│   │   └── restart-modal.tsx
│   ├── hooks/              # Custom React hooks
│   │   └── use-theme.ts
│   ├── lib/                # Core business logic
│   │   ├── agent/          # LLM execution & agent logic
│   │   ├── bot-manager.ts  # Telegram bot lifecycle
│   │   ├── config/         # YAML config management
│   │   ├── db/             # Drizzle ORM schema & queries
│   │   ├── memory/         # Qdrant vector memory (RAG)
│   │   ├── migrations/     # Workspace migrations
│   │   ├── scheduler/      # pg-boss task scheduling
│   │   ├── skills/         # Skills manager
│   │   ├── soul/           # Soul.md & identity management
│   │   ├── telemetry.ts    # Logging setup
│   │   ├── tools/          # MCP registry & built-in tools
│   │   ├── utils.ts
│   │   ├── workflow/       # Workflow orchestration engine
│   │   ├── proxy.ts
│   │   └── telegram/       # Telegram bot & handlers
│   └── instrumentation.ts  # Next.js instrumentation (bot startup)
├── docker-compose.yaml      # Postgres, Qdrant, Adminer, FastEmbed
├── drizzle.config.ts
└── package.json
```

## Core Modules

### Agent Execution (`src/lib/agent/`)

| File | Purpose |
|------|---------|
| `llm-executor.ts` | Core LLM chat execution with fallback chain, RAG middleware wrapping |
| `specialist.ts` | Spawns stateless sub-agents (sync/async via pg-boss) |
| `middleware.ts` | AI SDK middleware for RAG context injection |
| `log-bus.ts` | EventEmitter for step/specialist/workflow logs |

### Telegram (`src/lib/telegram/`)

| File | Purpose |
|------|---------|
| `handlers.ts` | All Telegram command/message handlers (~1271 lines) |

### Memory (`src/lib/memory/`)

| File | Purpose |
|------|---------|
| `retrieve.ts` | Hybrid RAG retrieval (dense + sparse + RRF fusion) |
| `ingest.ts` | Memory storage with dense+sparse vectors |

### Tools (`src/lib/tools/`)

| File | Purpose |
|------|---------|
| `registry.ts` | MCP client tool registry |
| `built-in.ts` | Built-in tools (~983 lines): terminal, skills, web search, memory, browser, todos |

### Workflow (`src/lib/workflow/`)

| File | Purpose |
|------|---------|
| `engine.ts` | Stateless workflow orchestration engine |

### Other Key Modules

| File | Purpose |
|------|---------|
| `bot-manager.ts` | Telegram bot lifecycle management |
| `soul/soul-manager.ts` | Soul.md parsing, snapshots, hot-reload |
| `config/config-manager.ts` | YAML config/secrets hot-reload watcher |
| `scheduler/index.ts` | pg-boss singleton + scheduling API |

## Configuration

Configuration is YAML-based in the workspace directory:

```yaml
# config.yaml
llm:
  model: "anthropic/claude-sonnet-4-5"
  fallbacks: [...]
  temperature: 0.7
  maxSteps: 10
  showThinking: false
memory:
  enabled: true
telegram:
  ownerId: 12345
tools:
  allowlist: "*"
  dangerousTools: ["run_command"]
  agentWorkspace: "/workspace"
  skillsDir: "/workspace/skills"
  mcpServers: [...]
```

Environment variables are defined in `.env.example`. Key variables include database connection strings, Telegram bot token, and LLM API keys.

## Database Schema

Key tables in `src/lib/db/schema.ts`:

- **conversations** - Chat history per chatId/agentId
- **jobs** - Background specialist/scheduled task jobs
- **agent_state** - Per-chat active agent
- **secret_requests** - Secure secret request flow
- **user_inputs** - User guidance requests
- **workflows** - Workflow definitions (JSONB nodes/edges)
- **workflow_runs** - Workflow execution runs
- **workflow_run_nodes** - Per-node execution state
- **workflow_hitl_requests** - Human-in-the-loop approvals

## Built-in Tools

From `src/lib/tools/built-in.ts`:

| Category | Tools |
|----------|-------|
| Terminal | `run_command`, `apply_patch` |
| Skills | `skill_list`, `skill_get`, `skill_save`, `skill_add_script`, `skill_delete` |
| Web | `web_search` (Brave), `web_fetch` |
| Memory | `rag_search`, `memory_read`, `memory_append`, `memory_delete` |
| Secrets | `request_secret` |
| Scheduling | `schedule_task`, `unschedule_task`, `list_schedules`, `get_schedule` |
| Browser | `browser_navigate`, `browser_snapshot`, `browser_get`, `browser_act`, `browser_screenshot`, `browser_close` |
| Todo | `todo_create`, `todo_add`, `todo_update`, `todo_clear` |
| Specialist | `resume_specialist` |
| Guidance | `request_guidance` |

## API Routes

The `src/app/api/` directory contains 50+ route handlers:

| Route Pattern | Purpose |
|---------------|---------|
| `/api/agents/[id]/*` | Agent CRUD (soul, identity, model, tools, rag, snapshots) |
| `/api/chat` | Web chat endpoint |
| `/api/tools` | Tool listing |
| `/api/skills/*` | Skill file management |
| `/api/memory/*` | Vector memory operations |
| `/api/soul/*` | Soul snapshots |
| `/api/workflow/*` | Workflow CRUD, run, stream, HITL resolve |
| `/api/logs/*` | Log streaming (SSE) and history |
| `/api/scheduled-tasks/*` | Cron task management |
| `/api/specialist/*` | Specialist resume/history |
| `/api/config/*` | Config/secrets management |
| `/api/webhook` | Telegram webhook |
| `/api/metrics` | Usage metrics |
| `/api/dashboard/login\|logout` | Dashboard auth |

## Workflow Node Types

Visual workflow editor using React Flow supports these node types:

| Node Type | Purpose |
|-----------|---------|
| `agent` | Spawns a specialist with task template |
| `parallel` | Fan-out signal |
| `condition` | JavaScript expression evaluation |
| `hitl` | Human-in-the-loop approval gate |
| `input/output` | Data entry and result collection |

## Running the Project

### Docker Services

Start required services:
```bash
docker-compose up -d
```

Services: `postgres:16-alpine`, `qdrant:latest`, `adminer`, `fastembed` (local embeddings)

### Development Commands

Check `package.json` for scripts. Typical commands:
```bash
npm run dev        # Start development server
npm run build      # Build for production
npm run lint       # Run linter
npx drizzle-kit    # Database migrations
```

### Starting the Telegram Bot

```bash
npx tsx scripts/run-bot.ts
```

## Skill Format

Skills are defined using the Anthropic SKILL.md format in `skills/<skill-name>/SKILL.md`. Each skill directory contains:

- `SKILL.md` - Skill definition with name, description, prompts, and tool definitions
- Supporting scripts and assets as needed

## Key Design Decisions

1. **Drizzle ORM** (not Prisma) for lighter footprint
2. **pg-boss over Redis** for built-in scheduling with PostgreSQL backend
3. **YAML config** for human-editable configuration files
4. **MCP for tools** as the standard tool protocol
5. **EventEmitter for streaming** (simple SSE vs WebSocket complexity)
6. **Workspace PVC** at `/workspace` survives pod restarts for persistent tools/data
7. **Stateless specialists** - no memory persistence across specialist calls
8. **Depth limit** - specialists cannot spawn further specialists (max depth 1)
