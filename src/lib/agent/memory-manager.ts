import fs from 'fs';
import path from 'path';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();
const MEMORY_PATH = path.join(WORKSPACE, 'MEMORY.md');

/**
 * Default soft budget (in estimated tokens) for Core Memory (issue #21). Core
 * Memory is injected into the system prompt on every request, so growth is
 * always-on cost. Above this budget it is likely accumulating episodic ballast
 * (dated findings, one-off gotchas) that belongs in the RAG layer instead.
 * Overridable via config `memory.coreSoftLimitTokens`.
 */
export const CORE_MEMORY_SOFT_LIMIT_TOKENS = 1500;

/** Same chars/token heuristic the #18 attribution tooling uses, kept local so
 * this module stays dependency-free. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.8);
}

class MemoryManager {
  getContent(): string {
    try {
      return fs.readFileSync(MEMORY_PATH, 'utf-8').trim();
    } catch {
      return '';
    }
  }

  write(content: string): void {
    fs.writeFileSync(MEMORY_PATH, content, 'utf-8');
  }

  append(fragment: string): void {
    const current = this.getContent();
    if (!current) {
      this.write(fragment.trim());
    } else {
      this.write(current + '\n\n' + fragment.trim());
    }
  }

  delete(fragment: string): boolean {
    const current = this.getContent();
    if (!current) return false;

    const trimmed = fragment.trim();
    // Try to find exact match with double newline separators
    // Pattern matches the fragment surrounded by newlines (start of string, double newline, or end)
    const pattern = new RegExp(
      '(^|\\n\\n)' + trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\n\\n|$)',
      's'
    );

    if (!pattern.test(current)) return false;

    const remaining = current.replace(pattern, '$1').replace(/^\n+|\n+$/g, '').trim();
    this.write(remaining);
    return true;
  }

  getPath(): string {
    return MEMORY_PATH;
  }

  /**
   * Size stats for Core Memory, used to surface the soft budget (#21) in the
   * memory_append tool result and the dashboard editor.
   */
  getStats(softLimitTokens: number = CORE_MEMORY_SOFT_LIMIT_TOKENS): {
    chars: number;
    approxTokens: number;
    softLimitTokens: number;
    overBudget: boolean;
  } {
    const chars = this.getContent().length;
    const approxTokens = estimateTokens(chars);
    return {
      chars,
      approxTokens,
      softLimitTokens,
      overBudget: approxTokens > softLimitTokens,
    };
  }
}

export const memoryManager = new MemoryManager();
export default MemoryManager;
