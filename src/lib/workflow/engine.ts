/**
 * WorkflowEngine — stateless orchestrator. All execution state lives in PostgreSQL.
 * The engine reads node definitions from `workflows.definition`, tracks progress in
 * `workflow_run_nodes`, and enqueues pg-boss jobs for each ready node.
 *
 * Pod restarts are safe: call recoverInProgressRuns() on startup to re-enqueue
 * any nodes that were `running` when the process died.
 */

import { db } from '@/lib/db';
import {
  workflows,
  workflowRuns,
  workflowRunNodes,
  workflowHitlRequests,
} from '@/lib/db/schema';
import type {
  WorkflowNodeDef,
  WorkflowEdgeDef,
  AgentNodeConfig,
  ParallelNodeConfig,
  ConditionNodeConfig,
  HITLNodeConfig,
} from '@/lib/db/schema';
import { eq, inArray, and } from 'drizzle-orm';
import { schedulerService } from '@/lib/scheduler';
import { emitWorkflow } from '@/lib/agent/log-bus';
import { topologicalSort, findReadyNodes } from './topology';
import { spawnSpecialist } from '@/lib/agent/specialist';
import { getBuiltInTools } from '@/lib/tools/built-in';

// ─── pg-boss queue names ───────────────────────────────────────────────────────

export const WORKFLOW_NODE_QUEUE = 'workflow-node-execution';
export const WORKFLOW_RESUME_QUEUE = 'workflow-resume';

// ─── Payload types for pg-boss jobs ───────────────────────────────────────────

export interface WorkflowNodeJobData {
  runId: string;
  runNodeId: string;
  workflowId: string;
  nodeType: string;
  nodeConfig: Record<string, unknown>;
  inputData: Record<string, unknown>;
  chatId: string;
}

export interface WorkflowResumeJobData {
  runId: string;
  nodeId: string;
  hitlId: string;
  approved: boolean;
}

// ─── WorkflowEngine ───────────────────────────────────────────────────────────

export class WorkflowEngine {
  /**
   * Create a new run for a workflow and enqueue the first ready nodes.
   */
  async createRun(
    workflowId: string,
    triggerData: Record<string, unknown> = {},
    chatId = 'system',
  ): Promise<string> {
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1);

    if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

    const { nodes, edges } = workflow.definition as {
      nodes: WorkflowNodeDef[];
      edges: WorkflowEdgeDef[];
    };

    // Validate — reject cycles
    const { cycle } = topologicalSort(nodes, edges);
    if (cycle) {
      throw new Error(`Workflow contains a cycle: ${cycle.join(' → ')}`);
    }

    const runId = crypto.randomUUID();
    const now = new Date();

    await db.insert(workflowRuns).values({
      id: runId,
      workflowId,
      status: 'running',
      triggerData,
      startedAt: now,
    });

    emitWorkflow({
      id: crypto.randomUUID(),
      kind: 'run_started',
      runId,
      workflowId,
      timestamp: now.toISOString(),
    });

    // Create a run-node row for every node in the definition
    const runNodeRows = nodes.map((node) => ({
      id: crypto.randomUUID(),
      runId,
      nodeId: node.id,
      nodeType: node.type,
      status: 'waiting' as const,
    }));
    await db.insert(workflowRunNodes).values(runNodeRows);

    // Immediately complete the InputNode with triggerData as outputData
    const inputNode = nodes.find((n) => n.type === 'input');
    if (inputNode) {
      await db
        .update(workflowRunNodes)
        .set({ status: 'completed', outputData: triggerData, completedAt: now })
        .where(and(eq(workflowRunNodes.runId, runId), eq(workflowRunNodes.nodeId, inputNode.id)));

      emitWorkflow({
        id: crypto.randomUUID(),
        kind: 'node_completed',
        runId,
        workflowId,
        nodeId: inputNode.id,
        nodeType: 'input',
        timestamp: now.toISOString(),
      });
    }

