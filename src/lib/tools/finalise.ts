import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';

export function makeAmendTool(onAmend: (text: string) => void): ToolSet {
  return {
    amend_final_response: tool({
      description:
        'Replace the user-facing response from your previous turn with new text. ' +
        'Only call this if the verification work you just did revealed that the original response ' +
        'was wrong, incomplete, or needs to mention a side-effect (e.g. a report link you just generated). ' +
        'If nothing needs to change, do NOT call this tool — the original response will stand.',
      inputSchema: z.object({
        new_text: z.string().min(1).describe('The new response text that will be sent to the user in place of the original.'),
        reason: z.string().optional().describe('Brief reason for the amendment (for logs).'),
      }),
      execute: async (input) => {
        onAmend(input.new_text);
        return { amended: true };
      },
    }),
  };
}
