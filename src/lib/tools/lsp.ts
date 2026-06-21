import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import path from 'node:path';
import { getWorkspaceDir } from './skills';
import { lspManager } from '../lsp/manager';
import {
  formatLocations,
  formatReferences,
  formatHover,
  formatDocumentSymbols,
  formatWorkspaceSymbols,
  formatDiagnostics,
} from '../lsp/format';
import type { BuiltInToolsOpts } from './types';

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(getWorkspaceDir(), p);
}

export function getLspTools(_opts?: BuiltInToolsOpts): ToolSet {
  return {
    lsp: tool({
      description:
        'Semantic code intelligence via the Language Server Protocol for TypeScript/JavaScript and Python. ' +
        'Operations: "diagnostics" (compiler/type errors for a file — use after edits), ' +
        '"definition" (go to a symbol\'s definition), "references" (find all usages), ' +
        '"hover" (type/signature/docs at a position), "document_symbol" (outline a file), ' +
        '"workspace_symbol" (find symbols by name across the project). ' +
        'Positions are 1-based line and character. The language server starts on first use.',
      inputSchema: z.object({
        operation: z.enum(['diagnostics', 'definition', 'references', 'hover', 'document_symbol', 'workspace_symbol']),
        path: z.string().optional().describe('File path (absolute or workspace-relative). Required for all operations except workspace_symbol.'),
        line: z.number().int().min(1).optional().describe('1-based line number. Required for definition/references/hover.'),
        character: z.number().int().min(1).optional().describe('1-based column. Required for definition/references/hover.'),
        query: z.string().optional().describe('Symbol name to search for. Required for workspace_symbol.'),
      }),
      execute: async ({ operation, path: filePath, line, character, query }) => {
        try {
          const root = getWorkspaceDir();

          if (operation === 'workspace_symbol') {
            if (!query) return 'Error: query is required for workspace_symbol.';
            // workspace/symbol isn't file-scoped; default to the TS server.
            const result = await lspManager.workspaceRequest('typescript', 'workspace/symbol', { query });
            return formatWorkspaceSymbols(result, root);
          }

          if (!filePath) return `Error: path is required for ${operation}.`;
          const absPath = resolvePath(filePath);
          if (!lspManager.supports(absPath)) {
            return `LSP not available for ${path.extname(absPath) || 'this file type'}. Supported: TypeScript/JavaScript, Python.`;
          }

          if (operation === 'diagnostics') {
            const diags = await lspManager.getDiagnostics(absPath);
            return formatDiagnostics(diags, path.relative(root, absPath));
          }

          if (operation === 'document_symbol') {
            const result = await lspManager.request(absPath, 'textDocument/documentSymbol', (uri) => ({
              textDocument: { uri },
            }));
            return formatDocumentSymbols(result);
          }

          // Position-based operations
          if (line === undefined || character === undefined) {
            return `Error: line and character are required for ${operation}.`;
          }
          const position = { line: line - 1, character: character - 1 };

          switch (operation) {
            case 'definition': {
              const result = await lspManager.request(absPath, 'textDocument/definition', (uri) => ({
                textDocument: { uri },
                position,
              }));
              return formatLocations(result, root, 'Defined');
            }
            case 'references': {
              const result = await lspManager.request(absPath, 'textDocument/references', (uri) => ({
                textDocument: { uri },
                position,
                context: { includeDeclaration: true },
              }));
              return formatReferences(result, root);
            }
            case 'hover': {
              const result = await lspManager.request(absPath, 'textDocument/hover', (uri) => ({
                textDocument: { uri },
                position,
              }));
              return formatHover(result);
            }
          }
          return `Error: unknown operation "${operation}".`;
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
