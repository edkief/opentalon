'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ChevronRight, File, Folder, FolderOpen, Plus, Trash2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { useTheme } from '@/hooks/use-theme';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    json: 'json',
    js: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    jsx: 'javascript',
    py: 'python',
    sh: 'shell',
    bash: 'shell',
    dockerfile: 'dockerfile',
  };
  return langMap[ext] || 'plaintext';
}

function FileTreeNode({
  node,
  selectedPath,
  onSelect,
  depth = 0,
}: {
  node: FileNode;
  selectedPath: string | null;
  onSelect: (node: FileNode) => void;
  depth?: number;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const isSelected = !node.isDirectory && selectedPath === node.path;

  const handleClick = () => {
    if (node.isDirectory) {
      setIsOpen(!isOpen);
    } else {
      onSelect(node);
    }
  };

  const Icon = node.isDirectory
    ? (isOpen ? FolderOpen : Folder)
    : File;

  return (
    <div>
      <button
        onClick={handleClick}
        className={[
          'flex items-center gap-1.5 w-full py-1 px-2 text-sm rounded-md transition-colors text-left',
          isSelected
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        ].join(' ')}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {node.isDirectory && (
          <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        )}
        {!node.isDirectory && <span className="w-3" />}
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
      {node.isDirectory && isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function SkillsPage() {
  const { isDark } = useTheme();
  const [skills, setSkills] = useState<string[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [showNewSkill, setShowNewSkill] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillDescription, setNewSkillDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const editorRef = useRef<unknown>(null);
  const handleSaveRef = useRef<() => void>(() => {});

  const isDirty = content !== savedContent;
  const canSave = isDirty && saveStatus === 'idle';

  const loadSkills = useCallback(() => {
    setLoading(true);
    fetch('/api/skills')
      .then((r) => r.json())
      .then((d: { skills: string[] }) => setSkills(d.skills || []))
      .catch(() => setSkills([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const loadFiles = useCallback((skillName: string) => {
    fetch(`/api/skills/${skillName}/files`)
      .then((r) => r.json())
      .then((d: { files: FileNode[] }) => setFiles(d.files || []))
      .catch(() => setFiles([]));
  }, []);

  const handleCreateSkill = async () => {
    if (!newSkillName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newSkillName.trim(),
          description: newSkillDescription.trim() || 'A custom skill',
        }),
      });
      if (res.ok) {
        setShowNewSkill(false);
        setNewSkillName('');
        setNewSkillDescription('');
        loadSkills();
        setSelectedSkill(newSkillName.trim());
        loadFiles(newSkillName.trim());
      }
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteSkill = async () => {
    if (!skillToDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillToDelete)}`, { method: 'DELETE' });
      if (res.ok) {
        if (selectedSkill === skillToDelete) {
          setSelectedSkill(null);
          setFiles([]);
          setSelectedFile(null);
          setContent('');
          setSavedContent('');
        }
        loadSkills();
      }
    } finally {
      setDeleting(false);
      setSkillToDelete(null);
    }
  };

  const loadFile = useCallback((skillName: string, filePath: string) => {
    fetch(`/api/skills/${skillName}/file?path=${encodeURIComponent(filePath)}`)
      .then((r) => r.json())
      .then((d: { content?: string; error?: string }) => {
        if (d.content !== undefined) {
          setContent(d.content);
          setSavedContent(d.content);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSkill && selectedFile) {
      loadFile(selectedSkill, selectedFile.path);
    }
  }, [selectedSkill, selectedFile, loadFile]);

  const handleSelectSkill = (skillName: string) => {
    if (skillName === selectedSkill) {
      setSelectedSkill(null);
      setFiles([]);
      setSelectedFile(null);
      setContent('');
      setSavedContent('');
    } else {
      setSelectedSkill(skillName);
      setSelectedFile(null);
      setContent('');
      setSavedContent('');
      loadFiles(skillName);
    }
  };

  const handleSelectFile = (node: FileNode) => {
    if (!node.isDirectory) {
      setSelectedFile(node);
    }
  };

  const handleSave = useCallback(async () => {
    if (!canSave || !selectedSkill || !selectedFile) return;
    setSaveStatus('saving');
    try {
      const res = await fetch(`/api/skills/${selectedSkill}/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedFile.path, content }),
      });
      if (res.ok) {
        setSavedContent(content);
        setSaveStatus('saved');
      } else {
        setSaveStatus('error');
      }
    } catch {
      setSaveStatus('error');
    }
    setTimeout(() => setSaveStatus('idle'), 2000);
  }, [canSave, selectedSkill, selectedFile, content]);

  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (isDirty && saveStatus === 'idle') {
          handleSave();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDirty, saveStatus, handleSave]);

  const handleEditorMount = useCallback((editor: unknown) => {
    editorRef.current = editor;
  }, []);

  const language = selectedFile ? getLanguageFromPath(selectedFile.path) : 'plaintext';

  return (
    <div className="flex flex-col md:flex-row h-full gap-4">
      <aside className="w-full md:w-60 shrink-0 flex flex-col border-b md:border-b-0 md:border-r border-border pr-0 md:pr-4 max-h-40 md:max-h-none overflow-y-auto">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Skills</h2>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            onClick={() => setShowNewSkill(true)}
            title="New Skill"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <ScrollArea className="flex-1">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : skills.length === 0 ? (
            <p className="text-sm text-muted-foreground">No skills found</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {skills.map((skill) => (
                <div key={skill}>
                  <div className="group flex items-center">
                    <button
                      onClick={() => handleSelectSkill(skill)}
                      className={[
                        'flex items-center gap-2 flex-1 min-w-0 py-1.5 px-2 text-sm rounded-md transition-colors text-left',
                        selectedSkill === skill
                          ? 'bg-accent text-accent-foreground'
                          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                      ].join(' ')}
                    >
                      <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${selectedSkill === skill ? 'rotate-90' : ''}`} />
                      <Wrench className="h-4 w-4 shrink-0" />
                      <span className="truncate">{skill}</span>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setSkillToDelete(skill); }}
                      className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                      title={`Delete ${skill}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {selectedSkill === skill && files.length > 0 && (
                    <div className="ml-2 border-l border-border pl-1">
                      {files.map((node) => (
                        <FileTreeNode
                          key={node.path}
                          node={node}
                          selectedPath={selectedFile?.path || null}
                          onSelect={handleSelectFile}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        {selectedFile ? (
          <>
            <div className="flex items-center justify-between mb-2 shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold">{selectedFile.name}</span>
                {isDirty && saveStatus === 'idle' && (
                  <span className="text-xs text-muted-foreground">Unsaved</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {saveStatus === 'saved' && <span className="text-sm text-green-500">Saved</span>}
                {saveStatus === 'error' && <span className="text-sm text-red-500">Failed</span>}
                <Button onClick={handleSave} disabled={!canSave} size="sm">
                  {saveStatus === 'saving' ? 'Saving...' : 'Save'}
                </Button>
              </div>
            </div>

            <div className="flex-1 border border-border rounded-md overflow-hidden min-h-[300px] md:min-h-[400px]">
              <MonacoEditor
                language={language}
                value={content}
                onChange={(v) => setContent(v ?? '')}
                onMount={handleEditorMount}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  tabSize: 2,
                  readOnly: false,
                }}
                theme={isDark ? 'vs-dark' : 'vs'}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Wrench className="h-12 w-12 mx-auto mb-4 opacity-20" />
              <p>Select a skill, then choose a file to edit</p>
            </div>
          </div>
        )}
      </div>

      <Dialog open={!!skillToDelete} onOpenChange={(o) => { if (!o) setSkillToDelete(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Skill</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Delete <span className="font-medium text-foreground">{skillToDelete}</span>? This will permanently remove all skill files and cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSkillToDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDeleteSkill} disabled={deleting}>
              {deleting ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showNewSkill} onOpenChange={(o) => { if (!o) { setShowNewSkill(false); setNewSkillName(''); setNewSkillDescription(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New Skill</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div>
              <label className="text-xs text-muted-foreground">Name (e.g., ping_host)</label>
              <input
                className="w-full mt-1 px-2 py-1.5 text-sm border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                value={newSkillName}
                onChange={(e) => setNewSkillName(e.target.value)}
                placeholder="skill_name"
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Description</label>
              <input
                className="w-full mt-1 px-2 py-1.5 text-sm border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                value={newSkillDescription}
                onChange={(e) => setNewSkillDescription(e.target.value)}
                placeholder="Use this skill when..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowNewSkill(false);
                setNewSkillName('');
                setNewSkillDescription('');
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreateSkill}
              disabled={!newSkillName.trim() || creating}
            >
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
