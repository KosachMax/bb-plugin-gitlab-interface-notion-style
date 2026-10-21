// The panel's filter grammar: one text box that carries qualifiers
// (`is:open assignee:@me label:bug project:gitlab.com/acme/web`) alongside
// plain text. Kept free of React so the parser, the matcher, and the
// suggestion table are unit-testable and the panel holds no second copy of
// the rules.

export type Kind = "issue" | "mr";

/** GitLab writes issue refs as #123 and merge-request refs as !123. */
export const MARKER: Record<Kind, string> = { issue: "#", mr: "!" };

/** The subset of a cached item the filter reads. */
export interface QueryableItem {
  kind: Kind;
  project: string;
  iid: number;
  title: string;
  /** GitLab's own word: "opened", "closed", "merged", "locked". */
  state: string;
  draft: boolean;
  author: string;
  labels: string[];
  assignees: string[];
  /** Merge requests only; absent or empty on issues. */
  reviewers?: string[];
}

export interface ParsedItemQuery {
  states: string[];
  /** True when `is:draft` asked for drafts only. */
  draftOnly: boolean;
  assignees: string[];
  reviewers: string[];
  authors: string[];
  labels: string[];
  projects: string[];
  noAssignee: boolean;
  noReviewer: boolean;
  noLabel: boolean;
  text: string[];
}

/**
 * `open` is what people type; `opened` is what GitLab stores. Everything else
 * passes through so an unknown state still narrows rather than matching all.
 */
const STATE_WORDS: Record<string, string> = {
  open: "opened",
  opened: "opened",
  closed: "closed",
  merged: "merged",
  locked: "locked",
};

