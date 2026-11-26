import fs from 'node:fs/promises';
import path from 'node:path';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { configManager } from '../config';
import type { MessageImage } from '../agent/types';

/**
 * Inbound Telegram attachments (#97). Photos, documents, voice notes, audio,
 * video, video notes and animations are downloaded into
 * `<workspace>/inbox/telegram/<chatId>/` and described to the agent in a text
 * note; images can also go to the model as image input.
 */

/** The Bot API refuses to serve files above 20 MB to bots. */
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

/** Image types every vision provider accepts; other images are note-only. */
const VISION_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export type AttachmentKind = 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'video_note' | 'animation';

/** One file on an incoming message, before it is downloaded. */
export interface InboundAttachment {
  kind: AttachmentKind;
  fileId: string;
  fileUniqueId: string;
  /** The sender's filename, when Telegram has one. */
  fileName?: string;
  mediaType: string;
  /** Size Telegram reports; may be missing. */
  size?: number;
}

/** An attachment after the download attempt. */
export interface SavedAttachment extends InboundAttachment {
  /** Absolute path of the saved file; absent when it was not saved. */
  path?: string;
  /** Why the file was not saved. */
  error?: string;
}

export interface AttachmentSettings {
  enabled: boolean;
  vision: boolean;
  maxBytes: number;
}

export function attachmentSettings(): AttachmentSettings {
  const cfg = configManager.get().telegram?.attachments;
  return {
    enabled: cfg?.enabled ?? true,
    vision: cfg?.vision ?? true,
    maxBytes: Math.min(cfg?.maxBytes ?? TELEGRAM_DOWNLOAD_LIMIT, TELEGRAM_DOWNLOAD_LIMIT),
  };
}

/** Lists the files on a message. Stickers and other message kinds have none. */
export function extractAttachments(message: Message): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  if (message.photo?.length) {
    // Telegram sends several sizes of one photo; the last is the largest.
    const p = message.photo.reduce((a, b) => (b.width * b.height >= a.width * a.height ? b : a));
    out.push({ kind: 'photo', fileId: p.file_id, fileUniqueId: p.file_unique_id, mediaType: 'image/jpeg', size: p.file_size });
  }
  const files: Array<[AttachmentKind, { file_id: string; file_unique_id: string; file_size?: number; file_name?: string; mime_type?: string } | undefined, string]> = [
    // Telegram sets `animation` and also `document` on a GIF; keep the animation only.
    ['document', message.animation ? undefined : message.document, 'application/octet-stream'],
    ['voice', message.voice, 'audio/ogg'],
    ['audio', message.audio, 'audio/mpeg'],
    ['video', message.video, 'video/mp4'],
    ['video_note', message.video_note, 'video/mp4'],
    ['animation', message.animation, 'video/mp4'],
  ];
  for (const [kind, f, fallbackType] of files) {
    if (!f) continue;
    out.push({
      kind,
      fileId: f.file_id,
      fileUniqueId: f.file_unique_id,
      ...(f.file_name ? { fileName: f.file_name } : {}),
      mediaType: f.mime_type || fallbackType,
      size: f.file_size,
    });
  }
  return out;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4',
  'application/pdf': 'pdf', 'application/octet-stream': 'bin',
};

/**
 * A filename safe on any filesystem: only `[A-Za-z0-9._-]`, no leading dots,
 * at most 80 characters with the extension kept. Falls back to
 * `<kind>.<ext>` when the sender gave no usable name.
 */
