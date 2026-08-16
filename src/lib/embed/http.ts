/**
 * Shared plumbing for the /api/embed/* routes.
 *
 * NOTE ON THE ROUTE GATE: /api/embed is deliberately absent from
 * PROTECTED_PREFIXES in src/proxy.ts. It authenticates itself per client rather
 * than behind the single dashboard password, because the callers are host
 * servers, not dashboard users. Every route in this directory must go through
 * `withEmbedAuth` or `withStreamToken` — there is no ambient protection.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  authenticateEmbedRequest,
  chatIdForPrincipal,
  corsHeadersFor,
  corsPreflightHeaders,
  verifyStreamToken,
} from './auth';
import type { EmbedPrincipal } from './auth';
import type { ResolvedEmbedClient } from './config';
import { getEmbedClient } from './config';
import { EmbedResourceContextSchema, EmbedResourceSchema } from './context';

/** The identity block every POST carries. Routes extend this with their own fields. */
export const EmbedRequestBaseSchema = z.object({
  resource: EmbedResourceSchema,
  actor: z.object({
    userKey: z.string().min(1).max(400),
    userLabel: z.string().max(200).optional(),
    roles: z.array(z.string().max(100)).max(50).default([]),
  }),
  context: EmbedResourceContextSchema.optional(),
});

export type EmbedRequestBase = z.infer<typeof EmbedRequestBaseSchema>;

export interface EmbedRouteContext {
  principal: EmbedPrincipal;
  client: ResolvedEmbedClient;
  chatId: string;
  body: EmbedRequestBase & Record<string, unknown>;
  cors: Record<string, string>;
}

function jsonError(
  status: number,
  code: string,
  message: string,
  cors: Record<string, string> = {},
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return NextResponse.json({ error: code, message }, { status, headers: { ...cors, ...extraHeaders } });
}

/**
 * Authenticate a POST, derive the chatId, and hand the route a validated body.
 *
 * The chatId is computed from the principal only. If a caller also sends a
 * `chatId`, it is compared and a mismatch is a 403 — accepting one would let a
 * host address any conversation on the instance.
 */
export async function withEmbedAuth(
  req: Request,
  handler: (ctx: EmbedRouteContext) => Promise<NextResponse>,
): Promise<NextResponse> {
  const origin = req.headers.get('origin');

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'bad_request', 'Body must be JSON');
  }

  const auth = await authenticateEmbedRequest(req, raw);
  if (!auth.ok) {
    // No client resolved on a 401, so no CORS headers either — correct, since an
    // unauthenticated origin should learn nothing about our configuration.
    const client = auth.error.status === 401 ? null : getEmbedClient(req.headers.get('x-embed-client') ?? '');
    return jsonError(auth.error.status, auth.error.code, auth.error.message, corsHeadersFor(client, origin));
  }

  const cors = corsHeadersFor(auth.client, origin);

  const parsed = EmbedRequestBaseSchema.passthrough().safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, 'bad_request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), cors);
  }

  const chatId = chatIdForPrincipal(auth.principal);

  const claimed = (raw as { chatId?: unknown }).chatId;
  if (typeof claimed === 'string' && claimed !== chatId) {
    return jsonError(403, 'forbidden', 'chatId does not belong to this actor', cors);
  }

  try {
    return await handler({
      principal: auth.principal,
      client: auth.client,
      chatId,
      body: parsed.data as EmbedRequestBase & Record<string, unknown>,
      cors,
    });
  } catch (err) {
    console.error('[embed] Route error:', err);
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('[Config]')) {
      return jsonError(503, 'config_invalid', message, cors);
    }
    return jsonError(500, 'internal_error', 'Request failed', cors);
  }
}

export interface EmbedStreamContext {
  chatId: string;
  client: ResolvedEmbedClient;
  since: number;
  cors: Record<string, string>;
}

/**
 * Authorise a GET (SSE or poll) via the stream token minted by POST /session.
 * A GET has no body, so this token is the only thing that can name a chat.
 */
export async function withStreamToken(
  req: Request,
  handler: (ctx: EmbedStreamContext) => Promise<Response>,
): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get('origin');

  const verified = verifyStreamToken(url.searchParams.get('token'));
  if (!verified) {
    return jsonError(401, 'unauthorized', 'Invalid or expired stream token');
  }

  const sinceRaw = Number(url.searchParams.get('since') ?? '0');
  const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? Math.floor(sinceRaw) : 0;

  return handler({
    chatId: verified.chatId,
    client: verified.client,
    since,
    cors: corsHeadersFor(verified.client, origin),
  });
}

/**
 * Preflight handler shared by every route. Matches on origin alone, because a
 * browser preflight carries no custom headers to identify the client with.
 * Returns nothing in the proxied topology (no client declares an origin), which
 * correctly refuses browsers.
 */
export function embedPreflight(req: Request): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: corsPreflightHeaders(req.headers.get('origin')),
  });
}
