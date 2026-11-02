// Emoji reactions as GitLab names them, shown the way GitLab's own bar does:
// 👍 and 👎 always, then whatever else was used, then a picker.

import type { Reaction } from "./review";

export interface EmojiChoice {
  name: string;
  glyph: string;
  /** Extra words the picker's search also matches. */
  words: string;
}

/** What the picker offers, in the order people reach for them. */
export const EMOJI_CHOICES: readonly EmojiChoice[] = [
  { name: "thumbsup", glyph: "👍", words: "like yes approve +1" },
  { name: "thumbsdown", glyph: "👎", words: "dislike no -1" },
  { name: "smile", glyph: "😄", words: "happy" },
  { name: "tada", glyph: "🎉", words: "party celebrate" },
  { name: "confused", glyph: "😕", words: "unsure" },
  { name: "heart", glyph: "❤️", words: "love" },
  { name: "rocket", glyph: "🚀", words: "ship launch" },
  { name: "eyes", glyph: "👀", words: "looking watching review" },
  { name: "pray", glyph: "🙏", words: "please thanks" },
  { name: "100", glyph: "💯", words: "perfect hundred" },
  { name: "fire", glyph: "🔥", words: "hot" },
  { name: "white_check_mark", glyph: "✅", words: "done check ok" },
  { name: "x", glyph: "❌", words: "cross wrong" },
  { name: "thinking", glyph: "🤔", words: "hmm question" },
  { name: "clap", glyph: "👏", words: "applause" },
  { name: "raised_hands", glyph: "🙌", words: "hooray" },
  { name: "sweat_smile", glyph: "😅", words: "phew" },
  { name: "bug", glyph: "🐛", words: "defect" },
  { name: "zap", glyph: "⚡", words: "fast lightning" },
  { name: "brain", glyph: "🧠", words: "smart" },
  { name: "pushpin", glyph: "📌", words: "pin" },
  { name: "trophy", glyph: "🏆", words: "win" },
  { name: "star", glyph: "⭐", words: "favorite" },
  { name: "cherries", glyph: "🍒", words: "cherry pick" },
];

const BY_NAME = new Map(EMOJI_CHOICES.map((choice) => [choice.name, choice]));

/** The glyph for a GitLab emoji name, or `:name:` when the picker does not know it. */
export function glyphFor(name: string): string {
  return BY_NAME.get(name)?.glyph ?? `:${name}:`;
}

export function searchEmoji(query: string): readonly EmojiChoice[] {
  const needle = query.trim().toLowerCase().replace(/^:|:$/g, "");
  if (needle === "") return EMOJI_CHOICES;
  return EMOJI_CHOICES.filter(
    (choice) => choice.name.includes(needle) || choice.words.includes(needle) || choice.glyph === query.trim(),
  );
}

/** The same list with `user` added or removed under `name`; the input is not changed. */
export function withReaction(
  reactions: readonly Reaction[],
  name: string,
  user: string,
  on: boolean,
): Reaction[] {
  const me = user.toLowerCase();
  const next = reactions.map((reaction) => ({ name: reaction.name, users: [...reaction.users] }));
  const entry = next.find((reaction) => reaction.name === name);
  if (on) {
    if (entry === undefined) next.push({ name, users: [user] });
    else if (!entry.users.some((u) => u.toLowerCase() === me)) entry.users.push(user);
    return next;
  }
  if (entry === undefined) return next;
  entry.users = entry.users.filter((u) => u.toLowerCase() !== me);
  return next.filter((reaction) => reaction.users.length > 0);
}

/**
 * The buttons of one bar: 👍 and 👎 when `fixed`, then every other emoji in use.
 * Empty fixed ones stay (dimmed) so there is always something to click.
 */
export function barEntries(
  reactions: readonly Reaction[],
  viewer: string | null,
  fixed: boolean,
): Array<{ name: string; users: string[]; mine: boolean }> {
  const me = viewer?.toLowerCase() ?? null;
  const known = new Map(reactions.map((reaction) => [reaction.name, reaction.users]));
  const names = [
    ...(fixed ? ["thumbsup", "thumbsdown"] : []),
    ...reactions.map((reaction) => reaction.name).filter((name) => !(fixed && (name === "thumbsup" || name === "thumbsdown"))),
  ];
  return names.map((name) => {
    const users = known.get(name) ?? [];
    return { name, users, mine: me !== null && users.some((u) => u.toLowerCase() === me) };
  });
}