/** Whitespace-separated tokens, except inside quotes: `label:"needs triage"`. */
const TOKEN = /(?:[^\s"]+|"[^"]*")+/g;

function unquote(value: string): string {
  return value.replace(/"/g, "");
}

export function parseItemQuery(query: string): ParsedItemQuery {
  const parsed: ParsedItemQuery = {
    states: [],
    draftOnly: false,
    assignees: [],
    reviewers: [],
    authors: [],
    labels: [],
    projects: [],
    noAssignee: false,
    noReviewer: false,
    noLabel: false,
    text: [],
  };
  for (const token of query.match(TOKEN) ?? []) {
    const idx = token.indexOf(":");
    const key = idx > 0 ? token.slice(0, idx).toLowerCase() : "";
    const value = idx > 0 ? unquote(token.slice(idx + 1)) : "";
    // A bare `label:` is someone mid-type, not a filter for the empty label.
    if (idx > 0 && value.length === 0) continue;
    if (key === "is" || key === "state") {
      const word = value.toLowerCase();
      if (word === "draft") parsed.draftOnly = true;
      else parsed.states.push(STATE_WORDS[word] ?? word);
    } else if (key === "assignee") {
      parsed.assignees.push(value.toLowerCase());
    } else if (key === "reviewer") {
      parsed.reviewers.push(value.toLowerCase());
    } else if (key === "author") {
      parsed.authors.push(value.toLowerCase());
    } else if (key === "label") {
      parsed.labels.push(value.toLowerCase());
    } else if (key === "project") {
      parsed.projects.push(value.toLowerCase());
    } else if (key === "no") {
      const word = value.toLowerCase();
      if (word === "assignee") parsed.noAssignee = true;
      if (word === "reviewer") parsed.noReviewer = true;
      if (word === "label") parsed.noLabel = true;
    } else {
      parsed.text.push(unquote(token).toLowerCase());
    }
  }
  return parsed;
}

/** `@me` only resolves once the viewer is known; until then it matches nothing. */
function resolveLogins(logins: string[], viewer: string | null): string[] {
  return logins.map((login) =>
    login === "@me" ? (viewer?.toLowerCase() ?? "\0") : login,
  );
}

export function matchesItemQuery(
  item: QueryableItem,
  query: ParsedItemQuery,
  viewer: string | null,
): boolean {
  if (query.states.length > 0 && !query.states.includes(item.state)) {
    return false;
  }
  // GitLab keeps draft orthogonal to state, so `is:draft` narrows instead of
  // replacing the state filter.
  if (query.draftOnly && !item.draft) return false;
  if (query.assignees.length > 0) {
    const wanted = resolveLogins(query.assignees, viewer);
    if (
      !item.assignees.some((login) => wanted.includes(login.toLowerCase()))
    ) {
      return false;
    }
  }
  if (query.reviewers.length > 0) {
    const wanted = resolveLogins(query.reviewers, viewer);
    if (
      !(item.reviewers ?? []).some((login) =>
        wanted.includes(login.toLowerCase()),
      )
    ) {
      return false;
    }
  }
  if (query.authors.length > 0) {
    const wanted = resolveLogins(query.authors, viewer);
    if (!wanted.includes(item.author.toLowerCase())) return false;
  }
  if (query.labels.length > 0) {
    const labels = item.labels.map((label) => label.toLowerCase());
    if (!query.labels.some((label) => labels.includes(label))) return false;
  }
  if (
    query.projects.length > 0 &&
    !query.projects.includes(item.project.toLowerCase())
  ) {
    return false;
  }
  if (query.noAssignee && item.assignees.length > 0) return false;
  if (query.noReviewer && (item.reviewers ?? []).length > 0) return false;
  if (query.noLabel && item.labels.length > 0) return false;
  if (query.text.length > 0) {
    const haystack =
      `${item.title} ${MARKER[item.kind]}${item.iid} ${item.project}`.toLowerCase();
    if (!query.text.every((term) => haystack.includes(term))) return false;
  }
  return true;
}

export const QUALIFIER_KEYS: { key: string; hint: string }[] = [
  { key: "is:", hint: "state — open, closed, merged, draft" },
  { key: "assignee:", hint: "assigned user, or @me" },
  { key: "reviewer:", hint: "review requested from, or @me" },
  { key: "author:", hint: "opened by" },
  { key: "label:", hint: "has label" },
  { key: "project:", hint: "in project" },
  { key: "no:", hint: "missing — assignee, reviewer, label" },
];

/** The words the panel can complete, harvested from the loaded items. */
export interface QueryVocabulary {
  users: string[];
  labels: string[];
  projects: string[];
}

/**
 * One completion. `state`/`username` let the panel draw the same dot or
 * avatar it draws in a row without the grammar knowing about React.
 */
export interface QuerySuggestion {
  /** Text that replaces the token being typed. */
  insert: string;
  label: string;
  hint?: string;
  state?: string;
  draft?: boolean;
  username?: string;
}

function quoteValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function suggestQueryTokens(
  token: string,
  vocab: QueryVocabulary,
  kind: Kind,
  viewer: string | null,
): QuerySuggestion[] {
  const idx = token.indexOf(":");
  if (idx <= 0) {
    const prefix = token.toLowerCase();
    return QUALIFIER_KEYS.filter((entry) => entry.key.startsWith(prefix)).map(
      (entry) => ({ insert: entry.key, label: entry.key, hint: entry.hint }),
    );
  }
  const key = token.slice(0, idx).toLowerCase();
  const partial = unquote(token.slice(idx + 1)).toLowerCase();
  const matches = (value: string) => value.toLowerCase().includes(partial);
  if (key === "is" || key === "state") {
    const words =
      kind === "mr"
        ? ["open", "draft", "closed", "merged"]
        : ["open", "closed"];
    return words.filter(matches).map((word) => ({
      insert: `${key}:${word} `,
      label: word,
      state: word === "draft" ? "opened" : (STATE_WORDS[word] ?? "opened"),
      draft: word === "draft",
    }));
  }
  if (key === "assignee" || key === "author" || key === "reviewer") {
    return ["@me", ...vocab.users].filter(matches).map((login) => ({
      insert: `${key}:${login} `,
      label: login === "@me" && viewer !== null ? `@me (${viewer})` : login,
      username: login === "@me" ? (viewer ?? undefined) : login,
    }));
  }
  if (key === "label") {
    return vocab.labels.filter(matches).map((label) => ({
      insert: `${key}:${quoteValue(label)} `,
      label,
    }));
  }
  if (key === "project") {
    return vocab.projects.filter(matches).map((project) => ({
      insert: `${key}:${quoteValue(project)} `,
      label: project,
    }));
  }
  if (key === "no") {
    return ["assignee", "reviewer", "label"].filter(matches).map((field) => ({
      insert: `${key}:${field} `,
      label: `no:${field}`,
    }));
  }
  return [];
}

/** The first `project:` value that names a tracked project, for form defaults. */
export function queryProject(
  query: ParsedItemQuery,
  projects: string[],
): string | null {
  for (const wanted of query.projects) {
    const match = projects.find(
      (project) => project.toLowerCase() === wanted,
    );
    if (match !== undefined) return match;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Editing a query token by token. The filter pills and the search box both
// rewrite the one query string through these, so the query stays the single
// source of truth (and keeps persisting the way it always has).
// ---------------------------------------------------------------------------

export interface QueryToken {
  /** Lowercased qualifier key, `state` folded into `is`; "" for plain text. */
  key: string;
  /** The unquoted value; for plain text, the whole token. */
  value: string;
  raw: string;
}

export function queryTokens(query: string): QueryToken[] {
  return (query.match(TOKEN) ?? []).map((raw) => {
    const idx = raw.indexOf(":");
    if (idx <= 0) return { key: "", value: unquote(raw), raw };
    const key = raw.slice(0, idx).toLowerCase();
    return { key: key === "state" ? "is" : key, value: unquote(raw.slice(idx + 1)), raw };
  });
}

/** `key:value`, quoted when the value has whitespace. */
export function formatQualifier(key: string, value: string): string {
  return /\s/.test(value) ? `${key}:"${value}"` : `${key}:${value}`;
}

function joinTokens(tokens: string[]): string {
  return tokens.length === 0 ? "" : `${tokens.join(" ")} `;
}

/** Drops every qualifier token the predicate matches; text is kept. */
export function withoutQualifiers(
  query: string,
  match: (key: string, value: string) => boolean,
): string {
  return joinTokens(
    queryTokens(query)
      .filter((token) => token.key === "" || !match(token.key, token.value))
      .map((token) => token.raw),
  );
}

/** Adds `key:value` unless an equal qualifier (case-insensitive) is present. */
export function withQualifier(query: string, key: string, value: string): string {
  const tokens = queryTokens(query);
  const present = tokens.some(
    (token) =>
      token.key === key && token.value.toLowerCase() === value.toLowerCase(),
  );
  if (present) return query;
  return joinTokens([...tokens.map((token) => token.raw), formatQualifier(key, value)]);
}

/** The plain-text part of a query, as the search box shows it. */
export function queryText(query: string): string {
  return queryTokens(query)
    .filter((token) => token.key === "")
    .map((token) => token.raw)
    .join(" ");
}

/**
 * Replaces the plain-text part, keeping every qualifier. Qualifiers typed into
 * the search box survive as qualifiers, so `label:bug` there becomes a pill.
 */
export function withQueryText(query: string, text: string): string {
  const qualifiers = queryTokens(query)
    .filter((token) => token.key !== "")
    .map((token) => token.raw);
  return joinTokens([...qualifiers, ...(text.match(TOKEN) ?? [])]);
}
