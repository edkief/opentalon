/**
 * In-process registry of AbortControllers for running specialist jobs.
 * Keyed by specialistId. Populated when a specialist starts, removed when it finishes.
 *
 * This only works within a single process — for the pg-boss background path the
 * bot process is the only one actually executing LLM calls, so the cancel API
 * route signals the same process via this map.
 */
const registry = new Map<string, AbortController>();

export const cancellationRegistry = {
  register(specialistId: string): AbortController {
    const controller = new AbortController();
    registry.set(specialistId, controller);
    return controller;
  },

  cancel(specialistId: string): boolean {
    const controller = registry.get(specialistId);
    if (!controller) return false;
    controller.abort();
    return true;
  },

  unregister(specialistId: string): void {
    registry.delete(specialistId);
  },

  isRegistered(specialistId: string): boolean {
    return registry.has(specialistId);
  },
};
