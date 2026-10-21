import { describe, expect, it } from "vitest";
import {
  matchesItemQuery,
  parseItemQuery,
  queryProject,
  queryText,
  queryTokens,
  suggestQueryTokens,
  withoutQualifiers,
  withQualifier,
  withQueryText,
  type QueryableItem,
} from "./item-query";

const ISSUE: QueryableItem = {
  kind: "issue",
  project: "gitlab.com/acme/web",
  iid: 42,
  title: "Login times out",
  state: "opened",
  draft: false,
  author: "dana",
  labels: ["bug", "needs triage"],
  assignees: ["Rio"],
};

const MR: QueryableItem = {
  kind: "mr",
  project: "code.example.dev/acme/api",
  iid: 7,
  title: "Rework token refresh",
  state: "merged",
  draft: true,
  author: "rio",
  labels: [],
  assignees: [],
};

const match = (query: string, item: QueryableItem, viewer: string | null = null) =>
  matchesItemQuery(item, parseItemQuery(query), viewer);

describe("parseItemQuery", () => {
  it("maps the state people type onto the state GitLab stores", () => {
    expect(parseItemQuery("is:open").states).toEqual(["opened"]);
    expect(parseItemQuery("state:merged is:closed").states).toEqual([
      "merged",
      "closed",
    ]);
  });

  it("keeps draft out of the state list — GitLab holds it separately", () => {
    const parsed = parseItemQuery("is:open is:draft");
    expect(parsed.states).toEqual(["opened"]);
    expect(parsed.draftOnly).toBe(true);
  });

  it("takes quoted values as one label and drops the quotes", () => {
    expect(parseItemQuery('label:"needs triage" bug').labels).toEqual([
      "needs triage",
    ]);
  });

  it("ignores a half-typed qualifier instead of filtering on empty", () => {
    const parsed = parseItemQuery("label: assignee:");
    expect(parsed.labels).toEqual([]);
    expect(parsed.assignees).toEqual([]);
    expect(parsed.text).toEqual([]);
  });

  it("treats unqualified words as text terms", () => {
    expect(parseItemQuery("login TIMEOUT").text).toEqual(["login", "timeout"]);
  });
});

describe("matchesItemQuery", () => {
  it("requires every text term but only one of a repeated qualifier", () => {
    expect(match("login times", ISSUE)).toBe(true);
    expect(match("login missing", ISSUE)).toBe(false);
    expect(match("label:bug label:regression", ISSUE)).toBe(true);
  });

  it("matches an iid with its GitLab marker", () => {
    expect(match("#42", ISSUE)).toBe(true);
    expect(match("!42", ISSUE)).toBe(false);
    expect(match("!7", MR)).toBe(true);
  });

  it("resolves @me against the viewer, case-insensitively", () => {
    expect(match("assignee:@me", ISSUE, "rio")).toBe(true);
    expect(match("assignee:@me", ISSUE, "dana")).toBe(false);
    expect(match("author:@me", ISSUE, "dana")).toBe(true);
  });

  it("matches nothing for @me while the viewer is unknown", () => {
    expect(match("assignee:@me", ISSUE, null)).toBe(false);
  });

  it("narrows drafts without dropping the state filter", () => {
    expect(match("is:draft", MR)).toBe(true);
    expect(match("is:draft", ISSUE)).toBe(false);
    expect(match("is:open is:draft", MR)).toBe(false);
  });

  it("filters on the host-qualified project ref", () => {
    expect(match("project:gitlab.com/acme/web", ISSUE)).toBe(true);
    expect(match("project:acme/web", ISSUE)).toBe(false);
  });

  it("finds items missing an assignee or a label", () => {
    expect(match("no:assignee", MR)).toBe(true);
    expect(match("no:assignee", ISSUE)).toBe(false);
    expect(match("no:label", MR)).toBe(true);
    expect(match("no:label", ISSUE)).toBe(false);
  });
});

