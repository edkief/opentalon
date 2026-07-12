/**
 * Resolved email channel configuration.
 *
 * Merges config.yaml (`email`) with secrets.yaml (`email`) + env fallbacks, and
 * applies defaults. SMTP credentials default to the IMAP credentials. Cred
 * resolution mirrors the Telegram `botToken ?? process.env.TELEGRAM_BOT_TOKEN`
 * pattern (resolved at point of use so hot-reload/secret edits take effect).
 */

import { configManager } from '../config';

export interface ResolvedEmailConfig {
  enabled: boolean;
  address?: string;
  fromName?: string;
  imap: { host: string; port: number; secure: boolean; mailbox: string; user: string; password: string };
  smtp: { host: string; port: number; secure: boolean; user: string; password: string };
  whitelist: string[];
  triggerMode: 'always' | 'mention';
  mentionKeyword?: string;
  privacy: 'public' | 'private';
  pollIntervalSec: number;
  stripPlusAddressing: boolean;
}

/**
 * Resolve the full email configuration, or null when email is disabled or the
 * required IMAP host/credentials are missing.
 */
export function getEmailConfig(): ResolvedEmailConfig | null {
  const cfg = configManager.get().email;
  if (!cfg?.enabled) return null;

  const secrets = configManager.getSecrets().email;
  const imapUser = secrets?.user ?? process.env.EMAIL_USER ?? '';
  const imapPassword = secrets?.password ?? process.env.EMAIL_PASSWORD ?? '';
  const smtpUser = secrets?.smtpUser ?? process.env.EMAIL_SMTP_USER ?? imapUser;
  const smtpPassword = secrets?.smtpPassword ?? process.env.EMAIL_SMTP_PASSWORD ?? imapPassword;

  const imapHost = cfg.imap?.host;
  if (!imapHost || !imapUser || !imapPassword) return null;

  const imapSecure = cfg.imap?.secure ?? true;
  const smtpSecure = cfg.smtp?.secure ?? true;

  return {
    enabled: true,
    address: cfg.address,
    fromName: cfg.fromName,
    imap: {
      host: imapHost,
      port: cfg.imap?.port ?? (imapSecure ? 993 : 143),
      secure: imapSecure,
      mailbox: cfg.imap?.mailbox ?? 'INBOX',
      user: imapUser,
      password: imapPassword,
    },
    smtp: {
      host: cfg.smtp?.host ?? imapHost,
      port: cfg.smtp?.port ?? (smtpSecure ? 465 : 587),
      secure: smtpSecure,
      user: smtpUser,
      password: smtpPassword,
    },
    whitelist: cfg.whitelist ?? [],
    triggerMode: cfg.triggerMode ?? 'always',
    mentionKeyword: cfg.mentionKeyword,
    privacy: cfg.privacy ?? 'public',
    pollIntervalSec: cfg.pollIntervalSec ?? 300,
    stripPlusAddressing: cfg.stripPlusAddressing ?? true,
  };
}

/** Own addresses used for self-loop guards + outbound recipient filtering. */
export function ownAddresses(cfg: ResolvedEmailConfig): string[] {
  return [cfg.address, cfg.imap.user, cfg.smtp.user].filter((a): a is string => !!a);
}
