// The viewer's own commits per day: counted from commits they authored (not
// push events, which also carry every commit of a rebased branch).

export interface AuthoredCommit {
  id: string;
  authored_date: string;
  /** Two or more parents: a merge, which carries other people's work. */
  parent_ids?: readonly string[];
  stats?: { additions: number; deletions: number } | null;
}

export interface ContributionDay {
  date: string;
  count: number;
  additions: number;
  deletions: number;
}

/** One entry per commit SHA (seen in several branches, it counts once); merges are skipped. */
export function aggregateCommits(
  commits: readonly AuthoredCommit[],
  startDate: string,
  endDate: string,
  dateOf: (timestamp: string) => string,
): ContributionDay[] {
  const seen = new Set<string>();
  const days = new Map<string, ContributionDay>();
  for (const commit of commits) {
    if (!commit.authored_date || seen.has(commit.id)) continue;
    if ((commit.parent_ids?.length ?? 1) > 1) continue;
    seen.add(commit.id);
    const date = dateOf(commit.authored_date);
    if (date < startDate || date > endDate) continue;
    const day = days.get(date) ?? { date, count: 0, additions: 0, deletions: 0 };
    day.count += 1;
    day.additions += Math.max(0, commit.stats?.additions ?? 0);
    day.deletions += Math.max(0, commit.stats?.deletions ?? 0);
    days.set(date, day);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
