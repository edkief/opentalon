import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const WORKSPACE = process.env.AGENT_WORKSPACE ?? process.cwd();
const SKILLS_DIR = path.join(WORKSPACE, 'skills');

function getSkillDir(skillName: string) {
  return path.join(SKILLS_DIR, skillName);
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

export function listSkills(): string[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name)
    .sort();
}

export function listSkillFiles(skillName: string): FileNode[] {
  const skillDir = getSkillDir(skillName);
  if (!fs.existsSync(skillDir)) {
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
  const fullPath = path.join(getSkillDir(skillName), filePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return fs.readFileSync(fullPath, 'utf-8');
}

export function writeSkillFile(skillName: string, filePath: string, content: string): void {
  const fullPath = path.join(getSkillDir(skillName), filePath);
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
