import type { AppSecrets } from './schema';

/**
 * Secret reference interpolation for config.yaml.
 *
 * config.yaml is human-editable and kept in plaintext (and exposed to the
 * dashboard editor), so credentials must not live there directly. Instead any
 * string in config may reference a value from secrets.yaml using a
 * shell/GitHub-Actions-style placeholder:
 *
 *     ${secrets.<dot.path>}
 *
 * where <dot.path> is a dotted path into the parsed secrets object. User-defined
 * secrets live under the freeform `custom:` section, so a typical reference is:
 *
 *     # secrets.yaml
 *     custom:
 *       mcp:
 *         myservice:
 *           token: s3cr3t
 *
 *     # config.yaml
 *     tools:
 *       mcpServers:
 *         - name: myservice
 *           url: https://example.com/mcp
 *           headers:
 *             Authorization: "Bearer ${secrets.custom.mcp.myservice.token}"
 *
 * The path may also point at built-in secret sections (e.g.
 * `${secrets.git.pat}`), but `custom.*` is the recommended namespace for
 * anything you define yourself.
 *
 * Resolution rules:
 *   - When a string is *exactly* one reference, the resolved value replaces it
 *     with its original type preserved (so a numeric secret stays a number).
 *   - When a reference is embedded in a larger string, the resolved value is
 *     stringified and substituted in place, so multiple refs / surrounding text
 *     are supported (e.g. "Bearer ${secrets.custom.x}").
 *   - An unresolved reference (no matching secret) is left verbatim and reported
 *     in `unresolved`, so misconfiguration is visible in logs rather than
 *     silently sending an empty credential.
 *
 * Interpolation is applied to the in-memory config only — the file on disk keeps
 * the references, which is the whole point.
 */

// A single reference token: ${secrets.a.b.c}
const SECRET_REF = /\$\{secrets\.([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*)\}/g;
// The whole string is exactly one reference (nothing before/after).
const WHOLE_REF = /^\$\{secrets\.([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*)\}$/;

function lookup(secrets: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((acc, key) => {
    if (acc != null && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, secrets);
}

export interface InterpolateResult<T> {
  value: T;
  /** Distinct reference paths that had no matching secret. */
  unresolved: string[];
}

/**
 * Recursively walks `input` (config object/array/primitive) and resolves every
 * `${secrets.<path>}` reference against `secrets`. Returns a new value; the
 * input is not mutated.
 */
export function interpolateSecrets<T>(input: T, secrets: AppSecrets): InterpolateResult<T> {
  const unresolved = new Set<string>();

  const resolveString = (str: string): unknown => {
    // Fast path: no reference at all.
    if (!str.includes('${secrets.')) return str;

    const whole = str.match(WHOLE_REF);
    if (whole) {
      const found = lookup(secrets, whole[1]);
      if (found === undefined) {
        unresolved.add(whole[1]);
        return str;
      }
      return found; // preserve original type
    }

    return str.replace(SECRET_REF, (match, dotPath: string) => {
      const found = lookup(secrets, dotPath);
      if (found === undefined) {
        unresolved.add(dotPath);
        return match;
      }
      return String(found);
    });
  };

  const walk = (val: unknown): unknown => {
    if (typeof val === 'string') return resolveString(val);
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return val;
  };

  return { value: walk(input) as T, unresolved: [...unresolved] };
}
