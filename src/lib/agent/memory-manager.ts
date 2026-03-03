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

  getPath(): string {
    return MEMORY_PATH;
  }
}

export const memoryManager = new MemoryManager();
export default MemoryManager;
