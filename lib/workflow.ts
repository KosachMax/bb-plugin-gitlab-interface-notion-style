export type WorkflowStage = "commit" | "push" | "create-mr" | "open-mr" | "idle";

export function workflowStage(input: {
  dirty: boolean;
  localHead: string | null;
  remoteHead: string | null;
  aheadOfBase: number;
  mergeRequestIid: number | null;
}): WorkflowStage {
  if (input.dirty) return "commit";
  if (input.localHead && input.aheadOfBase > 0 && input.localHead !== input.remoteHead) return "push";
  if (input.mergeRequestIid !== null) return "open-mr";
  if (input.localHead && input.remoteHead === input.localHead && input.aheadOfBase > 0) return "create-mr";
  return "idle";
}
