import { describe, expect, it } from "vitest";
import { aggregateCommits } from "./contributions";

const moscow = (timestamp: string) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));

describe("aggregateCommits", () => {
  it("counts each authored commit once, by the viewer's local date, with its lines", () => {
    const days = aggregateCommits([
      { id: "a", authored_date: "2026-10-30T21:30:00Z", stats: { additions: 10, deletions: 2 } },
      { id: "b", authored_date: "2026-10-31T10:00:00Z", stats: { additions: 1, deletions: 1 } },
      { id: "b", authored_date: "2026-10-31T10:00:00Z", stats: { additions: 1, deletions: 1 } },
      { id: "c", authored_date: "2026-09-01T10:00:00Z" },
      { id: "m", authored_date: "2026-10-31T11:00:00Z", parent_ids: ["x", "y"], stats: { additions: 9000, deletions: 9 } },
    ], "2026-10-01", "2026-10-31", moscow);
    expect(days).toEqual([{ date: "2026-10-31", count: 2, additions: 11, deletions: 3 }]);
  });
});
