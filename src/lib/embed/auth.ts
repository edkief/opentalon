/**
 * Embed-channel authentication.
 *
 * Topology today: the host application's SERVER proxies. A browser talks to the
 * host (TalonPress) using whatever session the host already has, the host calls
 * OpenTalon with a shared secret, and asserts who the end user is in the request
 * body. OpenTalon is therefore never exposed to browsers and needs no CORS.
 *
 * A future topology has the browser call OpenTalon directly with a short-lived
 * token the host mints. That is deliberately NOT implemented — but everything it
 * needs is shaped for it here:
 *   - `EmbedAuthenticator` is an interface with a dispatch table keyed on the
 *     client's `auth.mode`, so adding 'jwt' is one function and no call-site
 *     churn. A jwt-mode client currently resolves to a 501.
 *   - `corsHeadersFor()` is wired into every route now and simply returns {}
 *     while `allowedOrigins` is empty, so enabling direct calls is config-only.
 *   - Stream tokens (below) already exist, because SSE and polling are GETs that
 *     cannot carry a principal-bearing body. That token is exactly the handle a
 *     browser would hold in the direct topology.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { getEmbedClient, listEmbedClientIds, type ResolvedEmbedClient } from './config';
import { embedChatId } from './threads';

/** Who the host says is talking, once the host itself has been authenticated. */
export interface EmbedPrincipal {
  clientId: string;
  /** Host-side id of the thing being discussed (a TalonPress packageId). */
  resourceId: string;
  /** Opaque, stable-per-host-user key. Feeds the chatId hash. */
  userKey: string;
  userLabel?: string;
  roles: string[];
  via: 'shared-secret' | 'jwt';
}

export interface EmbedAuthError {
  status: 401 | 403 | 501;
  code: 'unauthorized' | 'forbidden' | 'not_implemented';
  message: string;
}

export type EmbedAuthResult =
  | { ok: true; principal: EmbedPrincipal; client: ResolvedEmbedClient }
  | { ok: false; error: EmbedAuthError };

export type EmbedAuthenticator = (
  req: Request,
  body: unknown,
  client: ResolvedEmbedClient,
) => Promise<EmbedAuthResult>;

const UNAUTHORIZED: EmbedAuthError = {
  status: 401,
  code: 'unauthorized',
  // Deliberately uniform: never reveal whether it was the client id, the
  // channel being off, a missing secret, or a wrong secret.
  message: 'Invalid client or credentials',
};

/** Constant-time secret comparison that tolerates length mismatch. */
function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison so timing does not leak the length.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** The host-asserted actor + resource block every request carries. */
interface AssertedIdentity {
  resource?: { id?: unknown; title?: unknown; url?: unknown; visibility?: unknown };
  actor?: { userKey?: unknown; userLabel?: unknown; roles?: unknown };
}

function readAssertedIdentity(body: unknown): {
  resourceId: string;
  userKey: string;
  userLabel?: string;
  roles: string[];
} | null {
  if (!body || typeof body !== 'object') return null;
  const { resource, actor } = body as AssertedIdentity;

  const resourceId = typeof resource?.id === 'string' ? resource.id.trim() : '';
  const userKey = typeof actor?.userKey === 'string' ? actor.userKey.trim() : '';
  if (!resourceId || !userKey) return null;

  const roles = Array.isArray(actor?.roles)
    ? actor.roles.filter((r): r is string => typeof r === 'string')
    : [];
  const userLabel = typeof actor?.userLabel === 'string' ? actor.userLabel.trim() : undefined;

  return { resourceId, userKey, userLabel, roles };
}

/**
 * Shared-secret authenticator: the host server presents its own credential and
 * vouches for the end user. We verify the host, then apply our own role gate to
 * what it claims — the host decides who its admins are, we decide which of those
 * roles may open a conversation.
 */
const sharedSecretAuthenticator: EmbedAuthenticator = async (req, body, client) => {
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !secretsMatch(presented, client.secret)) {
    return { ok: false, error: UNAUTHORIZED };
  }

  const asserted = readAssertedIdentity(body);
  if (!asserted) {
    return {
      ok: false,
      error: {
        status: 403,
        code: 'forbidden',
        message: 'resource.id and actor.userKey are required',
      },
    };
  }

  if (!asserted.roles.some((r) => client.allowedRoles.includes(r))) {
    return {
      ok: false,
      error: {
        status: 403,
        code: 'forbidden',
        message: `Actor holds none of the permitted roles (${client.allowedRoles.join(', ') || 'none configured'})`,
      },
    };
  }

  return {
    ok: true,
    client,
    principal: {
      clientId: client.id,
      resourceId: asserted.resourceId,
      userKey: asserted.userKey,
      userLabel: asserted.userLabel,
      roles: asserted.roles,
      via: 'shared-secret',
    },
  };
};

