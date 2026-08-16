/**
 * The channels a conversation can arrive on. Shared by the `/api/chats`
 * producer and the dashboard picker that renders it, so a new channel can't be
 * emitted by the API without the UI gaining a label/icon for it.
 *
 * Order drives the channel filter row in the conversation browser.
 */
export const CHAT_CHANNELS = ['telegram', 'email', 'embed', 'web'] as const;

export type ChatChannel = (typeof CHAT_CHANNELS)[number];
