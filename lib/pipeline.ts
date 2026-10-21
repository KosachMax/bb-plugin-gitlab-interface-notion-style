// Pipeline rules shared by the server (CLI and rpc) and the panel, so a
// button is enabled exactly when the server will accept the action.

/** A status after which GitLab will not change it by itself. */
export function isTerminalPipelineStatus(status: string): boolean {
  return [
    "success",
    "failed",
    "canceled",
    "skipped",
    "manual",
    "ignored",
  ].includes(status);
}

export interface JobActions {
  /** Run it again: finished jobs only. A manual job never ran, so it plays. */
  retry: boolean;
  /** Start a manual job. */
  play: boolean;
  cancel: boolean;
}

export function jobActions(status: string): JobActions {
  return {
    retry: ["failed", "canceled", "success"].includes(status),
    play: status === "manual",
    cancel: ["running", "pending", "preparing", "waiting_for_resource"].includes(
      status,
    ),
  };
}

/** What `retry` on a whole pipeline re-runs; success and manual stay as they are. */
export function retryableJobs<T extends { status: string }>(jobs: T[]): T[] {
  return jobs.filter((job) => job.status === "failed" || job.status === "canceled");
}

/** `refs/merge-requests/12/head` → 12: a merge-request pipeline's ref names it. */
export function mergeRequestIidFromRef(ref: string): number | null {
  const match = ref.match(/^refs\/merge-requests\/(\d+)\//);
  return match === null ? null : Number(match[1]);
}

/** 192 → "3m 12s"; 45 → "45s"; null → "". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const rest = total % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** GitLab job status → one traffic-light value for the panel. */
export function classifyJobStatus(
  rawStatus: string,
): "success" | "failure" | "pending" | "neutral" {
  switch (rawStatus) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "running":
    case "pending":
    case "created":
    case "preparing":
    case "scheduled":
    case "waiting_for_resource":
      return "pending";
    default:
      // canceled, skipped, manual, and anything GitLab adds later.
      return "neutral";
  }
}
