import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { PluginRpcClient, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  classifyJobStatus,
  countDiffLines,
  fetchProjectItems,
  gitlabRpcContract,
  isProjectRef,
  normalizeHostname,
  normalizeProjectRef,
  parseAuthenticatedHosts,
  parseGitlabRemote,
  parseProjectRef,
  parseGitlabCliArgs,
  parseGitlabTarget,
  tailJobLog,
  toItems,
  validateGitlabCliArgs,
  DEFAULT_JOB_LOG_LINES,
  type GitlabHost,
} from "./server";

type GitlabRpcHandlers = PluginRpcHandlers<typeof gitlabRpcContract>;

/** Hosting shapes glab supports, all keyed by the name it knows them by. */
const PLAIN: GitlabHost = {
  host: "gitlab.com",
  subfolder: "",
  sshHost: null,
  apiHost: null,
};
/** Self-managed, served under https://code.example.dev/gitlab/. */
const SUBFOLDER: GitlabHost = {
  host: "code.example.dev",
  subfolder: "gitlab",
  sshHost: null,
  apiHost: null,
};
/** Self-managed behind a port, with git-over-SSH on its own name. */
const SPLIT: GitlabHost = {
  host: "devops.corp",
  subfolder: "",
  sshHost: "ssh.devops.corp",
  apiHost: "devops.corp:8443",
};
const HOSTS: GitlabHost[] = [PLAIN, SUBFOLDER, SPLIT];

function assertGitlabFrontendInference(
  client: PluginRpcClient<typeof gitlabRpcContract>,
) {
  expectTypeOf(
    client.call("getMergeRequest", {
      project: "gitlab.com/group/sub/app",
      iid: 42,
    }),
  ).resolves.toHaveProperty("mergeRequest");

  // @ts-expect-error merge-request iids are numeric.
  void client.call("getIssue", { project: "gitlab.com/group/app", iid: "42" });
  // @ts-expect-error the contract only knows issues and merge requests.
  void client.call("listItems", { kind: "epic" });
}

