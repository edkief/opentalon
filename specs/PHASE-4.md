Phase 4 is about giving **OpenPincer** its "Eyes." We are building a high-performance **Control Plane** using Next.js 15 and Shadcn/ui. In 2026, the trend is "minimal chrome, maximum data"—focusing on real-time observability of the agent's thought process rather than just a chat history.

---

## Phase 4 Spec: The Control Plane (Web UI)

### 1. Technical Stack (UI & Observability)

* **Framework:** **Next.js 15** (App Router) with Partial Prerendering (PPR).
* **Styling:** **Tailwind CSS v4** + **Shadcn/ui** (using the new "App Blocks" registry).
* **Streaming:** **Server-Sent Events (SSE)** via Next.js Route Handlers (preferred over WebSockets for one-way log streaming).
* **Visualizations:** **Shadcn Charts** (Recharts-based) for token usage and latency metrics.
* **Editor:** **Monaco Editor** or `tiptap` for live-editing the `Soul.md` markdown.

---

### 2. Key UI Sections

#### **A. The "Thought Stream" (Real-time Logging)**

Unlike a standard chat, this is a technical log of the agent's internal loop.

* **Logic:** The backend pipes the Vercel AI SDK `onStepFinish` callbacks to an SSE stream.
* **UI:** A virtualized terminal-style list.
* **Features:** * **Verbose Toggle:** Switch between "Human readable" and "Raw JSON" (showing actual tool calls and Qdrant search scores).
* **Trace ID:** Click a log to see exactly which RAG memories were retrieved for that specific thought.



#### **B. The Memory Explorer (Qdrant CRUD)**

A table view of your long-term memory.

* **Features:** * Filter by `scope` (Private vs. Group).
* **Search-the-Search:** Manually test Qdrant queries to see what the agent "sees."
* **Pruning:** Delete or edit specific "facts" the agent has learned if it hallucinates or stores outdated info.



#### **C. Identity & Soul Management**

A dedicated page for the `Soul.md` file.

* **Features:** * **Hot-Swap Persona:** Change the markdown file and hit "Save" to immediately update the agent's system prompt.
* **Version Control:** Simple "Snapshots" of your soul so you can revert if a prompt change makes the agent unstable.



#### **D. Orchestration Tree (Sub-Agent Visualization)**

A visual representation of the **Supervisor-Specialist** hierarchy.

* **UI:** A hierarchical tree or "Flow" diagram showing active specialists.
* **Data:** Shows which specialist is currently "running," their specific task, and their time-to-completion.

---

### 3. Implementation Build Order

#### **Step 1: Dashboard Shell & SSE Setup**

* Scaffold the `/dashboard` route with a sidebar and top-nav using Shadcn's dashboard blocks.
* Create a Next.js Route Handler `/api/logs/stream` that pulls from a Redis pub/sub or a shared event emitter.
* **Test:** Use `curl` to see the log stream in your terminal.

#### **Step 2: The Thought Stream Component**

* Build the frontend log viewer. Use `react-virtuoso` for smooth scrolling through thousands of lines of logs.
* **Test:** Trigger a Telegram message and watch the logs appear in the Web UI in real-time.

#### **Step 3: Memory Table (Drizzle + Qdrant)**

* Create a page `/dashboard/memory`. Fetch data directly from Qdrant via a Server Component.
* Add an "Edit/Delete" modal using Shadcn's `Dialog` component.
* **Test:** Update a memory in the UI and verify it changes the agent's response on Telegram.

#### **Step 4: The "Soul" Editor**

* Integrate a Markdown editor on `/dashboard/soul`.
* Implement a `POST` route that overwrites the `assets/Soul.md` file (or updates it in Postgres).
* **Test:** Change the agent's name in `Soul.md` via the UI and check if it introduces itself with the new name.

#### **Step 5: Metrics & Costs Dashboard**

* Use Shadcn Charts to plot token usage per day and average response latency.
* **Test:** Confirm you can see the cost spike after spawning multiple specialists.

---

### 4. Technical Constraints

* **Latency:** The UI should be **Read-Only by default** to prevent blocking the agent's performance.
* **Security:** Since this dashboard controls your K8s/AWS "hands," ensure the `/dashboard` route is protected by **NextAuth.js** or a simple Cloudflare Access layer.

### Would you like me to...

* Provide a **Next.js Route Handler** example for the SSE log stream?
* Show the **Shadcn Chart configuration** for tracking agent token usage?
* Draft the **Final System Architecture** diagram for the entire OpenPincer project?

[Building a Real-time AI Dashboard with Next.js 15 and SSE](https://www.youtube.com/watch?v=FhbNw_8VYAo)
This video demonstrates how to implement real-time agent monitoring and log streaming within a Next.js 15 environment, covering the exact "Control Plane" concepts we've discussed for Phase 4 of OpenPincer.