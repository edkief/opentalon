# Agentic Best-Practices Review — LLM Invocation, Tools, Skills & MCP

**Date:** 2026-07-11
**Scope:** `src/lib/agent/llm-executor.ts` and adjacent modules:
`agent/specialist.ts`, `agent/middleware.ts`, `agent/model-resolver.ts`, `agent/turn-parts.ts`,
`agent/hitl.ts`, `tools/registry.ts` (MCP), `tools/built-in.ts` + sub-modules (`terminal.ts`,
`skills.ts`), `telegram/tools.ts`.

**Goal:** Assess how LLM invocation, tool calling, skill loading, and MCP integration follow
agentic best practices, and produce handover-ready recommendations.

## Summary of findings

| # | Recommendation | Severity | Effort |
|---|----------------|----------|--------|
| 1 | Fix `maxTokens` → `maxOutputTokens` (silently ignored on ai@6) | 🔴 Bug | S |
| 2 | Apply tool-result compression middleware to specialists | 🔴 High | S |
| 3 | Abort specialist work on timeout (don't leak the generation) | 🔴 High | S |
| 4 | Preserve full JSON Schema fidelity for MCP tools | 🟠 High | M |
| 5 | Make the system prompt cache-friendly (stable prefix + dynamic tail) | 🟠 High | M |
| 6 | Retrieve RAG context once per turn, not once per step | 🟠 Medium | M |
| 7 | Classify errors before falling back across models | 🟠 Medium | M |
| 8 | Fix temperature precedence (per-agent should beat global) & lower default for tool loops | 🟡 Medium | S |
| 9 | Route auxiliary turns (finalise, todo-check, max-steps summary) to a cheaper model | 🟡 Medium | M |
| 10 | Standardize tool error semantics and result envelopes | 🟡 Medium | M |
| 11 | Close MCP gaps: per-agent allowlist, dangerous-name prefixing, non-text results | 🟡 Medium | M |
| 12 | Event-driven specialist await + structured specialist result contract | 🟡 Medium | M |
| 13 | Smaller hardening items (batched) | 🟢 Low | S |

Full detail and per-item implementation plans: [recommendations.md](./recommendations.md)

## What's already good

Worth calling out — these follow best practice and should be preserved:

- **Tool-history replay** (`turn-parts.ts`): persisting and replaying tool-call/result parts so
  the model never learns "narrating work = doing work". Sanitization of orphaned call/result
  pairs is exactly right.
- **Tool-result compression with recovery path** (`middleware.ts`): head+tail truncation with the
  full output offloaded to a file the agent can `read_file` back — a proper "context editing with
  escape hatch" pattern (main-agent path only; see rec #2).
- **Progressive skill disclosure**: system prompt lists name+description only; `skill_get` loads
  full instructions on demand. This matches the Anthropic SKILL.md loading model.
- **Depth-limited specialists** with defensive tool stripping (`spawn_specialist`/`await_specialists`
  removed from child toolsets), scoped todo tools, and abort registration.
- **Max-steps and token-limit cutoffs surfaced honestly** to the user rather than silently
  returning partial output.
- **HITL gate for dangerous tools** with auto-deny timeout and allowlist auto-approval.
