// Rules and request shape for merging a merge request from the panel.
// Pure and shared: the button's enabled state in the panel and the request the
// server sends are decided here, so tests can pin both down.

export interface MergeCandidate {
  state: string;
  draft: boolean;
  hasConflicts: boolean;
}

export interface MergeAllowance {
  allowed: boolean;
  /** Why the button is disabled, in words a reviewer can act on. */
  reason: string | null;
}

/**
 * Whether the Merge button can be pressed at all. GitLab decides everything
 * else (required pipeline, required approvals, resolved threads); what is
 * blocked here is only what can never work.
 */
export function mergeAllowance(mr: MergeCandidate): MergeAllowance {
  if (mr.state === "merged") return { allowed: false, reason: "Already merged" };
  if (mr.state !== "opened") return { allowed: false, reason: `This merge request is ${mr.state}` };
  if (mr.draft) return { allowed: false, reason: "Still a draft: mark it ready first" };
  if (mr.hasConflicts) return { allowed: false, reason: "Has conflicts: resolve them first" };
  return { allowed: true, reason: null };
}

export interface MergeOptions {
  /** The head commit the person reviewed. GitLab refuses if the branch has moved on. */
  sha: string;
  squash: boolean;
  removeSourceBranch: boolean;
  /** Wait for the running pipeline instead of failing now. */
  whenPipelineSucceeds: boolean;
}

/** The query string of `PUT …/merge`, with only the switches that are on. */
export function mergeQuery(options: MergeOptions): string {
  const query = new URLSearchParams({ sha: options.sha });
  if (options.squash) query.set("squash", "true");
  if (options.removeSourceBranch) query.set("should_remove_source_branch", "true");
  if (options.whenPipelineSucceeds) query.set("merge_when_pipeline_succeeds", "true");
  return query.toString();
}

/**
 * GitLab answers a refused merge with a bare status code. Turn the ones that
 * matter into a sentence that says what to do next.
 */
export function explainMergeFailure(message: string): string {
  if (/\b409\b/.test(message) || /SHA/.test(message)) {
    return "The source branch changed after you opened this page. Reload and review the new commits before merging.";
  }
  if (/\b405\b/.test(message)) {
    return "GitLab will not merge this right now: a required pipeline, approval, or thread is still open. Check the readiness cells.";
  }
  if (/\b406\b/.test(message)) {
    return "GitLab reports a conflict with the target branch. Rebase or resolve it first.";
  }
  if (/\b40[13]\b/.test(message)) {
    return "GitLab says you are not allowed to merge here (permissions or an expired login).";
  }
  return message;
}
