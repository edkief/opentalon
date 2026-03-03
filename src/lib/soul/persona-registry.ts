import fs from 'fs';
import path from 'path';
import SoulManager from './soul-manager';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();
const PERSONAS_DIR = path.join(WORKSPACE, 'personas');

export interface PersonaMeta {
  id: string;
  soulPreview: string;
}

class PersonaRegistry {
  /** Ensure the personas directory and "default" persona exist. Does NOT overwrite existing files. */
  ensureDefaults(): void {
    fs.mkdirSync(PERSONAS_DIR, { recursive: true });
    SoulManager.ensurePersonaDir('default');
  }

  listPersonas(): PersonaMeta[] {
    if (!fs.existsSync(PERSONAS_DIR)) return [];
    return fs
      .readdirSync(PERSONAS_DIR)
      .filter((name) => {
        const dir = path.join(PERSONAS_DIR, name);
        return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'Soul.md'));
      })
      .sort()
      .map((id) => {
        const soulPath = path.join(PERSONAS_DIR, id, 'Soul.md');
        const raw = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8').trim() : '';
        return { id, soulPreview: raw.slice(0, 120) };
      });
  }

  createPersona(id: string): void {
    if (!/^[a-z0-9_-]+$/.test(id)) {
      throw new Error('Persona ID must be lowercase alphanumeric with dashes/underscores only');
    }
    if (this.personaExists(id)) {
      throw new Error(`Persona "${id}" already exists`);
    }
    SoulManager.ensurePersonaDir(id);
  }

  deletePersona(id: string): void {
    if (id === 'default') throw new Error('Cannot delete the default persona');
    const dir = path.join(PERSONAS_DIR, id);
    if (!fs.existsSync(dir)) throw new Error(`Persona "${id}" not found`);
    fs.rmSync(dir, { recursive: true });
  }

  personaExists(id: string): boolean {
    const dir = path.join(PERSONAS_DIR, id);
    return fs.existsSync(dir) && fs.existsSync(path.join(dir, 'Soul.md'));
  }

  getSoulManager(personaId: string): SoulManager {
    return SoulManager.forPersona(personaId);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __personaRegistry: PersonaRegistry | undefined;
}

if (!globalThis.__personaRegistry) {
  globalThis.__personaRegistry = new PersonaRegistry();
}

export const personaRegistry = globalThis.__personaRegistry;
export default PersonaRegistry;
