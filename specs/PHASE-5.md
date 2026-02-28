Phase 5 is the final evolution of **OpenPincer**, moving it from a tool that follows instructions to a system that **learns from its environment**. In 2026, the focus for top-tier agents is "relevance feedback" and "multimodal reasoning"—allowing the agent to see what you see and adjust its behavior based on your corrections.

---

## Phase 5 Spec: Self-Optimization & Multimodal Perception

### 1. Technical Stack (The 2026 "Outer Loop")

| Component | Technology | Version / Notes |
| --- | --- | --- |
| **Vision/Multimodal** | **Claude 3.5 Sonnet / GPT-4o** | Via Vercel AI SDK 6 `experimental_attachments` |
| **Vector Engine** | **Qdrant** | v1.17+ (Utilizing **Relevance Feedback Query**) |
| **Optimization** | **DSPy** | For programmatic prompt optimization and few-shot mining |
| **Continuous Eval** | **Promptfoo** | Automated red-teaming and regression testing in K8s |

---

### 2. Key Architectural Features

#### **A. Multimodal Vision (The "See what I see" feature)**

OpenPincer handles technical visual data (Grafana dashboards, terminal screenshots, architectural diagrams) as first-class input.

* **Logic:** The `grammY` Telegram handler is updated to intercept `photo` and `document` types. It downloads the file, generates a temporary URL/Buffer, and passes it to the `BaseAgent` using the AI SDK's multimodal parts.
* **Contextual Awareness:** The agent uses vision to interpret errors that are hard to copy-paste (e.g., a "Red" status light in a monitoring UI).

#### **B. Qdrant-Native Relevance Feedback**

Instead of a simple "Add this to memory" tool, we use **Qdrant 1.17’s Relevance Feedback API**.

* **The "Correction" Loop:** When you say *"That was the wrong way to restart the service,"* the agent triggers a `record_feedback` tool.
* **Technical Implementation:** This doesn't just store a text string; it stores a **Positive/Negative triplet** in Qdrant. In future queries, the agent uses the `recommend` API to "nudge" its search results toward your preferred methods and away from the "wrong" ones.

#### **C. Automated Regression Evals (The "Safety Net")**

To ensure your `Soul.md` updates don't break OpenPincer's core stability, we implement a CI/CD loop.

* **Logic:** Every time a change is pushed to the `Soul.md` or Tool definitions, a **Promptfoo** container runs on your cluster.
* **Assertions:** It runs 20+ "Golden Scenarios" (e.g., *"Troubleshoot hpg4 storage"*). If the agent fails to mention `nvme0n1p1` (which it previously knew), the build is flagged as "Regressed."

---

### 3. Implementation Build Order (Phase 5)

#### **Step 1: Multimodal Telegram Ingestion**

* Update the bot to handle incoming media.
* **Test:** Drop a screenshot of your `kubectl get pods` output and ask: "Which pod is crashing?"

#### **Step 2: Integration of Qdrant "Recommend" API**

* Modify the RAG retrieval function. Instead of just `search`, use the `recommend` endpoint.
* **Logic:** Pass the current user query as the "target" and any previous "Positive/Negative" interactions as the guiding vectors.
* **Test:** Correct the agent once. Verify that in the next conversation, it prioritizes the "Corrected" behavior.

#### **Step 3: Automated Eval Suite**

* Initialize `promptfooconfig.yaml` in your repo.
* Define your "Success Metrics" (e.g., Latency < 5s, Correct Tool Called).
* **Test:** Run `npx promptfoo eval` locally and view the matrix in the web viewer.

#### **Step 4: DSPy Optimization (Optional/Advanced)**

* Use **DSPy** to "compile" your `Soul.md`. It will look at your successful Qdrant memories and automatically generate "Few-shot examples" to include in the system prompt for better accuracy.

---

### 4. Technical Constraints for Phase 5

* **Qdrant Isolation:** Ensure the "Negative Feedback" vectors are scoped strictly to the specific sub-agent or user to avoid "Correction Leakage" across different tasks.
* **Vision Latency:** Use a "Compressed Preview" for vision tasks unless the agent specifically requests the "High-Res" original for detailed log reading.
