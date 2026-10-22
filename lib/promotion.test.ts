import { describe, expect, it } from "vitest";

import { cherryPickSources, classifyPromotion, normalizedPatch, promotionSummary } from "./promotion";

const commit = (sha: string, parentCount = 1) => ({ sha, title: `title ${sha}`, parentCount });

describe("cherryPickSources", () => {
  it("reads every -x line", () => {
    expect(
      cherryPickSources(
        "Fix\n\n(cherry picked from commit ABCDEF1234567)\n(cherry picked from commit 1234567890)",
      ),
    ).toEqual(["abcdef1234567", "1234567890"]);
  });
  it("ignores messages without one", () => {
    expect(cherryPickSources("cherry picked by hand")).toEqual([]);
  });
});

describe("classifyPromotion", () => {
  const base = {
    target: "stage-1",
    targetHistoryComplete: true,
  };

  it("counts a commit already on the target branch", () => {
    const [result] = classifyPromotion({
      ...base,
      commits: [commit("aaaaaaaa11")],
      branchesBySha: new Map([["aaaaaaaa11", ["master", "stage-1"]]]),
      targetCommits: [],
    });
    expect(result).toMatchObject({ status: "promoted", basis: "sha" });
  });

  it("counts a cherry-pick -x by its source SHA, even abbreviated", () => {
    const [result] = classifyPromotion({
      ...base,
      commits: [commit("bbbbbbbb2222")],
      branchesBySha: new Map([["bbbbbbbb2222", ["master"]]]),
      targetCommits: [{ sha: "cccc9999", message: "x\n\n(cherry picked from commit bbbbbbbb)" }],
    });
    expect(result).toMatchObject({ status: "promoted", basis: "cherry-pick", targetSha: "cccc9999" });
  });

  it("reports a missing commit only when the whole history was read", () => {
    const input = {
      commits: [commit("dddddddd")],
      branchesBySha: new Map([["dddddddd", ["master"]]]),
      targetCommits: [],
    };
    expect(classifyPromotion({ ...base, ...input })[0].status).toBe("missing");
    expect(
      classifyPromotion({ ...base, ...input, targetHistoryComplete: false })[0].status,
    ).toBe("unknown");
  });

  it("does not guess for merge commits or failed lookups", () => {
    const results = classifyPromotion({
      ...base,
      commits: [commit("eeeeeeee", 2), commit("ffffffff")],
      branchesBySha: new Map([["ffffffff", null]]),
      targetCommits: [],
    });
    expect(results.map((r) => r.status)).toEqual(["unknown", "unknown"]);
  });

  it("does not treat a short or unrelated SHA as a match", () => {
    const [result] = classifyPromotion({
      ...base,
      commits: [commit("12345678")],
      branchesBySha: new Map([["12345678", []]]),
      targetCommits: [{ sha: "t", message: "(cherry picked from commit 1234567f)" }],
    });
    expect(result.status).toBe("missing");
  });

  it("summarises the counts", () => {
    const results = classifyPromotion({
      ...base,
      commits: [commit("a1a1a1a1"), commit("b2b2b2b2"), commit("c3c3c3c3", 2)],
      branchesBySha: new Map([
        ["a1a1a1a1", ["stage-1"]],
        ["b2b2b2b2", []],
      ]),
      targetCommits: [],
    });
    expect(promotionSummary(results)).toEqual({ promoted: 1, missing: 1, unknown: 1, total: 3 });
  });
});

describe("patch equivalence", () => {
  it("counts a cherry-pick without -x when the diff is the same", () => {
    const [result] = classifyPromotion({
      target: "stage-1",
      targetHistoryComplete: true,
      commits: [commit("abcabcab")],
      branchesBySha: new Map([["abcabcab", ["master"]]]),
      targetCommits: [],
      samePatch: new Map([["abcabcab", "99998888"]]),
    });
    expect(result).toMatchObject({ status: "promoted", basis: "patch", targetSha: "99998888" });
  });

  it("ignores hunk positions but not content", () => {
    const a = normalizedPatch([{ old_path: "a.py", new_path: "a.py", diff: "@@ -1,2 +1,2 @@\n-x = 1\n+x = 2\n y" }]);
    const b = normalizedPatch([{ old_path: "a.py", new_path: "a.py", diff: "@@ -40,2 +41,2 @@\n-x = 1\n+x = 2\n z" }]);
    const c = normalizedPatch([{ old_path: "a.py", new_path: "a.py", diff: "@@ -1 +1 @@\n-x = 1\n+x = 3" }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("lookalikes", () => {
  it("flags a same-title commit with a changed diff instead of calling it missing", () => {
    const [result] = classifyPromotion({
      target: "stage-1",
      targetHistoryComplete: true,
      commits: [commit("12121212")],
      branchesBySha: new Map([["12121212", ["master"]]]),
      targetCommits: [],
      lookalike: new Map([["12121212", "34343434"]]),
    });
    expect(result).toMatchObject({ status: "unknown", targetSha: "34343434" });
  });
});
