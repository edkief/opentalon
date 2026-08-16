/**
 * Unit tests for the embed channel's identity and authorisation logic:
 * chatId derivation, shared-secret authentication, the role gate, stream-token
 * mint/verify/expiry, CORS gating, and the rate limiter.
 *
 * The config is stubbed by writing directly onto configManager's cache, so this
 * needs no config.yaml, no database, and no network.
 *
 * Run: pnpm test:embed-auth
 */

import { configManager } from '../src/lib/config';
import type { AppConfig, AppSecrets } from '../src/lib/config/schema';
import { embedChatId, embedClientIdOf, isEmbedChatId } from '../src/lib/embed/threads';
// Config is read at point of use (never at module load), so static imports are
// safe here — the stub below is in place before any of these actually read it.
import { getEmbedClient, getEmbedConfig } from '../src/lib/embed/config';
import {
  authenticateEmbedRequest,
  chatIdForPrincipal,
  corsHeadersFor,
  mintStreamToken,
  verifyStreamToken,
} from '../src/lib/embed/auth';
import { consumeEmbedRate } from '../src/lib/embed/rate-limit';
import { withEmbedAuth } from '../src/lib/embed/http';
import { NextResponse } from 'next/server';

let passed = 0;
let failed = 0;

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}\n      expected: ${e}\n      actual:   ${a}`);
  }
}

function ok(name: string, cond: boolean): void {
  eq(name, cond, true);
}

// ── Config stub ──────────────────────────────────────────────────────────────
// configManager caches parsed config; overwrite the cache directly rather than
// touching the filesystem.
function stubConfig(config: Partial<AppConfig>, secrets: Partial<AppSecrets> = {}): void {
  const mgr = configManager as unknown as { cachedConfig: unknown; cachedSecrets: unknown };
  mgr.cachedConfig = config;
  mgr.cachedSecrets = secrets;
}

const BASE_CONFIG: Partial<AppConfig> = {
  embed: {
    enabled: true,
    clients: [
      { id: 'talonpress', label: 'TalonPress', allowedRoles: ['admin'] },
      { id: 'nosecret', label: 'No Secret' },
      { id: 'off', enabled: false },
      { id: 'jwtclient', auth: { mode: 'jwt' } },
      { id: 'cors', allowedOrigins: ['https://pages.example.com'] },
    ],
  },
};

const BASE_SECRETS: Partial<AppSecrets> = {
  embed: {
    talonpress: { secret: 'sekret-value-1234' },
    jwtclient: { secret: 'jwt-secret' },
    cors: { secret: 'cors-secret' },
    off: { secret: 'off-secret' },
  },
};

stubConfig(BASE_CONFIG, BASE_SECRETS);

function request(headers: Record<string, string>): Request {
  return new Request('https://opentalon.local/api/embed/message', { headers });
}

const AUTH_HEADERS = {
  'x-embed-client': 'talonpress',
  authorization: 'Bearer sekret-value-1234',
};

const BODY = {
  resource: { id: 'demo-abc123', title: 'Demo page' },
  actor: { userKey: 'user-1', userLabel: 'Ed', roles: ['admin'] },
};

async function main(): Promise<void> {
  console.log('=== Embed auth ===\n');

  // ── chatId derivation ────────────────────────────────────────────────────────
  console.log('chatId derivation');
  const chatA = embedChatId('talonpress', 'demo-abc123', 'user-1');
  ok('has embed: prefix', isEmbedChatId(chatA));
  ok('carries the client id in the clear', chatA.startsWith('embed:talonpress:'));
  eq('client id is recoverable', embedClientIdOf(chatA), 'talonpress');
  eq('deterministic', embedChatId('talonpress', 'demo-abc123', 'user-1'), chatA);
  ok('different user → different chat', embedChatId('talonpress', 'demo-abc123', 'user-2') !== chatA);
  ok('different resource → different chat', embedChatId('talonpress', 'other', 'user-1') !== chatA);
  ok('different client → different chat', embedChatId('other', 'demo-abc123', 'user-1') !== chatA);
  eq('non-embed chatId has no client', embedClientIdOf('12345'), null);
  eq('malformed embed chatId has no client', embedClientIdOf('embed:nocolon'), null);

  // ── Client resolution ────────────────────────────────────────────────────────
  console.log('\nclient resolution');
  ok('channel resolves when enabled', getEmbedConfig() !== null);
  ok('configured client resolves', getEmbedClient('talonpress') !== null);
  eq('client without a secret does not resolve', getEmbedClient('nosecret'), null);
  eq('disabled client does not resolve', getEmbedClient('off'), null);
  eq('unknown client does not resolve', getEmbedClient('nope'), null);
  eq('defaults to admin-only', getEmbedClient('jwtclient')?.allowedRoles, ['admin']);
  eq('defaults to deny for dangerous tools', getEmbedClient('talonpress')?.dangerousTools, 'deny');
  eq('defaults to private memory scope', getEmbedClient('talonpress')?.memoryScope, 'private');

  stubConfig({ embed: { ...BASE_CONFIG.embed, enabled: false } }, BASE_SECRETS);
  eq('nothing resolves when the channel is disabled', getEmbedClient('talonpress'), null);
  stubConfig(BASE_CONFIG, BASE_SECRETS);

  // ── Shared-secret authentication ─────────────────────────────────────────────
  console.log('\nshared-secret authentication');
  {
    const res = await authenticateEmbedRequest(request(AUTH_HEADERS), BODY);
    ok('valid credentials authenticate', res.ok);
    if (res.ok) {
      eq('principal carries the resource', res.principal.resourceId, 'demo-abc123');
      eq('principal carries the user key', res.principal.userKey, 'user-1');
      eq('principal records the mechanism', res.principal.via, 'shared-secret');
      eq('chatId matches direct derivation', chatIdForPrincipal(res.principal), chatA);
    }
  }
  {
    const res = await authenticateEmbedRequest(
      request({ ...AUTH_HEADERS, authorization: 'Bearer wrong-value-9999' }),
      BODY,
    );
    eq('wrong secret is rejected', res.ok === false && res.error.status, 401);
  }
  {
    const res = await authenticateEmbedRequest(request({ ...AUTH_HEADERS, authorization: 'Bearer short' }), BODY);
    eq('length-mismatched secret is rejected', res.ok === false && res.error.status, 401);
  }
  {
    const res = await authenticateEmbedRequest(request({ authorization: 'Bearer sekret-value-1234' }), BODY);
    eq('missing client header is rejected', res.ok === false && res.error.status, 401);
  }
  {
    const res = await authenticateEmbedRequest(request({ ...AUTH_HEADERS, 'x-embed-client': 'nosecret' }), BODY);
    eq('client without a secret is rejected', res.ok === false && res.error.status, 401);
  }
  {
    const res = await authenticateEmbedRequest(request(AUTH_HEADERS), {
      ...BODY,
      actor: { ...BODY.actor, roles: ['viewer'] },
    });
    eq('actor without a permitted role is forbidden', res.ok === false && res.error.status, 403);
  }
  {
    const res = await authenticateEmbedRequest(request(AUTH_HEADERS), {
      ...BODY,
      actor: { ...BODY.actor, roles: [] },
    });
    eq('actor with no roles is forbidden', res.ok === false && res.error.status, 403);
  }
  {
    const res = await authenticateEmbedRequest(request(AUTH_HEADERS), { actor: BODY.actor });
    eq('missing resource id is rejected', res.ok === false && res.error.status, 403);
  }
  {
    const res = await authenticateEmbedRequest(request(AUTH_HEADERS), { resource: BODY.resource });
    eq('missing actor is rejected', res.ok === false && res.error.status, 403);
  }
  {
    // The direct-browser topology is declared but not implemented: it must fail
    // closed rather than silently degrading to a weaker check.
    const res = await authenticateEmbedRequest(
      request({ 'x-embed-client': 'jwtclient', authorization: 'Bearer jwt-secret' }),
      BODY,
    );
    eq('jwt mode is not implemented', res.ok === false && res.error.status, 501);
  }

  // ── Stream tokens ────────────────────────────────────────────────────────────
  console.log('\nstream tokens');
  const client = getEmbedClient('talonpress')!;
  {
    const { token } = mintStreamToken(client, chatA);
    const verified = verifyStreamToken(token);
    eq('round-trips the chatId', verified?.chatId, chatA);
    eq('resolves the client', verified?.client.id, 'talonpress');
  }
  {
    const { token } = mintStreamToken(client, chatA);
    const [payload, sig] = token.split('.');
    eq('tampered signature is rejected', verifyStreamToken(`${payload}.${sig.slice(0, -1)}x`), null);
    const otherPayload = Buffer.from(`talonpress|embed:talonpress:deadbeefdeadbeef|${Date.now() + 60_000}`, 'utf8')
      .toString('base64url');
    eq('tampered payload is rejected', verifyStreamToken(`${otherPayload}.${sig}`), null);
  }
  {
    const { token } = mintStreamToken(client, chatA, -1000);
    eq('expired token is rejected', verifyStreamToken(token), null);
  }
  eq('empty token is rejected', verifyStreamToken(''), null);
  eq('garbage token is rejected', verifyStreamToken('not-a-token'), null);
  {
    // Revoking a client (removing its secret) must invalidate live tokens.
    const { token } = mintStreamToken(client, chatA);
    stubConfig(BASE_CONFIG, { embed: { ...BASE_SECRETS.embed, talonpress: {} } });
    eq('token dies with the client secret', verifyStreamToken(token), null);
    stubConfig(BASE_CONFIG, BASE_SECRETS);
  }

  // ── CORS ─────────────────────────────────────────────────────────────────────
  console.log('\nCORS gating');
  eq('no origins configured → no headers', corsHeadersFor(client, 'https://pages.example.com'), {});
  const corsClient = getEmbedClient('cors')!;
  eq(
    'allowed origin is echoed',
    corsHeadersFor(corsClient, 'https://pages.example.com')['Access-Control-Allow-Origin'],
    'https://pages.example.com',
  );
  eq('disallowed origin gets nothing', corsHeadersFor(corsClient, 'https://evil.example.com'), {});
  eq('absent origin gets nothing', corsHeadersFor(corsClient, null), {});
  eq('no client gets nothing', corsHeadersFor(null, 'https://pages.example.com'), {});

  // ── Rate limiting ────────────────────────────────────────────────────────────
  console.log('\nrate limiting');
  {
    const chat = `embed:talonpress:${Date.now().toString(16)}`;
    const results = Array.from({ length: 4 }, () => consumeEmbedRate(chat, 3));
    eq('allows up to the limit', results.slice(0, 3).map((r) => r.allowed), [true, true, true]);
    eq('blocks past the limit', results[3].allowed, false);
    ok('reports a retry delay', results[3].retryAfterSec >= 1);
    ok('separate chats have separate budgets', consumeEmbedRate(`${chat}-other`, 3).allowed);
  }

  // ── Route wrapper ────────────────────────────────────────────────────────────
  // Exercises withEmbedAuth itself rather than a route module: importing an
  // /api route under tsx trips a pre-existing circular-import issue in
  // specialist.ts (the same failure occurs for /api/chat), and every rejection
  // path below is decided by the wrapper anyway.
  console.log('\nroute wrapper');
  const post = (headers: Record<string, string>, body: unknown) =>
    new Request('https://opentalon.local/api/embed/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const reached = { value: false };
  const handler = async () => {
    reached.value = true;
    return NextResponse.json({ ok: true });
  };

  {
    reached.value = false;
    const res = await withEmbedAuth(post(AUTH_HEADERS, BODY), handler);
    eq('valid request reaches the handler', res.status, 200);
    ok('handler actually ran', reached.value);
  }
  {
    reached.value = false;
    const res = await withEmbedAuth(post({}, BODY), handler);
    eq('unauthenticated request is 401', res.status, 401);
    eq('handler did not run', reached.value, false);
  }
  {
    const res = await withEmbedAuth(post(AUTH_HEADERS, { ...BODY, actor: { userKey: 'u', roles: ['viewer'] } }), handler);
    eq('unpermitted role is 403', res.status, 403);
  }
  {
    // The isolation boundary: a host must not be able to name a conversation it
    // did not open, even with valid credentials.
    reached.value = false;
    const res = await withEmbedAuth(
      post(AUTH_HEADERS, { ...BODY, chatId: 'embed:talonpress:0000000000000000' }),
      handler,
    );
    eq('foreign chatId is 403', res.status, 403);
    eq('handler did not run for a foreign chatId', reached.value, false);
  }
  {
    const res = await withEmbedAuth(post(AUTH_HEADERS, { ...BODY, chatId: chatA }), handler);
    eq('own chatId is accepted', res.status, 200);
  }
  {
    const res = await withEmbedAuth(post(AUTH_HEADERS, 'not json at all'), handler);
    eq('non-JSON body is 400', res.status, 400);
  }
  {
    const res = await withEmbedAuth(post(AUTH_HEADERS, { resource: { id: 'x' } }), handler);
    eq('missing actor is rejected before the handler', res.status, 403);
  }
  {
    const res = await withEmbedAuth(post(AUTH_HEADERS, BODY), async () => {
      throw new Error('boom');
    });
    eq('handler failure becomes a 500', res.status, 500);
  }
}

main()
  .then(() => {
    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
