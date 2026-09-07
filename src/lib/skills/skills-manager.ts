import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();
const SKILLS_DIR = path.join(WORKSPACE, 'skills');
const SYSTEM_SKILLS_DIR = process.env.SYSTEM_SKILLS_DIR ?? path.join(process.cwd(), 'system-skills');

function getSkillDir(skillName: string) {
  return path.join(SKILLS_DIR, skillName.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

function getSystemSkillDir(skillName: string) {
  return path.join(SYSTEM_SKILLS_DIR, skillName.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

function resolveChildPath(root: string, filePath: string): string {
  const fullPath = path.resolve(root, filePath);
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Invalid skill file path: ${filePath}`);
  }
  return fullPath;
}

function resolveSkillDir(skillName: string): string | null {
  const workspace = getSkillDir(skillName);
  if (fs.existsSync(path.join(workspace, 'SKILL.md'))) return workspace;
  const system = getSystemSkillDir(skillName);
  if (fs.existsSync(path.join(system, 'SKILL.md'))) return system;
  return null;
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

export function listSkills(): string[] {
  const names = new Set<string>();
  for (const root of [SKILLS_DIR, SYSTEM_SKILLS_DIR]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'SKILL.md'))) {
        names.add(entry.name);
      }
    }
  }
  return [...names].sort();
}

export function listSkillFiles(skillName: string): FileNode[] {
  const skillDir = resolveSkillDir(skillName);
  if (!skillDir || !fs.existsSync(skillDir)) {
    return [];
  }

  function buildTree(dirPath: string, relativePath: string): FileNode[] {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .map(entry => {
        const entryRelativePath = path.join(relativePath, entry.name);
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          return {
            name: entry.name,
            path: entryRelativePath,
            isDirectory: true,
            children: buildTree(entryPath, entryRelativePath),
          };
        }
        return {
          name: entry.name,
          path: entryRelativePath,
          isDirectory: false,
        };
      })
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
  }

  return buildTree(skillDir, '');
}

export function readSkillFile(skillName: string, filePath: string): string {
  const skillDir = resolveSkillDir(skillName);
  if (!skillDir) throw new Error(`Skill not found: ${skillName}`);
  const fullPath = resolveChildPath(skillDir, filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return fs.readFileSync(fullPath, 'utf-8');
}

export function writeSkillFile(skillName: string, filePath: string, content: string): void {
  if (!fs.existsSync(path.join(getSkillDir(skillName), 'SKILL.md')) && resolveSkillDir(skillName) === getSystemSkillDir(skillName)) {
    throw new Error(`System skill "${skillName}" is read-only; create a workspace override first`);
  }
  const fullPath = resolveChildPath(getSkillDir(skillName), filePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, content, 'utf-8');
}

export function createSkill(name: string, description: string, content: string): void {
  const skillDir = getSkillDir(name);
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }
  const markdown = matter.stringify(content.trim(), { name, description, license: 'None' });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), markdown, 'utf-8');
}

export function deleteSkill(name: string): void {
  const skillDir = getSkillDir(name);
  if (!fs.existsSync(skillDir)) {
    if (fs.existsSync(getSystemSkillDir(name))) {
      throw new Error(`System skill "${name}" is read-only`);
    }
    throw new Error(`Skill not found: ${name}`);
  }
  fs.rmSync(skillDir, { recursive: true, force: true });
}
