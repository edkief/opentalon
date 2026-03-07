import fs from 'fs';
import path from 'path';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();
const MEMORY_PATH = path.join(WORKSPACE, 'Memory.md');

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
}

export const memoryManager = new MemoryManager();
export default MemoryManager;
