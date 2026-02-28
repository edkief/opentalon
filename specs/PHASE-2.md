With Phase 1 focusing on the "Brain" and communication, **Phase 2** is about giving the agent a **Long-Term Memory** and **Contextual Awareness**.

In 2026, the standard for high-performance memory is **Hybrid Search**—combining the "vibe" of semantic search with the "precision" of keyword matching. This ensures your agent remembers the difference between `hpg4` and `hpg5` without getting confused by their semantic similarity.

---

## Phase 2 Spec: Long-Term Memory (RAG)

### 1. Updated Tech Stack (Memory Additions)

* **Embedding Model:** `text-embedding-3-small` (OpenAI) or `bge-m3` (for native Hybrid support).
* **Sparse Vector Generation:** `bm25-node` or Qdrant's native **FastEmbed** integration.
* **Orchestration:** **Vercel AI SDK `Middleware**` (to intercept and inject context).

---

### 2. Key Components & Logic

#### **A. The Hybrid Ingestion Pipeline (`/lib/memory/ingest.ts`)**

Every message handled in Phase 1 now triggers a background "Upsert" to Qdrant.

* **Dense Vector:** Captures the *meaning* (e.g., "troubleshooting storage").
* **Sparse Vector:** Captures the *keywords* (e.g., `nvme0n1p1`, `pvc-123`).
* **Payload Metadata:** ```json
{
"chat_id": "12345",
"scope": "private", // or "shared"
"author": "user",
"timestamp": 1738820000,
"text": "The nvme drive is full"
}
```


```



#### **B. The Scoped Retrieval Engine (`/lib/memory/retrieve.ts`)**

This function performs a single, unified query to Qdrant using **Reciprocal Rank Fusion (RRF)**.

* **Logic:** 1. Turn the user's current query into a dense and sparse vector.
2. Query Qdrant with a **Filter**: `must: { key: "scope", match: { value: current_scope } }`.
3. Retrieve the top 5 results where the scores from both vector types are fused.

#### **C. RAG Middleware (`/lib/agent/middleware.ts`)**

Instead of manually pasting context into every prompt, use the Vercel AI SDK's **Language Model Middleware**.

* **Action:** Intercept the `generateText` call, run the retrieval engine, and prepend the results to the `system` prompt as `## Past Relevant Context`.

---

### 3. Implementation Build Order

#### **Step 1: Qdrant Collection Config**

Initialize your Qdrant collection with **two named vectors**:

* `dense`: (e.g., 1536 dims for OpenAI).
* `sparse`: (using BM25 or Qdrant's `modifier: idf`).

#### **Step 2: Background Ingestion**

Update your Telegram message handler. After the agent responds, fire off an async function (don't make the user wait) that embeds the message and stores it in Qdrant.

* **Test:** Use the Qdrant Dashboard to verify that "points" are appearing with the correct `scope` tags.

#### **Step 3: The Retrieval Tool**

Create a standalone function `getRelatedContext(query, scope)`.

* **Test:** Write a small script to query "K8s storage" and ensure it returns your Phase 1 troubleshooting logs.

#### **Step 4: AI SDK Middleware Integration**

Wrap your LLM provider with the `retrieve_middleware`.

```typescript
const modelWithMemory = wrapLanguageModel({
  model: anthropic('claude-3-5-sonnet-latest'),
  middleware: [ragMiddleware], // Automatically pulls context from Qdrant
});

```

#### **Step 5: The "Memory Refresh" (Optional MVP+)**

Implement a simple "Forget" command or a way to prune old/irrelevant memories from the Web UI to keep the context window clean.

---

### 4. Technical Constraints

* **Latency Budget:** Retrieval + Embedding should add no more than **300ms** to the total response time.
* **Privacy First:** If a query comes from a **Group Chat**, the `scope: "private"` filter must be hard-coded into the retrieval function—never rely on the LLM to filter this.