describe("GitLab project refs", () => {
  it("reads a host-qualified ref out of every remote shape", () => {
    expect(parseGitlabRemote("git@gitlab.com:group/sub/app.git", HOSTS)).toBe(
      "gitlab.com/group/sub/app",
    );
    expect(parseGitlabRemote("https://gitlab.com/group/app.git\n", HOSTS)).toBe(
      "gitlab.com/group/app",
    );
    expect(
      parseGitlabRemote("ssh://git@gitlab.com:2222/group/sub/deep/app", HOSTS),
    ).toBe("gitlab.com/group/sub/deep/app");
    // Case and IDN are normalized so one instance is never tracked twice and
    // the ref stays the ASCII name DNS and glab both use.
    expect(parseGitlabRemote("git@GitLab.com:group/app.git", HOSTS)).toBe(
      "gitlab.com/group/app",
    );
    expect(
      parseGitlabRemote("https://xn--gitlb-jra.example/g/a.git", [
        { host: "gitläb.example", subfolder: "", sshHost: null, apiHost: null },
      ]),
    ).toBe("xn--gitlb-jra.example/g/a");
  });

  it("resolves the hosting variants glab describes in its host config", () => {
    // A subfolder is part of the URL but never part of the project path.
    expect(
      parseGitlabRemote("https://code.example.dev/gitlab/group/app.git", HOSTS),
    ).toBe("code.example.dev/group/app");
    // Ports never reach a ref: `glab --hostname` rejects them, and the port
    // belongs to the host's api_host config instead.
    expect(
      parseGitlabRemote("https://devops.corp:8443/team/web/app.git", HOSTS),
    ).toBe("devops.corp/team/web/app");
    // Git over SSH answering on another name still maps to the glab host.
    expect(
      parseGitlabRemote("git@ssh.devops.corp:team/web/app.git", HOSTS),
    ).toBe("devops.corp/team/web/app");
    // A subfolder-shaped path on a host without one stays untouched.
    expect(parseGitlabRemote("https://gitlab.com/gitlab/app.git", HOSTS)).toBe(
      "gitlab.com/gitlab/app",
    );
  });

  it("keeps untracked hosts and namespace-less paths out of discovery", () => {
    expect(parseGitlabRemote("git@github.com:acme/widgets.git", HOSTS)).toBeNull();
    // A user-level path with no namespace is not a project.
    expect(parseGitlabRemote("https://gitlab.com/app.git", HOSTS)).toBeNull();
    // A subfolder install whose remote carries only the subfolder + project.
    expect(
      parseGitlabRemote("https://code.example.dev/gitlab/app.git", HOSTS),
    ).toBeNull();
    expect(parseGitlabRemote("", HOSTS)).toBeNull();
    expect(parseGitlabRemote("git@gitlab.com:group/app.git", [])).toBeNull();
    // IPv6 literals: glab refuses them, so the plugin must not invent a ref.
    expect(normalizeHostname("[2001:db8::1]")).toBeNull();
    expect(normalizeHostname("[2001:db8::1]:8443")).toBeNull();
  });

  it("normalizes whatever a user types into extraProjects", () => {
    // Host-qualified, with scheme, case, port, subfolder and trailing slash.
    expect(
      normalizeProjectRef(
        "HTTPS://Code.Example.DEV/gitlab/group/app/",
        HOSTS,
        "gitlab.com",
      ),
    ).toBe("code.example.dev/group/app");
    expect(
      normalizeProjectRef("devops.corp:8443/team/web/app", HOSTS, "gitlab.com"),
    ).toBe("devops.corp/team/web/app");
    // A bare path takes the configured default host, whatever domain that is.
    expect(normalizeProjectRef("group/app", HOSTS, "gitlab.internal")).toBe(
      "gitlab.internal/group/app",
    );
    // An instance glab does not know yet stays addressable for after login.
    expect(
      normalizeProjectRef("git.new-team.dev/group/app", HOSTS, "gitlab.com"),
    ).toBe("git.new-team.dev/group/app");
    expect(normalizeProjectRef("not a project", HOSTS, "gitlab.com")).toBeNull();
    expect(normalizeProjectRef("   ", HOSTS, "gitlab.com")).toBeNull();
  });

  it("splits a ref at the host, never at every slash", () => {
    expect(parseProjectRef("gitlab.example.dev/group/sub/app")).toEqual({
      host: "gitlab.example.dev",
      path: "group/sub/app",
    });
    expect(() => parseProjectRef("gitlab.com")).toThrow("malformed");
    expect(isProjectRef("gitlab.com/group")).toBe(true);
    expect(isProjectRef("gitlab.com/")).toBe(false);
    expect(isProjectRef("group/app")).toBe(true);
  });
});

