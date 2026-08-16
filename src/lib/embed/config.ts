/**
 * Resolved embed-channel configuration.
 *
 * Merges config.yaml (`embed`) with secrets.yaml (`embed.<clientId>.secret`) and
 * env fallbacks, and applies defaults. Mirrors `src/lib/email/config.ts`:
 * everything is resolved at point of use and nothing is cached, so a config or
 * secret edit takes effect on the next request without a restart.
 */

import { configManager } from '../config';

/** How a host proves who it is. Only 'shared-secret' is implemented — see auth.ts. */
export type EmbedAuthMode = 'shared-secret' | 'jwt';

export interface ResolvedEmbedClient {
  id: string;
  label: string;
  authMode: EmbedAuthMode;
  /** Empty when no secret is configured — such a client can never authenticate. */
  secret: string;
  allowedRoles: string[];
  allowedOrigins: string[];
  agentId?: string;
  toolProfile?: string[];
  memoryScope: 'private' | 'shared';
  dangerousTools: 'deny' | 'allowlist';
  maxContextChars: number;
  rateLimitPerMinute: number;
}

export interface ResolvedEmbedConfig {
  enabled: boolean;
  historyLimit: number;
  outboxRetentionHours: number;
  maxMessageChars: number;
}

/** Channel-level settings, or null when the embed channel is disabled. */
export function getEmbedConfig(): ResolvedEmbedConfig | null {
  const cfg = configManager.get().embed;
  if (!cfg?.enabled) return null;
  return {
    enabled: true,
    historyLimit: cfg.historyLimit ?? 20,
    outboxRetentionHours: cfg.outboxRetentionHours ?? 168,
    maxMessageChars: cfg.maxMessageChars ?? 8000,
  };
}

/** Env var name a client's secret may fall back to, e.g. "talon-press" → EMBED_SECRET_TALON_PRESS. */
function secretEnvVar(clientId: string): string {
  return `EMBED_SECRET_${clientId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * Resolve one client, or null when the channel is off, the client is unknown or
 * disabled, or no secret is configured for it. Callers treat null as "this
 * client does not exist" — never leak which of those it was.
 */
export function getEmbedClient(clientId: string): ResolvedEmbedClient | null {
  if (!getEmbedConfig()) return null;

  const entry = configManager.get().embed?.clients?.find((c) => c.id === clientId);
  if (!entry || entry.enabled === false) return null;

  const secret =
    configManager.getSecrets().embed?.[clientId]?.secret ??
    process.env[secretEnvVar(clientId)] ??
    '';
  if (!secret) return null;

  return {
    id: entry.id,
    label: entry.label ?? entry.id,
    authMode: entry.auth?.mode ?? 'shared-secret',
    secret,
    // Default to admin-only. An explicitly empty array denies everyone, which is
    // a legitimate way to park a client without deleting its config.
    allowedRoles: entry.allowedRoles ?? ['admin'],
    allowedOrigins: entry.allowedOrigins ?? [],
    agentId: entry.agentId,
    toolProfile: entry.toolProfile,
    memoryScope: entry.memoryScope ?? 'private',
    dangerousTools: entry.dangerousTools ?? 'deny',
    maxContextChars: entry.maxContextChars ?? 4000,
    rateLimitPerMinute: entry.rateLimitPerMinute ?? 20,
  };
}

/** All configured client ids, including ones missing a secret (for status reporting). */
export function listEmbedClientIds(): string[] {
  return (configManager.get().embed?.clients ?? []).map((c) => c.id);
}
