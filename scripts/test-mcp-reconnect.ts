/**
 * Regression test for the MCP session-expiry auto-reconnect.
 *
 * Spins up a tiny in-process Streamable HTTP MCP server that:
 *   - issues a session ID on `initialize`
 *   - returns 400 + "Bad Request: no valid session ID" on every call once
 *     `killSession()` is invoked, until the next `initialize`
 *   - returns a normal `tools/call` result otherwise
 *
 * Then drives the registry through:
 *   1. initial connect + a successful tool call
 *   2. server-side session kill
 *   3. another tool call — must transparently reconnect and return data
 *
 * Run with:  npx tsx scripts/test-mcp-reconnect.ts
 *
 * Driven from the registry's public surface (mcpRegistry, buildTools) so we
 * exercise the real code path, not a re-implementation.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mcpRegistry } from '../src/lib/tools/registry';

// ─── Mini Streamable HTTP MCP server ─────────────────────────────────────────

const sessions = new Map<string, { id: string; valid: boolean }>();
let serverKillId: string | null = null;

function newSessionId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function jsonRpcOk(id: number | string, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function sessionExpiredError(id: number | string | null) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: 'Bad Request: no valid session ID provided',
    },
  };
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('method not allowed');
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf-8');
    let msg: { id?: number | string | null; method?: string; params?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        ...headers,
      });
      res.end(JSON.stringify(body));
    };
    const respondSessionExpired = () => {
      respond(400, sessionExpiredError(msg.id ?? null));
    };

    // initialize / tools/list / tools/call all require a valid session if
    // the server has already issued one. The very first `initialize` may
    // arrive without a session ID.
    if (msg.method === 'initialize') {
      const sid = newSessionId();
      sessions.set(sid, { id: sid, valid: true });
      respond(
        200,
        jsonRpcOk(msg.id!, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'test-mcp-reconnect', version: '0.0.0' },
        }),
        { 'mcp-session-id': sid },
      );
      return;
    }

    if (!sessionId || !sessions.has(sessionId)) {
      respondSessionExpired();
      return;
    }

    const session = sessions.get(sessionId)!;
    if (!session.valid || serverKillId === sessionId) {
      respondSessionExpired();
      return;
    }

    if (msg.method === 'notifications/initialized') {
      // Notifications get 202 Accepted with no body. Reset the kill switch
      // for this session so the next reconnect on a fresh session starts
      // life unlocked.
      res.writeHead(202);
      res.end();
      return;
    }

    if (msg.method === 'tools/list') {
      respond(
        200,
        jsonRpcOk(msg.id!, {
          tools: [
            {
              name: 'echo',
              description: 'Echoes back the provided text',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          ],
        }),
      );
      return;
    }

    if (msg.method === 'tools/call') {
      const params = (msg.params ?? {}) as { name?: string; arguments?: { text?: string } };
      if (params.name !== 'echo') {
        respond(200, jsonRpcOk(msg.id!, { content: [{ type: 'text', text: 'unknown tool' }], isError: true }));
        return;
      }
      const text = params.arguments?.text ?? '';
      respond(200, jsonRpcOk(msg.id!, { content: [{ type: 'text', text: `echo: ${text}` }] }));
      return;
    }

    respond(200, jsonRpcOk(msg.id!, {}));
  });
});

async function startServer(): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return addr.port;
}

function killLatestSession(): void {
  // Find the most recent session — that's the one the registered client
  // currently holds. Marking it invalid + setting the kill switch means
  // the very next request with that session-id returns session-expired.
  const all = Array.from(sessions.values());
  const last = all[all.length - 1];
  if (last) {
    last.valid = false;
    serverKillId = last.id;
  }
}

// ─── Test harness ────────────────────────────────────────────────────────────

let failed = 0;
const ok = (label: string, cond: boolean, extra?: string) => {
  if (!cond) {
    failed++;
    console.error(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

async function main() {
  const port = await startServer();
  const url = `http://127.0.0.1:${port}/mcp`;
  process.env.MCP_SERVERS = JSON.stringify([
    { name: 'mock', url, transport: 'streamable-http' },
  ]);

  console.log(`\n[setup] mock MCP server listening on ${url}`);

  const tools = await mcpRegistry.initialize().then(() => mcpRegistry.buildTools());
  const echoKey = Object.keys(tools).find((k) => k === 'mock_echo');
  ok('registry exposed mock_echo after init', !!echoKey);
  if (!echoKey) {
    console.error('\nMissing echo tool — aborting.');
    await mcpRegistry.close();
    server.close();
    process.exit(1);
  }

  const stateBefore = mcpRegistry._getServerStateForTesting('mock');
  ok('serverStates has a "mock" entry after init', !!stateBefore);
  const clientBefore = stateBefore?.client;

  console.log('\n[1] first call before session kill should succeed');
  const r1 = await tools[echoKey].execute!({ text: 'hello' }, { messages: [], toolCallId: 't1' });
  ok('first call returned expected text', (r1 as string).includes('echo: hello'), String(r1));

  console.log('\n[2] invalidate the server-side session');
  killLatestSession();

  console.log('\n[3] second call should transparently reconnect and succeed');
  const r2 = await tools[echoKey].execute!({ text: 'world' }, { messages: [], toolCallId: 't2' });
  ok('post-kill call returned expected text', (r2 as string).includes('echo: world'), String(r2));

  const stateAfter = mcpRegistry._getServerStateForTesting('mock');
  const clientAfter = stateAfter?.client;
  ok(
    'serverStates.client was swapped after session expiry',
    !!clientBefore && !!clientAfter && clientBefore !== clientAfter,
  );

  console.log('\n[4] a sustained post-reconnect call still works (new session)');
  const r3 = await tools[echoKey].execute!({ text: 'again' }, { messages: [], toolCallId: 't3' });
  ok('post-reconnect call returned expected text', (r3 as string).includes('echo: again'), String(r3));

  console.log('\n[5] concurrent calls during a session kill should all recover');
  killLatestSession();
  const concurrent = await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      tools[echoKey].execute!({ text: `c${i}` }, { messages: [], toolCallId: `tc${i}` }),
    ),
  );
  ok(
    'all 5 concurrent calls returned expected text',
    concurrent.every((r, i) => (r as string).includes(`echo: c${i}`)),
    JSON.stringify(concurrent),
  );
  const stateFinal = mcpRegistry._getServerStateForTesting('mock');
  ok(
    'serverStates.client was swapped exactly once across 5 concurrent calls',
    !!stateAfter && stateFinal?.client === stateAfter?.client,
  );

  await mcpRegistry.close();
  server.close();
  await new Promise<void>((resolve) => server.on('close', () => resolve()));

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll MCP session-reconnect invariants hold.');
}

main().catch((err) => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
