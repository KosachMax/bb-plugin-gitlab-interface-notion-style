import { describe, expect, it } from "vitest";
import { emojiFor, reviewVerdict } from "./review";

describe("review verdict", () => {
  it("counts a thumbs-up like an approval, and a button wins when both", () => {
    const verdict = reviewVerdict({
      author: "rinat",
      approvedBy: ["Aleksey"],
      reactions: [{ name: "thumbsup", users: ["aleksey", "Maksim"] }],
    });
    expect(verdict.state).toBe("approved");
    expect(verdict.approvers).toEqual([
      { username: "Aleksey", via: "approval" },
      { username: "Maksim", via: "reaction" },
    ]);
  });

  it("ignores the author's own reaction", () => {
    const verdict = reviewVerdict({
      author: "Rinat",
      approvedBy: [],
      reactions: [{ name: "thumbsup", users: ["rinat"] }],
    });
    expect(verdict).toEqual({ approvers: [], rejectors: [], state: "pending" });
  });

  it("lets a thumbs-down outweigh approvals", () => {
    const verdict = reviewVerdict({
      author: "rinat",
      approvedBy: ["Aleksey"],
      reactions: [{ name: "thumbsdown", users: ["Ilya"] }],
    });
    expect(verdict.state).toBe("rejected");
    expect(verdict.rejectors).toEqual(["Ilya"]);
    expect(verdict.approvers).toHaveLength(1);
  });

  it("accepts the check-mark emojis and skips unrelated reactions", () => {
    const verdict = reviewVerdict({
      author: "rinat",
      approvedBy: [],
      reactions: [
        { name: "white_check_mark", users: ["Mira"] },
        { name: "eyes", users: ["Ilya"] },
      ],
    });
    expect(verdict.approvers).toEqual([{ username: "Mira", via: "reaction" }]);
  });

  it("names emoji, falling back to the :name: form", () => {
    expect(emojiFor("thumbsup")).toBe("👍");
    expect(emojiFor("some_custom_one")).toBe(":some_custom_one:");
  });
});

describe("reaction approvals setting", () => {
  it("does not count a thumbs-up as approval when turned off", () => {
    const verdict = reviewVerdict({
      author: "ann",
      approvedBy: [],
      reactions: [{ name: "thumbsup", users: ["bob"] }],
      reactionApprovals: false,
    });
    expect(verdict.state).toBe("pending");
  });
});