/**
 * Placeholder for the direct browser topology: the host would mint a signed
 * assertion the browser carries to OpenTalon. Not implemented — a client
 * configured with `auth.mode: jwt` fails closed rather than falling back to a
 * weaker check.
 */
const jwtAuthenticator: EmbedAuthenticator = async () => ({
  ok: false,
  error: {
    status: 501,
    code: 'not_implemented',
    message:
      "auth.mode 'jwt' (direct browser-to-OpenTalon) is not implemented; use 'shared-secret' with a host-side proxy",
  },
});

const AUTHENTICATORS: Record<string, EmbedAuthenticator> = {
  'shared-secret': sharedSecretAuthenticator,
  jwt: jwtAuthenticator,
};

/**
 * Authenticate an embed request. Resolves the client from the X-Embed-Client
 * header, then dispatches on its configured auth mode.
 */
export async function authenticateEmbedRequest(
  req: Request,
  body: unknown,
): Promise<EmbedAuthResult> {
  const clientId = req.headers.get('x-embed-client')?.trim() ?? '';
  if (!clientId) return { ok: false, error: UNAUTHORIZED };

  const client = getEmbedClient(clientId);
  if (!client) return { ok: false, error: UNAUTHORIZED };

  const authenticator = AUTHENTICATORS[client.authMode];
  if (!authenticator) return { ok: false, error: UNAUTHORIZED };

  return authenticator(req, body, client);
}

/** The conversation a principal is entitled to, and only that one. */
export function chatIdForPrincipal(principal: EmbedPrincipal): string {
  return embedChatId(principal.clientId, principal.resourceId, principal.userKey);
}

// ─── Stream tokens ───────────────────────────────────────────────────────────
// SSE and polling are GETs with no body, so they cannot re-derive a principal.
// POST /session mints a short-lived token binding a chatId; the stream routes
// verify it and read nothing else from the query but the cursor.

const STREAM_TOKEN_TTL_MS = 60 * 60 * 1000;

function signStreamPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export interface StreamToken {
  token: string;
  expiresAt: string;
}

export function mintStreamToken(
  client: ResolvedEmbedClient,
  chatId: string,
  ttlMs = STREAM_TOKEN_TTL_MS,
): StreamToken {
  const exp = Date.now() + ttlMs;
  const payload = Buffer.from(`${client.id}|${chatId}|${exp}`, 'utf8').toString('base64url');
  return {
    token: `${payload}.${signStreamPayload(payload, client.secret)}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

/**
 * Verify a stream token and return the chatId it authorises, or null. The client
 * is resolved from the token's own payload and its live secret is used to check
 * the signature, so revoking a client (removing its secret) invalidates every
 * outstanding token immediately.
 */
export function verifyStreamToken(
  token: string | null | undefined,
): { chatId: string; client: ResolvedEmbedClient } | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let decoded: string;
  try {
    decoded = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const [clientId, chatId, expRaw] = decoded.split('|');
  if (!clientId || !chatId || !expRaw) return null;

  const client = getEmbedClient(clientId);
  if (!client) return null;

  if (!secretsMatch(signature, signStreamPayload(payload, client.secret))) return null;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;

  return { chatId, client };
}

// ─── CORS ────────────────────────────────────────────────────────────────────

/**
 * CORS headers for a client. Empty while `allowedOrigins` is empty, which is the
 * correct answer for the proxied topology — only the host's server calls us. It
 * is wired into the routes now so switching a deployment to direct browser calls
 * is a config change rather than a code change.
 */
export function corsHeadersFor(
  client: ResolvedEmbedClient | null,
  origin: string | null,
): Record<string, string> {
  if (!client || client.allowedOrigins.length === 0) return {};
  if (!origin || !client.allowedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Embed-Client',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/**
 * CORS headers for a preflight, where the client cannot be identified.
 *
 * A browser's OPTIONS preflight does not carry custom headers — X-Embed-Client
 * only appears inside Access-Control-Request-Headers — so resolving a client the
 * usual way always fails and would refuse every preflight. Match the origin
 * against every configured client instead. Still empty in the proxied topology,
 * where no client declares an origin.
 */
export function corsPreflightHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  for (const id of listEmbedClientIds()) {
    const client = getEmbedClient(id);
    const headers = corsHeadersFor(client, origin);
    if (Object.keys(headers).length > 0) return headers;
  }
  return {};
}
