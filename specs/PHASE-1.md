## Phase 1 Spec: Core Identity & Communication

### 1. Technical Stack (Latest Stable - Feb 2026)

* **Runtime:** Node.js `v24.x`
* **Framework:** Next.js `16.x` (App Router)
* **LLM SDK:** `ai@6.0.104` (Vercel AI SDK)
* **Telegram:** `grammy@1.40.0`
* **Vector Client:** `@qdrant/js-client-rest@1.17.0`
* **ORM:** `drizzle-orm@0.45.1` (with `postgres` for session state)

---

### 2. Key Components & Logic

#### **A. The Soul Engine (`/lib/soul/`)**

Instead of hardcoding prompts, we implement a `SoulManager` that watches a `Soul.md` file.

* **Feature:** Hot-reloading system prompts.
* **Logic:** A utility that reads `Soul.md`, parses any frontmatter (using `gray-matter`) for configuration (like `temperature` or `model`), and returns the raw string for the `system` property of the LLM call.

#### **B. The Base Agent (`/lib/agent/base-agent.ts`)**

A class-based wrapper around the Vercel AI SDK `generateText` or `streamText` functions.

* **Stability Goal:** Implement robust error handling and "Fallback Providers." If Anthropic fails, automatically retry with OpenAI or a local Ollama instance.
* **Logic:**
```typescript
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export class BaseAgent {
  async chat(messages: Message[], context: string = "") {
    return await generateText({
      model: anthropic('claude-3-5-sonnet-latest'),
      system: `${this.soulContents}\n\nContext: ${context}`,
      messages,
      // Phase 1: Simple text, Phase 2: Add tools
    });
  }
}

```



#### **C. The Telegram Bridge (`/lib/telegram/bot.ts`)**

Using `grammY` for high-speed, type-safe interaction.

* **Logic:**
* **Direct Messages:** Always respond.
* **Group Chats:** Use the `filter` middleware to only respond when the bot is @mentioned.
* **Session Management:** Use `drizzle-orm` to persist the last 10 message IDs per `chat_id` to maintain a short-term conversation "window."



---

### 3. Implementation Build Order

Follow this sequence to ensure each step is testable before moving to the next.

#### **Step 1: Environment & Soul**

* Initialize Next.js project.
* Create `assets/Soul.md` with your persona.
* Write `getSoul()` utility to read this file.
* **Test:** Create a simple CLI script `npm run test-soul` that prints the parsed persona to the terminal.

#### **Step 2: LLM Integration**

* Configure the Vercel AI SDK with your chosen provider.
* Build the `BaseAgent` class.
* **Test:** Create a Next.js API Route `/api/chat` that accepts a string and returns a response based on the `Soul.md` personality.

#### **Step 3: Telegram Basic Connection**

* Initialize the `grammY` bot.
* Implement a `/start` command and a basic "Echo" handler.
* **Test:** Send a message to the bot on Telegram and receive an echo.

#### **Step 4: The Integration (The "Brain" Connects)**

* Connect the Telegram handler to the `BaseAgent`.
* Pass the `ctx.message.text` to `agent.chat()`.
* **Stability Check:** Wrap the LLM call in a `try/catch`. If it fails, have the bot reply: *"My brain is a bit foggy right now, give me a second..."* and retry.

#### **Step 5: Short-term Persistence**

* Setup Drizzle and a simple `conversations` table.
* Store `role` and `content` for each message.
* Pass the last 5 messages as `initialMessages` to the Vercel AI SDK.
* **Test:** Ask the bot "What is my name?" after telling it your name in a previous message.

---

### 4. Technical Constraints for Phase 1

* **No RAG yet:** We will use a "blind" agent for the first 48 hours to ensure the Telegram-to-LLM pipeline is 100% stable.
* **No Sub-agents:** Everything runs in the main thread.
* **Manual Soul Sync:** If you edit `Soul.md`, the app must be restarted (or use a file watcher in dev mode).

**Does this build order align with your current development workflow, or would you like to prioritize the Qdrant connection earlier for immediate "Long-term Memory"?**