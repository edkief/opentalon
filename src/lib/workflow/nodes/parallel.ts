export async function executeParallelNode(
  runNodeId: string,
  inputData: Record<string, unknown>,
  chatId: string,
  onComplete: (runNodeId: string, outputData: Record<string, unknown>, chatId: string) => Promise<void>,
): Promise<void> {
  // Pure fan-out signal — complete immediately so advanceRun enqueues all child nodes.
  await onComplete(runNodeId, inputData, chatId);
}
