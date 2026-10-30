// The new-thread dashboard: which open merge requests want something from the
// viewer, from GitLab's own detailed_merge_status. Pure, so it is testable.

export type DashboardGroup = "action" | "ready" | "review" | "waiting";

export interface DashboardInput {
  author: string;
  draft: boolean;
  /** GitLab's detailed_merge_status, e.g. "mergeable", "conflict". */
  status: string;
}

/** Statuses only the author can clear. */
const NEEDS_AUTHOR = new Set([
  "conflict",
  "need_rebase",
  "broken_status",
  "ci_must_pass",
  "discussions_not_resolved",
  "requested_changes",
  "blocked_status",
  "jira_association_missing",
]);

/** Where one of the viewer's own merge requests belongs. */
export function groupOwnMergeRequest(mr: DashboardInput): Exclude<DashboardGroup, "review"> {
  if (mr.draft) return "waiting";
  if (NEEDS_AUTHOR.has(mr.status)) return "action";
  if (mr.status === "mergeable") return "ready";
  return "waiting";
}

/** A short reason shown next to the title, with its tone. */
export function dashboardReason(mr: DashboardInput): { text: string; tone: "bad" | "warn" | "ok" | "info" | "neutral" } {
  if (mr.draft) return { text: "📝 Draft", tone: "neutral" };
  switch (mr.status) {
    case "conflict":
      return { text: "⚠️ Conflicts", tone: "bad" };
    case "need_rebase":
      return { text: "⚠️ Needs rebase", tone: "bad" };
    case "ci_must_pass":
    case "broken_status":
      return { text: "❌ Pipeline failed", tone: "bad" };
    case "discussions_not_resolved":
      return { text: "💬 Open threads", tone: "warn" };
    case "requested_changes":
      return { text: "✋ Changes requested", tone: "warn" };
    case "blocked_status":
      return { text: "⛔ Blocked by another MR", tone: "warn" };
    case "mergeable":
      return { text: "✅ Ready", tone: "ok" };
    case "not_approved":
    case "approvals_syncing":
      return { text: "👀 Awaiting approval", tone: "neutral" };
    case "ci_still_running":
      return { text: "⟳ Pipeline running", tone: "info" };
    default:
      return { text: "⏳ Checking", tone: "neutral" };
  }
}