    // Advance the run to enqueue the first batch of ready nodes
    await this.advanceRun(runId, chatId);

    return runId;
  }

  /**
   * Find all nodes whose predecessors are completed and enqueue them.
   * Called after every node completion, failure, or HITL resolution.
   */
  async advanceRun(runId: string, chatId = 'system'): Promise<void> {
    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    if (!run || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return;

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, run.workflowId))
      .limit(1);
    if (!workflow) return;

    const { nodes, edges } = workflow.definition as {
      nodes: WorkflowNodeDef[];
      edges: WorkflowEdgeDef[];
    };

    const runNodes = await db
      .select()
      .from(workflowRunNodes)
      .where(eq(workflowRunNodes.runId, runId));

    const completedIds = new Set(
      runNodes.filter((rn) => rn.status === 'completed' || rn.status === 'skipped').map((rn) => rn.nodeId),
    );
    const excludedIds = new Set(
      runNodes
        .filter((rn) => rn.status !== 'waiting')
        .map((rn) => rn.nodeId),
    );
    const failedNodes = runNodes.filter((rn) => rn.status === 'failed');

    // If any node failed, fail the whole run
    if (failedNodes.length > 0) {
      await this.failRun(runId, run.workflowId, `Node ${failedNodes[0].nodeId} failed: ${failedNodes[0].errorMessage}`);
      return;
    }

    // Check if the OutputNode is complete — run is done
    const outputNode = nodes.find((n) => n.type === 'output');
    if (outputNode) {
      const outputRunNode = runNodes.find((rn) => rn.nodeId === outputNode.id);
      if (outputRunNode?.status === 'completed') {
        await db
          .update(workflowRuns)
          .set({ status: 'completed', result: outputRunNode.outputData ?? {}, completedAt: new Date(), updatedAt: new Date() })
          .where(eq(workflowRuns.id, runId));

        emitWorkflow({
          id: crypto.randomUUID(),
          kind: 'run_completed',
          runId,
          workflowId: run.workflowId,
          timestamp: new Date().toISOString(),
        });
        return;
      }
    }

    const allNodeIds = nodes.map((n) => n.id);
    const readyNodeIds = findReadyNodes(allNodeIds, edges, completedIds, excludedIds);

    for (const nodeId of readyNodeIds) {
      const nodeDef = nodes.find((n) => n.id === nodeId);
      if (!nodeDef) continue;

      const runNode = runNodes.find((rn) => rn.nodeId === nodeId);
      if (!runNode) continue;

      // Resolve inputData from predecessor outputs + edge data mappings
      const inputData = this.resolveInputData(nodeId, nodes, edges, runNodes);

      // Mark as running
      await db
        .update(workflowRunNodes)
        .set({ status: 'running', inputData, startedAt: new Date(), updatedAt: new Date() })
        .where(eq(workflowRunNodes.id, runNode.id));

      emitWorkflow({
        id: crypto.randomUUID(),
        kind: 'node_started',
        runId,
        workflowId: run.workflowId,
        nodeId,
        nodeType: nodeDef.type,
        timestamp: new Date().toISOString(),
      });

      // Enqueue the node job
      await schedulerService.sendWorkflowNodeJob({
        runId,
        runNodeId: runNode.id,
        workflowId: run.workflowId,
        nodeType: nodeDef.type,
        nodeConfig: nodeDef.config as Record<string, unknown>,
        inputData,
        chatId,
      });
    }
  }

  /**
   * Called by the pg-boss worker when a node job completes successfully.
   */
  async handleNodeComplete(
    runNodeId: string,
    outputData: Record<string, unknown>,
    chatId = 'system',
  ): Promise<void> {
    const [runNode] = await db
      .select()
      .from(workflowRunNodes)
      .where(eq(workflowRunNodes.id, runNodeId))
      .limit(1);
    if (!runNode) return;

    const now = new Date();

    await db
      .update(workflowRunNodes)
      .set({ status: 'completed', outputData, completedAt: now, updatedAt: now })
      .where(eq(workflowRunNodes.id, runNodeId));

    const [run] = await db
      .select({ workflowId: workflowRuns.workflowId })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runNode.runId))
      .limit(1);

    emitWorkflow({
      id: crypto.randomUUID(),
      kind: 'node_completed',
      runId: runNode.runId,
      workflowId: run?.workflowId ?? '',
      nodeId: runNode.nodeId,
      nodeType: runNode.nodeType,
      result: typeof outputData.output === 'string' ? outputData.output.slice(0, 500) : undefined,
      durationMs: runNode.startedAt ? now.getTime() - runNode.startedAt.getTime() : undefined,
      timestamp: now.toISOString(),
    });

    await this.advanceRun(runNode.runId, chatId);
  }

  /**
   * Called by the pg-boss worker when a node job fails.
   */
  async handleNodeFailed(runNodeId: string, errorMessage: string): Promise<void> {
    const [runNode] = await db
      .select()
      .from(workflowRunNodes)
      .where(eq(workflowRunNodes.id, runNodeId))
      .limit(1);
    if (!runNode) return;

    const now = new Date();
    await db
      .update(workflowRunNodes)
      .set({ status: 'failed', errorMessage, completedAt: now, updatedAt: now })
      .where(eq(workflowRunNodes.id, runNodeId));

    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runNode.runId))
      .limit(1);

    emitWorkflow({
      id: crypto.randomUUID(),
      kind: 'node_failed',
      runId: runNode.runId,
      workflowId: run?.workflowId ?? '',
      nodeId: runNode.nodeId,
      nodeType: runNode.nodeType,
      timestamp: now.toISOString(),
    });

    await this.failRun(runNode.runId, run?.workflowId ?? '', errorMessage);
  }

  /**
   * Called when a HITL request is approved or denied (from Telegram or dashboard).
   */
  async handleHITLResolved(hitlId: string, approved: boolean): Promise<void> {
    const [hitl] = await db
      .select()
      .from(workflowHitlRequests)
      .where(eq(workflowHitlRequests.id, hitlId))
      .limit(1);
    if (!hitl || hitl.status !== 'pending') return;

    await db
      .update(workflowHitlRequests)
      .set({ status: approved ? 'approved' : 'denied', resolvedAt: new Date() })
      .where(eq(workflowHitlRequests.id, hitlId));

    const [run] = await db
      .select({ workflowId: workflowRuns.workflowId })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, hitl.runId))
      .limit(1);

    emitWorkflow({
      id: crypto.randomUUID(),
      kind: 'hitl_resolved',
      runId: hitl.runId,
      workflowId: run?.workflowId ?? '',
      nodeId: hitl.nodeId,
      timestamp: new Date().toISOString(),
    });

    // Enqueue a resume job
    await schedulerService.sendWorkflowResumeJob({
      runId: hitl.runId,
      nodeId: hitl.nodeId,
      hitlId,
      approved,
    });
  }

  /**
   * Execute a workflow node synchronously (called by the pg-boss worker).
   */
  async executeNode(data: WorkflowNodeJobData): Promise<void> {
    const { runId, runNodeId, nodeType, nodeConfig, inputData, chatId } = data;

    try {
      switch (nodeType) {
        case 'agent':
          await this.executeAgentNode(runNodeId, nodeConfig as unknown as AgentNodeConfig, inputData, chatId);
          break;
        case 'parallel':
          await this.executeParallelNode(runId, runNodeId, nodeConfig as unknown as ParallelNodeConfig, inputData, chatId);
          break;
        case 'condition':
          await this.executeConditionNode(runId, runNodeId, nodeConfig as unknown as ConditionNodeConfig, inputData, chatId);
          break;
        case 'hitl':
          await this.executeHITLNode(runId, runNodeId, nodeConfig as unknown as HITLNodeConfig, chatId);
          break;
        case 'output':
          // OutputNode simply passes inputData through as outputData
          await this.handleNodeComplete(runNodeId, inputData, chatId);
          break;
        default:
          throw new Error(`Unknown node type: ${nodeType}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.handleNodeFailed(runNodeId, message);
    }
  }

  /**
   * Resume a workflow after a HITL node is resolved (called by the workflow-resume pg-boss worker).
   */
  async executeResumeJob(data: WorkflowResumeJobData): Promise<void> {
    const { runId, nodeId, approved, hitlId } = data;

    // Find the run node for this HITL node
    const [runNode] = await db
      .select()
      .from(workflowRunNodes)
      .where(and(eq(workflowRunNodes.runId, runId), eq(workflowRunNodes.nodeId, nodeId)))
      .limit(1);
    if (!runNode) return;

    const [run] = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);

    if (!approved) {
      // Denied — fail the node and the run
      await this.handleNodeFailed(runNode.id, 'HITL step denied by user');
      return;
    }

    // Approved — mark the HITL node as completed and resume the run
    await db
      .update(workflowRunNodes)
      .set({ status: 'completed', outputData: { approved: true, hitlId }, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(workflowRunNodes.id, runNode.id));

    // Unpause the run
    await db
      .update(workflowRuns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(workflowRuns.id, runId));

    emitWorkflow({
      id: crypto.randomUUID(),
      kind: 'node_completed',
      runId,
      workflowId: run?.workflowId ?? '',
      nodeId,
      nodeType: 'hitl',
      timestamp: new Date().toISOString(),
    });

    await this.advanceRun(runId, run?.workflowId ?? 'system');
  }

  /**
   * On process startup: re-enqueue any nodes that were `running` when the process crashed.
   */
  async recoverInProgressRuns(): Promise<void> {
    const stuckRuns = await db
      .select()
      .from(workflowRuns)
      .where(inArray(workflowRuns.status, ['running', 'paused']));

    for (const run of stuckRuns) {
      const stuckNodes = await db
        .select()
        .from(workflowRunNodes)
        .where(and(eq(workflowRunNodes.runId, run.id), eq(workflowRunNodes.status, 'running')));

      if (stuckNodes.length === 0) continue;

      const [workflow] = await db
        .select()
        .from(workflows)
        .where(eq(workflows.id, run.workflowId))
        .limit(1);
      if (!workflow) continue;

      const { nodes } = workflow.definition as { nodes: WorkflowNodeDef[]; edges: WorkflowEdgeDef[] };

      for (const runNode of stuckNodes) {
        const nodeDef = nodes.find((n) => n.id === runNode.nodeId);
        if (!nodeDef) continue;

        console.log(`[WorkflowEngine] Recovering stuck node ${runNode.nodeId} in run ${run.id}`);

        await schedulerService.sendWorkflowNodeJob({
          runId: run.id,
          runNodeId: runNode.id,
          workflowId: run.workflowId,
          nodeType: nodeDef.type,
          nodeConfig: nodeDef.config as Record<string, unknown>,
          inputData: (runNode.inputData as Record<string, unknown>) ?? {},
          chatId: 'system',
        });
      }
    }
  }

  // ─── Private execution methods ─────────────────────────────────────────────

  private async executeAgentNode(
    runNodeId: string,
    config: AgentNodeConfig,
    inputData: Record<string, unknown>,
    chatId: string,
  ): Promise<void> {
    // Resolve {{key}} template references in the task and context templates
    const taskDescription = resolveTemplate(config.taskTemplate, inputData);
    const contextSnapshot = config.contextTemplate
      ? resolveTemplate(config.contextTemplate, inputData)
      : JSON.stringify(inputData, null, 2);

    // Provide built-in tools so the agent can execute multi-step tool loops
    // (without tools, generateText runs a single round with no tool execution)
    const tools = getBuiltInTools({ telegramChatId: chatId });

    const result = await spawnSpecialist({
      taskDescription,
      contextSnapshot,
      depth: 0,
      tools,
      agentId: config.agentId || 'default',
      maxStepsOverride: config.maxSteps,
      timeoutMs: config.timeoutMs,
    });

    await this.handleNodeComplete(runNodeId, { output: result }, chatId);
  }

  private async executeParallelNode(
    _runId: string,
    runNodeId: string,
    _config: ParallelNodeConfig,
    inputData: Record<string, unknown>,
    chatId: string,
  ): Promise<void> {
    // The parallel node is a pure fan-out signal. Complete it immediately so
    // that advanceRun sees it as a completed predecessor and enqueues all
    // child nodes (those connected by outgoing edges) in the next pass.
    await this.handleNodeComplete(runNodeId, inputData, chatId);
  }

  private async executeConditionNode(
    runId: string,
    runNodeId: string,
    config: ConditionNodeConfig,
    inputData: Record<string, unknown>,
    chatId: string,
  ): Promise<void> {
    let result = false;
    try {
      // Safe evaluation: only exposes { input } binding — no process/require access
      const fn = new Function('input', `"use strict"; return !!(${config.expression})`);
      result = Boolean(fn(inputData));
    } catch (err) {
      throw new Error(`Condition expression evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const outputData = { conditionResult: result, input: inputData };
    await db
      .update(workflowRunNodes)
      .set({
        status: 'completed',
        outputData,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workflowRunNodes.id, runNodeId));

    // Mark the non-taken edge's target as skipped
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (run) {
      const [workflow] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
      if (workflow) {
        const { edges } = workflow.definition as { nodes: WorkflowNodeDef[]; edges: WorkflowEdgeDef[] };
        const [runNode] = await db.select().from(workflowRunNodes).where(eq(workflowRunNodes.id, runNodeId)).limit(1);

        if (runNode) {
          const outEdges = edges.filter((e) => e.sourceNodeId === runNode.nodeId);
          const skippedLabel = result ? config.falseEdgeLabel : config.trueEdgeLabel;
          for (const edge of outEdges) {
            if (edge.label === skippedLabel) {
              await db
                .update(workflowRunNodes)
                .set({ status: 'skipped', updatedAt: new Date() })
                .where(and(eq(workflowRunNodes.runId, runId), eq(workflowRunNodes.nodeId, edge.targetNodeId)));
            }
          }
        }
      }
    }

    emitWorkflow({
      id: crypto.randomUUID(),
      kind: 'node_completed',
      runId,
      workflowId: run?.workflowId ?? '',
      nodeId: runNodeId,
      nodeType: 'condition',
      timestamp: new Date().toISOString(),
    });

    await this.advanceRun(runId, chatId);
  }

  private async executeHITLNode(
    runId: string,
    runNodeId: string,
    config: HITLNodeConfig,
    chatId: string,
  ): Promise<void> {
    if (config.autoApprove) {
      // Auto-approve — skip the HITL gate (used for non-interactive runs)
      await this.handleNodeComplete(runNodeId, { approved: true, autoApproved: true }, chatId);
      return;
    }

    const hitlId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + (config.ttlMs ?? 5 * 60 * 1000));

    const [runNode] = await db
      .select()
      .from(workflowRunNodes)
      .where(eq(workflowRunNodes.id, runNodeId))
      .limit(1);

    await db.insert(workflowHitlRequests).values({
      id: hitlId,
      runId,
      nodeId: runNode?.nodeId ?? runNodeId,
      prompt: config.prompt,
      chatId,
      expiresAt,
    });

    await db
      .update(workflowRunNodes)
      .set({ status: 'awaiting_hitl', hitlId, updatedAt: new Date() })
      .where(eq(workflowRunNodes.id, runNodeId));

    await db
      .update(workflowRuns)
      .set({ status: 'paused', updatedAt: new Date() })
      .where(eq(workflowRuns.id, runId));

    const [run] = await db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);

    emitWorkflow({
      id: crypto.randomUUID(),
      kind: 'hitl_requested',
      runId,
      workflowId: run?.workflowId ?? '',
      nodeId: runNode?.nodeId ?? runNodeId,
      nodeType: 'hitl',
      timestamp: new Date().toISOString(),
    });

    // Return without marking the node complete — the resume job will do that
    console.log(`[WorkflowEngine] HITL requested for run ${runId}, hitlId=${hitlId}`);
  }

  /**
   * Cancel a running or paused run. Marks the run as cancelled and all
   * non-terminal nodes (waiting / running / awaiting_hitl) as failed.
   */
  async cancelRun(runId: string): Promise<void> {
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (!run) return;
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return;

    const now = new Date();

    // Mark all non-terminal nodes as failed
    const runNodes = await db.select().from(workflowRunNodes).where(eq(workflowRunNodes.runId, runId));
    const nonTerminal = runNodes.filter((rn) => !['completed', 'failed', 'skipped'].includes(rn.status));
    for (const rn of nonTerminal) {
      await db
        .update(workflowRunNodes)
        .set({ status: 'failed', errorMessage: 'Run cancelled by user', completedAt: now, updatedAt: now })
        .where(eq(workflowRunNodes.id, rn.id));
    }

    await db
      .update(workflowRuns)
      .set({ status: 'cancelled', errorMessage: 'Cancelled by user', completedAt: now, updatedAt: now })
      .where(eq(workflowRuns.id, runId));

    emitWorkflow({
      id: crypto.randomUUID(),
      kind: 'run_failed',
      runId,
      workflowId: run.workflowId,
      timestamp: now.toISOString(),
    });
  }

  // ─── Run failure ───────────────────────────────────────────────────────────

  private async failRun(runId: string, workflowId: string, errorMessage: string): Promise<void> {
    await db
      .update(workflowRuns)
      .set({ status: 'failed', errorMessage, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(workflowRuns.id, runId));

    emitWorkflow({
      id: crypto.randomUUID(),
      kind: 'run_failed',
      runId,
      workflowId,
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Input data resolution ─────────────────────────────────────────────────

  private resolveInputData(
    nodeId: string,
    nodes: WorkflowNodeDef[],
    edges: WorkflowEdgeDef[],
    runNodes: (typeof workflowRunNodes.$inferSelect)[],
  ): Record<string, unknown> {
    const incomingEdges = edges.filter((e) => e.targetNodeId === nodeId);
    const merged: Record<string, unknown> = {};

    for (const edge of incomingEdges) {
      const predRunNode = runNodes.find((rn) => rn.nodeId === edge.sourceNodeId);
      if (!predRunNode?.outputData) continue;

      if (edge.dataMapping && Object.keys(edge.dataMapping).length > 0) {
        // Apply field-level mapping
        for (const [sourceKey, targetKey] of Object.entries(edge.dataMapping)) {
          const val = (predRunNode.outputData as Record<string, unknown>)[sourceKey];
          if (val !== undefined) merged[targetKey] = val;
        }
      } else {
        // Default: merge all outputData fields, prefixed by source node label
        const predNodeDef = nodes.find((n) => n.id === edge.sourceNodeId);
        const prefix = predNodeDef?.label?.replace(/\s+/g, '_').toLowerCase() ?? edge.sourceNodeId;
        merged[prefix] = predRunNode.outputData;
      }
    }

    // Expose flat 'output' shortcut only when there is a single predecessor
    if (incomingEdges.length === 1) {
      const singlePred = runNodes.find((rn) => rn.nodeId === incomingEdges[0].sourceNodeId);
      if (typeof (singlePred?.outputData as Record<string, unknown> | null)?.output === 'string') {
        merged['output'] = (singlePred!.outputData as Record<string, unknown>).output;
      }
    }

    return merged;
  }
}

// ─── Template resolution ───────────────────────────────────────────────────────

/**
 * Resolve {{key}} placeholders in a template string against an inputData map.
 * Supports dot notation: {{agentA.output}}
 */
function resolveTemplate(template: string, data: Record<string, unknown>): string {
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

// ─── Singleton ─────────────────────────────────────────────────────────────────

export const workflowEngine = new WorkflowEngine();
