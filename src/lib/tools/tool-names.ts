/** Model-facing replacement for the formerly generic shell-tool name. */
export const SHELL_TOOL_NAME = 'run_shell';

/**
 * Preserve persisted allowlists that predate the run_command -> run_shell
 * rename without exposing both names to the model.
 */
export function canonicalToolName(name: string): string {
  return name === 'run_command' ? SHELL_TOOL_NAME : name;
}

export function canonicalToolNames(names: Iterable<string>): Set<string> {
  return new Set([...names].map(canonicalToolName));
}
