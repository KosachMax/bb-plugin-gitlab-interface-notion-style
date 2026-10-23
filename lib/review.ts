// Who has reviewed a merge request. GitLab's own Approve button is one way;
// plenty of teams approve with a 👍 reaction instead, so both count, and both
// are shown together. Shared by the server's tests and the panel.

export interface Reaction {
  /** GitLab's emoji name, e.g. "thumbsup". */
  name: string;
  users: string[];
}

/** Reactions that mean "reviewed, looks good". */
export const APPROVE_REACTIONS: readonly string[] = [
  "thumbsup",
  "white_check_mark",
  "heavy_check_mark",
];

/** Reactions that mean "not good as it is". */
export const REJECT_REACTIONS: readonly string[] = ["thumbsdown"];

export interface Reviewer {
  username: string;
  /** The Approve button, or a positive reaction. A button wins when both. */
  via: "approval" | "reaction";
}

export interface ReviewVerdict {
  approvers: Reviewer[];
  /** People who reacted with a negative emoji. */
  rejectors: string[];
  state: "rejected" | "approved" | "pending";
}

/**
 * Combines the formal approvals with positive and negative reactions. The
 * merge request's own author does not review it, so their reaction is ignored.
 */
export function reviewVerdict(input: {
  author: string;
  approvedBy: readonly string[];
  reactions: readonly Reaction[];
  /** Off: only 👎 counts (as "changes requested"); 👍 is not an approval. */
  reactionApprovals?: boolean;
}): ReviewVerdict {
  const author = input.author.toLowerCase();
  const approvers = new Map<string, Reviewer>();
  for (const username of input.approvedBy) {
    approvers.set(username.toLowerCase(), { username, via: "approval" });
  }
  const rejectors = new Map<string, string>();
  for (const reaction of input.reactions) {
    const positive = APPROVE_REACTIONS.includes(reaction.name);
    const negative = REJECT_REACTIONS.includes(reaction.name);
    if (!positive && !negative) continue;
    for (const username of reaction.users) {
      const key = username.toLowerCase();
      if (key === author) continue;
      if (positive && input.reactionApprovals !== false && !approvers.has(key)) {
        approvers.set(key, { username, via: "reaction" });
      }
      if (negative) rejectors.set(key, username);
    }
  }
  const state =
    rejectors.size > 0 ? "rejected" : approvers.size > 0 ? "approved" : "pending";
  return {
    approvers: [...approvers.values()],
    rejectors: [...rejectors.values()],
    state,
  };
}

const EMOJI: Record<string, string> = {
  thumbsup: "👍",
  thumbsdown: "👎",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  tada: "🎉",
  eyes: "👀",
  rocket: "🚀",
  heart: "❤️",
  smile: "😄",
  laughing: "😆",
  confused: "😕",
  clap: "👏",
  fire: "🔥",
  thinking: "🤔",
  raised_hands: "🙌",
  ok_hand: "👌",
  pray: "🙏",
  warning: "⚠️",
};

/** The glyph for a GitLab emoji name, or `:name:` when it is not in the short list. */
export function emojiFor(name: string): string {
  return EMOJI[name] ?? `:${name}:`;
}
