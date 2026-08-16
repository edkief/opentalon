/**
 * Page-context envelope: what the host tells the agent about the thing the user
 * is currently looking at.
 *
 * The host owns this. It pushes an envelope on publish and updates it through a
 * dedicated operation (POST /api/embed/context) or alongside a message. We
 * validate, cap and render it — we never invent it and never let the caller hand
 * us a raw system-prompt string (which is exactly the hole /api/chat has today,
 * src/app/api/chat/route.ts:111).
 */

import { z } from 'zod';

export const EmbedResourceContextSchema = z
  .object({
    version: z.string().max(200).optional(),
    title: z.string().max(500).optional(),
    url: z.string().max(2000).optional(),
    visibility: z.string().max(50).optional(),
    summary: z.string().max(20_000).optional(),
    outline: z.array(z.string().max(500)).max(200).optional(),
    facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    excerpt: z.string().max(20_000).optional(),
    updatedAt: z.string().max(100).optional(),
  })
  .strip();

export type EmbedResourceContext = z.infer<typeof EmbedResourceContextSchema>;

/** Resource descriptors the host sends on every request, outside the context blob. */
export const EmbedResourceSchema = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().max(500).optional(),
    url: z.string().max(2000).optional(),
    visibility: z.string().max(50).optional(),
  })
  .strip();

export type EmbedResource = z.infer<typeof EmbedResourceSchema>;

/**
 * Version used to key the rendered block. Falls back to a hash of the content so
 * a host that never sets `version` still gets a stable, change-detecting key.
 */
export function contextVersionOf(context: EmbedResourceContext | null): string | null {
  if (!context) return null;
  if (context.version) return context.version;
  // Cheap structural fingerprint; only needs to change when the content does.
  const json = JSON.stringify(context);
  let h = 0;
  for (let i = 0; i < json.length; i++) h = (Math.imul(31, h) + json.charCodeAt(i)) | 0;
  return `auto-${(h >>> 0).toString(16)}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Render the system-prompt context block for a turn.
 *
 * PROMPT CACHE CONSTRAINT — do not break this. `context` is appended to the
 * *stable* half of the system prompt (src/lib/agent/llm-executor.ts:177), which
 * is the provider cache prefix. The output here must be a pure function of the
 * resource plus the stored context version: no timestamps, no message text, no
 * per-request state. Anything that changes every turn belongs in the user
 * message instead, or the cache misses on every single request.
 */
export function renderContextBlock(args: {
  chatId: string;
  clientLabel: string;
  resourceId: string;
  title?: string | null;
  url?: string | null;
  context: EmbedResourceContext | null;
  contextVersion: string | null;
  maxChars: number;
  workspaceDir: string;
  skillsContext: string;
}): string {
  const { chatId, clientLabel, resourceId, title, url, context, contextVersion } = args;

  const head: string[] = [
    `Embedded chat surface inside ${clientLabel}. chat_id: ${chatId}.`,
    `The user is reading "${title ?? resourceId}"${url ? ` at ${url}` : ''} (resource id: ${resourceId}).`,
  ];
  if (context?.visibility) head.push(`Page visibility: ${context.visibility}.`);

  const body: string[] = [];
  if (context) {
    body.push(`\n\n## Page context${contextVersion ? ` (v${contextVersion})` : ''}`);
    if (context.summary) body.push(context.summary);
    if (context.outline?.length) {
      body.push(`\nOutline:\n${context.outline.map((s) => `- ${s}`).join('\n')}`);
    }
    if (context.facts && Object.keys(context.facts).length > 0) {
      const facts = Object.entries(context.facts)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n');
      body.push(`\nFacts:\n${facts}`);
    }
    if (context.excerpt) body.push(`\nExcerpt the user is looking at:\n${context.excerpt}`);
  }

  let rendered = body.join('\n');
  if (rendered.length > args.maxChars) {
    rendered = `${truncate(rendered, args.maxChars)}\n\n[Page context truncated. Ask the host's own tools for the full content rather than assuming what is missing.]`;
  }

  const tail =
    `\n\nThe user is on this page right now, so "this page" / "here" in their message means this resource. ` +
    `Use the host's tools (for TalonPress: the talonpress_* tools with the resource id above) to read or modify it — ` +
    `do not guess at content you have not read. Replies are rendered in a small chat panel, so keep them short and concrete.` +
    `\n\nAgent workspace: ${args.workspaceDir} (use this as the base for all file paths). ` +
    `Skills are stored in ${args.workspaceDir}/skills/.${args.skillsContext}`;

  return head.join(' ') + rendered + tail;
}
