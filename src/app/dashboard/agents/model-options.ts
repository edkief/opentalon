export interface ModelOption {
  value: string;
  label: string;
}

/**
 * The options for a model dropdown: the listed models, plus the selected one
 * when it isn't listed (e.g. set by hand in agent.yml), marked as such (#88).
 * Without it the select would show its first option ("inherit") while state
 * still held the agent's model, so picking "inherit" changed nothing.
 */
export function modelOptions(available: string[], current: string): ModelOption[] {
  const listed = available.map((m) => ({ value: m, label: m }));
  if (!current || available.includes(current)) return listed;
  return [{ value: current, label: `${current} (not in list)` }, ...listed];
}
