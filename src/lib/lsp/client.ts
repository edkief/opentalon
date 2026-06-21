import { spawn, type ChildProcess } from 'node:child_process';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { InitializeParams, InitializeResult } from 'vscode-languageserver-protocol';

/**
 * Thin wrapper around a language-server child process speaking LSP over
 * JSON-RPC on stdio. Simplified port of claude-code services/lsp/LSPClient.
 */
export class LspClient {
  private proc: ChildProcess;
  private connection: MessageConnection;

  constructor(command: string, args: string[], cwd: string, env?: Record<string, string>) {
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    if (!this.proc.stdout || !this.proc.stdin) {
      throw new Error(`Failed to open stdio for language server "${command}"`);
    }
    this.connection = createMessageConnection(
      new StreamMessageReader(this.proc.stdout),
      new StreamMessageWriter(this.proc.stdin),
    );
    this.connection.listen();
  }

  async initialize(params: InitializeParams): Promise<InitializeResult> {
    const result = await this.connection.sendRequest<InitializeResult>('initialize', params);
    await this.connection.sendNotification('initialized', {});
    return result;
  }

  sendRequest<T>(method: string, params: unknown): Promise<T> {
    return this.connection.sendRequest<T>(method, params);
  }

  sendNotification(method: string, params: unknown): Promise<void> {
    return this.connection.sendNotification(method, params);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.connection.onNotification(method, handler);
  }

  onRequest(method: string, handler: (params: unknown) => unknown): void {
    this.connection.onRequest(method, handler);
  }

  async stop(): Promise<void> {
    try {
      await this.connection.sendRequest('shutdown', {});
      await this.connection.sendNotification('exit', {});
    } catch {
      // server may already be gone
    } finally {
      this.connection.dispose();
      if (!this.proc.killed) this.proc.kill();
    }
  }
}
