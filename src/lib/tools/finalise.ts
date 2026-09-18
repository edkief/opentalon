import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';

export function makeReplaceFinalResponseTool(onReplace: (text: string) => void): ToolSet {
  return {
    // Named "replace_" rather than "amend_": smaller models read "amend" as
    // "add to" and send only the delta, which silently destroys the rest of
    // the reply. Every string here restates the full-replacement contract for
    // the same reason — name, description, argument name, argument
    // description, and tool result all say it independently.
    replace_final_response: tool({
      description:
        'OVERWRITE the user-facing reply from your previous turn with completely new text. ' +
        'This is a REPLACEMENT, not an append: the text you pass becomes the entire reply, and the previous ' +
        'response is discarded in full. Anything you leave out will NOT be shown to the user. ' +
        'So pass the whole finished reply — copy over every part of the previous response that should survive, ' +
        'verbatim, plus your changes. Never pass only the new or changed part. ' +
        'Only call this if the work you just did revealed that the previous response was wrong, incomplete, ' +
        'or needs to mention a side-effect (e.g. a report link you just generated). ' +
        'If nothing needs to change, do NOT call this tool — the previous response will stand unchanged.',
      inputSchema: z.object({
        replacement_text: z
          .string()
          .min(1)
          .describe(
            'The COMPLETE reply to send, from first word to last. It is shown to the user exactly as written, ' +
              'in place of the previous response — not added to it. Must stand on its own: include the parts of ' +
              'the previous response you want to keep, not just the edit.',
          ),
        reason: z.string().optional().describe('Brief reason for the replacement (for logs).'),
      }),
      execute: async (input) => {
        onReplace(input.replacement_text);
        return {
          replaced: true,
          note:
            'The previous response has been discarded. The user will see exactly the text you just passed, ' +
            'and nothing else. Do not call this tool again unless that text itself is wrong.',
        };
      },
    }),
  };
}
