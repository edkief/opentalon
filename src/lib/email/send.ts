/**
 * Outbound SMTP sender — the email ChannelSender.
 *
 * Registered under the `email:` prefix in the channel registry (see
 * imap-manager.startEmail), so ALL app-wide pushes — scheduled-task replies,
 * workflow notifications, guidance prompts, job completions — reach email
 * threads automatically via `sendToChat`.
 *
 * NOTE on quoting: email_messages does not persist message bodies, so we cannot
 * reconstruct the full quoted original here. We rely on RFC threading headers
 * (In-Reply-To / References) instead — Gmail/Thunderbird/Apple Mail collapse the
 * reply into the existing thread and render the history client-side. A quoted
 * original block is deferred alongside inline-reply diffing (see docs Deferred).
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { marked } from 'marked';
import { convert as htmlToText } from 'html-to-text';
import { getLatestInboundForChat, recordEmailMessage } from '../db/email';
import { normalizeMessageId, buildReplySubject, capReferences } from './threading';
import { normalizeAddress, buildAllowedSet } from './address';
import { getEmailConfig, ownAddresses, type ResolvedEmailConfig } from './config';
import type { ChannelSendFormat } from '../channels/registry';

interface TransportCache {
  key: string;
  transport: Transporter;
}
let cache: TransportCache | null = null;

function getTransport(cfg: ResolvedEmailConfig): Transporter {
  // Rebuild the transport only when the SMTP config actually changes
  // (config-changed hot-reload flows through here at next send).
  const key = JSON.stringify(cfg.smtp);
  if (cache && cache.key === key) return cache.transport;
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.password },
  });
  cache = { key, transport };
  return transport;
}

/** True when the caller passed an HTML format hint rather than markdown. */
function isHtmlFormat(fmt?: ChannelSendFormat): boolean {
  if (fmt === 'html') return true;
  if (fmt && typeof fmt === 'object') return fmt.parse_mode === 'HTML';
  return false;
}

/**
 * Send `text` to an `email:<hex>` chat, replying in-thread to the latest inbound
 * message when one exists. ChannelSender signature.
 */
export async function sendEmailToChat(
  chatId: string,
  text: string,
  formatOrOptions?: ChannelSendFormat,
  throwOnError = false,
): Promise<void> {
  const cfg = getEmailConfig();
  if (!cfg) {
    if (throwOnError) throw new Error('[email] channel not configured');
    return;
  }

  try {
    const own = ownAddresses(cfg);
    const ownSet = new Set(own.map((a) => normalizeAddress(a, cfg.stripPlusAddressing)));
    const allowed = buildAllowedSet(cfg.whitelist, own, cfg.stripPlusAddressing);

    const lastInbound = await getLatestInboundForChat(chatId);

    // Recipients + subject + threading headers.
    let to: string[];
    let cc: string[] = [];
    let subject: string;
    let inReplyTo: string | undefined;
    let references: string[] | undefined;

    if (lastInbound) {
      // Reply-all: To = original sender; Cc = original To+Cc minus our own addresses.
      to = [lastInbound.fromAddress];
      cc = [...(lastInbound.toAddresses ?? []), ...(lastInbound.ccAddresses ?? [])].filter(
        (a) => !ownSet.has(normalizeAddress(a, cfg.stripPlusAddressing)),
      );
      subject = buildReplySubject(lastInbound.subject);
      inReplyTo = lastInbound.messageId;
      references = capReferences([...(lastInbound.referencesIds ?? []), lastInbound.messageId]);
    } else {
      // Pure-outbound thread (e.g. a scheduled task on an email chatId with no
      // prior inbound). Send to the first whitelist address with a fresh subject.
      const target = cfg.whitelist[0];
      if (!target) {
        if (throwOnError) throw new Error('[email] no recipient (empty whitelist, no prior inbound)');
        console.warn('[email] Dropping outbound message: no recipient for', chatId);
        return;
      }
      to = [target];
      subject = `Message from ${cfg.fromName ?? cfg.address ?? 'OpenTalon'}`;
    }

    // privacy=private: never mail anyone outside whitelist ∪ self.
    if (cfg.privacy === 'private') {
      to = to.filter((a) => allowed.has(normalizeAddress(a, cfg.stripPlusAddressing)));
      cc = cc.filter((a) => allowed.has(normalizeAddress(a, cfg.stripPlusAddressing)));
      if (to.length === 0) {
        console.warn('[email] privacy=private dropped all recipients for', chatId);
        return;
      }
    }

    // Body: honor an HTML hint, else render markdown → HTML + plain-text parts.
    let html: string;
    let plain: string;
    if (isHtmlFormat(formatOrOptions)) {
      html = text;
      plain = htmlToText(text, { wordwrap: false });
    } else {
      html = marked.parse(text, { async: false });
      plain = text;
    }

    const fromAddress = cfg.address ?? cfg.smtp.user;
    const info = await getTransport(cfg).sendMail({
      from: cfg.fromName ? { name: cfg.fromName, address: fromAddress } : fromAddress,
      to,
      cc: cc.length > 0 ? cc : undefined,
      subject,
      text: plain,
      html,
      inReplyTo,
      references: references && references.length > 0 ? references : undefined,
    });

    // Record the outbound row so future replies to us resolve to this chatId.
    const outboundId = normalizeMessageId(info.messageId);
    if (outboundId) {
      await recordEmailMessage({
        messageId: outboundId,
        chatId,
        direction: 'outbound',
        imapUid: null,
        mailbox: cfg.imap.mailbox,
        fromAddress,
        toAddresses: to,
        ccAddresses: cc.length > 0 ? cc : null,
        subject,
        normalizedSubject: null,
        inReplyTo: inReplyTo ?? null,
        referencesIds: references ?? null,
        processed: true,
      }).catch((err) => console.error('[email] failed to record outbound row:', err));
    }
  } catch (err) {
    if (throwOnError) throw err;
    console.error('[email] Failed to send message to', chatId, err);
  }
}
