import { describe, expect, it } from "vitest";
import { workflowStage } from "./workflow";

const base = {
  dirty: false,
  localHead: "abc",
  remoteHead: "abc",
  aheadOfBase: 1,
  mergeRequestIid: null,
};

describe("workflowStage", () => {
  it("prioritizes uncommitted changes over a pushed MR", () => {
    expect(workflowStage({ ...base, dirty: true, mergeRequestIid: 42 })).toBe("commit");
  });
  it("prompts for push when the local head differs from GitLab", () => {
    expect(workflowStage({ ...base, remoteHead: "older", mergeRequestIid: 42 })).toBe("push");
  });
  it("opens an existing MR after synchronization", () => {
    expect(workflowStage({ ...base, mergeRequestIid: 42 })).toBe("open-mr");
  });
  it("offers MR creation only for a pushed branch ahead of base", () => {
    expect(workflowStage(base)).toBe("create-mr");
    expect(workflowStage({ ...base, aheadOfBase: 0 })).toBe("idle");
  });
});
