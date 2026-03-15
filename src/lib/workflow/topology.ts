import type { WorkflowNodeDef, WorkflowEdgeDef } from '@/lib/db/schema';

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
