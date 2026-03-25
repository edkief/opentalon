import type { WorkflowNodeDef, WorkflowEdgeDef, AgentNodeConfig, ConditionNodeConfig, HITLNodeConfig, CodeNodeConfig } from '@/lib/db/schema';

export interface TopologyResult {
  order: string[];        // topologically sorted node IDs
  cycle: string[] | null; // non-null if a cycle was detected
}

/**
 * Kahn's algorithm — BFS-based topological sort.
 * Returns the sorted order and null cycle on success.
 * Returns the partial order and a representative cycle path on failure.
 */
export function topologicalSort(
  nodes: WorkflowNodeDef[],
  edges: WorkflowEdgeDef[],
): TopologyResult {
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Build adjacency list and in-degree map
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) continue;
    adjacency.get(edge.sourceNodeId)!.push(edge.targetNodeId);
    inDegree.set(edge.targetNodeId, (inDegree.get(edge.targetNodeId) ?? 0) + 1);
  }

  // Queue nodes with no incoming edges
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const neighbor of adjacency.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (order.length < nodeIds.size) {
    // Cycle detected — find one cycle via DFS for a useful error message
    const remaining = [...nodeIds].filter((id) => !order.includes(id));
    const cycleNodes = findCycle(remaining, adjacency);
    return { order, cycle: cycleNodes };
  }

  return { order, cycle: null };
}

function findCycle(candidates: string[], adjacency: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): boolean {
    visited.add(node);
    stack.add(node);
    path.push(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      if (!candidates.includes(neighbor)) continue;
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true;
      } else if (stack.has(neighbor)) {
        // Found the cycle start — slice the path to the cycle
        const cycleStart = path.indexOf(neighbor);
        path.push(neighbor); // close the loop for clarity
        return true;
      }
    }

    stack.delete(node);
    path.pop();
    return false;
  }

  for (const node of candidates) {
    if (!visited.has(node)) {
      if (dfs(node)) return path;
    }
  }

  return candidates; // fallback
}

/**
 * Returns IDs of nodes that are ready to execute:
 * all predecessors are in the completedNodeIds set.
 */
export function findReadyNodes(
  allNodeIds: string[],
  edges: WorkflowEdgeDef[],
  completedNodeIds: Set<string>,
  excludeNodeIds: Set<string>,
): string[] {
  const ready: string[] = [];

  for (const nodeId of allNodeIds) {
    if (completedNodeIds.has(nodeId)) continue;
    if (excludeNodeIds.has(nodeId)) continue;

    const predecessors = edges
      .filter((e) => e.targetNodeId === nodeId)
      .map((e) => e.sourceNodeId);

    if (predecessors.every((p) => completedNodeIds.has(p))) {
      ready.push(nodeId);
    }
  }

  return ready;
}

/**
 * Client-side cycle check: can `targetId` reach `sourceId` through existing edges?
 * If yes, adding source→target would create a cycle.
 */
export function wouldCreateCycle(
  sourceId: string,
  targetId: string,
  edges: WorkflowEdgeDef[],
): boolean {
  // BFS from targetId — if we reach sourceId, adding source→target makes a cycle
  const visited = new Set<string>();
  const queue = [targetId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === sourceId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const edge of edges) {
      if (edge.sourceNodeId === current && !visited.has(edge.targetNodeId)) {
        queue.push(edge.targetNodeId);
      }
    }
  }

  return false;
}

// ─── Workflow validation ──────────────────────────────────────────────────────

export interface ValidationIssue {
  level: 'error' | 'warning';
  nodeId?: string;
  message: string;
}

