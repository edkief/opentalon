/**
 * Resolve {{key}} placeholders in a template string against an inputData map.
 * Supports dot notation: {{agentA.output}}
 */
export function resolveTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const keys = path.trim().split('.');
    let value: unknown = data;
    for (const key of keys) {
      if (value == null || typeof value !== 'object') return `{{${path}}}`;
      value = (value as Record<string, unknown>)[key];
    }
    return value != null ? String(value) : `{{${path}}}`;
  });
}