describe("glab plumbing", () => {
  it("collects only the hosts glab reports as logged in", () => {
    const status = [
      "gitlab.com",
      "  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401",
      "  ! No token found (checked config file, keyring, and environment variables).",
      "gitlab.example.dev",
      "  ✓ Logged in to gitlab.example.dev as tanuki (/home/me/config.yml)",
      "  ✓ Token found: **************************",
    ].join("\n");
    expect(parseAuthenticatedHosts(status)).toEqual(["gitlab.example.dev"]);
    expect(parseAuthenticatedHosts("")).toEqual([]);
  });

  it("counts diff lines without charging the +++/--- headers", () => {
    const diff = [
      "@@ -1,4 +1,5 @@",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      " context",
      "-removed",
      "+added one",
      "+added two",
    ].join("\n");
    expect(countDiffLines(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it("maps GitLab job statuses onto the panel's traffic light", () => {
    expect(classifyJobStatus("success")).toBe("success");
    expect(classifyJobStatus("failed")).toBe("failure");
    expect(classifyJobStatus("running")).toBe("pending");
    expect(classifyJobStatus("waiting_for_resource")).toBe("pending");
    // A manual or skipped job is not a failure — it is simply not a signal.
    expect(classifyJobStatus("manual")).toBe("neutral");
    expect(classifyJobStatus("skipped")).toBe("neutral");
  });

  it("rejects CLI arguments that would otherwise broaden a project query", () => {
    expect(validateGitlabCliArgs(["issues", "gitlab.com/group/sub/app"])).toBeNull();
    expect(validateGitlabCliArgs(["issues", "not a project"])).toContain(
      "expected host/group/project",
    );
    expect(
      validateGitlabCliArgs(["mrs", "gitlab.com/group/app", "extra"]),
    ).toContain("Unexpected argument");
    expect(validateGitlabCliArgs(["projects", "extra"])).toContain(
      "does not accept arguments",
    );
    expect(validateGitlabCliArgs(["projects", "--json"])).toBeNull();
    expect(validateGitlabCliArgs(["issues", "--bogus"])).toContain(
      'Unknown flag "--bogus"',
    );
  });
});

describe("bb gitlab argument parsing", () => {
  it("parses list filters, with repeatable labels and both flag forms", () => {
    expect(
      parseGitlabCliArgs([
        "mrs",
        "gitlab.com/group/app",
        "--state=merged",
        "--author",
        "@me",
        "--label",
        "bug",
        "--label=needs review",
        "--draft",
        "--limit",
        "5",
        "--json",
      ]),
    ).toEqual({
      sub: "mrs",
      project: "gitlab.com/group/app",
      filters: {
        state: "merged",
        mine: false,
        author: "@me",
        assignee: null,
        labels: ["bug", "needs review"],
        draft: true,
        limit: 5,
        json: true,
      },
    });
    expect(parseGitlabCliArgs(["issues"])).toMatchObject({
      sub: "issues",
      project: null,
      filters: { state: "open", mine: false, labels: [] },
    });
  });

  it("rejects list filters that cannot mean anything", () => {
    expect(parseGitlabCliArgs(["issues", "--state", "merged"])).toEqual({
      error: "Issues are never merged; use --state closed.",
    });
    expect(parseGitlabCliArgs(["issues", "--draft"])).toEqual({
      error: 'Unknown flag "--draft".',
    });
    expect(parseGitlabCliArgs(["mrs", "--state", "weird"])).toHaveProperty(
      "error",
    );
    expect(parseGitlabCliArgs(["mrs", "--limit", "0"])).toHaveProperty("error");
    expect(parseGitlabCliArgs(["mrs", "--mine", "--assignee", "dana"])).toHaveProperty(
      "error",
    );
    expect(parseGitlabCliArgs(["mrs", "--author"])).toEqual({
      error: "Flag --author needs a value.",
    });
    expect(parseGitlabCliArgs(["mrs", "--state", "open", "--state", "all"])).toEqual({
      error: "Flag --state given twice.",
    });
  });

  it("keeps comment text verbatim, flags and all", () => {
    expect(
      parseGitlabCliArgs(["comment", "gitlab.com/g/app!12", "LGTM,", "--but", "see", "#3"]),
    ).toEqual({
      sub: "comment",
      target: "gitlab.com/g/app!12",
      body: "LGTM, --but see #3",
    });
    expect(parseGitlabCliArgs(["comment", "gitlab.com/g/app!12"])).toHaveProperty(
      "error",
    );
  });

  it("parses pipeline, retry, and run selectors", () => {
    expect(parseGitlabCliArgs(["pipeline"])).toEqual({
      sub: "pipeline",
      target: null,
      ref: null,
      pipelineId: null,
      logs: DEFAULT_JOB_LOG_LINES,
      json: false,
    });
    expect(
      parseGitlabCliArgs(["pipeline", "gitlab.com/g/app", "--ref", "main", "--logs", "0"]),
    ).toMatchObject({ target: "gitlab.com/g/app", ref: "main", logs: 0 });
    expect(
      parseGitlabCliArgs(["retry", "gitlab.com/g/app!4", "--job", "unit tests"]),
    ).toEqual({
      sub: "retry",
      target: "gitlab.com/g/app!4",
      ref: null,
      pipelineId: null,
      job: "unit tests",
    });
    expect(
      parseGitlabCliArgs(["retry", "--pipeline", "9", "--ref", "main"]),
    ).toEqual({ error: "Pass --pipeline or --ref, not both." });
    expect(parseGitlabCliArgs(["pipeline", "--pipeline", "abc"])).toHaveProperty(
      "error",
    );
    expect(parseGitlabCliArgs(["run", "--ref", "release"])).toEqual({
      sub: "run",
      target: null,
      ref: "release",
    });
    expect(parseGitlabCliArgs(["show"])).toHaveProperty("error");
    expect(parseGitlabCliArgs(["deploy"])).toEqual({
      error: 'Unknown subcommand "deploy".',
    });
  });
});

describe("bb gitlab targets", () => {
  it("reads host-qualified issue and merge-request refs", () => {
    expect(parseGitlabTarget("gitlab.com/group/sub/app#7", HOSTS, "gitlab.com")).toEqual({
      kind: "issue",
      project: "gitlab.com/group/sub/app",
      iid: 7,
    });
    expect(parseGitlabTarget("gitlab.com/group/app!12", HOSTS, "gitlab.com")).toEqual({
      kind: "mr",
      project: "gitlab.com/group/app",
      iid: 12,
    });
    expect(parseGitlabTarget("gitlab.com/group/app", HOSTS, "gitlab.com")).toEqual({
      kind: "project",
      project: "gitlab.com/group/app",
    });
    expect(parseGitlabTarget("gitlab.com/group/app!0", HOSTS, "gitlab.com")).toBeNull();
    expect(parseGitlabTarget("not a ref", HOSTS, "gitlab.com")).toBeNull();
  });

  it("reads web URLs, including subfolder and port installs", () => {
    expect(
      parseGitlabTarget(
        "https://gitlab.com/group/app/-/merge_requests/12/diffs#note_5",
        HOSTS,
        "gitlab.com",
      ),
    ).toEqual({ kind: "mr", project: "gitlab.com/group/app", iid: 12 });
    expect(
      parseGitlabTarget(
        "https://code.example.dev/gitlab/group/app/-/issues/3",
        HOSTS,
        "gitlab.com",
      ),
    ).toEqual({ kind: "issue", project: "code.example.dev/group/app", iid: 3 });
    expect(
      parseGitlabTarget(
        "https://devops.corp:8443/team/svc/-/pipelines/900",
        HOSTS,
        "gitlab.com",
      ),
    ).toEqual({ kind: "pipeline", project: "devops.corp/team/svc", id: 900 });
    expect(
      parseGitlabTarget("https://gitlab.com/group/app/-/jobs/31", HOSTS, "gitlab.com"),
    ).toEqual({ kind: "job", project: "gitlab.com/group/app", id: 31 });
    expect(
      parseGitlabTarget("https://gitlab.com/group/app/", HOSTS, "gitlab.com"),
    ).toEqual({ kind: "project", project: "gitlab.com/group/app" });
    expect(
      parseGitlabTarget("https://gitlab.com/group/app/-/tree/main", HOSTS, "gitlab.com"),
    ).toEqual({ kind: "project", project: "gitlab.com/group/app" });
  });

  it("tails a job trace without terminal escapes", () => {
    const trace = [
      "\x1b[0Ksection_start:1700000000:step_script\r\x1b[0K\x1b[32;1mExecuting step\x1b[0;m",
      "Downloading 10%\rDownloading 100%",
      "\x1b[31mFAIL\x1b[0m src/app.test.ts",
      "section_end:1700000001:step_script\r\x1b[0K",
      "",
    ].join("\n");
    expect(tailJobLog(trace, 2)).toBe(
      ["Downloading 100%", "FAIL src/app.test.ts"].join("\n"),
    );
    expect(tailJobLog(trace, 10).split("\n")[0]).toBe("Executing step");
    expect(tailJobLog(trace, 0)).toBe("");
    const failed = [
      "section_start:1:step_script\r\x1b[0KRunning tests",
      "E   AssertionError: 1 != 2",
      "section_end:2:step_script\r\x1b[0K",
      // GitLab writes one section's end and the next one's start on one line.
      "section_start:3:after_script\r\x1b[0KRunning after script...",
      "$ ls report/",
      "section_end:4:after_script\r\x1b[0Ksection_start:4:upload_artifacts_on_failure\r\x1b[0KUploading artifacts...",
      "report.xml: found 1 matching artifact files",
      "section_end:5:upload_artifacts_on_failure\r\x1b[0Ksection_start:5:cleanup_file_variables\r\x1b[0KCleaning up",
      "section_end:6:cleanup_file_variables\r\x1b[0K\x1b[31;1mERROR: Job failed: exit code 1\x1b[0;m",
    ].join("\n");
    expect(tailJobLog(failed, 2)).toBe(
      ["E   AssertionError: 1 != 2", "ERROR: Job failed: exit code 1"].join("\n"),
    );
  });
});

describe("GitLab payload parsing", () => {
  it("normalizes issue and merge-request rows, dropping unusable ones", () => {
    const rows = [
      {
        iid: 7,
        title: "Fix the flaky spec",
        state: "opened",
        work_in_progress: true,
        author: { id: 3, username: "tanuki" },
        labels: ["bug", "ci"],
        assignees: [{ id: 4, username: "mensahs" }, { id: 5, username: "" }],
        web_url: "https://gitlab.com/group/app/-/merge_requests/7",
        description: "It fails once per week.",
        updated_at: "2026-08-14T12:29:03.902Z",
      },
      // No iid: GitLab cannot address it, so neither can the cache.
      { title: "orphan" },
    ];
    expect(toItems(rows, "gitlab.com/group/app", "mr")).toEqual([
      {
        project: "gitlab.com/group/app",
        iid: 7,
        kind: "mr",
        title: "Fix the flaky spec",
        state: "opened",
        draft: true,
        author: "tanuki",
        labels: ["bug", "ci"],
        assignees: ["mensahs"],
        url: "https://gitlab.com/group/app/-/merge_requests/7",
        body: "It fails once per week.",
        updatedAt: "2026-08-14T12:29:03.902Z",
      },
    ]);
  });

  it("falls back to empty fields rather than failing a whole list", () => {
    const items = toItems([{ iid: 1, description: null, labels: null }], "gitlab.com/g/a", "issue");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "", state: "opened", body: "", labels: [], author: "" });
    expect(toItems({ message: "404 Not found" }, "gitlab.com/g/a", "issue")).toEqual([]);
  });

  it("keeps merge requests when a project has issues disabled", async () => {
    const endpoints: string[] = [];
    const items = await fetchProjectItems(async (_project, endpoint) => {
      endpoints.push(endpoint);
      if (endpoint.includes("/issues?")) {
        throw new Error("glab api failed: 404 Not found (HTTP 404)");
      }
      if (endpoint.includes("state=opened")) {
        return [
          {
            iid: 12,
            title: "Add geometries",
            state: "opened",
            author: { username: "mensahs" },
            web_url: "https://gitlab.example.dev/group/sub/app/-/merge_requests/12",
            updated_at: "2026-08-14T12:29:03.902Z",
          },
        ];
      }
      return [];
    }, "gitlab.example.dev/group/sub/app");

    // Subgroup paths must reach GitLab URL-encoded, as one id segment.
    expect(
      endpoints.every((endpoint) =>
        endpoint.startsWith("projects/group%2Fsub%2Fapp/"),
      ),
    ).toBe(true);
    expect(endpoints).toHaveLength(5);
    expect(items).toEqual([
      {
        project: "gitlab.example.dev/group/sub/app",
        iid: 12,
        kind: "mr",
        title: "Add geometries",
        state: "opened",
        draft: false,
        author: "mensahs",
        labels: [],
        assignees: [],
        url: "https://gitlab.example.dev/group/sub/app/-/merge_requests/12",
        body: "",
        updatedAt: "2026-08-14T12:29:03.902Z",
      },
    ]);
  });

  it("lets a genuine failure abort the sync instead of caching an empty project", async () => {
    await expect(
      fetchProjectItems(async () => {
        throw new Error("glab api failed: 500 Internal Server Error");
      }, "gitlab.com/group/app"),
    ).rejects.toThrow("500");
  });
});

describe("rpc contract", () => {
  it("infers parsed handler inputs and frontend results", () => {
    expectTypeOf<
      Parameters<GitlabRpcHandlers["createIssue"]>[0]
    >().toEqualTypeOf<{
      project: string;
      title: string;
      body?: string;
    }>();
    expectTypeOf(assertGitlabFrontendInference).toBeFunction();
  });

  it("rejects invalid method inputs and outputs at runtime", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "gitlab-contract",
    });
    const contract = defineRpcContract({
      startReview: gitlabRpcContract.startReview,
    });
    bb.rpc.register(contract, {
      startReview() {
        return { threadId: "" };
      },
    });

    await expect(
      harness.callRpc("startReview", { project: "group", iid: 4 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("startReview", {
        project: "gitlab.com/group/sub/app",
        iid: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("startReview", {
        project: "gitlab.com/group/sub/app",
        iid: 4,
      }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
});
