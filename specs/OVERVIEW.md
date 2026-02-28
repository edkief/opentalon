## Project Spec: **OpenPincer** (OpenClaw-Refined)

**OpenPincer** is a lightweight, high-stability AI agent framework designed to act as a Personal Assitant. It prioritizes architectural clarity, persistent memory via Qdrant, and a "Supervisor-Specialist" orchestration model.

---

### 1. Core Tech Stack (2026 Latest)

| Component | Technology | Version / Notes |
| --- | --- | --- |
| **Runtime** | **Node.js** | v22+ (LTS) |
| **Framework** | **Next.js** | v15+ (App Router) |
| **LLM SDK** | **Vercel AI SDK** | v3.1+ (Unified provider API) |
| **Database (Vector)** | **Qdrant** | v1.12+ (Self-hosted via K8s) |
| **Database (Relational)** | **PostgreSQL** | v16+ (via Drizzle ORM) |
| **Telegram API** | **grammY** | v1.20+ (Type-safe bot framework) |
| **Tooling Standard** | **MCP SDK** | Latest (@modelcontextprotocol/sdk) |
| **Styling** | **Tailwind + Shadcn** | For the Monitoring Web UI |

---

### 2. Key Architectural Features

#### **A. Scoped Context Memory (Qdrant)**

* **Hybrid Search:** Every query uses both Dense (semantic) and Sparse (keyword) vectors to ensure technical terms (like `nvme0n1p1`) are never missed.
* **Privacy Guard:** Memories are tagged with `scope: "private"` (DMs) or `scope: "shared"` (Groups). The agent automatically filters results based on the incoming message's `chat_id`.
* **Identity:** The `Soul.md` file is the source of truth for the agent’s personality and is injected into the System Prompt on every run.

#### **B. Supervisor-Specialist Orchestration**

* **The Supervisor:** The main agent you interact with. It holds the "Long-term Memory" and decides when a task is too complex for a single turn.
* **The Specialist:** A transient, stateless sub-agent spawned via a tool call (`spawn_specialist`). It receives a "Context Snapshot" (read-only) and returns a structured JSON result to the Supervisor.

#### **C. Light Web UI (The "Control Plane")**

* **Live Logs:** A stream of the agent's internal "thought process" (thought chain) and tool execution.
* **Memory Management:** A simple interface to view/edit the Qdrant vector store "facts" and update the `Soul.md`.

---

### 3. Implementation-Friendly Build Order

This order minimizes "circular dependencies" and ensures you have a working bot as early as possible.

#### **Phase 0: The Infrastructure (Foundation)**

1. **K8s Setup:** Deploy a Qdrant `StatefulSet` with a PersistentVolumeClaim (PVC).
2. **Project Init:** Scaffold the Next.js app with Tailwind, Drizzle (Postgres), and the Vercel AI SDK.
3. **The "Empty Shell":** Create a basic `BaseAgent` class that can take a string and return an LLM response using a `Soul.md` file stored in `/assets`.

#### **Phase 1: The "Nervous System" (Communication)**

1. **Telegram Bot:** Integrate `grammY`. Ensure the bot can echo messages and recognize the difference between a DM and a Group mention.
2. **Scoped Logic:** Implement the middleware that identifies the user and checks for `is_admin` status.

#### **Phase 2: The "Memory" (RAG)**

1. **Qdrant Integration:** Write the "Ingestion" pipeline—every message from the user is embedded and saved with metadata (`chat_id`, `timestamp`, `scope`).
2. **Hybrid Retrieval:** Implement the `retrieve_context` function that queries Qdrant using the Hybrid (Dense+Sparse) method.
3. **The Loop:** Update the `BaseAgent` to perform a RAG step before generating every response.

#### **Phase 3: The "Hands" (Tools & Sub-Agents)**

1. **MCP Implementation:** Register a few basic tools (e.g., `check_k8s_status`, `read_file`).
2. **Specialist Factory:** Create the `spawn_specialist` utility. Test it by having the Main Agent ask a sub-agent to "summarize this technical log."

#### **Phase 4: The "Eyes" (Monitoring UI)**

1. **Logging Stream:** Use Server-Sent Events (SSE) or WebSockets to stream agent logs to a `/dashboard` page.
2. **Identity Editor:** Build a simple Markdown editor in the UI to live-update `Soul.md`.

#### **Phase 5: The "Outer Loop" (Optimization & Vision)**

1. Multimodal Feedback: Update the Telegram bridge for vision-based diagnostics and implement Qdrant's Relevance Feedback API to learn from user corrections.
2. Automated Evals: Integrate a continuous evaluation pipeline using Promptfoo to run regression tests against the Soul.md and tool performance.