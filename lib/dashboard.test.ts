import { describe, expect, it } from "vitest";

import { dashboardReason, groupOwnMergeRequest } from "./dashboard";

const mr = (status: string, draft = false) => ({ author: "me", status, draft });

describe("groupOwnMergeRequest", () => {
  it("puts what only the author can fix under action", () => {
    for (const status of ["conflict", "ci_must_pass", "discussions_not_resolved", "need_rebase"]) {
      expect(groupOwnMergeRequest(mr(status))).toBe("action");
    }
  });
  it("separates ready from waiting", () => {
    expect(groupOwnMergeRequest(mr("mergeable"))).toBe("ready");
    expect(groupOwnMergeRequest(mr("not_approved"))).toBe("waiting");
    expect(groupOwnMergeRequest(mr("ci_still_running"))).toBe("waiting");
  });
  it("keeps drafts out of action and ready", () => {
    expect(groupOwnMergeRequest(mr("conflict", true))).toBe("waiting");
    expect(dashboardReason(mr("mergeable", true)).text).toContain("Draft");
  });
});
