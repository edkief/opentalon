import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspaceDir } from './skills';
import type { BuiltInToolsOpts } from './types';

interface NotebookCell {
  cell_type: 'code' | 'markdown';
  id?: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
}

interface NotebookContent {
  cells: NotebookCell[];
  metadata: { language_info?: { name?: string } };
  nbformat: number;
  nbformat_minor: number;
}

/** Parse a synthetic "cell-N" id into a numeric index, else undefined. */
function parseCellId(cellId: string): number | undefined {
  const m = /^cell-(\d+)$/.exec(cellId);
  return m ? Number(m[1]) : undefined;
}

export function getNotebookTools(_opts?: BuiltInToolsOpts): ToolSet {
  return {
    notebook_edit: tool({
      description:
        'Edit a Jupyter notebook (.ipynb) cell. ' +
        'edit_mode "replace" overwrites a cell\'s source, "insert" adds a new cell after the given cell ' +
        '(cell_type required), and "delete" removes a cell. ' +
        'Identify cells by their id (or "cell-N" index form). Omit cell_id to insert at the start.',
      inputSchema: z.object({
        notebook_path: z.string().describe('Path to the .ipynb file (absolute or workspace-relative)'),
        new_source: z.string().describe('New cell source (ignored for delete)'),
        cell_id: z.string().optional().describe('Target cell id, or "cell-N" index form. Required unless inserting.'),
        cell_type: z.enum(['code', 'markdown']).optional().describe('Cell type. Required when edit_mode is "insert".'),
        edit_mode: z.enum(['replace', 'insert', 'delete']).optional().describe('Edit operation. Defaults to "replace".'),
      }),
      execute: async ({ notebook_path, new_source, cell_id, cell_type, edit_mode }) => {
        const mode = edit_mode ?? 'replace';
        try {
          const absPath = path.isAbsolute(notebook_path)
            ? notebook_path
            : path.join(getWorkspaceDir(), notebook_path);

          if (mode === 'insert' && !cell_type) {
            return 'Error: cell_type is required when edit_mode is "insert".';
          }
          if (!cell_id && mode !== 'insert') {
            return 'Error: cell_id must be specified when not inserting a new cell.';
          }

          let raw: string;
          try {
            raw = await fs.readFile(absPath, 'utf-8');
          } catch {
            return `Error: notebook not found at ${notebook_path}`;
          }

          let notebook: NotebookContent;
          try {
            notebook = JSON.parse(raw) as NotebookContent;
          } catch {
            return `Error: ${notebook_path} is not valid JSON.`;
          }
          if (!Array.isArray(notebook.cells)) {
            return `Error: ${notebook_path} is not a valid notebook (no cells array).`;
          }

          // Resolve target cell index
          let cellIndex = 0;
          if (cell_id) {
            cellIndex = notebook.cells.findIndex((c) => c.id === cell_id);
            if (cellIndex === -1) {
              const parsed = parseCellId(cell_id);
              if (parsed !== undefined) cellIndex = parsed;
            }
            if (cellIndex < 0 || (mode !== 'insert' && !notebook.cells[cellIndex])) {
              return `Error: cell "${cell_id}" not found in notebook.`;
            }
            if (mode === 'insert') cellIndex += 1;
          }

          // Replacing one past the end becomes an insert
          let effMode = mode;
          if (effMode === 'replace' && cellIndex === notebook.cells.length) {
            effMode = 'insert';
            if (!cell_type) cell_type = 'code';
          }

          const supportsId =
            notebook.nbformat > 4 ||
            (notebook.nbformat === 4 && notebook.nbformat_minor >= 5);

          if (effMode === 'delete') {
            if (!notebook.cells[cellIndex]) return `Error: cell index ${cellIndex} out of range.`;
            notebook.cells.splice(cellIndex, 1);
            await writeNotebook(absPath, notebook);
            return `Done: deleted cell at index ${cellIndex} in ${notebook_path}`;
          }

          if (effMode === 'insert') {
            const newId = supportsId ? Math.random().toString(36).substring(2, 15) : undefined;
            const cell: NotebookCell =
              cell_type === 'markdown'
                ? { cell_type: 'markdown', id: newId, source: new_source, metadata: {} }
                : { cell_type: 'code', id: newId, source: new_source, metadata: {}, execution_count: null, outputs: [] };
            notebook.cells.splice(cellIndex, 0, cell);
            await writeNotebook(absPath, notebook);
            return `Done: inserted ${cell.cell_type} cell at index ${cellIndex} in ${notebook_path}`;
          }

          // replace
          const target = notebook.cells[cellIndex];
          if (!target) return `Error: cell index ${cellIndex} out of range.`;
          target.source = new_source;
          if (target.cell_type === 'code') {
            target.execution_count = null;
            target.outputs = [];
          }
          if (cell_type && cell_type !== target.cell_type) {
            target.cell_type = cell_type;
          }
          await writeNotebook(absPath, notebook);
          return `Done: replaced cell at index ${cellIndex} in ${notebook_path}`;
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}

async function writeNotebook(absPath: string, notebook: NotebookContent): Promise<void> {
  await fs.writeFile(absPath, JSON.stringify(notebook, null, 1), 'utf-8');
}