export function validateWorkflow(
  nodes: WorkflowNodeDef[],
  edges: WorkflowEdgeDef[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Rule 6: All edges reference existing node IDs
  for (const edge of edges) {
    if (!nodeIds.has(edge.sourceNodeId)) {
      issues.push({ level: 'error', message: `Edge "${edge.id}" references unknown source node "${edge.sourceNodeId}"` });
    }
    if (!nodeIds.has(edge.targetNodeId)) {
      issues.push({ level: 'error', message: `Edge "${edge.id}" references unknown target node "${edge.targetNodeId}"` });
    }
  }

  // Only consider valid edges for remaining checks
  const validEdges = edges.filter((e) => nodeIds.has(e.sourceNodeId) && nodeIds.has(e.targetNodeId));

  // Rule 1 & 2: Exactly one input / output node
  const inputNodes = nodes.filter((n) => n.type === 'input');
  const outputNodes = nodes.filter((n) => n.type === 'output');

  if (inputNodes.length === 0) {
    issues.push({ level: 'error', message: 'Workflow must have an input node' });
  } else if (inputNodes.length > 1) {
    issues.push({ level: 'error', message: `Workflow must have exactly one input node, found ${inputNodes.length}` });
  }

  if (outputNodes.length === 0) {
    issues.push({ level: 'error', message: 'Workflow must have an output node' });
  } else if (outputNodes.length > 1) {
    issues.push({ level: 'error', message: `Workflow must have exactly one output node, found ${outputNodes.length}` });
  }

  // Rule 3: No cycles
  const { cycle } = topologicalSort(nodes, validEdges);
  if (cycle) {
    issues.push({ level: 'error', message: `Graph contains a cycle: ${cycle.join(' → ')}` });
  }

  // Build incoming/outgoing maps
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const edge of validEdges) {
    incoming.get(edge.targetNodeId)!.push(edge.sourceNodeId);
    outgoing.get(edge.sourceNodeId)!.push(edge.targetNodeId);
  }

  // Rule 7: Input node must have no incoming edges
  for (const n of inputNodes) {
    if (incoming.get(n.id)!.length > 0) {
      issues.push({ level: 'error', nodeId: n.id, message: 'Input node must not have incoming edges' });
    }
  }

  // Rule 8: Output node must have no outgoing edges
  for (const n of outputNodes) {
    if (outgoing.get(n.id)!.length > 0) {
      issues.push({ level: 'error', nodeId: n.id, message: 'Output node must not have outgoing edges' });
    }
  }

  // Rule 4 & 5: Connectivity for non-input/output nodes
  for (const node of nodes) {
    if (node.type === 'input') continue;
    if (incoming.get(node.id)!.length === 0) {
      issues.push({ level: 'error', nodeId: node.id, message: `Node "${node.label}" has no incoming edges` });
    }
  }
  for (const node of nodes) {
    if (node.type === 'output') continue;
    if (outgoing.get(node.id)!.length === 0) {
      issues.push({ level: 'error', nodeId: node.id, message: `Node "${node.label}" has no outgoing edges` });
    }
  }

  // Rule 9: Output reachable from input (BFS)
  if (inputNodes.length === 1 && outputNodes.length === 1) {
    const visited = new Set<string>();
    const queue = [inputNodes[0].id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const target of outgoing.get(current) ?? []) {
        queue.push(target);
      }
    }
    if (!visited.has(outputNodes[0].id)) {
      issues.push({ level: 'error', message: 'Output node is not reachable from input node' });
    }
  }

  // Rule 10: Agent nodes must have a non-empty taskTemplate
  for (const node of nodes) {
    if (node.type !== 'agent') continue;
    const config = node.config as AgentNodeConfig;
    if (!config.taskTemplate?.trim()) {
      issues.push({ level: 'error', nodeId: node.id, message: `Agent node "${node.label}" must have a non-empty task template` });
    }
  }

  // Rule 11, 12 & branch labels: Condition nodes
  for (const node of nodes) {
    if (node.type !== 'condition') continue;
    const config = node.config as ConditionNodeConfig;
    if (!config.expression?.trim()) {
      issues.push({ level: 'error', nodeId: node.id, message: `Condition node "${node.label}" must have a non-empty expression` });
    }
    const condOutEdges = validEdges.filter((e) => e.sourceNodeId === node.id);
    if (condOutEdges.length !== 2) {
      issues.push({ level: 'error', nodeId: node.id, message: `Condition node "${node.label}" must have exactly 2 outgoing edges, found ${condOutEdges.length}` });
    } else {
      const trueLabel = config.trueEdgeLabel?.trim() || 'true';
      const falseLabel = config.falseEdgeLabel?.trim() || 'false';
      const edgeLabels = condOutEdges.map((e) => e.label ?? '');
      if (!edgeLabels.includes(trueLabel)) {
        issues.push({ level: 'error', nodeId: node.id, message: `Condition node "${node.label}": no outgoing edge is labelled "${trueLabel}" (true branch)` });
      }
      if (!edgeLabels.includes(falseLabel)) {
        issues.push({ level: 'error', nodeId: node.id, message: `Condition node "${node.label}": no outgoing edge is labelled "${falseLabel}" (false branch)` });
      }
    }
  }

  // Rule 13: HITL nodes must have a non-empty prompt
  for (const node of nodes) {
    if (node.type !== 'hitl') continue;
    const config = node.config as HITLNodeConfig;
    if (!config.prompt?.trim()) {
      issues.push({ level: 'error', nodeId: node.id, message: `HITL node "${node.label}" must have a non-empty prompt` });
    }
  }

  // Rule 15: Code nodes must have non-empty code
  for (const node of nodes) {
    if (node.type !== 'code') continue;
    const config = node.config as CodeNodeConfig;
    if (!config.code?.trim()) {
      issues.push({ level: 'error', nodeId: node.id, message: `Code node "${node.label}" must have non-empty code` });
    }
  }

  // Rule 14: Duplicate edges (warning)
  const edgeKeys = new Set<string>();
  for (const edge of validEdges) {
    const key = `${edge.sourceNodeId}→${edge.targetNodeId}`;
    if (edgeKeys.has(key)) {
      issues.push({ level: 'warning', message: `Duplicate edge from "${nodeMap.get(edge.sourceNodeId)?.label}" to "${nodeMap.get(edge.targetNodeId)?.label}"` });
    }
    edgeKeys.add(key);
  }

  return issues;
}
