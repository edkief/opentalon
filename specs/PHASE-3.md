In **Phase 3**, we transform **OpenPincer** from a chatbot into an **Active Agent**. This phase focuses on **Capability (Skills)** and **Delegation (Sub-Agents)**.

Instead of just talking about a problem, OpenPincer will now have the "hands" to solve them via the **Model Context Protocol (MCP)** and the ability to spawn specialized "worker" agents for complex, multi-step tasks.

---

## Phase 2 Recap & Phase 3 Goal

* **Phase 1 & 2:** Provided the **Brain** (LLM), **Voice** (Telegram), and **Memory** (Qdrant).
* **Phase 3 Goal:** Provide **Agency**. Enable the "Supervisor" agent to use tools and manage "Specialist" sub-agents.

---

## Phase 3 Spec: Agency & Orchestration

### 1. Technical Stack (Tooling & Orchestration)

* **Tooling Standard:** Anthropic Skills (https://github.com/anthropics/skills/blob/main/skills/canvas-design/SKILL.md) and **Model Context Protocol (MCP)** SDK.
* **Orchestration Pattern:** **Supervisor-Worker** (via Vercel AI SDK `tools`).
* **Execution Sandbox:** `isolated-vm` (for safe "Skill" execution) or local shell execution (if running inside your K8s management node).
* **State Management:** Redis or Postgres (to track "Jobs" that sub-agents are performing).

---

### 2. Key Components & Logic

#### **A. The MCP Tool Registry (`/lib/tools/registry.ts`)**

OpenPincer doesn't hardcode tools. It connects to **MCP Servers**.

* **Logic:** On startup, OpenPincer connects to specified MCP servers (e.g., a Google Drive server, a GitHub server, or a custom K8s-management server).
* **Dynamic Discovery:** Tools are pulled from the MCP server and converted into Vercel AI SDK `tool` objects automatically.

#### **B. The "Specialist" Factory (`/lib/agent/specialist.ts`)**

A utility to spawn a transient, focused agent.

* **The `spawn_specialist` Tool:** This is a tool available to the Main Supervisor.
* **Arguments:** `task_description`, `required_tools`, `context_snapshot`.
* **Execution:** 1.  Create a new `BaseAgent` instance.
2.  Inject a "Constrained System Prompt" (e.g., "You are a log analysis expert. Your only goal is to find the root cause of this error.").
3.  Execute the task and return the final string to the Supervisor.

#### **C. Human-in-the-Loop (HITL) Pipeline**

Even if not fully enforced in the MVP, the architecture must support it.

* **Logic:** If a tool is marked as `dangerous: true`, the agent sends a Telegram message with an **Inline Keyboard** (Approve/Deny). The execution pauses until the `callback_query` is received.

---

### 3. Implementation Build Order

#### **Step 1: MCP Client Setup**

* Install the `@modelcontextprotocol/sdk`.
* Create a simple MCP local server that can "Read a File" or "List K8s Pods."
* **Test:** Have the agent successfully list your pods when asked via Telegram.

#### **Step 2: Tool Calling Integration**

* Update the `BaseAgent` to use the `tools` property in `generateText`.
* Ensure the agent can "Loop" (execute tool -> observe result -> generate final response).
* **Test:** "OpenPincer, check the logs of the `openclaw-gateway` pod and tell me if there are any 500 errors."

#### **Step 3: The `spawn_specialist` Tool**

* Define a tool that recursively calls the `BaseAgent` logic with a different prompt.
* Implement a "Depth Limit" (max 1 level deep) to prevent infinite agent-spawning loops.
* **Test:** "OpenPincer, I have a massive log file. Spawn a researcher to summarize the key events and give me a 3-bullet point report."

#### **Step 4: Sub-Agent Context Handoff**

* Refine how data is passed. The Supervisor should summarize the "Story so far" for the Specialist so the Specialist doesn't have to re-read the entire Qdrant history.
* **Test:** Ensure the Specialist knows the user's name and the specific problem without having its own RAG access.

#### **Step 5: Telemetry & Monitoring**

* Update the Web UI to show a **Tree View** of agent activity.
* Supervisor -> (Tool: `spawn_specialist`) -> Specialist -> (Tool: `read_file`) -> Result.

---

### 4. Technical Constraints for Phase 3

* **Recursion Limit:** Specialists cannot spawn further Specialists (keeps it "Lite").
* **Stateless Specialists:** Once a Specialist returns its result, its memory is wiped. Only the Supervisor's "Long-term Memory" persists.
* **Timeout:** Sub-agent tasks must complete within 60 seconds or "Time out" to prevent hanging Telegram processes.

---

### 5. Summary of the "OpenPincer" Architecture

By the end of Phase 3, you have a system where:

1. **You** talk to the **Supervisor** (OpenPincer) via **Telegram**.
2. **OpenPincer** checks **Qdrant** for past context.
3. **OpenPincer** uses **MCP Tools** to touch your infrastructure.
4. **OpenPincer** spawns **Specialists** to do the "heavy lifting" of data analysis.
5. **You** monitor it all through a **Next.js Dashboard**.

### Would you like me to...

* Show you how to define the **`spawn_specialist` tool schema** in TypeScript?
* Provide a **Base MCP Server template** for your Kubernetes interactions?
* Draft the **Phase 4: Web UI** specs (Monitoring & Management)?

[Orchestrating multiple AI agents with a supervisor-specialist pattern](https://www.google.com/search?q=https://www.youtube.com/watch%3Fv%3DR9K49E_K_U8)
This video explains the design patterns for multi-agent systems, specifically how a supervisor agent can manage specialized workers—a concept central to Phase 3 of your OpenPincer project.