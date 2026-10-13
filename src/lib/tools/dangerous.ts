import { configManager } from '../config';
import { canonicalToolNames } from './tool-names';

/**
 * The tool names `tools.dangerousTools` lists (or `DANGEROUS_TOOLS`, default `run_shell`), re-read
 * on each call so a hot reload applies at once. MCP tools are gated by it (registry.ts), and so are
 * pi's tools under the default harness trust (agent/harness-gate.ts).
 */
export function getDangerousToolNames(): Set<string> {
  const cfg = configManager.get().tools?.dangerousTools;
  if (cfg) return canonicalToolNames(cfg);
  const raw = process.env.DANGEROUS_TOOLS ?? 'run_shell';
  return canonicalToolNames(raw.split(',').map((s) => s.trim()).filter(Boolean));
}
