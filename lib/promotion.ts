// Whether a merge request's commits have been carried over to another branch
// (a "promotion" branch such as stage-1). Pure, so the server and the tests
// share it; the server supplies what GitLab returned.
//
// A commit counts as promoted when
//   - its own SHA is on the target branch (merged or fast-forwarded), or
//   - a commit on the target branch names it in a `git cherry-pick -x` line.
// Anything else is "missing" — or "unknown" when we cannot tell (a merge
// commit, or a lookup that failed). Titles and authors are never evidence.

export type PromotionStatus = "promoted" | "missing" | "unknown";
export type PromotionBasis = "sha" | "cherry-pick" | "patch" | null;

export interface PromotionCommitInput {
  sha: string;
  title: string;
  parentCount: number;
}

export interface PromotionCommit {
  sha: string;
  title: string;
  status: PromotionStatus;
  basis: PromotionBasis;
  /** The commit on the target branch that carries this one, when known. */
  targetSha: string | null;
  note: string;
}

const CHERRY_PICK_LINE = /\(cherry picked from commit ([0-9a-f]{7,40})\)/gi;

/** Every source SHA a commit message says it was cherry-picked from. */
export function cherryPickSources(message: string): string[] {
  return [...message.matchAll(CHERRY_PICK_LINE)].map((match) => match[1].toLowerCase());
}

/** Two SHAs name the same commit when one is a prefix of the other (≥ 7 chars). */
function sameSha(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

export function classifyPromotion(input: {
  target: string;
  commits: readonly PromotionCommitInput[];
  /** Branches each commit is on, or null when GitLab could not say. */
  branchesBySha: ReadonlyMap<string, readonly string[] | null>;
  /** Recent commits on the target branch, with full messages. */
  targetCommits: readonly { sha: string; message: string }[];
  /** False when targetCommits stopped at a page limit. */
  targetHistoryComplete: boolean;
  /** Source SHA → target commit whose diff is identical (cherry-pick without -x). */
  samePatch?: ReadonlyMap<string, string>;
  /** Source SHA → target commit with the same title but a different diff. */
  lookalike?: ReadonlyMap<string, string>;
}): PromotionCommit[] {
  const pickedFrom = new Map<string, string>();
  for (const entry of input.targetCommits) {
    for (const source of cherryPickSources(entry.message)) {
      if (!pickedFrom.has(source)) pickedFrom.set(source, entry.sha);
    }
  }
  const findPick = (sha: string): string | null => {
    for (const [source, targetSha] of pickedFrom) {
      if (sameSha(source, sha)) return targetSha;
    }
    return null;
  };

  return input.commits.map((commit) => {
    const base = { sha: commit.sha, title: commit.title };
    const branches = input.branchesBySha.get(commit.sha);
    if (branches?.includes(input.target)) {
      return { ...base, status: "promoted", basis: "sha", targetSha: commit.sha, note: `SHA is on ${input.target}` };
    }
    const picked = findPick(commit.sha);
    if (picked !== null) {
      return {
        ...base,
        status: "promoted",
        basis: "cherry-pick",
        targetSha: picked,
        note: `${picked.slice(0, 8)} on ${input.target} is a cherry-pick -x of it`,
      };
    }
    const patch = input.samePatch?.get(commit.sha);
    if (patch !== undefined) {
      return {
        ...base,
        status: "promoted",
        basis: "patch",
        targetSha: patch,
        note: `${patch.slice(0, 8)} on ${input.target} has the same diff`,
      };
    }
    if (commit.parentCount > 1) {
      return { ...base, status: "unknown", basis: null, targetSha: null, note: "Merge commit: it moves with its parents, not on its own" };
    }
    const lookalike = input.lookalike?.get(commit.sha);
    if (lookalike !== undefined) {
      return {
        ...base,
        status: "unknown",
        basis: null,
        targetSha: lookalike,
        note: `${lookalike.slice(0, 8)} on ${input.target} has the same title but a different diff: check it by hand`,
      };
    }
    if (branches === null || branches === undefined) {
      return { ...base, status: "unknown", basis: null, targetSha: null, note: "GitLab did not say which branches this commit is on" };
    }
    if (!input.targetHistoryComplete) {
      return { ...base, status: "unknown", basis: null, targetSha: null, note: `Not found in the part of ${input.target} that was read` };
    }
    return { ...base, status: "missing", basis: null, targetSha: null, note: `No match on ${input.target}` };
  });
}

export function promotionSummary(commits: readonly PromotionCommit[]): {
  promoted: number;
  missing: number;
  unknown: number;
  total: number;
} {
  const count = (status: PromotionStatus) => commits.filter((c) => c.status === status).length;
  return {
    promoted: count("promoted"),
    missing: count("missing"),
    unknown: count("unknown"),
    total: commits.length,
  };
}

/**
 * A diff reduced to what a cherry-pick keeps: file paths and changed lines.
 * Hunk positions and index lines move when the target branch differs.
 */
export function normalizedPatch(files: readonly { old_path: string; new_path: string; diff: string }[]): string {
  return files
    .map((file) => {
      const lines = file.diff
        .split("\n")
        .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"));
      return `${file.old_path}→${file.new_path}\n${lines.join("\n")}`;
    })
    .sort()
    .join("\n\n");
}
