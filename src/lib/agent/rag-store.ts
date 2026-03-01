/**
 * In-process store that lets the RAG middleware pass retrieved context
 * to the onStepFinish callback without threading it through the AI SDK.
 *
 * Keys are chatId strings; values are the last retrieved memoryContext string.
 * consumeRagContext clears the entry so each step only carries its own context.
 */

const store = new Map<string, string>();

export function setRagContext(chatId: string, context: string): void {
  store.set(chatId, context);
}

export function consumeRagContext(chatId: string): string | undefined {
  const ctx = store.get(chatId);
  store.delete(chatId);
  return ctx;
}
