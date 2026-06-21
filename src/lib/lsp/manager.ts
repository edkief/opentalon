import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { LspClient } from './client';
import { getWorkspaceDir } from '../tools/skills';
import { configManager } from '../config';

const LSP_CONTENT_MODIFIED = -32801;

interface LanguageDef {
  /** LSP languageId sent in didOpen */
  languageId: string;
  command: string;
  args: string[];
}

/** Built-in language definitions, overridable via config tools.languageServers. */
const DEFAULT_LANGUAGES: Record<string, LanguageDef> = {
  typescript: { languageId: 'typescript', command: 'typescript-language-server', args: ['--stdio'] },
  python: { languageId: 'python', command: 'pyright-langserver', args: ['--stdio'] },
};

/** File extension → language key + the languageId to advertise for that extension. */
const EXT_MAP: Record<string, { lang: string; languageId: string }> = {
  '.ts': { lang: 'typescript', languageId: 'typescript' },
  '.tsx': { lang: 'typescript', languageId: 'typescriptreact' },
  '.mts': { lang: 'typescript', languageId: 'typescript' },
  '.cts': { lang: 'typescript', languageId: 'typescript' },
  '.js': { lang: 'typescript', languageId: 'javascript' },
  '.jsx': { lang: 'typescript', languageId: 'javascriptreact' },
  '.mjs': { lang: 'typescript', languageId: 'javascript' },
  '.cjs': { lang: 'typescript', languageId: 'javascript' },
  '.py': { lang: 'python', languageId: 'python' },
  '.pyi': { lang: 'python', languageId: 'python' },
};

interface ServerEntry {
  client: LspClient;
  openFiles: Map<string, number>; // uri → version
  diagnostics: Map<string, Diagnostic[]>; // uri → latest diagnostics
}

class LspManager {
  private servers = new Map<string, ServerEntry>();
  private starting = new Map<string, Promise<ServerEntry>>();

  /** Is there LSP support for this file extension? */
  supports(absPath: string): boolean {
    return path.extname(absPath).toLowerCase() in EXT_MAP;
  }

  private resolveLang(lang: string): LanguageDef {
    const override = configManager.get().tools?.languageServers?.[lang];
    const base = DEFAULT_LANGUAGES[lang];
    if (override) {
      return { languageId: base?.languageId ?? lang, command: override.command, args: override.args ?? base?.args ?? ['--stdio'] };
    }
    if (!base) throw new Error(`No language server configured for "${lang}"`);
    return base;
  }

  private async ensureServer(lang: string): Promise<ServerEntry> {
    const existing = this.servers.get(lang);
    if (existing) return existing;
    const inflight = this.starting.get(lang);
    if (inflight) return inflight;

    const promise = (async (): Promise<ServerEntry> => {
      const def = this.resolveLang(lang);
      const root = getWorkspaceDir();
      const client = new LspClient(def.command, def.args, root);
      const entry: ServerEntry = { client, openFiles: new Map(), diagnostics: new Map() };

      client.onNotification('textDocument/publishDiagnostics', (params) => {
        const p = params as { uri: string; diagnostics: Diagnostic[] };
        if (p?.uri) entry.diagnostics.set(p.uri, p.diagnostics ?? []);
      });
      // Some servers ask the client for configuration; answer with nulls.
      client.onRequest('workspace/configuration', (params) => {
        const items = (params as { items?: unknown[] })?.items ?? [];
        return items.map(() => null);
      });
      client.onRequest('window/workDoneProgress/create', () => null);

      const rootUri = pathToFileURL(root).toString();
      await client.initialize({
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            publishDiagnostics: { relatedInformation: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            references: {},
            implementation: { linkSupport: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
          workspace: { symbol: {}, configuration: true, workspaceFolders: true },
        },
        initializationOptions: {},
      } as never);

      this.servers.set(lang, entry);
      this.starting.delete(lang);
      return entry;
    })();

    this.starting.set(lang, promise);
    try {
      return await promise;
    } catch (err) {
      this.starting.delete(lang);
      throw err;
    }
  }

  private async ensureFileOpen(entry: ServerEntry, absPath: string, languageId: string): Promise<string> {
    const uri = pathToFileURL(absPath).toString();
    const content = await fs.readFile(absPath, 'utf-8');
    const prevVersion = entry.openFiles.get(uri);
    if (prevVersion === undefined) {
      entry.openFiles.set(uri, 1);
      await entry.client.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text: content },
      });
    } else {
      const version = prevVersion + 1;
      entry.openFiles.set(uri, version);
      await entry.client.sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }
    return uri;
  }

  private extInfo(absPath: string): { lang: string; languageId: string } {
    const ext = path.extname(absPath).toLowerCase();
    const info = EXT_MAP[ext];
    if (!info) throw new Error(`LSP not available for ${ext || 'this file'}`);
    return info;
  }

  /** Run a position/document LSP request that takes a textDocument uri. */
  async request<T>(absPath: string, method: string, makeParams: (uri: string) => unknown): Promise<T> {
    const { lang, languageId } = this.extInfo(absPath);
    const entry = await this.ensureServer(lang);
    const uri = await this.ensureFileOpen(entry, absPath, languageId);
    const params = makeParams(uri);
    try {
      return await entry.client.sendRequest<T>(method, params);
    } catch (err) {
      if ((err as { code?: number })?.code === LSP_CONTENT_MODIFIED) {
        await new Promise((r) => setTimeout(r, 500));
        return await entry.client.sendRequest<T>(method, params);
      }
      throw err;
    }
  }

  /** Workspace-wide request not tied to a single file (e.g. workspace/symbol). */
  async workspaceRequest<T>(lang: string, method: string, params: unknown): Promise<T> {
    const entry = await this.ensureServer(lang);
    return entry.client.sendRequest<T>(method, params);
  }

  /** Open the file and wait briefly for pushed diagnostics. */
  async getDiagnostics(absPath: string): Promise<Diagnostic[]> {
    const { lang, languageId } = this.extInfo(absPath);
    const entry = await this.ensureServer(lang);
    const uri = await this.ensureFileOpen(entry, absPath, languageId);
    entry.diagnostics.delete(uri);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const diags = entry.diagnostics.get(uri);
      if (diags !== undefined) return diags;
      await new Promise((r) => setTimeout(r, 150));
    }
    return entry.diagnostics.get(uri) ?? [];
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled([...this.servers.values()].map((e) => e.client.stop()));
    this.servers.clear();
    this.starting.clear();
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __lspManager: LspManager | undefined;
}

if (!globalThis.__lspManager) {
  globalThis.__lspManager = new LspManager();
}

export const lspManager = globalThis.__lspManager;
