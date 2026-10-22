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
      return { ...base, status: "promoted", basis: "sha", targetSha: commit.sha, note: `SHA есть в истории ${input.target}` };
    }
    const picked = findPick(commit.sha);
    if (picked !== null) {
      return {
        ...base,
        status: "promoted",
        basis: "cherry-pick",
        targetSha: picked,
        note: `В ${input.target} есть ${picked.slice(0, 8)} с меткой cherry-pick -x`,
      };
    }
    const patch = input.samePatch?.get(commit.sha);
    if (patch !== undefined) {
      return {
        ...base,
        status: "promoted",
        basis: "patch",
        targetSha: patch,
        note: `В ${input.target} есть ${patch.slice(0, 8)} с тем же диффом`,
      };
    }
    if (commit.parentCount > 1) {
      return { ...base, status: "unknown", basis: null, targetSha: null, note: "Merge-коммит: переносится вместе с родителями, отдельно не проверяется" };
    }
    const lookalike = input.lookalike?.get(commit.sha);
    if (lookalike !== undefined) {
      return {
        ...base,
        status: "unknown",
        basis: null,
        targetSha: lookalike,
        note: `В ${input.target} есть ${lookalike.slice(0, 8)} с тем же заголовком, но другим диффом: проверьте вручную`,
      };
    }
    if (branches === null || branches === undefined) {
      return { ...base, status: "unknown", basis: null, targetSha: null, note: "GitLab не ответил, в каких ветках этот коммит" };
    }
    if (!input.targetHistoryComplete) {
      return { ...base, status: "unknown", basis: null, targetSha: null, note: `Не найден в прочитанной части ${input.target}` };
    }
    return { ...base, status: "missing", basis: null, targetSha: null, note: `Совпадений в ${input.target} нет` };
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
