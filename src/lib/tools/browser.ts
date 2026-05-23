import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { configManager } from '../config';
import { getWorkspaceDir } from './skills';
import { requestAndWait } from './approval';
import type { BuiltInToolsOpts } from './types';

const execAsync = promisify(exec);

function getBrowserBin(): string {
  return configManager.get().tools?.agentBrowserBin ?? 'agent-browser';
}

export function isBrowserEnabled(): boolean {
  return configManager.get().tools?.agentBrowserEnabled === true;
}

async function runBrowser(args: string): Promise<string> {
  const bin = getBrowserBin();
  try {
    const { stdout, stderr } = await execAsync(`${bin} ${args}`, {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      shell: '/bin/sh',
    });
    return [stdout, stderr].filter(Boolean).join('\n') || '(no output)';
  } catch (err: any) {
    const msg = err?.stderr ? `${err.message}\n${err.stderr}` : String(err);
    return `agent-browser error: ${msg}`;
  }
}

export function getBrowserTools(opts?: BuiltInToolsOpts): ToolSet {
  if (!isBrowserEnabled()) return {};

  const send = opts?.sendApprovalRequest;

  return {
    browser_navigate: tool({
      description:
        'Open a URL in the headless browser. Call this first before any other browser tools. ' +
        'The browser session persists until browser_close is called. ' +
        'Returns the page title and URL after navigation.',
      inputSchema: z.object({
        url: z.string().describe('URL to open'),
        wait: z
          .enum(['load', 'networkidle', 'domcontentloaded'])
          .optional()
          .describe('Wait condition after navigation (default: load)'),
      }) as any,
      execute: async (input: { url: string; wait?: string }) => {
        const waitFlag = input.wait
          ? ` && ${getBrowserBin()} wait --load ${input.wait}`
          : '';
        return runBrowser(`open ${JSON.stringify(input.url)}${waitFlag}`);
      },
    } as any),

    browser_snapshot: tool({
      description:
        'Get the accessibility tree of the current page. ' +
        'Returns element references like @e1, @e2 that can be passed to browser_act. ' +
        'Always call this after browser_navigate to understand the page structure. ' +
        'Set interactive_only: true (default) to only return clickable/fillable elements.',
      inputSchema: z.object({
        interactive_only: z
          .boolean()
          .optional()
          .describe('Only return interactive elements (default: true)'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Limit tree depth (useful for large pages)'),
      }) as any,
      execute: async (input: { interactive_only?: boolean; depth?: number }) => {
        const flags = [
          (input.interactive_only ?? true) ? '-i' : '',
          input.depth ? `-d ${input.depth}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        return runBrowser(`snapshot ${flags}`);
      },
    } as any),

    browser_get: tool({
      description:
        'Read information from the current page. ' +
        'Use "url" or "title" for page-level info. ' +
        'Use "text" with a CSS selector or @ref to extract element text. ' +
        'Use "value" to read input field values.',
      inputSchema: z.object({
        what: z
          .enum(['text', 'html', 'value', 'title', 'url', 'count'])
          .describe('What to retrieve'),
        selector: z
          .string()
          .optional()
          .describe('CSS selector or @ref (e.g. @e1). Required for text/html/value/count.'),
      }) as any,
      execute: async (input: { what: string; selector?: string }) => {
        const sel = input.selector ? ` ${JSON.stringify(input.selector)}` : '';
        return runBrowser(`get ${input.what}${sel}`);
      },
    } as any),

    browser_act: tool({
      description:
        'Perform an action in the browser that modifies page state. Requires user approval. ' +
        'Use refs from browser_snapshot (e.g. @e1) as the selector — they are more reliable than CSS selectors. ' +
        'Actions: click, fill (clear+type), type (append text), press (key like "Enter"/"Tab"), ' +
        'check/uncheck (checkboxes), scroll (up/down/left/right), back, forward, reload.',
      inputSchema: z.object({
        action: z
          .enum([
            'click',
            'fill',
            'type',
            'press',
            'check',
            'uncheck',
            'scroll',
            'back',
            'forward',
            'reload',
          ])
          .describe('The action to perform'),
        selector: z
          .string()
          .optional()
          .describe('CSS selector or @ref. Required for click/fill/type/check/uncheck.'),
        value: z
          .string()
          .optional()
          .describe(
            'Text for fill/type, key name for press (e.g. "Enter"), direction for scroll (up/down/left/right).',
          ),
      }) as any,
      execute: async (input: { action: string; selector?: string; value?: string }) => {
        const approved = await requestAndWait('browser_act', input, send);
        if (!approved) return 'browser_act was denied by the user.';

        let cmd: string;
        switch (input.action) {
          case 'click':
          case 'check':
          case 'uncheck':
            cmd = `${input.action} ${JSON.stringify(input.selector ?? '')}`;
            break;
          case 'fill':
          case 'type':
            cmd = `${input.action} ${JSON.stringify(input.selector ?? '')} ${JSON.stringify(input.value ?? '')}`;
            break;
          case 'press':
            cmd = `press ${JSON.stringify(input.value ?? '')}`;
            break;
          case 'scroll':
            cmd = `scroll ${input.value ?? 'down'}`;
            break;
          case 'back':
          case 'forward':
          case 'reload':
            cmd = input.action;
            break;
          default:
            return `Unknown action: ${input.action}`;
        }
        return runBrowser(cmd);
      },
    } as any),

    browser_screenshot: tool({
      description:
        'Take a screenshot of the current page and save it to a file. ' +
        'Returns the file path — pass it to send_file to send the image to Telegram. ' +
        'Set full_page: true to capture the entire page height, not just the visible viewport.',
      inputSchema: z.object({
        filename: z
          .string()
          .optional()
          .describe('Output filename (default: auto-generated in workspace dir)'),
        full_page: z
          .boolean()
          .optional()
          .describe('Capture full page height (default: false)'),
        annotate: z
          .boolean()
          .optional()
          .describe('Overlay numbered labels on interactive elements'),
      }) as any,
      execute: async (input: { filename?: string; full_page?: boolean; annotate?: boolean }) => {
        const outPath = input.filename
          ? path.resolve(getWorkspaceDir(), input.filename)
          : path.join(getWorkspaceDir(), `screenshot-${Date.now()}.png`);
        const flags = [input.full_page ? '--full' : '', input.annotate ? '--annotate' : '']
          .filter(Boolean)
          .join(' ');
        await runBrowser(`screenshot ${flags} ${JSON.stringify(outPath)}`);
        return outPath;
      },
    } as any),

    browser_close: tool({
      description:
        'Close the browser session and release all resources. ' +
        'Call this when you are done browsing.',
      inputSchema: z.object({}) as any,
      execute: async () => {
        return runBrowser('close');
      },
    } as any),
  };
}
