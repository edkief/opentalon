import pino from 'pino';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { emitLog } from './agent/log-bus';
import type { LogLevel } from './agent/log-bus';

// pino numeric level → LogLevel string
const LEVEL_MAP: Record<number, LogLevel> = {
  10: 'debug', // trace
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'error', // fatal
};

const COMPONENT_RE = /^\[([^\]]+)\]\s*/;

// Writable sink that parses pino JSON lines and emits to logBus
function makeLogBusSink(): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        const line = chunk.toString().trim();
        if (!line || line.startsWith(':')) { callback(); return; }
        const data = JSON.parse(line) as {
          level: number;
          time: number;
          msg?: string;
        };
        const level = LEVEL_MAP[data.level] ?? 'info';
        const raw = data.msg ?? '';
        const match = COMPONENT_RE.exec(raw);
        emitLog({
          id: randomUUID(),
          ts: data.time ?? Date.now(),
          level,
          component: match ? match[1] : 'system',
          message: match ? raw.slice(match[0].length) : raw,
          raw,
        });
      } catch {
        // ignore malformed lines (e.g. pino-pretty passthrough text)
      }
      callback();
    },
  });
}

function makeStreams(): ReturnType<typeof pino.multistream> {
  const sink = makeLogBusSink();

  if (process.env.NODE_ENV !== 'production') {
    try {
      // pino-pretty is a devDependency — not available in production
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pretty = require('pino-pretty') as (opts: Record<string, unknown>) => NodeJS.WritableStream;
      const prettyStream = pretty({ colorize: true, sync: true });
      return pino.multistream([
        { stream: prettyStream as Writable },
        { stream: sink },
      ]);
    } catch {
      // pino-pretty not available, fall through to stdout
    }
  }

  return pino.multistream([
    { stream: process.stdout },
    { stream: sink },
  ]);
}

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info' },
  makeStreams(),
);

// ── Console intercept ─────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __consoleIntercepted: boolean | undefined;
}

export function setupConsoleIntercept(): void {
  if (globalThis.__consoleIntercepted) return;
  globalThis.__consoleIntercepted = true;

  const orig = {
    log:   console.log.bind(console),
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  console.log   = (...args: unknown[]) => { logger.info(args.join(' '));  orig.log(...args); };
  console.info  = (...args: unknown[]) => { logger.info(args.join(' '));  orig.info(...args); };
  console.warn  = (...args: unknown[]) => { logger.warn(args.join(' '));  orig.warn(...args); };
  console.error = (...args: unknown[]) => { logger.error(args.join(' ')); orig.error(...args); };
  console.debug = (...args: unknown[]) => { logger.debug(args.join(' ')); orig.debug(...args); };
}
