import { describe, expect, it } from "vitest";
import { explainMergeFailure, mergeAllowance, mergeQuery } from "./merge";

describe("merge allowance", () => {
  const open = { state: "opened", draft: false, hasConflicts: false };

  it("allows an open, ready merge request", () => {
    expect(mergeAllowance(open)).toEqual({ allowed: true, reason: null });
  });

  it("blocks what can never work, and says why", () => {
    expect(mergeAllowance({ ...open, state: "merged" }).reason).toBe("Already merged");
    expect(mergeAllowance({ ...open, state: "closed" }).allowed).toBe(false);
    expect(mergeAllowance({ ...open, draft: true }).reason).toContain("draft");
    expect(mergeAllowance({ ...open, hasConflicts: true }).reason).toContain("conflicts");
  });

  it("leaves pipeline and approval rules to GitLab", () => {
    // Nothing in the candidate describes them, so they cannot block here.
    expect(mergeAllowance(open).allowed).toBe(true);
  });
});

describe("merge request", () => {
  it("always pins the reviewed commit and sends only the switches that are on", () => {
    expect(
      mergeQuery({ sha: "abc123", squash: false, removeSourceBranch: false, whenPipelineSucceeds: false }),
    ).toBe("sha=abc123");
    expect(
      mergeQuery({ sha: "abc123", squash: true, removeSourceBranch: true, whenPipelineSucceeds: true }),
    ).toBe(
      "sha=abc123&squash=true&should_remove_source_branch=true&merge_when_pipeline_succeeds=true",
    );
  });

  it("explains the refusals people actually hit", () => {
    expect(explainMergeFailure("glab api failed: 409 SHA does not match HEAD")).toContain("changed");
    expect(explainMergeFailure('{"message":"405 Method Not Allowed"}')).toContain("will not merge");
    expect(explainMergeFailure("406 Branch cannot be merged")).toContain("conflict");
    expect(explainMergeFailure("403 Forbidden")).toContain("not allowed");
    expect(explainMergeFailure("something else")).toBe("something else");
  });
});