describe("suggestQueryTokens", () => {
  const vocab = {
    users: ["dana", "rio"],
    labels: ["bug", "needs triage"],
    projects: ["gitlab.com/acme/web"],
  };

  it("completes qualifier keys by prefix", () => {
    expect(
      suggestQueryTokens("la", vocab, "issue", null).map((s) => s.insert),
    ).toEqual(["label:"]);
  });

  it("offers merged and draft only for merge requests", () => {
    expect(
      suggestQueryTokens("is:", vocab, "mr", null).map((s) => s.label),
    ).toEqual(["open", "draft", "closed", "merged"]);
    expect(
      suggestQueryTokens("is:", vocab, "issue", null).map((s) => s.label),
    ).toEqual(["open", "closed"]);
  });

  it("labels @me with the viewer and carries an avatar username", () => {
    const [me] = suggestQueryTokens("assignee:", vocab, "issue", "dana");
    expect(me).toMatchObject({
      insert: "assignee:@me ",
      label: "@me (dana)",
      username: "dana",
    });
  });

  it("quotes a completed value that contains whitespace", () => {
    expect(
      suggestQueryTokens("label:needs", vocab, "issue", null).map(
        (s) => s.insert,
      ),
    ).toEqual(['label:"needs triage" ']);
  });

  it("completes a value that is already partly typed", () => {
    expect(
      suggestQueryTokens("author:ri", vocab, "issue", null).map((s) => s.label),
    ).toEqual(["rio"]);
  });
});

describe("queryProject", () => {
  it("picks the first project: value that names a tracked project", () => {
    expect(
      queryProject(parseItemQuery("project:gone project:gitlab.com/acme/web"), [
        "gitlab.com/acme/web",
      ]),
    ).toBe("gitlab.com/acme/web");
    expect(queryProject(parseItemQuery("is:open"), ["gitlab.com/acme/web"])).toBe(
      null,
    );
  });
});

describe("query editing", () => {
  it("lists tokens with folded keys and unquoted values", () => {
    expect(queryTokens('state:open label:"needs triage" login')).toEqual([
      { key: "is", value: "open", raw: "state:open" },
      { key: "label", value: "needs triage", raw: 'label:"needs triage"' },
      { key: "", value: "login", raw: "login" },
    ]);
  });

  it("adds a qualifier once and quotes values with spaces", () => {
    const once = withQualifier("is:open ", "label", "needs triage");
    expect(once).toBe('is:open label:"needs triage" ');
    expect(withQualifier(once, "label", "Needs Triage")).toBe(once);
    expect(parseItemQuery(once).labels).toEqual(["needs triage"]);
  });

  it("removes matching qualifiers and keeps text", () => {
    expect(
      withoutQualifiers("is:open is:draft login label:bug", (key, value) =>
        key === "is" && value !== "draft",
      ),
    ).toBe("is:draft login label:bug ");
    expect(withoutQualifiers("is:open", () => true)).toBe("");
  });

  it("edits the text part without touching qualifiers", () => {
    expect(queryText("is:open login timeout label:bug")).toBe("login timeout");
    expect(withQueryText("is:open login label:bug", "crash  report")).toBe(
      "is:open label:bug crash report ",
    );
    expect(withQueryText("is:open login", "")).toBe("is:open ");
    expect(parseItemQuery(withQueryText("", "assignee:@me oops")).assignees).toEqual([
      "@me",
    ]);
  });
});

describe("reviewer qualifier", () => {
  const MR: QueryableItem = {
    ...ISSUE,
    kind: "mr",
    reviewers: ["Ilya", "Dana"],
  };

  it("filters merge requests by reviewer, @me, and no:reviewer", () => {
    expect(matchesItemQuery(MR, parseItemQuery("reviewer:ilya"), null)).toBe(true);
    expect(matchesItemQuery(MR, parseItemQuery("reviewer:rio"), null)).toBe(false);
    expect(matchesItemQuery(MR, parseItemQuery("reviewer:@me"), "dana")).toBe(true);
    // Until the viewer is known, @me matches nothing rather than everything.
    expect(matchesItemQuery(MR, parseItemQuery("reviewer:@me"), null)).toBe(false);
    expect(matchesItemQuery(MR, parseItemQuery("no:reviewer"), null)).toBe(false);
    expect(
      matchesItemQuery({ ...MR, reviewers: [] }, parseItemQuery("no:reviewer"), null),
    ).toBe(true);
  });

  it("treats a missing reviewer list like an empty one", () => {
    expect(matchesItemQuery(ISSUE, parseItemQuery("no:reviewer"), null)).toBe(true);
    expect(matchesItemQuery(ISSUE, parseItemQuery("reviewer:ilya"), null)).toBe(false);
  });

  it("completes the key and the people", () => {
    const vocab = { users: ["Ilya", "Dana"], labels: [], projects: [] };
    expect(suggestQueryTokens("rev", vocab, "mr", null).map((s) => s.insert)).toEqual([
      "reviewer:",
    ]);
    expect(
      suggestQueryTokens("reviewer:il", vocab, "mr", null).map((s) => s.label),
    ).toEqual(["Ilya"]);
  });
});
