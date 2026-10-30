import { describe, expect, it } from "vitest";
import { aggregatePushEvents } from "./contributions";

describe("aggregatePushEvents", () => {
  it("counts pushed commits by the viewer's date and excludes unrelated activity", () => {
    const result = aggregatePushEvents([
      { action_name: "pushed to", created_at: "2026-10-30T21:30:00Z", push_data: { commit_count: 2 } },
      { action_name: "pushed new", created_at: "2026-10-31T10:00:00Z", push_data: { commit_count: 1 } },
      { action_name: "deleted", created_at: "2026-10-31T11:00:00Z", push_data: { commit_count: 0 } },
      { action_name: "approved", created_at: "2026-10-31T12:00:00Z" },
    ], "2026-10-31", "2026-10-31", (timestamp) => {
      return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
    });
    expect(result).toEqual({ pushEvents: 2, days: [{ date: "2026-10-31", count: 3 }] });
  });
});