export function safeFileName(att: Pick<InboundAttachment, 'kind' | 'fileName' | 'mediaType'>): string {
  const fallback = `${att.kind}.${EXT_BY_TYPE[att.mediaType] ?? att.mediaType.split('/')[1]?.replace(/[^A-Za-z0-9]/g, '') ?? 'bin'}`;
  const cleaned = (att.fileName ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/_+/g, '_');
  const name = cleaned && cleaned !== '_' ? cleaned : fallback;
  if (name.length <= 80) return name;
  const ext = path.extname(name).slice(0, 12);
  return name.slice(0, 80 - ext.length) + ext;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Where an attachment is saved: `<workspace>/inbox/telegram/<chatId>/<stamp>-<uniqueId>-<name>`. */
export function inboxPath(workspace: string, chatId: string, att: InboundAttachment, now = new Date()): string {
  const chatDir = chatId.replace(/[^0-9A-Za-z_-]/g, '_');
  const unique = att.fileUniqueId.replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(workspace, 'inbox', 'telegram', chatDir, `${stamp(now)}-${unique}-${safeFileName(att)}`);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** True for an image a vision model can take. */
export function isVisionImage(mediaType: string): boolean {
  return VISION_TYPES.has(mediaType.toLowerCase());
}

/** The text the agent reads about the files on this message. */
export function buildAttachmentNote(saved: SavedAttachment[]): string {
  if (!saved.length) return '';
  const lines = saved.map((a) => {
    const what = [a.kind.replace('_', ' '), a.mediaType, a.size !== undefined ? formatBytes(a.size) : undefined]
      .filter(Boolean).join(', ');
    const name = a.fileName ? ` "${a.fileName}"` : '';
    return a.path
      ? `- ${what}${name}: saved to ${a.path}`
      : `- ${what}${name}: not saved (${a.error ?? 'unknown error'})`;
  });
  const heading = saved.length === 1 ? '[The user sent a file]' : `[The user sent ${saved.length} files]`;
  return `${heading}\n${lines.join('\n')}`;
}

/**
 * Downloads each attachment into the chat's inbox. Never throws: a file that
 * can't be fetched comes back with `error` set. The bot token is part of the
 * download URL, so neither the URL nor fetch errors carrying it are logged.
 */
export async function downloadAttachments(
  api: Pick<Api, 'getFile' | 'token'>,
  workspace: string,
  chatId: string,
  attachments: InboundAttachment[],
  settings: Pick<AttachmentSettings, 'maxBytes'>,
  fetchImpl: typeof fetch = fetch,
): Promise<SavedAttachment[]> {
  const out: SavedAttachment[] = [];
  for (const att of attachments) {
    const tooLarge = (n: number) =>
      `too large: ${formatBytes(n)}, limit ${formatBytes(settings.maxBytes)}`;
    if (att.size !== undefined && att.size > settings.maxBytes) {
      out.push({ ...att, error: tooLarge(att.size) });
      continue;
    }
    try {
      const file = await api.getFile(att.fileId);
      if (!file.file_path) throw new Error('Telegram returned no file path');
      const res = await fetchImpl(`https://api.telegram.org/file/bot${api.token}/${file.file_path}`);
      if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
      const data = new Uint8Array(await res.arrayBuffer());
      if (data.byteLength > settings.maxBytes) {
        out.push({ ...att, size: data.byteLength, error: tooLarge(data.byteLength) });
        continue;
      }
      const dest = inboxPath(workspace, chatId, att);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);
      out.push({ ...att, size: data.byteLength, path: dest });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = raw.split(api.token).join('<token>');
      console.error(`[Telegram] Could not save ${att.kind} attachment in chat ${chatId}: ${message}`);
      out.push({ ...att, error: message });
    }
  }
  return out;
}

/** Reads the saved images a vision model can take. Unreadable files are skipped. */
export async function loadVisionImages(saved: SavedAttachment[]): Promise<MessageImage[]> {
  const images: MessageImage[] = [];
  for (const a of saved) {
    if (!a.path || !isVisionImage(a.mediaType)) continue;
    try {
      images.push({ data: new Uint8Array(await fs.readFile(a.path)), mediaType: a.mediaType.toLowerCase() });
    } catch (err) {
      console.error(`[Telegram] Could not read saved image ${a.path}:`, err);
    }
  }
  return images;
}

/**
 * Collects the messages of a Telegram album (one update per item, sharing a
 * `media_group_id`) and hands them over together once no item has arrived for
 * `delayMs`.
 */
export class MediaGroupBuffer<T> {
  private readonly groups = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly delayMs: number,
    private readonly onFlush: (key: string, items: T[]) => void,
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
  ) {}

  add(key: string, item: T): void {
    const group = this.groups.get(key);
    if (group) this.timers.clear(group.timer);
    const items = group ? [...group.items, item] : [item];
    const timer = this.timers.set(() => {
      this.groups.delete(key);
      this.onFlush(key, items);
    }, this.delayMs);
    this.groups.set(key, { items, timer });
  }

  get size(): number {
    return this.groups.size;
  }
}
