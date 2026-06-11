import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { configManager } from '../../config';
import { parseModelString, getApiKeyForProvider } from '../../agent/model-resolver';
import { escapeHtml } from '../format';
import { chatModelPins, isOwner } from '../state';

export async function handleListModelsCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId) return;

  const cfg = configManager.get().llm ?? {};
  const primary = cfg.model ?? process.env.LLM_MODEL ?? '(auto-detect)';
  const fallbacks = cfg.fallbacks ?? [];
  const pinned = chatModelPins.get(chatId);

  const lines: string[] = [];
  lines.push(`<b>Primary:</b> <code>${escapeHtml(primary)}</code>${pinned ? '' : ' ✓'}`);
  if (fallbacks.length) {
    lines.push('\n<b>Fallbacks:</b>');
    for (const fb of fallbacks) lines.push(`  • <code>${escapeHtml(fb)}</code>`);
  }
  if (pinned) {
    lines.push(`\n<b>Pinned (this chat):</b> <code>${escapeHtml(pinned)}</code> ✓`);
    lines.push('<i>Use /resetmodel to restore default behaviour.</i>');
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

/** Return all configured + auto-detectable models that have a valid API key. */
function getAvailableModels(): string[] {
  const cfg = configManager.get().llm ?? {};
  const configured = [cfg.model, ...(cfg.fallbacks ?? [])].filter((s): s is string => Boolean(s));



  // Custom providers
  const customProviders = configManager.getSecrets().providers?.map(p => p.name) ?? [];
  return configured.filter(s => {
    const parsed = parseModelString(s);
    if (!parsed) return false;
    const knownProviders = ['anthropic', 'openai', 'mistral', 'minimax', 'google'];
    const allKnown = new Set([...knownProviders, ...customProviders]);
    return allKnown.has(parsed.provider) && Boolean(getApiKeyForProvider(parsed.provider));
  });
}

/** Build a flat inline keyboard with one button per model (2 per row) + Cancel. */
function buildFlatModelKeyboard(models: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  models.forEach((m, i) => {
    kb.text(m, `setmodel:pick:${m}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('✖ Cancel', 'setmodel:cancel');
}

/** Build a provider-level keyboard for the two-level menu + Cancel. */
function buildProviderKeyboard(providers: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  providers.forEach((p, i) => {
    kb.text(p, `setmodel:provider:${p}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('✖ Cancel', 'setmodel:cancel');
}

export async function handleSetModelCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !isOwner(ctx.message?.from?.id)) return;

  const modelString = (ctx.match as string | undefined)?.trim();

  // No argument — show interactive selection
  if (!modelString) {
    const models = getAvailableModels();
    if (models.length === 0) {
      await ctx.reply('No configured providers with API keys found. Add API keys to <code>secrets.yaml</code>.', { parse_mode: 'HTML' });
      return;
    }

    // Flat if ≤6 models, two-level otherwise
    if (models.length <= 6) {
      await ctx.reply('Select a model to pin for this chat:', {
        parse_mode: 'HTML',
        reply_markup: buildFlatModelKeyboard(models),
      });
    } else {
      const providers = [...new Set(models.map(m => parseModelString(m)!.provider))];
      await ctx.reply('Select a provider:', {
        parse_mode: 'HTML',
        reply_markup: buildProviderKeyboard(providers),
      });
    }
    return;
  }

  const parsed = parseModelString(modelString);
  if (!parsed) {
    await ctx.reply('Invalid format. Use <code>provider/model</code>, e.g. <code>anthropic/claude-sonnet-4-5</code>.', { parse_mode: 'HTML' });
    return;
  }

  const apiKey = getApiKeyForProvider(parsed.provider);
  const knownProviders = ['anthropic', 'openai', 'mistral', 'minimax', 'google'];
  const customProviders = configManager.getSecrets().providers?.map(p => p.name) ?? [];
  const allKnown = new Set([...knownProviders, ...customProviders]);

  if (!allKnown.has(parsed.provider) || !apiKey) {
    const available = [...allKnown].filter(p => getApiKeyForProvider(p));
    await ctx.reply(
      `Provider <code>${escapeHtml(parsed.provider)}</code> is not configured or has no API key.\n\n` +
      `Configured providers: ${available.map(p => `<code>${escapeHtml(p)}</code>`).join(', ') || 'none'}`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  chatModelPins.set(chatId, modelString);
  await ctx.reply(
    `Model pinned to <code>${escapeHtml(modelString)}</code> for this chat.\nFallbacks are disabled while pinned.\nUse /resetmodel to restore defaults.`,
    { parse_mode: 'HTML' },
  );
}

export async function handleModelCallback(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !isOwner(ctx.callbackQuery?.from?.id)) {
    await ctx.answerCallbackQuery('Not authorized.');
    return;
  }

  const data = ctx.callbackQuery?.data ?? '';

  // Provider selected — show models for that provider
  const providerMatch = data.match(/^setmodel:provider:(.+)$/);
  if (providerMatch) {
    const provider = providerMatch[1];
    const models = getAvailableModels().filter(m => parseModelString(m)?.provider === provider);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Select a <b>${escapeHtml(provider)}</b> model:`, {
      parse_mode: 'HTML',
      reply_markup: buildFlatModelKeyboard(models),
    });
    return;
  }

  // Model selected — pin it
  const pickMatch = data.match(/^setmodel:pick:(.+)$/);
  if (pickMatch) {
    const modelString = pickMatch[1];
    chatModelPins.set(chatId, modelString);
    await ctx.answerCallbackQuery(`Pinned: ${modelString}`);
    await ctx.editMessageText(
      `Model pinned to <code>${escapeHtml(modelString)}</code> for this chat.\nFallbacks are disabled while pinned.\nUse /resetmodel to restore defaults.`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  // Cancelled
  if (data === 'setmodel:cancel') {
    await ctx.answerCallbackQuery('Cancelled.');
    await ctx.deleteMessage().catch(() => ctx.editMessageReplyMarkup({ reply_markup: undefined }));
  }
}

export async function handleResetModelCommand(ctx: Context): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !isOwner(ctx.message?.from?.id)) return;

  const wasPinned = chatModelPins.get(chatId);
  chatModelPins.delete(chatId);

  const cfg = configManager.get().llm ?? {};
  const primary = cfg.model ?? process.env.LLM_MODEL ?? '(auto-detect)';

  if (wasPinned) {
    await ctx.reply(
      `Model pin removed. Back to configured primary: <code>${escapeHtml(primary)}</code>`,
      { parse_mode: 'HTML' },
    );
  } else {
    await ctx.reply(`No model was pinned. Using configured primary: <code>${escapeHtml(primary)}</code>`, { parse_mode: 'HTML' });
  }
}
