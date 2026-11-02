import { describe, expect, it } from "vitest";

import { barEntries, glyphFor, searchEmoji, withReaction } from "./reactions";

describe("withReaction", () => {
  it("adds a person once and removes the entry when nobody is left", () => {
    const a = withReaction([], "thumbsup", "Me", true);
    expect(a).toEqual([{ name: "thumbsup", users: ["Me"] }]);
    expect(withReaction(a, "thumbsup", "me", true)).toEqual(a);
    expect(withReaction(a, "thumbsup", "ME", false)).toEqual([]);
  });
  it("leaves the input alone", () => {
    const input = [{ name: "tada", users: ["x"] }];
    withReaction(input, "tada", "y", true);
    expect(input).toEqual([{ name: "tada", users: ["x"] }]);
  });
});

describe("barEntries", () => {
  it("always offers thumbs up and down, marks the viewer's own, then the rest", () => {
    const entries = barEntries([{ name: "tada", users: ["ann"] }, { name: "thumbsup", users: ["bob", "Me"] }], "me", true);
    expect(entries.map((e) => [e.name, e.users.length, e.mine])).toEqual([
      ["thumbsup", 2, true],
      ["thumbsdown", 0, false],
      ["tada", 1, false],
    ]);
  });
  it("shows only what is in use on a comment", () => {
    expect(barEntries([], "me", false)).toEqual([]);
  });
});

describe("emoji", () => {
  it("finds by name, by word, and by the glyph itself", () => {
    expect(searchEmoji("cherry").map((c) => c.name)).toContain("cherries");
    expect(searchEmoji("like")[0].name).toBe("thumbsup");
    expect(searchEmoji("🚀").map((c) => c.name)).toEqual(["rocket"]);
    expect(searchEmoji("").length).toBeGreaterThan(10);
  });
  it("falls back to :name: for an emoji the picker does not know", () => {
    expect(glyphFor("thumbsup")).toBe("👍");
    expect(glyphFor("parrot")).toBe(":parrot:");
  });
});
