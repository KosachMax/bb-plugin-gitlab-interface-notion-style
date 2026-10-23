// GitLab Interface (Notion style) — GitLab issues & merge requests inside BB.
//
// Auth rides on the GitLab CLI: every host `glab auth status` reports as
// logged in is a host this plugin can reach, so self-managed instances work
// without extra configuration. Projects are discovered from each BB project's
// git remote (kept when its host is one of those authenticated hosts) plus an
// optional extraProjects setting. A background service syncs open +
// recently-closed issues/MRs into the plugin's SQLite cache; the frontend
// panel and mention providers read that cache, while mutations (note, create,
// close/reopen, assign, label) and detail views go straight through
// `glab api`.
//
// A project is addressed by its host-qualified ref — "gitlab.com/group/sub/app"
// — because a GitLab path has any number of namespace segments and the same
// path can exist on two instances.
import { execFile } from "node:child_process";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { explainMergeFailure, mergeAllowance, mergeQuery } from "./lib/merge";
import { classifyPromotion, normalizedPatch, type PromotionCommit } from "./lib/promotion";
import {
  classifyJobStatus,
  isTerminalPipelineStatus,
  jobActions,
  mergeRequestIidFromRef,
  retryableJobs,
} from "./lib/pipeline";

// The pipeline rules live in lib/pipeline so the panel shares them; tests and
// other callers keep reaching them through the server module.
export {
  classifyJobStatus,
  isTerminalPipelineStatus,
  jobActions,
  mergeRequestIidFromRef,
  retryableJobs,
};

/** Pages of 100 read for members and labels: 2,000 people is the ceiling. */
const MAX_LIST_PAGES = 20;
const SYNC_INTERVAL_MS = 5 * 60_000;
const ISSUE_PAGE = 100;
const CLOSED_ISSUE_PAGE = 50;
const MR_PAGE = 50;
const CLOSED_MR_PAGE = 30;
/** One page of per-file diffs; a bigger merge request reports truncation. */
const DIFF_PAGE = 100;
/** Per-file diffs above this size stay on GitLab; the panel links out. */
const MAX_PATCH_BYTES = 20_000;

const GLAB_HINT =
  "Install the GitLab CLI (https://gitlab.com/gitlab-org/cli) and run " +
  "`glab auth login`, then `bb plugin reload gitlab-interface-notion-style`.";

/**
 * "host/group/sub/project" — the host glab knows the instance by, then a path
 * of 1+ namespace segments. No port and no scheme: `glab --hostname` accepts a
 * bare hostname only, and everything else about how an instance is reached
 * (port, subfolder, http, alternate SSH host, custom CA) lives in that host's
 * glab config. Underscores appear in intranet hostnames, which glab accepts.
 */
const PROJECT_REF_PATTERN =
  /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

// ---------------------------------------------------------------------------
// The rpc contract: what the frontend panel may ask for.
// ---------------------------------------------------------------------------
const projectRefSchema = z.string().regex(PROJECT_REF_PATTERN);
const iidSchema = z.number().int().positive();
const itemInputSchema = z
  .object({ project: projectRefSchema, iid: iidSchema })
  .strict();
const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
const projectInfoSchema = z
  .object({
    project: projectRefSchema,
    host: z.string().min(1),
    path: z.string().min(1),
    bbProjectId: z.string().nullable(),
  })
  .strict();
const itemSchema = z
  .object({
    project: projectRefSchema,
    iid: iidSchema,
    kind: z.enum(["issue", "mr"]),
    title: z.string(),
    /** GitLab-native: "opened" | "closed" | "merged" | "locked". */
    state: z.string(),
    draft: z.boolean(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    /** Merge requests only; always empty for issues. */
    reviewers: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const syncResultSchema = z
  .object({
    projects: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
  })
  .strict();
const okResultSchema = z.object({ ok: z.literal(true) }).strict();
const noteSchema = z
  .object({ author: z.string(), body: z.string(), createdAt: z.string() })
  .strict();
const threadLinkSchema = z
  .object({
    kind: z.enum(["issue", "mr"]),
    project: projectRefSchema,
    iid: iidSchema,
    threadId: z.string().min(1),
    createdAt: z.string(),
  })
  .strict();
const pipelineIdSchema = z.number().int().positive();
const jobIdSchema = z.number().int().positive();
const pipelineSummarySchema = z
  .object({
    id: pipelineIdSchema,
    status: z.string(),
    ref: z.string(),
    sha: z.string(),
    source: z.string(),
    url: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const pipelineJobSchema = z
  .object({
    id: jobIdSchema,
    name: z.string(),
    stage: z.string(),
    status: z.string(),
    allowFailure: z.boolean(),
    url: z.string(),
    durationSeconds: z.number().nullable(),
  })
  .strict();
const pipelineDetailSchema = pipelineSummarySchema
  .extend({
    user: z.string(),
    durationSeconds: z.number().nullable(),
    yamlErrors: z.string().nullable(),
  })
  .strict();
const pipelineActionSchema = z
  .object({ id: pipelineIdSchema, status: z.string(), url: z.string() })
  .strict();

const branchSchema = z
  .object({
    name: z.string().min(1),
    isDefault: z.boolean(),
    protected: z.boolean(),
    merged: z.boolean(),
    url: z.string(),
    commit: z
      .object({
        sha: z.string(),
        title: z.string(),
        author: z.string(),
        date: z.string(),
        url: z.string(),
      })
      .strict()
      .nullable(),
    /** The open merge request whose source this branch is. */
    mergeRequest: z
      .object({ iid: iidSchema, title: z.string(), draft: z.boolean() })
      .strict()
      .nullable(),
    /** The newest pipeline GitLab ran on this branch. */
    pipeline: z
      .object({ id: z.number().int().positive(), status: z.string() })
      .strict()
      .nullable(),
  })
  .strict();

const diffFileSchema = z
  .object({
    path: z.string(),
    status: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    patch: z.string().nullable(),
  })
  .strict();

const mergeRequestSchema = z
  .object({
    project: projectRefSchema,
    iid: iidSchema,
    title: z.string(),
    state: z.string(),
    draft: z.boolean(),
    author: z.string(),
    body: z.string(),
    url: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    sourceBranch: z.string(),
    targetBranch: z.string(),
    /** GitLab's own file count; the files themselves load with getMergeRequestFiles. */
    changedFiles: z.number().int().nonnegative(),
    /** The source branch's head commit: what a merge from this page is pinned to. */
    headSha: z.string(),
    /** The merge request's own squash and delete-branch settings, to prefill the merge dialog. */
    squash: z.boolean(),
    removeSourceBranch: z.boolean(),
    /** A merge is already queued behind the running pipeline. */
    mergeScheduled: z.boolean(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    reviewers: z.array(z.string()),
    /** GitLab's detailed_merge_status, e.g. "mergeable", "need_rebase". */
    mergeStatus: z.string(),
    hasConflicts: z.boolean(),
    approvalsRequired: z.number().int().nonnegative(),
    approvalsLeft: z.number().int().nonnegative(),
    approvedBy: z.array(z.string()),
    pipeline: z
      .object({ id: z.number().int().nonnegative(), status: z.string(), url: z.string() })
      .strict()
      .nullable(),
    /** Every thread and standalone comment, oldest first; system notes excluded. */
    discussions: z.array(
      z
        .object({
          /** GitLab's discussion id, which a reply is posted to. */
          id: z.string().min(1),
          /** A single standalone comment rather than a thread. */
          individual: z.boolean(),
          /** Can be resolved: review threads, not plain comments. */
          resolvable: z.boolean(),
          /** "" for a thread that is not attached to a file. */
          path: z.string(),
          line: z.number().int().nonnegative().nullable(),
          resolved: z.boolean(),
          notes: z.array(noteSchema),
        })
        .strict(),
    ),
    /** Emoji reactions on the merge request itself, grouped by emoji. */
    reactions: z.array(
      z
        .object({ name: z.string().min(1), users: z.array(z.string()) })
        .strict(),
    ),
  })
  .strict();

export const gitlabRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z
      .object({
        glabOk: z.boolean(),
        glabError: z.string().nullable(),
        hosts: z.array(z.string()),
        projects: z.array(projectInfoSchema),
        lastSyncedAt: z.string().nullable(),
      })
      .strict(),
  },
  refresh: { input: z.null(), output: syncResultSchema },
  listItems: {
    input: z
      .object({
        kind: z.enum(["issue", "mr"]).optional(),
        project: projectRefSchema.optional(),
        state: z.enum(["open", "closed"]).optional(),
      })
      .strict(),
    output: z.object({ items: z.array(itemSchema) }).strict(),
  },
  /** The settings the panel reads. */
  uiSettings: {
    input: z.null(),
    output: z
      .object({
        promotionBranch: z.string(),
        assigneesReview: z.boolean(),
        reactionApprovals: z.boolean(),
        allowMerge: z.boolean(),
      })
      .strict(),
  },
  viewer: {
    input: z.null(),
    output: z.object({ username: z.string().min(1) }).strict(),
  },
  assignableUsers: {
    input: z.object({ project: projectRefSchema }).strict(),
    output: z.object({ users: z.array(z.string().min(1)) }).strict(),
  },
  projectLabels: {
    input: z.object({ project: projectRefSchema }).strict(),
    output: z
      .object({
        labels: z.array(z.string().min(1)),
        /** GitLab's own label colors, "#rrggbb", by label name. */
        colors: z.record(z.string(), z.string()),
      })
      .strict(),
  },
  setIssueState: {
    input: itemInputSchema
      .extend({ state: z.enum(["open", "closed"]) })
      .strict(),
    output: okResultSchema,
  },
  setAssignees: {
    input: itemInputSchema
      .extend({
        assignees: z.array(z.string().min(1)),
        kind: z.enum(["issue", "mr"]).default("issue"),
      })
      .strict(),
    output: z
      .object({ ok: z.literal(true), assignees: z.array(z.string().min(1)) })
      .strict(),
  },
  setReviewers: {
    input: itemInputSchema
      .extend({ reviewers: z.array(z.string().min(1)) })
      .strict(),
    output: z
      .object({ ok: z.literal(true), reviewers: z.array(z.string().min(1)) })
      .strict(),
  },
  setLabels: {
    input: itemInputSchema
      .extend({
        labels: z.array(z.string()),
        kind: z.enum(["issue", "mr"]).default("issue"),
      })
      .strict(),
    output: z
      .object({ ok: z.literal(true), labels: z.array(z.string().min(1)) })
      .strict(),
  },
  getIssue: {
    input: itemInputSchema,
    output: z
      .object({
        issue: z
          .object({
            project: projectRefSchema,
            iid: iidSchema,
            title: z.string(),
            state: z.string(),
            author: z.string(),
            body: z.string(),
            labels: z.array(z.string()),
            assignees: z.array(z.string()),
            url: z.string(),
            updatedAt: z.string(),
            notes: z.array(noteSchema),
          })
          .strict(),
      })
      .strict(),
  },
  getMergeRequest: {
    input: itemInputSchema,
    output: z.object({ mergeRequest: mergeRequestSchema }).strict(),
  },
  /** The diffs, loaded on their own because they are the heaviest part. */
  getMergeRequestFiles: {
    input: itemInputSchema,
    output: z
      .object({
        files: z.array(diffFileSchema),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        /** True when the list stopped at the page limit, so files is partial. */
        truncated: z.boolean(),
      })
      .strict(),
  },
  listPipelines: {
    input: z
      .object({
        project: projectRefSchema,
        ref: z.string().min(1).max(255).optional(),
        status: z.string().min(1).max(40).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      })
      .strict(),
    output: z
      .object({
        pipelines: z.array(pipelineSummarySchema),
        defaultBranch: z.string(),
      })
      .strict(),
  },
  getPipeline: {
    input: z.object({ project: projectRefSchema, id: pipelineIdSchema }).strict(),
    output: z
      .object({
        pipeline: pipelineDetailSchema,
        jobs: z.array(pipelineJobSchema),
        /** The merge request this pipeline belongs to, when it is one. */
        mergeRequestIid: z.number().int().positive().nullable(),
      })
      .strict(),
  },
  listBranches: {
    input: z
      .object({
        project: projectRefSchema,
        search: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(100).default(100),
      })
      .strict(),
    output: z.object({ branches: z.array(branchSchema) }).strict(),
  },
  /** A pipeline's jobs on their own, so a merge request page need not wait for them. */
  getPipelineJobs: {
    input: z.object({ project: projectRefSchema, id: pipelineIdSchema }).strict(),
    output: z.object({ jobs: z.array(pipelineJobSchema) }).strict(),
  },
  getJobLog: {
    input: z
      .object({
        project: projectRefSchema,
        jobId: jobIdSchema,
        lines: z.number().int().min(1).max(2000).default(60),
      })
      .strict(),
    output: z.object({ log: z.string(), truncated: z.boolean() }).strict(),
  },
  retryPipeline: {
    input: z.object({ project: projectRefSchema, id: pipelineIdSchema }).strict(),
    output: pipelineActionSchema.extend({ retried: z.number().int().nonnegative() }).strict(),
  },
  cancelPipeline: {
    input: z.object({ project: projectRefSchema, id: pipelineIdSchema }).strict(),
    output: pipelineActionSchema,
  },
  runJob: {
    input: z
      .object({
        project: projectRefSchema,
        jobId: jobIdSchema,
        action: z.enum(["retry", "play", "cancel"]),
      })
      .strict(),
    output: z.object({ jobId: jobIdSchema, status: z.string(), url: z.string() }).strict(),
  },
  runPipeline: {
    input: z
      .object({
        project: projectRefSchema,
        ref: z.string().min(1).max(255).optional(),
        mergeRequestIid: z.number().int().positive().optional(),
      })
      .strict()
      .refine((value) => value.ref === undefined || value.mergeRequestIid === undefined, {
        message: "pass a ref or a merge request, not both",
      }),
    output: pipelineActionSchema,
  },
  /** Which of a merge request's commits are already on another branch. */
  getMergeRequestPromotion: {
    input: itemInputSchema
      .extend({ target: z.string().min(1).max(255) })
      .strict(),
    output: z
      .object({
        target: z.string(),
        /** False when the branch does not exist in this project. */
        targetExists: z.boolean(),
        checkedAt: z.string(),
        /** False when the merge request had more commits than were read. */
        complete: z.boolean(),
        commits: z.array(
          z
            .object({
              sha: z.string(),
              title: z.string(),
              status: z.enum(["promoted", "missing", "unknown"]),
              basis: z.enum(["sha", "cherry-pick", "patch"]).nullable(),
              targetSha: z.string().nullable(),
              note: z.string(),
              /** The commit message after the title line; often the only TL;DR there is. */
              body: z.string(),
              author: z.string(),
              createdAt: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  /** Start an agent thread that reviews and explains specific commits of a merge request. */
  startCommitReview: {
    input: itemInputSchema
      .extend({ shas: z.array(z.string().regex(/^[0-9a-f]{7,40}$/i)).min(1).max(100) })
      .strict(),
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  /** Start an agent thread that cherry-picks commits onto a branch via a new MR. */
  startCherryPick: {
    input: itemInputSchema
      .extend({
        target: z.string().min(1).max(255),
        shas: z.array(z.string().regex(/^[0-9a-f]{7,40}$/i)).min(1).max(100),
      })
      .strict(),
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  mergeMergeRequest: {
    input: itemInputSchema
      .extend({
        /** The commit the person reviewed; GitLab refuses if the branch has moved. */
        sha: z.string().min(7).max(64),
        squash: z.boolean().default(false),
        removeSourceBranch: z.boolean().default(false),
        whenPipelineSucceeds: z.boolean().default(false),
      })
      .strict(),
    output: z
      .object({
        ok: z.literal(true),
        state: z.string(),
        /** Queued behind the pipeline instead of merged right now. */
        scheduled: z.boolean(),
      })
      .strict(),
  },
  replyToDiscussion: {
    input: itemInputSchema
      .extend({ discussionId: z.string().min(1), body: nonBlankStringSchema })
      .strict(),
    output: okResultSchema,
  },
  setDiscussionResolved: {
    input: itemInputSchema
      .extend({ discussionId: z.string().min(1), resolved: z.boolean() })
      .strict(),
    output: okResultSchema,
  },
  commentIssue: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  commentMergeRequest: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  createIssue: {
    input: z
      .object({
        project: projectRefSchema,
        title: nonBlankStringSchema,
        body: z.string().optional(),
      })
      .strict(),
    output: z.object({ iid: iidSchema.nullable(), url: z.string() }).strict(),
  },
  startWork: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  startReview: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  mergeRequestForThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ mergeRequest: itemInputSchema.nullable() }).strict(),
  },
  listLinks: {
    input: z.null(),
    output: z
      .object({ links: z.record(z.string(), z.array(threadLinkSchema)) })
      .strict(),
  },
});

// ---------------------------------------------------------------------------
// GitLab REST payloads. These come off the network, so every field is parsed
// with a fallback: one odd row must never take down a list or a detail view.
// ---------------------------------------------------------------------------
const gitlabUserRowSchema = z.looseObject({
  id: z.number().int().catch(0),
  username: z.string().catch(""),
});
const gitlabItemRowSchema = z.looseObject({
  iid: z.number().int().positive(),
  title: z.string().catch(""),
  state: z.string().catch("opened"),
  draft: z.boolean().catch(false),
  work_in_progress: z.boolean().catch(false),
  author: gitlabUserRowSchema.nullish().catch(null),
  labels: z.array(z.string()).catch([]),
  assignees: z.array(gitlabUserRowSchema).catch([]),
  reviewers: z.array(gitlabUserRowSchema).catch([]),
  web_url: z.string().catch(""),
  description: z.string().catch(""),
  updated_at: z.string().catch(""),
});
const gitlabItemListSchema = z
  .array(gitlabItemRowSchema.nullable().catch(null))
  .catch([]);
const gitlabMergeRequestRowSchema = gitlabItemRowSchema.extend({
  created_at: z.string().catch(""),
  sha: z.string().catch(""),
  squash: z.boolean().catch(false),
  force_remove_source_branch: z.boolean().nullish().catch(null),
  merge_when_pipeline_succeeds: z.boolean().catch(false),
  source_branch: z.string().catch(""),
  target_branch: z.string().catch(""),
  changes_count: z.union([z.string(), z.number()]).catch(""),
  has_conflicts: z.boolean().catch(false),
  detailed_merge_status: z.string().catch(""),
  merge_status: z.string().catch(""),
  reviewers: z.array(gitlabUserRowSchema).catch([]),
  head_pipeline: z
    .looseObject({
      id: z.number().int().nullable().catch(null),
      status: z.string().catch(""),
      web_url: z.string().catch(""),
    })
    .nullish()
    .catch(null),
});
const gitlabNoteRowSchema = z.looseObject({
  body: z.string().catch(""),
  system: z.boolean().catch(false),
  created_at: z.string().catch(""),
  resolvable: z.boolean().catch(false),
  resolved: z.boolean().catch(false),
  author: gitlabUserRowSchema.nullish().catch(null),
  position: z
    .looseObject({
      new_path: z.string().nullable().catch(null),
      old_path: z.string().nullable().catch(null),
      new_line: z.number().int().nullable().catch(null),
      old_line: z.number().int().nullable().catch(null),
    })
    .nullish()
    .catch(null),
});
const gitlabNoteListSchema = z.array(gitlabNoteRowSchema).catch([]);
const gitlabDiscussionListSchema = z
  .array(
    z.looseObject({
      id: z.string().catch(""),
      individual_note: z.boolean().catch(false),
      notes: gitlabNoteListSchema,
    }),
  )
  .catch([]);
const gitlabAwardListSchema = z
  .array(
    z.looseObject({
      name: z.string().catch(""),
      user: gitlabUserRowSchema.nullish().catch(null),
    }),
  )
  .catch([]);
const gitlabDiffListSchema = z
  .array(
    z.looseObject({
      old_path: z.string().catch(""),
      new_path: z.string().catch(""),
      new_file: z.boolean().catch(false),
      deleted_file: z.boolean().catch(false),
      renamed_file: z.boolean().catch(false),
      diff: z.string().catch(""),
    }),
  )
  .catch([]);
const gitlabJobListSchema = z
  .array(
    z.looseObject({
      id: z.number().int().nonnegative().catch(0),
      name: z.string().catch("job"),
      status: z.string().catch(""),
      web_url: z.string().catch(""),
    }),
  )
  .catch([]);
const gitlabPipelineRowSchema = z.looseObject({
  id: z.number().int().positive(),
  status: z.string().catch(""),
  ref: z.string().catch(""),
  sha: z.string().catch(""),
  source: z.string().catch(""),
  web_url: z.string().catch(""),
  created_at: z.string().catch(""),
  updated_at: z.string().catch(""),
});
const gitlabPipelineDetailSchema = gitlabPipelineRowSchema.extend({
  duration: z.number().nullish().catch(null),
  yaml_errors: z.string().nullish().catch(null),
  user: gitlabUserRowSchema.nullish().catch(null),
});
const gitlabPipelineJobRowSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string().catch("job"),
  stage: z.string().catch(""),
  status: z.string().catch(""),
  allow_failure: z.boolean().catch(false),
  web_url: z.string().catch(""),
  duration: z.number().nullish().catch(null),
  pipeline: z
    .looseObject({ id: z.number().int().positive() })
    .nullish()
    .catch(null),
});
const gitlabPipelineJobListSchema = z
  .array(gitlabPipelineJobRowSchema.nullable().catch(null))
  .catch([]);
type PipelineRowShape = z.infer<typeof gitlabPipelineRowSchema>;
type PipelineJobRowShape = z.infer<typeof gitlabPipelineJobRowSchema>;

export function toPipelineSummary(row: PipelineRowShape) {
  return {
    id: row.id,
    status: row.status,
    ref: row.ref,
    sha: row.sha,
    source: row.source,
    url: row.web_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPipelineJob(row: PipelineJobRowShape) {
  return {
    id: row.id,
    name: row.name,
    stage: row.stage,
    status: row.status,
    allowFailure: row.allow_failure,
    url: row.web_url,
    durationSeconds: row.duration ?? null,
  };
}

const gitlabBranchListSchema = z
  .array(
    z
      .looseObject({
        name: z.string().catch(""),
        default: z.boolean().catch(false),
        protected: z.boolean().catch(false),
        merged: z.boolean().catch(false),
        web_url: z.string().catch(""),
        commit: z
          .looseObject({
            id: z.string().catch(""),
            title: z.string().catch(""),
            author_name: z.string().catch(""),
            committed_date: z.string().catch(""),
            web_url: z.string().catch(""),
          })
          .nullish()
          .catch(null),
      })
      .nullable()
      .catch(null),
  )
  .catch([]);

type BranchRowShape = NonNullable<
  z.infer<typeof gitlabBranchListSchema>[number]
>;

/**
 * Joins GitLab's branch list with the open merge requests and recent
 * pipelines that mention each branch. Pure, so the join is testable; the
 * three lists come from three requests.
 */
export function buildBranchRows(
  branches: ReadonlyArray<BranchRowShape | null>,
  openMergeRequests: ReadonlyArray<{
    source_branch: string;
    iid: number;
    title: string;
    draft: boolean;
    work_in_progress: boolean;
  }>,
  pipelines: ReadonlyArray<{ id: number; ref: string; status: string }>,
) {
  const mrBySource = new Map<string, (typeof openMergeRequests)[number]>();
  for (const mr of openMergeRequests) {
    // The newest MR wins when a branch has several.
    if (!mrBySource.has(mr.source_branch)) mrBySource.set(mr.source_branch, mr);
  }
  // Pipelines arrive newest first, so the first one seen per ref is its latest.
  const pipelineByRef = new Map<string, (typeof pipelines)[number]>();
  for (const pipeline of pipelines) {
    if (!pipelineByRef.has(pipeline.ref)) pipelineByRef.set(pipeline.ref, pipeline);
  }
  return branches
    .filter((row): row is BranchRowShape => row !== null && row.name.length > 0)
    .map((row) => {
      const mr = mrBySource.get(row.name);
      const pipeline = pipelineByRef.get(row.name);
      return {
        name: row.name,
        isDefault: row.default,
        protected: row.protected,
        merged: row.merged,
        url: row.web_url,
        commit:
          row.commit == null
            ? null
            : {
                sha: row.commit.id,
                title: row.commit.title,
                author: row.commit.author_name,
                date: row.commit.committed_date,
                url: row.commit.web_url,
              },
        mergeRequest:
          mr === undefined
            ? null
            : {
                iid: mr.iid,
                title: mr.title,
                draft: mr.draft || mr.work_in_progress,
              },
        pipeline:
          pipeline === undefined
            ? null
            : { id: pipeline.id, status: pipeline.status },
      };
    });
}

const gitlabApprovalsSchema = z
  .looseObject({
    approvals_required: z.number().int().nonnegative().catch(0),
    approvals_left: z.number().int().nonnegative().catch(0),
    approved_by: z
      .array(z.looseObject({ user: gitlabUserRowSchema.nullish().catch(null) }))
      .catch([]),
  })
  .catch({ approvals_required: 0, approvals_left: 0, approved_by: [] });
const gitlabMemberListSchema = z.array(gitlabUserRowSchema).catch([]);
const gitlabLabelListSchema = z
  .array(
    z.looseObject({
      name: z.string().catch(""),
      color: z.string().catch(""),
    }),
  )
  .catch([]);

type GitlabUserRow = z.infer<typeof gitlabUserRowSchema>;
type GitlabItemRow = z.infer<typeof gitlabItemRowSchema>;

interface ProjectInfo {
  /** "host/group/sub/project" */
  project: string;
  host: string;
  path: string;
  /** The BB project whose remote points at it, when there is one. */
  bbProjectId: string | null;
}

interface CachedItem {
  project: string;
  iid: number;
  kind: "issue" | "mr";
  title: string;
  state: string;
  draft: boolean;
  author: string;
  labels: string[];
  assignees: string[];
  reviewers: string[];
  url: string;
  body: string;
  updatedAt: string;
}

interface Note {
  author: string;
  body: string;
  createdAt: string;
}

interface ThreadLink {
  kind: "issue" | "mr";
  project: string;
  iid: number;
  threadId: string;
  createdAt: string;
}

/** Runs `glab api` against the host a project ref names, returning raw JSON. */
type GitlabApi = (
  project: string,
  endpoint: string,
  options?: { method?: "POST" | "PUT"; fields?: Record<string, string> },
) => Promise<unknown>;

function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), {
    name: "NeedsConfigurationError",
  });
}

/**
 * One GitLab instance as glab knows it. `host` is the name `glab --hostname`
 * takes and `glab auth status` prints; the rest is that host's glab config,
 * which is where non-default hosting is described:
 *
 * - `subfolder` — GitLab served under a path, https://example.com/gitlab/
 * - `sshHost`   — git over SSH answers on another name than the API
 * - `apiHost`   — the API answers on another name, possibly with a port
 *
 * glab applies all of it; this plugin only has to recognize the remotes those
 * setups produce and map them back to `host`.
 */
export interface GitlabHost {
  host: string;
  subfolder: string;
  sshHost: string | null;
  apiHost: string | null;
}

/**
 * A comparable hostname: lowercased, punycoded, port and brackets removed.
 * Null for anything that cannot be a `--hostname` (an IPv6 literal, which
 * glab rejects outright, or a value the URL parser refuses).
 */
export function normalizeHostname(value: string): string | null {
  const bare = value.trim().replace(/\/+$/, "");
  if (bare.length === 0 || bare.startsWith("[")) return null;
  try {
    const { hostname } = new URL(`https://${bare}`);
    // IDN arrives as punycode here, which is what DNS and glab both want.
    return hostname.startsWith("[") || hostname.length === 0 ? null : hostname;
  } catch {
    return null;
  }
}

/**
 * "host/path" from any git remote URL that belongs to one of the instances
 * glab is authenticated with, else null. Handles https, scp-style
 * `git@host:group/app.git`, and `ssh://git@host:2222/group/app.git`, and
 * resolves the three ways a remote's host can differ from the glab host name:
 * an `ssh_host`, an `api_host` (with or without a port), and a `subfolder`
 * that is part of the URL but not part of the project path.
 */
export function parseGitlabRemote(
  url: string,
  knownHosts: readonly GitlabHost[],
): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  const withScheme = trimmed.match(
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+)$/i,
  );
  const scpStyle = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  const match = withScheme ?? scpStyle;
  if (match === null) return null;
  const remoteHost = normalizeHostname(match[1]);
  if (remoteHost === null) return null;
  const known = knownHosts.find((candidate) =>
    [candidate.host, candidate.sshHost, candidate.apiHost].some(
      (name) => name != null && normalizeHostname(name) === remoteHost,
    ),
  );
  if (known === undefined) return null;
  const remotePath = match[2].replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  // A subfolder is part of the URL but not part of the project path.
  const prefix = known.subfolder.replace(/^\/+|\/+$/g, "");
  const path =
    prefix.length > 0 && remotePath.startsWith(`${prefix}/`)
      ? remotePath.slice(prefix.length + 1)
      : remotePath;
  if (!path.includes("/")) return null;
  const ref = `${normalizeHostname(known.host) ?? known.host}/${path}`;
  return PROJECT_REF_PATTERN.test(ref) ? ref : null;
}

/**
 * A user-written project entry ("HTTPS://Example.COM:8443/gitlab/group/app",
 * "group/app") as a project ref, or null when it cannot be one. Bare paths
 * take `fallbackHost`.
 */
export function normalizeProjectRef(
  entry: string,
  knownHosts: readonly GitlabHost[],
  fallbackHost: string,
): string | null {
  const trimmed = entry.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  const asRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const viaKnownHost = parseGitlabRemote(asRemote, knownHosts);
  if (viaKnownHost !== null) return viaKnownHost;
  // An entry for an instance glab does not know yet: keep it addressable, so
  // logging in later starts tracking it instead of silently dropping it.
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const segments = withoutScheme.split("/").filter((part) => part.length > 0);
  const [first, ...rest] = segments;
  if (first === undefined) return null;
  const host = normalizeHostname(first);
  const looksHostQualified = host !== null && rest.length >= 2;
  const ref = looksHostQualified
    ? `${host}/${rest.join("/")}`
    : `${normalizeHostname(fallbackHost) ?? ""}/${segments.join("/")}`;
  return PROJECT_REF_PATTERN.test(ref) ? ref : null;
}

/** Splits a project ref into its host and its namespace path. */
export function parseProjectRef(ref: string): { host: string; path: string } {
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) {
    throw new Error(`malformed GitLab project ref "${ref}"`);
  }
  return { host: ref.slice(0, separator), path: ref.slice(separator + 1) };
}

export function isProjectRef(value: unknown): value is string {
  return typeof value === "string" && PROJECT_REF_PATTERN.test(value);
}

/**
 * Hosts `glab auth status` reports as logged in (stdout+stderr combined).
 * Whatever name glab prints is the name `--hostname` expects back, so it is
 * only case/IDN-normalized here, never rewritten.
 */
export function parseAuthenticatedHosts(output: string): string[] {
  const hosts = new Set<string>();
  for (const line of output.split("\n")) {
    const match = line.match(/Logged in to (\S+) as /);
    if (match === null) continue;
    const host = normalizeHostname(match[1]);
    if (host !== null) hosts.add(host);
  }
  return [...hosts];
}

/**
 * +/- line counts of a unified diff. GitLab ships the diff text per file but
 * no per-file counts, so the panel's numbers come from here.
 */
export function countDiffLines(diff: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// `bb gitlab-ui` argument parsing. Pure, so the shape of every subcommand is
// testable without glab; resolving a target against the authenticated hosts
// happens at run time (parseGitlabTarget).
// ---------------------------------------------------------------------------

export interface GitlabListFilters {
  /** "closed" and "merged" are exact GitLab states; "all" keeps everything. */
  state: "open" | "closed" | "merged" | "all";
  /** Assigned to the glab user of each item's host. */
  mine: boolean;
  /** Username, or "@me". */
  author: string | null;
  /** Username, or "@me". */
  assignee: string | null;
  /** Merge requests only. Username, or "@me". */
  reviewer: string | null;
  /** Every label must be present. */
  labels: string[];
  draft: boolean;
  limit: number | null;
  json: boolean;
}

export interface GitlabPipelineSelector {
  /** Raw target as typed; null means the BB project the CLI runs in. */
  target: string | null;
  ref: string | null;
  pipelineId: number | null;
}

export type GitlabCliCommand =
  | { sub: "help" }
  | { sub: "projects"; json: boolean }
  | { sub: "sync" }
  | {
      sub: "issues" | "mrs";
      project: string | null;
      filters: GitlabListFilters;
    }
  | { sub: "show"; target: string; json: boolean }
  | { sub: "comment"; target: string; body: string }
  | ({ sub: "pipeline"; logs: number; json: boolean } & GitlabPipelineSelector)
  | ({ sub: "retry"; job: string | null } & GitlabPipelineSelector)
  | { sub: "run"; target: string | null; ref: string | null };

/** Lines of each failed job's log `bb gitlab-ui pipeline` prints by default. */
export const DEFAULT_JOB_LOG_LINES = 30;

interface FlagSpec {
  booleans: readonly string[];
  values: readonly string[];
  /** Value flags that may be given more than once. */
  repeatable?: readonly string[];
}

/**
 * `--flag`, `--flag value`, and `--flag=value`. Anything not starting with
 * `--` is positional; a bare `--` ends flag parsing.
 */
function parseFlags(
  args: readonly string[],
  spec: FlagSpec,
):
  | {
      positionals: string[];
      booleans: Set<string>;
      values: Map<string, string[]>;
    }
  | { error: string } {
  const positionals: string[] = [];
  const booleans = new Set<string>();
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
    if (spec.booleans.includes(name)) {
      if (equals >= 0) return { error: `Flag --${name} takes no value.` };
      booleans.add(name);
      continue;
    }
    if (!spec.values.includes(name)) {
      return { error: `Unknown flag "--${name}".` };
    }
    let value: string | undefined;
    if (equals >= 0) {
      value = arg.slice(equals + 1);
    } else {
      value = args[index + 1];
      index += 1;
    }
    if (value === undefined || value.trim().length === 0) {
      return { error: `Flag --${name} needs a value.` };
    }
    const seen = values.get(name) ?? [];
    if (seen.length > 0 && !(spec.repeatable ?? []).includes(name)) {
      return { error: `Flag --${name} given twice.` };
    }
    values.set(name, [...seen, value]);
  }
  return { positionals, booleans, values };
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseNonNegativeInt(value: string): number | null {
  return value === "0" ? 0 : parsePositiveInt(value);
}

export function parseGitlabCliArgs(
  argv: readonly string[],
): GitlabCliCommand | { error: string } {
  const [sub, ...args] = argv;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return args.length === 0
      ? { sub: "help" }
      : { error: `Unexpected argument "${args[0]}".` };
  }

  if (sub === "comment") {
    // The body is everything after the target, unparsed: agents rarely quote,
    // and comment text may well contain "--".
    const [target, ...words] = args;
    const body = words.join(" ").trim();
    if (target === undefined || body.length === 0) {
      return { error: "Usage: bb gitlab-ui comment <issue-or-mr> <text…>" };
    }
    return { sub: "comment", target, body };
  }

  const specs: Record<string, FlagSpec> = {
    projects: { booleans: ["json"], values: [] },
    sync: { booleans: [], values: [] },
    issues: {
      booleans: ["mine", "json"],
      values: ["state", "author", "assignee", "label", "limit"],
      repeatable: ["label"],
    },
    mrs: {
      booleans: ["mine", "draft", "json"],
      values: ["state", "author", "assignee", "reviewer", "label", "limit"],
      repeatable: ["label"],
    },
    show: { booleans: ["json"], values: [] },
    pipeline: { booleans: ["json"], values: ["ref", "pipeline", "logs"] },
    retry: { booleans: [], values: ["ref", "pipeline", "job"] },
    run: { booleans: [], values: ["ref"] },
  };
  const spec = specs[sub];
  if (spec === undefined) return { error: `Unknown subcommand "${sub}".` };
  const parsed = parseFlags(args, spec);
  if ("error" in parsed) return parsed;
  const { positionals, booleans, values } = parsed;
  const value = (name: string): string | null => values.get(name)?.[0] ?? null;
  const maxPositionals = sub === "projects" || sub === "sync" ? 0 : 1;
  if (positionals.length > maxPositionals) {
    return maxPositionals === 0
      ? { error: `Subcommand "${sub}" does not accept arguments.` }
      : { error: `Unexpected argument "${positionals[1]}".` };
  }
  const target = positionals[0] ?? null;

  switch (sub) {
    case "projects":
      return { sub, json: booleans.has("json") };
    case "sync":
      return { sub };
    case "issues":
    case "mrs": {
      if (target !== null && !isProjectRef(target)) {
        return {
          error: `Invalid project "${target}"; expected host/group/project.`,
        };
      }
      const state = value("state") ?? "open";
      if (
        state !== "open" &&
        state !== "closed" &&
        state !== "merged" &&
        state !== "all"
      ) {
        return {
          error: `Invalid --state "${state}"; expected open, closed, merged, or all.`,
        };
      }
      if (sub === "issues" && state === "merged") {
        return { error: "Issues are never merged; use --state closed." };
      }
      const rawLimit = value("limit");
      const limit = rawLimit === null ? null : parsePositiveInt(rawLimit);
      if (rawLimit !== null && limit === null) {
        return { error: `Invalid --limit "${rawLimit}"; expected a positive number.` };
      }
      if (booleans.has("mine") && value("assignee") !== null) {
        return { error: "--mine already means --assignee @me." };
      }
      return {
        sub,
        project: target,
        filters: {
          state,
          mine: booleans.has("mine"),
          author: value("author"),
          assignee: value("assignee"),
          reviewer: value("reviewer"),
          labels: values.get("label") ?? [],
          draft: booleans.has("draft"),
          limit,
          json: booleans.has("json"),
        },
      };
    }
    case "show":
      if (target === null) {
        return { error: "Usage: bb gitlab-ui show <issue-or-mr>" };
      }
      return { sub, target, json: booleans.has("json") };
    case "pipeline":
    case "retry": {
      const rawPipeline = value("pipeline");
      const pipelineId =
        rawPipeline === null ? null : parsePositiveInt(rawPipeline);
      if (rawPipeline !== null && pipelineId === null) {
        return { error: `Invalid --pipeline "${rawPipeline}"; expected a pipeline id.` };
      }
      if (pipelineId !== null && value("ref") !== null) {
        return { error: "Pass --pipeline or --ref, not both." };
      }
      const selector = { target, ref: value("ref"), pipelineId };
      if (sub === "retry") return { sub, ...selector, job: value("job") };
      const rawLogs = value("logs");
      const logs =
        rawLogs === null ? DEFAULT_JOB_LOG_LINES : parseNonNegativeInt(rawLogs);
      if (logs === null) {
        return { error: `Invalid --logs "${rawLogs}"; expected a number of lines.` };
      }
      return { sub, ...selector, logs, json: booleans.has("json") };
    }
    case "run":
      return { sub, target, ref: value("ref") };
  }
  return { error: `Unknown subcommand "${sub}".` };
}

export function validateGitlabCliArgs(argv: string[]): string | null {
  const parsed = parseGitlabCliArgs(argv);
  return "error" in parsed ? parsed.error : null;
}

/** What a `bb gitlab-ui` target names, once resolved against glab's hosts. */
export type GitlabTarget =
  | { kind: "project"; project: string }
  | { kind: "issue" | "mr"; project: string; iid: number }
  | { kind: "pipeline" | "job"; project: string; id: number };

const WEB_URL_RESOURCES: Record<string, "issue" | "mr" | "pipeline" | "job"> = {
  issues: "issue",
  work_items: "issue",
  merge_requests: "mr",
  pipelines: "pipeline",
  jobs: "job",
};

/**
 * A target as a user or agent writes it:
 *
 * - `host/group/app#7` (issue) or `host/group/app!12` (merge request)
 * - a web URL copied from the browser — `…/group/app/-/merge_requests/12`,
 *   `/-/issues/7`, `/-/pipelines/900`, `/-/jobs/31` — which also sidesteps
 *   zsh history expansion of `!`
 * - a bare project ref, `host/group/app`
 *
 * URLs go through the hosts' glab config, so subfolder and port installs map
 * back to the ref glab knows. Null when the value is none of these.
 */
export function parseGitlabTarget(
  raw: string,
  knownHosts: readonly GitlabHost[],
  fallbackHost: string,
): GitlabTarget | null {
  const value = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const withoutQuery = value.replace(/[?#].*$/, "").replace(/\/+$/, "");
    // GitLab puts every project page after "/-/"; one this parser has no kind
    // for (tree, blob, commits…) still names its project.
    const dash = withoutQuery.indexOf("/-/");
    const project = normalizeProjectRef(
      dash < 0 ? withoutQuery : withoutQuery.slice(0, dash),
      knownHosts,
      fallbackHost,
    );
    if (project === null) return null;
    const match =
      dash < 0 ? null : withoutQuery.slice(dash).match(/^\/-\/([a-z_]+)\/(\d+)(?:\/|$)/);
    const kind = match === null ? undefined : WEB_URL_RESOURCES[match[1]];
    const number = match === null ? null : parsePositiveInt(match[2]);
    if (kind === undefined || number === null) return { kind: "project", project };
    return kind === "issue" || kind === "mr"
      ? { kind, project, iid: number }
      : { kind, project, id: number };
  }
  const separator = Math.max(value.lastIndexOf("#"), value.lastIndexOf("!"));
  if (separator > 0) {
    const project = value.slice(0, separator);
    const iid = parsePositiveInt(value.slice(separator + 1));
    if (!isProjectRef(project) || iid === null) return null;
    return { kind: value[separator] === "!" ? "mr" : "issue", project, iid };
  }
  return isProjectRef(value) ? { kind: "project", project: value } : null;
}

/** Never why a job failed: GitLab ignores after_script errors for job status. */
const RUNNER_HOUSEKEEPING_SECTIONS = [
  "after_script",
  "upload_artifacts_on_success",
  "upload_artifacts_on_failure",
  "archive_cache",
  "archive_cache_on_failure",
  "cleanup_file_variables",
];

/**
 * The last `lines` lines of a raw GitLab job trace, readable in a terminal:
 * ANSI colors, collapsible-section markers, and carriage-return progress
 * redraws removed.
 */
export function tailJobLog(trace: string, lines: number): string {
  if (lines <= 0) return "";
  const cleaned = trace
    // Runner housekeeping after the script (artifact upload, cache archive,
    // cleanup) would otherwise fill the tail and push the real error out.
    .replace(
      new RegExp(
        `section_start:\\d+:(${RUNNER_HOUSEKEEPING_SECTIONS.join("|")})\\b[\\s\\S]*?section_end:\\d+:\\1\\r?(?:\x1b\\[0K)?`,
        "g",
      ),
      "",
    )
    // A section end sits on a line of its own; drop the line, not just the marker.
    .replace(/^(?:\x1b\[0K)?section_end:\d+:[A-Za-z0-9_.-]+\r?(?:\x1b\[0K)?\r?\n/gm, "")
    .replace(/section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]]*\])?/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    // A progress bar redraws with \r; only the last redraw is visible.
    .map((line) => line.replace(/\r+$/, "").split("\r").at(-1) ?? "")
    .map((line) => line.trimEnd());
  while (cleaned.length > 0 && cleaned.at(-1) === "") cleaned.pop();
  return cleaned.slice(-lines).join("\n");
}

function usernames(rows: readonly GitlabUserRow[]): string[] {
  return rows.map((row) => row.username).filter((name) => name.length > 0);
}

function toItem(
  row: GitlabItemRow,
  project: string,
  kind: "issue" | "mr",
): CachedItem {
  return {
    project,
    iid: row.iid,
    kind,
    title: row.title,
    state: row.state,
    draft: row.draft || row.work_in_progress,
    author: row.author?.username ?? "",
    labels: row.labels,
    assignees: usernames(row.assignees),
    reviewers: kind === "mr" ? usernames(row.reviewers) : [],
    url: row.web_url,
    body: row.description,
    updatedAt: row.updated_at,
  };
}

/** Parses a GitLab issue/MR list payload, dropping rows it cannot read. */
export function toItems(
  raw: unknown,
  project: string,
  kind: "issue" | "mr",
): CachedItem[] {
  const rows = gitlabItemListSchema.parse(raw);
  const items: CachedItem[] = [];
  for (const row of rows) {
    if (row !== null) items.push(toItem(row, project, kind));
  }
  return items;
}

/**
 * Open items plus a page of recently-closed (and merged) ones, so the Closed
 * filter has something to show without a live glab call per view. A project
 * with issues disabled still contributes its merge requests.
 */
export async function fetchProjectItems(
  api: GitlabApi,
  project: string,
): Promise<CachedItem[]> {
  const { path } = parseProjectRef(project);
  const base = `projects/${encodeURIComponent(path)}`;
  const order = "order_by=updated_at&sort=desc";
  const tolerant = async (endpoint: string): Promise<unknown> => {
    try {
      return await api(project, endpoint);
    } catch (error) {
      // Issues (or merge requests) disabled for the project — the 403/404
      // here must not abort the rest of the sync.
      if (/40[34]/.test(String(error))) return [];
      throw error;
    }
  };
  const [openIssues, closedIssues, openMrs, closedMrs, mergedMrs] =
    await Promise.all([
      tolerant(`${base}/issues?state=opened&per_page=${ISSUE_PAGE}&${order}`),
      tolerant(
        `${base}/issues?state=closed&per_page=${CLOSED_ISSUE_PAGE}&${order}`,
      ),
      tolerant(
        `${base}/merge_requests?state=opened&per_page=${MR_PAGE}&${order}`,
      ),
      tolerant(
        `${base}/merge_requests?state=closed&per_page=${CLOSED_MR_PAGE}&${order}`,
      ),
      tolerant(
        `${base}/merge_requests?state=merged&per_page=${CLOSED_MR_PAGE}&${order}`,
      ),
    ]);
  return [
    ...toItems(openIssues, project, "issue"),
    ...toItems(closedIssues, project, "issue"),
    ...toItems(openMrs, project, "mr"),
    ...toItems(closedMrs, project, "mr"),
    ...toItems(mergedMrs, project, "mr"),
  ];
}

/**
 * glab runs a git lookup and posts usage telemetry each time it exits, which
 * made every `glab api` call take 2.3s instead of 0.65s (measured against a
 * self-managed instance). A panel makes a handful of calls per page, so this
 * is the difference between a page loading in 5s and in 1.5s. The switches are
 * set on the processes this plugin starts only; the user's own glab settings
 * and shell are untouched.
 */
export const GLAB_QUIET_ENV = {
  GLAB_SEND_TELEMETRY: "false",
  GLAB_CHECK_UPDATE: "false",
} as const;

function run(
  file: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
  }>();
  execFile(
    file,
    args,
    {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...GLAB_QUIET_ENV },
    },
    (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `${file} ${args.slice(0, 3).join(" ")} failed: ${
              stderr.trim() || error.message
            }`,
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    },
  );
  return promise;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    extraProjects: {
      type: "string",
      label: "Extra projects",
      description:
        'Comma-separated "host/group/project" list to track in addition to the ' +
        "projects discovered from BB projects. A bare path uses the default host.",
      default: "",
    },
    defaultHost: {
      type: "string",
      label: "Default GitLab host",
      description:
        "Host used for extra projects written without one, e.g. gitlab.com.",
      default: "gitlab.com",
    },
    promotionBranch: {
      type: "string",
      label: "Cherry-pick tracking branch",
      description:
        "Branch whose cherry-picks are tracked on merge requests, e.g. stage-1. Empty turns the check off. Each person can still pick another branch on the Commits tab.",
      default: "",
    },
    assigneesReview: {
      type: "boolean",
      label: "Assignees count as reviewers",
      description:
        'For teams that request reviews through the assignee field: "Review requests" then includes merge requests where you are assignee.',
      default: false,
    },
    reactionApprovals: {
      type: "boolean",
      label: "Count 👍 as approval",
      description: "Treat a thumbs-up reaction from someone other than the author as an approval in the review summary.",
      default: false,
    },
    allowMerge: {
      type: "boolean",
      label: "Allow merging from the panel",
      description: "Show the Merge button on merge request pages. GitLab still enforces its own merge rules.",
      default: true,
    },
    defaultProject: {
      type: "project",
      label: "Default BB project",
      description:
        "Where agent threads spawn for GitLab projects that are not attached to a BB project.",
    },
  });

  // ------------------------------------------------------------------
  // glab CLI plumbing. The server process may have a trimmed PATH, so probe
  // common install locations once and remember the winner.
  // ------------------------------------------------------------------
  let glabPath: string | null = null;
  let glabAuthError: string | null = "checking glab…";
  let authenticatedHosts: GitlabHost[] = [];

  async function resolveGlab(): Promise<string> {
    if (glabPath !== null) return glabPath;
    const candidates = [
      "glab",
      "/opt/homebrew/bin/glab",
      "/usr/local/bin/glab",
    ];
    for (const candidate of candidates) {
      try {
        await run(candidate, ["--version"], 5_000);
        glabPath = candidate;
        return candidate;
      } catch {
        // try the next location
      }
    }
    throw needsConfiguration(`GitLab CLI not found. ${GLAB_HINT}`);
  }

  async function glab(args: string[], timeoutMs?: number): Promise<string> {
    const file = await resolveGlab();
    const { stdout } = await run(file, args, timeoutMs);
    return stdout;
  }

  /**
   * Text parameters ride in the JSON body (--raw-field), which keeps commas
   * and quotes intact; array parameters such as `assignee_ids[]` belong in the
   * endpoint's query string, which GitLab also reads for PUT.
   */
  // Identical reads that arrive together (a page opening, React running an
  // effect twice, two panels asking for the same list) share one glab call,
  // and a read repeated within a few seconds reuses the answer. Any write
  // clears it, so a page that reloads after an action sees the new state.
  const READ_REUSE_MS = 4_000;
  const recentReads = new Map<string, { at: number; result: Promise<unknown> }>();

  const gitlabApi: GitlabApi = async (project, endpoint, options) => {
    const { host } = parseProjectRef(project);
    const isRead = options?.method === undefined;
    const cacheKey = `${host}|${endpoint}`;
    if (isRead) {
      const recent = recentReads.get(cacheKey);
      if (recent !== undefined && Date.now() - recent.at < READ_REUSE_MS) {
        return recent.result;
      }
    } else {
      recentReads.clear();
    }
    const args = ["api", "--hostname", host];
    if (options?.method !== undefined) args.push("--method", options.method);
    for (const [key, value] of Object.entries(options?.fields ?? {})) {
      args.push("--raw-field", `${key}=${value}`);
    }
    args.push(endpoint);
    const result = glab(args, 30_000).then((text) => JSON.parse(text) as unknown);
    if (isRead) {
      recentReads.set(cacheKey, { at: Date.now(), result });
      // A failed read must not be served again.
      result.catch(() => recentReads.delete(cacheKey));
      if (recentReads.size > 200) recentReads.clear();
    }
    return result;
  };

  /**
   * How this instance is reached, straight from its glab config. Unset keys
   * print nothing, and an unreadable key degrades to "not configured" rather
   * than failing the whole auth check.
   */
  async function readHostConfig(host: string): Promise<GitlabHost> {
    const read = async (key: string): Promise<string> => {
      try {
        return (await glab(["config", "get", key, "--host", host], 10_000)).trim();
      } catch {
        return "";
      }
    };
    const [subfolder, sshHost, apiHost] = await Promise.all([
      read("subfolder"),
      read("ssh_host"),
      read("api_host"),
    ]);
    return {
      host,
      subfolder,
      sshHost: sshHost.length > 0 ? sshHost : null,
      apiHost: apiHost.length > 0 ? apiHost : null,
    };
  }

  async function checkAuth(): Promise<void> {
    const file = await resolveGlab();
    // `glab auth status` writes its report to stderr and exits non-zero when
    // any configured host fails, so read the text rather than the exit code.
    const { promise, resolve } = Promise.withResolvers<string>();
    execFile(
      file,
      ["auth", "status"],
      {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, ...GLAB_QUIET_ENV },
      },
      (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`),
    );
    const hosts = parseAuthenticatedHosts(await promise);
    if (hosts.length === 0) {
      glabAuthError = `GitLab CLI is not authenticated with any host. ${GLAB_HINT}`;
      throw needsConfiguration(glabAuthError);
    }
    authenticatedHosts = await Promise.all(hosts.map(readHostConfig));
    glabAuthError = null;
  }

  // ------------------------------------------------------------------
  // Project discovery: BB project git remotes → host/path. The remote comes
  // from BB's own project record, so a checkout living on an enrolled remote
  // host resolves exactly like a local one.
  // ------------------------------------------------------------------
  let projectCache: { projects: ProjectInfo[]; fetchedAt: number } | null = null;

  async function discoverProjects(force = false): Promise<ProjectInfo[]> {
    if (
      !force &&
      projectCache !== null &&
      Date.now() - projectCache.fetchedAt < 60_000
    ) {
      return projectCache.projects;
    }
    const byRef = new Map<string, ProjectInfo>();
    const addRef = (ref: string, bbProjectId: string | null): void => {
      if (byRef.has(ref)) return;
      const { host, path } = parseProjectRef(ref);
      byRef.set(ref, { project: ref, host, path, bbProjectId });
    };
    try {
      for (const bbProject of await bb.sdk.projects.list()) {
        if (bbProject.gitRemoteUrl === null) continue;
        const ref = parseGitlabRemote(bbProject.gitRemoteUrl, authenticatedHosts);
        if (ref !== null) {
          addRef(ref, bbProject.id);
          continue;
        }
        // Not one of glab's hosts. Say so once per sync: on a self-managed
        // instance the fix is `glab auth login --hostname <host>`, and silence
        // here reads as the plugin ignoring the project.
        const remoteHost = bbProject.gitRemoteUrl.match(
          /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)/i,
        );
        if (remoteHost !== null) {
          bb.log.debug(
            `project ${bbProject.id} remote host ${remoteHost[1]} is not an authenticated glab host`,
          );
        }
      }
    } catch (error) {
      bb.log.warn(
        `project discovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const { extraProjects, defaultHost } = await settings.get();
    for (const raw of extraProjects.split(/[\s,]+/)) {
      if (raw.trim().length === 0) continue;
      const ref = normalizeProjectRef(raw, authenticatedHosts, defaultHost);
      if (ref !== null) addRef(ref, null);
      else bb.log.warn(`ignoring malformed extraProjects entry "${raw}"`);
    }
    const projects = [...byRef.values()];
    projectCache = { projects, fetchedAt: Date.now() };
    return projects;
  }

  // ------------------------------------------------------------------
  // SQLite cache of open issues + merge requests across tracked projects.
  // ------------------------------------------------------------------
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS items (
       project TEXT NOT NULL,
       iid INTEGER NOT NULL,
       kind TEXT NOT NULL,
       title TEXT NOT NULL,
       state TEXT NOT NULL,
       draft INTEGER NOT NULL DEFAULT 0,
       author TEXT NOT NULL,
       labels TEXT NOT NULL,
       assignees TEXT NOT NULL DEFAULT '[]',
       url TEXT NOT NULL,
       body TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (project, kind, iid)
     )`,
    // Merge-request reviewers; rows cached before this fill in on the next sync.
    `ALTER TABLE items ADD COLUMN reviewers TEXT NOT NULL DEFAULT '[]'`,
  ]);

  const cachedStringArraySchema = z.array(z.string()).catch([]);

  function rowToItem(row: Record<string, unknown>): CachedItem {
    return {
      project: String(row.project),
      iid: Number(row.iid),
      kind: row.kind === "mr" ? "mr" : "issue",
      title: String(row.title),
      state: String(row.state),
      draft: Number(row.draft) === 1,
      author: String(row.author),
      // Written by this plugin, but a corrupt row must not fail the list.
      labels: cachedStringArraySchema.parse(JSON.parse(String(row.labels))),
      assignees: cachedStringArraySchema.parse(
        JSON.parse(String(row.assignees)),
      ),
      reviewers: cachedStringArraySchema.parse(
        JSON.parse(String(row.reviewers ?? "[]")),
      ),
      url: String(row.url),
      body: String(row.body),
      updatedAt: String(row.updated_at),
    };
  }

  function listCachedItems(options: {
    kind?: "issue" | "mr";
    project?: string;
    query?: string;
    /** "open" → opened only; "closed" → everything else (closed, merged). */
    state?: "open" | "closed";
  }): CachedItem[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.project !== undefined) {
      clauses.push("project = ?");
      params.push(options.project);
    }
    if (options.state === "open") {
      clauses.push("state = 'opened'");
    } else if (options.state === "closed") {
      clauses.push("state != 'opened'");
    }
    const query = options.query?.trim() ?? "";
    if (query.length > 0) {
      clauses.push(
        "(title LIKE ? OR CAST(iid AS TEXT) LIKE ? OR project LIKE ?)",
      );
      const like = `%${query.replace(/^[#!]/, "")}%`;
      params.push(like, like, like);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM items ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToItem);
  }

  function getCachedItem(
    kind: "issue" | "mr",
    project: string,
    iid: number,
  ): CachedItem | null {
    const row = db
      .prepare("SELECT * FROM items WHERE project = ? AND kind = ? AND iid = ?")
      .get(project, kind, iid) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToItem(row);
  }

  function replaceProjectRows(project: string, items: CachedItem[]): void {
    const insert = db.prepare(
      `INSERT INTO items (project, iid, kind, title, state, draft, author, labels, assignees, reviewers, url, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      db.prepare("DELETE FROM items WHERE project = ?").run(project);
      for (const item of items) {
        insert.run(
          item.project,
          item.iid,
          item.kind,
          item.title,
          item.state,
          item.draft ? 1 : 0,
          item.author,
          JSON.stringify(item.labels),
          JSON.stringify(item.assignees),
          JSON.stringify(item.reviewers),
          item.url,
          item.body,
          item.updatedAt,
        );
      }
    })();
  }

  /** Patch a cached row in place after a mutation so the UI updates without
      waiting for the next full sync. */
  function patchCachedItem(
    kind: "issue" | "mr",
    project: string,
    iid: number,
    patch: {
      state?: string;
      assignees?: string[];
      reviewers?: string[];
      labels?: string[];
    },
  ): void {
    if (patch.state !== undefined) {
      db.prepare(
        "UPDATE items SET state = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(patch.state, project, kind, iid);
    }
    if (patch.assignees !== undefined) {
      db.prepare(
        "UPDATE items SET assignees = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(JSON.stringify(patch.assignees), project, kind, iid);
    }
    if (patch.reviewers !== undefined) {
      db.prepare(
        "UPDATE items SET reviewers = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(JSON.stringify(patch.reviewers), project, kind, iid);
    }
    if (patch.labels !== undefined) {
      db.prepare(
        "UPDATE items SET labels = ? WHERE project = ? AND kind = ? AND iid = ?",
      ).run(JSON.stringify(patch.labels), project, kind, iid);
    }
    bb.realtime.publish("data-changed", {});
  }

  async function syncAll(
    force = false,
  ): Promise<{ projects: number; items: number }> {
    await checkAuth();
    const projects = await discoverProjects(force);
    // Cheap change detection so idle syncs don't wake every panel.
    const fingerprint = db.prepare(
      "SELECT project, kind, iid, state, updated_at FROM items ORDER BY project, kind, iid",
    );
    const before = JSON.stringify(fingerprint.all());
    // A project that stopped being tracked — removed from extraProjects, or
    // gone from GitLab — must not keep serving rows to lists and mentions.
    const tracked = projects.map((entry) => entry.project);
    if (tracked.length === 0) {
      db.prepare("DELETE FROM items").run();
    } else {
      db.prepare(
        `DELETE FROM items WHERE project NOT IN (${tracked.map(() => "?").join(",")})`,
      ).run(...tracked);
    }
    let total = 0;
    for (const { project } of projects) {
      try {
        const items = await fetchProjectItems(gitlabApi, project);
        replaceProjectRows(project, items);
        total += items.length;
      } catch (error) {
        bb.log.warn(
          `sync failed for ${project}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await bb.storage.kv.set("sync-cursor", {
      lastSyncedAt: new Date().toISOString(),
      projects: projects.length,
      items: total,
    });
    if (before !== JSON.stringify(fingerprint.all())) {
      bb.realtime.publish("data-changed", { items: total });
    }
    bb.log.info(`synced ${total} item(s) across ${projects.length} project(s)`);
    return { projects: projects.length, items: total };
  }

  // Initial sync + 5-minute refresh loop. NeedsConfigurationError from a
  // missing/unauthenticated glab flips the plugin to needs-configuration
  // instead of crash-looping. The abort check after each sync is load-bearing:
  // an abort that lands mid-sync would otherwise register its listener on an
  // already-aborted signal, which never fires, and the reload would wait out
  // the full interval and report the plugin degraded.
  bb.background.service("sync", {
    async start(signal) {
      while (!signal.aborted) {
        await syncAll();
        if (signal.aborted) break;
        const sleep = Promise.withResolvers<void>();
        const timer = setTimeout(sleep.resolve, SYNC_INTERVAL_MS);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            sleep.resolve();
          },
          { once: true },
        );
        await sleep.promise;
      }
    },
  });

  // Surface an unconfigured glab immediately instead of waiting for the
  // service's first crash.
  try {
    await checkAuth();
  } catch (error) {
    bb.status.needsConfiguration(
      error instanceof Error ? error.message : String(error),
    );
  }

  // ------------------------------------------------------------------
  // Issue/MR ↔ thread links (the pills in the UI).
  // kv: "link:<kind>:<project>!<iid>" → ThreadLink[]
  // ------------------------------------------------------------------
  async function addLink(link: ThreadLink): Promise<void> {
    const key = `link:${link.kind}:${link.project}!${link.iid}`;
    const existing = (await bb.storage.kv.get<ThreadLink[]>(key)) ?? [];
    await bb.storage.kv.set(key, [...existing, link]);
    bb.realtime.publish("links-changed", { key });
  }

  async function listAllLinks(): Promise<Record<string, ThreadLink[]>> {
    const keys = await bb.storage.kv.list("link:");
    const result: Record<string, ThreadLink[]> = {};
    for (const key of keys) {
      const links = await bb.storage.kv.get<ThreadLink[]>(key);
      if (links !== undefined && links.length > 0) {
        result[key.slice("link:".length)] = links;
      }
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Spawning agent threads on issues / MR reviews.
  // ------------------------------------------------------------------
  async function resolveBbProjectId(project: string): Promise<string> {
    const projects = await discoverProjects();
    const info = projects.find((entry) => entry.project === project);
    if (info?.bbProjectId != null) return info.bbProjectId;
    const { defaultProject } = await settings.get();
    if (defaultProject) return defaultProject;
    throw new Error(
      `No BB project is attached to ${project}. Create a project whose checkout has ` +
        "that origin remote, or set the defaultProject plugin setting.",
    );
  }

  async function spawnOnItem(
    kind: "issue" | "mr",
    project: string,
    iid: number,
  ): Promise<{ threadId: string }> {
    const item = getCachedItem(kind, project, iid);
    const noun = kind === "mr" ? "merge request" : "issue";
    const marker = kind === "mr" ? "!" : "#";
    const title = item?.title ?? `${noun} ${marker}${iid}`;
    const bbProjectId = await resolveBbProjectId(project);
    const ref = `${project}${marker}${iid}`;
    const prompt =
      kind === "issue"
        ? [
            `Work on GitLab issue ${ref}: ${title}`,
            "",
            "Read the full issue and its comments first:",
            `  glab issue view ${iid} -R ${project} --comments`,
            "",
            item !== null && item.body.length > 0
              ? `Issue description:\n\n${item.body}`
              : "(no cached description — read it with the command above)",
            "",
            "Implement a fix or the requested change in this checkout. " +
              `If you open a merge request, include "Closes #${iid}" in its description.`,
          ].join("\n")
        : [
            `Review GitLab merge request ${ref}: ${title}`,
            "",
            "Read the merge request and its diff:",
            `  glab mr view ${iid} -R ${project} --comments`,
            `  glab mr diff ${iid} -R ${project}`,
            "",
            "Review the change for correctness, missing tests, and design issues. " +
              "Summarize your findings with file/line references. Do not push " +
              "changes or post to GitLab unless asked.",
          ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId: bbProjectId,
      environment: { type: "project-default" },
      title: `${ref}: ${title}`.slice(0, 120),
      prompt,
    });
    await addLink({
      kind,
      project,
      iid,
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
    bb.log.info(`spawned thread ${thread.id} for ${noun} ${ref}`);
    return { threadId: thread.id };
  }

  // ------------------------------------------------------------------
  // Viewer identity + per-project members and labels, cached in memory so the
  // filter chips and assignee picker don't hit the network on every render.
  // ------------------------------------------------------------------
  const viewerCache = new Map<string, { username: string; fetchedAt: number }>();
  const membersCache = new Map<
    string,
    { members: GitlabUserRow[]; fetchedAt: number }
  >();
  const labelsCache = new Map<
    string,
    { labels: string[]; colors: Record<string, string>; fetchedAt: number }
  >();

  async function getViewer(host?: string): Promise<string> {
    const resolvedHost = host ?? authenticatedHosts[0]?.host;
    if (resolvedHost === undefined) {
      throw needsConfiguration(`No authenticated GitLab host. ${GLAB_HINT}`);
    }
    const cached = viewerCache.get(resolvedHost);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 60 * 60_000) {
      return cached.username;
    }
    const raw = await glab(["api", "--hostname", resolvedHost, "user"], 15_000);
    const { username } = gitlabUserRowSchema.parse(JSON.parse(raw));
    if (username.length === 0) {
      throw new Error(`could not resolve the glab user on ${resolvedHost}`);
    }
    viewerCache.set(resolvedHost, { username, fetchedAt: Date.now() });
    return username;
  }

  async function getMembers(project: string): Promise<GitlabUserRow[]> {
    const cached = membersCache.get(project);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached.members;
    }
    const { path } = parseProjectRef(project);
    // A large instance has far more than one page of people; read them all
    // (bounded) so the pickers and filters can reach everyone.
    const members: GitlabUserRow[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const rows = gitlabMemberListSchema.parse(
        await gitlabApi(
          project,
          `projects/${encodeURIComponent(path)}/members/all?per_page=100&page=${page}`,
        ),
      );
      members.push(...rows);
      if (rows.length < 100) break;
    }
    membersCache.set(project, { members, fetchedAt: Date.now() });
    return members;
  }

  /** GitLab assigns by numeric user id, so usernames need resolving first. */
  async function resolveUserIds(
    project: string,
    names: readonly string[],
  ): Promise<number[]> {
    if (names.length === 0) return [];
    const idByName = new Map<string, number>();
    for (const member of await getMembers(project)) {
      if (member.username.length > 0 && member.id > 0) {
        idByName.set(member.username, member.id);
      }
    }
    const ids: number[] = [];
    for (const name of names) {
      const known = idByName.get(name);
      if (known !== undefined) {
        ids.push(known);
        continue;
      }
      // Assignable without being a direct member (group or instance user).
      const [found] = gitlabMemberListSchema.parse(
        await gitlabApi(project, `users?username=${encodeURIComponent(name)}`),
      );
      if (found === undefined || found.id <= 0) {
        throw new Error(`unknown GitLab user "${name}"`);
      }
      ids.push(found.id);
    }
    return ids;
  }

  async function getProjectLabels(
    project: string,
  ): Promise<{ labels: string[]; colors: Record<string, string> }> {
    const cached = labelsCache.get(project);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      // Only the contract's fields: the RPC output is strict, and fetchedAt is ours.
      return { labels: cached.labels, colors: cached.colors };
    }
    const { path } = parseProjectRef(project);
    const rows: z.infer<typeof gitlabLabelListSchema> = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const batch = gitlabLabelListSchema.parse(
        await gitlabApi(
          project,
          `projects/${encodeURIComponent(path)}/labels?per_page=100&with_counts=false&page=${page}`,
        ),
      );
      rows.push(...batch);
      if (batch.length < 100) break;
    }
    // Group labels come back alongside project labels and can repeat.
    const labels = [
      ...new Set(rows.map((row) => row.name.trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    const colors: Record<string, string> = {};
    for (const row of rows) {
      const name = row.name.trim();
      if (name.length > 0 && /^#[0-9a-fA-F]{3,8}$/.test(row.color)) {
        colors[name] = row.color;
      }
    }
    const result = { labels, colors };
    labelsCache.set(project, { ...result, fetchedAt: Date.now() });
    return result;
  }

  /** Human notes of a GitLab note list — GitLab's activity feed is in there too. */
  function toNotes(raw: unknown): Note[] {
    return gitlabNoteListSchema
      .parse(raw)
      .filter((row) => !row.system && row.body.trim().length > 0)
      .map((row) => ({
        author: row.author?.username ?? "",
        body: row.body,
        createdAt: row.created_at,
      }));
  }

  // ------------------------------------------------------------------
  // rpc — the frontend data plane.
  // ------------------------------------------------------------------
  bb.rpc.register(gitlabRpcContract, {
    /** () → auth/sync status for the panel banner. */
    async status() {
      const cursor = await bb.storage.kv.get<{
        lastSyncedAt: string;
        projects: number;
        items: number;
      }>("sync-cursor");
      return {
        glabOk: glabAuthError === null,
        glabError: glabAuthError,
        hosts: authenticatedHosts.map((entry) => entry.host),
        projects: await discoverProjects(),
        lastSyncedAt: cursor?.lastSyncedAt ?? null,
      };
    },

    /** () → force a full sync now. */
    async refresh() {
      return await syncAll(true);
    },

    /** { kind?, project?, state? } → cached items, newest first. */
    async listItems(input) {
      return {
        items: listCachedItems({
          kind: input.kind,
          project: input.project,
          state: input.state,
        }),
      };
    },

    /** () → the authenticated glab username, for "assign to me" affordances. */
    async viewer() {
      return { username: await getViewer() };
    },

    /** { project } → usernames that can be assigned in that project. */
    async assignableUsers(input) {
      const members = await getMembers(input.project);
      return {
        users: [...new Set(usernames(members))].sort((a, b) =>
          a.localeCompare(b),
        ),
      };
    },

    /** { project } → labels available in that project. */
    async projectLabels(input) {
      return await getProjectLabels(input.project);
    },

    /** { project, iid, state } → close or reopen an issue. */
    async setIssueState({ project, iid, state }): Promise<{ ok: true }> {
      const { path } = parseProjectRef(project);
      const event = state === "closed" ? "close" : "reopen";
      await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/issues/${iid}?state_event=${event}`,
        { method: "PUT" },
      );
      patchCachedItem("issue", project, iid, {
        state: state === "closed" ? "closed" : "opened",
      });
      return { ok: true };
    },

    /** { project, iid, assignees, kind? } → set the exact assignee list. */
    async setAssignees({
      project,
      iid,
      assignees,
      kind,
    }): Promise<{ ok: true; assignees: string[] }> {
      const next = [...new Set(assignees)];
      const { path } = parseProjectRef(project);
      const ids = await resolveUserIds(project, next);
      // GitLab clears the assignee list when the id list is exactly [0].
      const query = (ids.length > 0 ? ids : [0])
        .map((id) => `assignee_ids[]=${id}`)
        .join("&");
      const updated = gitlabItemRowSchema.parse(
        await gitlabApi(
          project,
          `projects/${encodeURIComponent(path)}/${
            kind === "mr" ? "merge_requests" : "issues"
          }/${iid}?${query}`,
          { method: "PUT" },
        ),
      );
      const applied = usernames(updated.assignees);
      patchCachedItem(kind, project, iid, { assignees: applied });
      return { ok: true, assignees: applied };
    },

    /** { project, iid, reviewers } → set the exact merge-request reviewer list. */
    async setReviewers({
      project,
      iid,
      reviewers,
    }): Promise<{ ok: true; reviewers: string[] }> {
      const next = [...new Set(reviewers)];
      const { path } = parseProjectRef(project);
      const ids = await resolveUserIds(project, next);
      // As with assignees, [0] is how GitLab clears the list.
      const query = (ids.length > 0 ? ids : [0])
        .map((id) => `reviewer_ids[]=${id}`)
        .join("&");
      const updated = gitlabItemRowSchema.parse(
        await gitlabApi(
          project,
          `projects/${encodeURIComponent(path)}/merge_requests/${iid}?${query}`,
          { method: "PUT" },
        ),
      );
      const applied = usernames(updated.reviewers);
      patchCachedItem("mr", project, iid, { reviewers: applied });
      return { ok: true, reviewers: applied };
    },

    /** { project, iid, labels } → set the exact issue label list. */
    async setLabels({
      project,
      iid,
      labels,
      kind,
    }): Promise<{ ok: true; labels: string[] }> {
      const next = [
        ...new Set(labels.map((label) => label.trim()).filter(Boolean)),
      ];
      const { path } = parseProjectRef(project);
      const updated = gitlabItemRowSchema.parse(
        await gitlabApi(
          project,
          `projects/${encodeURIComponent(path)}/${
            kind === "mr" ? "merge_requests" : "issues"
          }/${iid}`,
          { method: "PUT", fields: { labels: next.join(",") } },
        ),
      );
      patchCachedItem(kind, project, iid, { labels: updated.labels });
      return { ok: true, labels: updated.labels };
    },

    /** { project, iid } → live issue detail incl. comments. */
    async getIssue({ project, iid }) {
      const { path } = parseProjectRef(project);
      const base = `projects/${encodeURIComponent(path)}/issues/${iid}`;
      const [detailRaw, notesRaw] = await Promise.all([
        gitlabApi(project, base),
        gitlabApi(
          project,
          `${base}/notes?per_page=100&sort=asc&order_by=created_at`,
        ),
      ]);
      const detail = gitlabItemRowSchema.parse(detailRaw);
      return {
        issue: {
          project,
          iid,
          title: detail.title,
          state: detail.state,
          author: detail.author?.username ?? "",
          body: detail.description,
          labels: detail.labels,
          assignees: usernames(detail.assignees),
          url: detail.web_url,
          updatedAt: detail.updated_at,
          notes: toNotes(notesRaw),
        },
      };
    },

    /**
     * { project, iid } → full merge-request detail: overview, pipeline jobs
     * (GitLab's answer to checks), approvals, conversation notes, inline
     * discussion threads, and per-file diffs. Approvals, discussions, diffs,
     * and jobs are optional on any given instance or plan, so a failure there
     * degrades that section instead of the whole view.
     */
    async getMergeRequest({ project, iid }) {
      const { path } = parseProjectRef(project);
      const encoded = encodeURIComponent(path);
      const base = `projects/${encoded}/merge_requests/${iid}`;
      const optional = async (endpoint: string): Promise<unknown> => {
        try {
          return await gitlabApi(project, endpoint);
        } catch (error) {
          bb.log.warn(
            `optional call ${endpoint} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
      };
      // Everything the top of the page needs, in one round of parallel calls.
      // The diffs are the heaviest payload and are only needed on the Changes
      // tab, so they load separately (getMergeRequestFiles).
      const [detailRaw, discussionsRaw, approvalsRaw, awardsRaw] =
        await Promise.all([
          gitlabApi(project, base),
          optional(`${base}/discussions?per_page=100`),
          optional(`${base}/approvals`),
          optional(`${base}/award_emoji?per_page=100`),
        ]);
      const detail = gitlabMergeRequestRowSchema.parse(detailRaw);

      // Threads and standalone comments alike, so each can be replied to.
      // Notes GitLab writes itself ("approved this merge request") are dropped.
      const discussions: Array<{
        id: string;
        individual: boolean;
        resolvable: boolean;
        path: string;
        line: number | null;
        resolved: boolean;
        notes: Note[];
      }> = [];
      for (const discussion of gitlabDiscussionListSchema.parse(
        discussionsRaw,
      )) {
        if (discussion.id.length === 0) continue;
        const position = discussion.notes.find(
          (note) => note.position != null,
        )?.position;
        const notes = discussion.notes
          .filter((note) => !note.system && note.body.trim().length > 0)
          .map((note) => ({
            author: note.author?.username ?? "",
            body: note.body,
            createdAt: note.created_at,
          }));
        if (notes.length === 0) continue;
        const resolvable = discussion.notes.some((note) => note.resolvable);
        discussions.push({
          id: discussion.id,
          individual: discussion.individual_note,
          resolvable,
          path: position?.new_path ?? position?.old_path ?? "",
          line: position == null ? null : (position.new_line ?? position.old_line),
          resolved:
            resolvable &&
            discussion.notes.every((note) => !note.resolvable || note.resolved),
          notes,
        });
      }

      const reactionsByName = new Map<string, string[]>();
      for (const award of gitlabAwardListSchema.parse(awardsRaw)) {
        const username = award.user?.username ?? "";
        if (award.name.length === 0 || username.length === 0) continue;
        const users = reactionsByName.get(award.name) ?? [];
        if (!users.includes(username)) users.push(username);
        reactionsByName.set(award.name, users);
      }
      const reactions = [...reactionsByName].map(([name, users]) => ({
        name,
        users,
      }));

      const approvals = gitlabApprovalsSchema.parse(approvalsRaw);
      const changesCount = Number.parseInt(String(detail.changes_count), 10);
      const changedFiles = Number.isFinite(changesCount) ? changesCount : 0;

      return {
        mergeRequest: {
          project,
          iid,
          title: detail.title,
          state: detail.state,
          draft: detail.draft || detail.work_in_progress,
          author: detail.author?.username ?? "",
          body: detail.description,
          url: detail.web_url,
          createdAt: detail.created_at,
          updatedAt: detail.updated_at,
          sourceBranch: detail.source_branch,
          targetBranch: detail.target_branch,
          changedFiles,
          headSha: detail.sha,
          squash: detail.squash,
          removeSourceBranch: detail.force_remove_source_branch ?? false,
          mergeScheduled: detail.merge_when_pipeline_succeeds,
          labels: detail.labels,
          assignees: usernames(detail.assignees),
          reviewers: usernames(detail.reviewers),
          mergeStatus: detail.detailed_merge_status || detail.merge_status,
          hasConflicts: detail.has_conflicts,
          approvalsRequired: approvals.approvals_required,
          approvalsLeft: approvals.approvals_left,
          approvedBy: approvals.approved_by
            .map((entry) => entry.user?.username ?? "")
            .filter((name) => name.length > 0),
          pipeline:
            detail.head_pipeline == null
              ? null
              : {
                  id: detail.head_pipeline.id ?? 0,
                  status: detail.head_pipeline.status,
                  url: detail.head_pipeline.web_url,
                },
          discussions,
          reactions,
        },
      };
    },

    /** { project, id } → the jobs of one pipeline. */
    async getPipelineJobs({ project, id }) {
      return { jobs: (await listPipelineJobs(project, id)).map(toPipelineJob) };
    },

    /** { project, iid } → the changed files with their patches. */
    async getMergeRequestFiles({ project, iid }) {
      const raw = await gitlabApi(
        project,
        `${projectApiBase(project)}/merge_requests/${iid}/diffs?per_page=${DIFF_PAGE}`,
      );
      let additions = 0;
      let deletions = 0;
      const files = gitlabDiffListSchema.parse(raw).map((file) => {
        const counts = countDiffLines(file.diff);
        additions += counts.additions;
        deletions += counts.deletions;
        return {
          path: file.new_path || file.old_path,
          status: file.new_file
            ? "added"
            : file.deleted_file
              ? "deleted"
              : file.renamed_file
                ? "renamed"
                : "modified",
          additions: counts.additions,
          deletions: counts.deletions,
          // Very large diffs stay on GitLab — the panel links out instead.
          patch:
            file.diff.length > 0 && file.diff.length <= MAX_PATCH_BYTES
              ? file.diff
              : null,
        };
      });
      // The page cutoff is the only thing that truncates the list; a file
      // count from GitLab can disagree for its own reasons and must not
      // fake truncation.
      return { files, additions, deletions, truncated: files.length >= DIFF_PAGE };
    },

    /** { project, ref?, status?, limit } → newest pipelines, with the default branch. */
    async listPipelines({ project, ref, status, limit }) {
      const query = new URLSearchParams({
        order_by: "id",
        sort: "desc",
        per_page: String(limit),
      });
      if (ref !== undefined) query.set("ref", ref);
      if (status !== undefined) query.set("status", status);
      const [raw, defaultBranch] = await Promise.all([
        gitlabApi(project, `${projectApiBase(project)}/pipelines?${query}`),
        getDefaultBranch(project).catch(() => ""),
      ]);
      const pipelines = z
        .array(gitlabPipelineRowSchema.nullable().catch(null))
        .catch([])
        .parse(raw)
        .filter((row): row is PipelineRow => row !== null)
        .map(toPipelineSummary);
      return { pipelines, defaultBranch };
    },

    /** { project, id } → one pipeline with its jobs. */
    async getPipeline({ project, id }) {
      const [detailRaw, jobs] = await Promise.all([
        gitlabApi(project, `${projectApiBase(project)}/pipelines/${id}`),
        listPipelineJobs(project, id),
      ]);
      const detail = gitlabPipelineDetailSchema.parse(detailRaw);
      return {
        pipeline: {
          ...toPipelineSummary(detail),
          user: detail.user?.username ?? "",
          durationSeconds: detail.duration ?? null,
          yamlErrors: detail.yaml_errors ?? null,
        },
        jobs: jobs.map(toPipelineJob),
        mergeRequestIid: mergeRequestIidFromRef(detail.ref),
      };
    },

    /** { project, search?, limit } → branches with their open MR and latest pipeline. */
    async listBranches({ project, search, limit }) {
      const base = projectApiBase(project);
      // Newest activity first, so the first 100 are the ones people want.
      const query = new URLSearchParams({
        per_page: String(limit),
        sort: "updated_desc",
      });
      const searching = search !== undefined && search.trim().length > 0;
      if (searching) query.set("search", search.trim());
      const [branchesRaw, defaultRaw, pipelinesRaw, mergeRequests] = await Promise.all([
        gitlabApi(project, `${base}/repository/branches?${query}`),
        // The default branch is often not among the newest 100, but it is
        // the one people compare everything to, so it always leads the list.
        searching
          ? Promise.resolve(null)
          : getDefaultBranch(project)
              .then((name) =>
                gitlabApi(
                  project,
                  `${base}/repository/branches/${encodeURIComponent(name)}`,
                ),
              )
              .catch(() => null),
        gitlabApi(
          project,
          `${base}/pipelines?per_page=100&order_by=id&sort=desc`,
        ).catch(() => []),
        (async () => {
          const rows: z.infer<typeof gitlabMergeRequestRowSchema>[] = [];
          for (let page = 1; page <= 5; page += 1) {
            const batch = z
              .array(gitlabMergeRequestRowSchema.nullable().catch(null))
              .catch([])
              .parse(
                await gitlabApi(
                  project,
                  `${base}/merge_requests?state=opened&per_page=100&page=${page}`,
                ),
              )
              .filter(
                (row): row is z.infer<typeof gitlabMergeRequestRowSchema> =>
                  row !== null,
              );
            rows.push(...batch);
            if (batch.length < 100) break;
          }
          return rows;
        })().catch(() => []),
      ]);
      const pipelines = z
        .array(gitlabPipelineRowSchema.nullable().catch(null))
        .catch([])
        .parse(pipelinesRaw)
        .filter((row): row is PipelineRow => row !== null);
      const listed = gitlabBranchListSchema.parse(branchesRaw);
      const [defaultRow] =
        defaultRaw === null ? [] : gitlabBranchListSchema.parse([defaultRaw]);
      const branchRows =
        defaultRow != null && !listed.some((row) => row?.name === defaultRow.name)
          ? [defaultRow, ...listed]
          : listed;
      return {
        branches: buildBranchRows(
          branchRows,
          mergeRequests.map((row) => ({
            source_branch: row.source_branch,
            iid: row.iid,
            title: row.title,
            draft: row.draft,
            work_in_progress: row.work_in_progress,
          })),
          pipelines,
        ),
      };
    },

    /** { project, jobId, lines } → the tail of a job's log. */
    async getJobLog({ project, jobId, lines }) {
      const log = await coreJobTrace(project, jobId, lines);
      // Bounded by bytes as well as lines: one minified line can be huge.
      const clipped = log.length > 200_000;
      return {
        log: clipped ? log.slice(log.length - 200_000) : log,
        truncated: clipped,
      };
    },

    /** { project, id } → retry the pipeline's failed and canceled jobs. */
    async retryPipeline({ project, id }) {
      const { pipeline, retried } = await coreRetryPipeline(project, id);
      return {
        id: pipeline.id,
        status: pipeline.status,
        url: pipeline.web_url,
        retried: retried.length,
      };
    },

    async cancelPipeline({ project, id }) {
      const pipeline = await coreCancelPipeline(project, id);
      return { id: pipeline.id, status: pipeline.status, url: pipeline.web_url };
    },

    /** { project, jobId, action } → retry, play, or cancel one job. */
    async runJob({ project, jobId, action }) {
      const job = await coreJobAction(project, jobId, action);
      return { jobId: job.id, status: job.status, url: job.web_url };
    },

    /** { project, ref? | mergeRequestIid? } → start a new pipeline. */
    async runPipeline({ project, ref, mergeRequestIid }) {
      const { pipeline } = await coreRunPipeline(project, {
        ...(ref === undefined ? {} : { ref }),
        ...(mergeRequestIid === undefined ? {} : { mergeRequestIid }),
      });
      return {
        id: pipeline.id,
        status: pipeline.status,
        url: pipeline.web_url,
      };
    },

    /**
     * { project, iid, target } → for each commit of the merge request, whether
     * it is already on `target`: by SHA (GitLab's commit refs) or by a
     * `cherry-pick -x` line in the target's recent history.
     */
    async getMergeRequestPromotion({ project, iid, target }) {
      const api = projectApiBase(project);
      const checkedAt = new Date().toISOString();
      try {
        await gitlabApi(project, `${api}/repository/branches/${encodeURIComponent(target)}`);
      } catch (error) {
        if (/\b404\b/.test(error instanceof Error ? error.message : String(error))) {
          return { target, targetExists: false, checkedAt, complete: true, commits: [] };
        }
        throw error;
      }
      const commitRow = z
        .object({
          id: z.string(),
          title: z.string().default(""),
          message: z.string().default(""),
          parent_ids: z.array(z.string()).default([]),
          created_at: z.string().default(""),
          author_name: z.string().default(""),
        })
        .passthrough();
      const mrCommits: z.infer<typeof commitRow>[] = [];
      let complete = true;
      for (let page = 1; ; page += 1) {
        const rows = z
          .array(commitRow)
          .parse(await gitlabApi(project, `${api}/merge_requests/${iid}/commits?per_page=100&page=${page}`));
        mrCommits.push(...rows);
        if (rows.length < 100) break;
        if (page >= 5) {
          complete = false;
          break;
        }
      }
      // GitLab lists them newest first; people read a branch oldest first.
      mrCommits.reverse();

      // Which branches each commit is on, four lookups at a time.
      const branchesBySha = new Map<string, string[] | null>();
      const refRow = z.object({ type: z.string(), name: z.string() }).passthrough();
      const queue = [...mrCommits];
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            try {
              const refs = z
                .array(refRow)
                .parse(
                  await gitlabApi(
                    project,
                    `${api}/repository/commits/${next.id}/refs?type=branch&per_page=100`,
                  ),
                );
              branchesBySha.set(next.id, refs.map((ref) => ref.name));
            } catch {
              branchesBySha.set(next.id, null);
            }
          }
        }),
      );

      // Cherry-picks happen after the original commit; read the target from then.
      const oldest = mrCommits
        .map((entry) => Date.parse(entry.created_at))
        .filter((time) => Number.isFinite(time))
        .sort((a, b) => a - b)[0];
      const since = oldest === undefined ? "" : `&since=${encodeURIComponent(new Date(oldest - 86_400_000).toISOString())}`;
      const targetCommits: { sha: string; message: string; title: string }[] = [];
      let targetHistoryComplete = true;
      for (let page = 1; ; page += 1) {
        const rows = z
          .array(commitRow)
          .parse(
            await gitlabApi(
              project,
              `${api}/repository/commits?ref_name=${encodeURIComponent(target)}&per_page=100&page=${page}${since}`,
            ),
          );
        targetCommits.push(...rows.map((row) => ({ sha: row.id, message: row.message, title: row.title })));
        if (rows.length < 100) break;
        if (page >= 10) {
          targetHistoryComplete = false;
          break;
        }
      }

      // A cherry-pick without -x keeps the diff. Same title only picks which
      // diffs to compare; the diff itself is the evidence.
      const diffRow = z.object({ old_path: z.string(), new_path: z.string(), diff: z.string() }).passthrough();
      const diffCache = new Map<string, Promise<string | null>>();
      const patchOf = (sha: string) => {
        let pending = diffCache.get(sha);
        if (pending === undefined) {
          pending = gitlabApi(project, `${api}/repository/commits/${sha}/diff?per_page=100`).then(
            (rows) => normalizedPatch(z.array(diffRow).parse(rows)),
            () => null,
          );
          diffCache.set(sha, pending);
        }
        return pending;
      };
      const onTarget = (sha: string) => branchesBySha.get(sha)?.includes(target) ?? false;
      const samePatch = new Map<string, string>();
      const lookalike = new Map<string, string>();
      for (const entry of mrCommits) {
        if (onTarget(entry.id) || entry.parent_ids.length > 1) continue;
        const candidates = targetCommits.filter((row) => row.title.trim() === entry.title.trim()).slice(0, 3);
        if (candidates.length === 0) continue;
        const source = await patchOf(entry.id);
        if (source === null || source.length === 0) continue;
        for (const candidate of candidates) {
          if ((await patchOf(candidate.sha)) === source) {
            samePatch.set(entry.id, candidate.sha);
            break;
          }
        }
        if (!samePatch.has(entry.id)) lookalike.set(entry.id, candidates[0].sha);
      }

      const commits: PromotionCommit[] = classifyPromotion({
        samePatch,
        lookalike,
        target,
        commits: mrCommits.map((entry) => ({
          sha: entry.id,
          title: entry.title,
          parentCount: entry.parent_ids.length,
        })),
        branchesBySha,
        targetCommits,
        targetHistoryComplete,
      });
      const bySha = new Map(mrCommits.map((entry) => [entry.id, entry]));
      return {
        target,
        targetExists: true,
        checkedAt,
        complete,
        commits: commits.map((commit) => {
          const row = bySha.get(commit.sha);
          const message = row?.message ?? "";
          const firstBreak = message.indexOf("\n");
          return {
            ...commit,
            body: firstBreak < 0 ? "" : message.slice(firstBreak + 1).trim(),
            author: row?.author_name ?? "",
            createdAt: row?.created_at ?? "",
          };
        }),
      };
    },

    /** { project, iid, shas } → a thread that explains and reviews those commits. */
    async startCommitReview({ project, iid, shas }) {
      const item = getCachedItem("mr", project, iid);
      const title = item?.title ?? `merge request !${iid}`;
      const ref = `${project}!${iid}`;
      const prompt = [
        `Review ${shas.length === 1 ? "a commit" : `${shas.length} commits`} of GitLab merge request ${ref} ("${title}").`,
        "",
        ...shas.map((sha) => `  ${sha}`),
        "",
        "For each commit:",
        "1. Read it: `git fetch origin && git show --stat <sha>`, then the diff where it matters.",
        "2. Give a TL;DR in two or three sentences: what changes and why.",
        "3. List risks: behaviour changes, missing tests, migrations, anything that would break if this commit were cherry-picked alone.",
        "",
        `Context: glab mr view ${iid} -R ${project}`,
        "Do not push, comment on GitLab or change branches unless asked.",
      ].join("\n");
      const thread = await bb.sdk.threads.spawn({
        projectId: await resolveBbProjectId(project),
        environment: { type: "project-default" },
        title: `Review ${shas.length === 1 ? shas[0].slice(0, 8) : `${shas.length} commits`} of !${iid}`.slice(0, 120),
        prompt,
      });
      await addLink({ kind: "mr", project, iid, threadId: thread.id, createdAt: new Date().toISOString() });
      return { threadId: thread.id };
    },

    /** { project, iid, target, shas } → a thread that cherry-picks them via a new MR. */
    async startCherryPick({ project, iid, target, shas }) {
      const item = getCachedItem("mr", project, iid);
      const title = item?.title ?? `merge request !${iid}`;
      const ref = `${project}!${iid}`;
      const branch = `cherry-pick/mr-${iid}-to-${target.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
      const prompt = [
        `Cherry-pick commits of GitLab merge request ${ref} ("${title}") onto ${target}.`,
        "",
        "Commits, oldest first:",
        ...shas.map((sha) => `  ${sha}`),
        "",
        "Steps:",
        `1. git fetch origin && git switch -c ${branch} origin/${target}`,
        `2. git cherry-pick -x ${shas.join(" ")}`,
        "   If a commit conflicts, stop and ask me before resolving anything; do not change the patch on your own.",
        `3. git push -u origin ${branch}`,
        `4. glab mr create -R ${project} --source-branch ${branch} --target-branch ${target} --title "Cherry-pick !${iid} to ${target}" --description "Cherry-pick of !${iid} (${shas.length} commit${shas.length === 1 ? "" : "s"}) with git cherry-pick -x."`,
        "",
        `Never push to ${target} directly. Report the new merge request link when done.`,
      ].join("\n");
      const thread = await bb.sdk.threads.spawn({
        projectId: await resolveBbProjectId(project),
        environment: { type: "project-default" },
        title: `Cherry-pick !${iid} → ${target}`.slice(0, 120),
        prompt,
      });
      await addLink({ kind: "mr", project, iid, threadId: thread.id, createdAt: new Date().toISOString() });
      bb.log.info(`spawned cherry-pick thread ${thread.id} for ${ref} → ${target}`);
      return { threadId: thread.id };
    },

    /**
     * { project, iid, sha, squash, removeSourceBranch, whenPipelineSucceeds } →
     * merge. The head commit is re-read first and must be the one the person
     * reviewed; GitLab then enforces its own rules (pipeline, approvals,
     * threads) and a refusal comes back as a plain sentence.
     */
    async mergeMergeRequest({
      project,
      iid,
      sha,
      squash,
      removeSourceBranch,
      whenPipelineSucceeds,
    }): Promise<{ ok: true; state: string; scheduled: boolean }> {
      if (!(await settings.get()).allowMerge) {
        throw new Error("Merging from the panel is turned off in the plugin settings");
      }
      const base = `${projectApiBase(project)}/merge_requests/${iid}`;
      const current = gitlabMergeRequestRowSchema.parse(
        await gitlabApi(project, base),
      );
      const allowance = mergeAllowance({
        state: current.state,
        draft: current.draft || current.work_in_progress,
        hasConflicts: current.has_conflicts,
      });
      if (!allowance.allowed) {
        throw new Error(allowance.reason ?? "This merge request cannot be merged");
      }
      if (current.sha.length > 0 && !current.sha.startsWith(sha) && !sha.startsWith(current.sha)) {
        throw new Error(explainMergeFailure("409 SHA does not match HEAD"));
      }
      let updated;
      try {
        updated = gitlabMergeRequestRowSchema.parse(
          await gitlabApi(
            project,
            `${base}/merge?${mergeQuery({ sha, squash, removeSourceBranch, whenPipelineSucceeds })}`,
            { method: "PUT" },
          ),
        );
      } catch (error) {
        throw new Error(
          explainMergeFailure(error instanceof Error ? error.message : String(error)),
        );
      }
      if (updated.state === "merged") {
        patchCachedItem("mr", project, iid, { state: "merged" });
      }
      return {
        ok: true,
        state: updated.state,
        scheduled: updated.state !== "merged" && updated.merge_when_pipeline_succeeds,
      };
    },

    /** { project, iid, discussionId, body } → reply inside an existing thread. */
    async replyToDiscussion({ project, iid, discussionId, body }): Promise<{ ok: true }> {
      await gitlabApi(
        project,
        `${projectApiBase(project)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`,
        { method: "POST", fields: { body } },
      );
      return { ok: true };
    },

    /** { project, iid, discussionId, resolved } → resolve or reopen a thread. */
    async setDiscussionResolved({
      project,
      iid,
      discussionId,
      resolved,
    }): Promise<{ ok: true }> {
      await gitlabApi(
        project,
        `${projectApiBase(project)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}?resolved=${resolved}`,
        { method: "PUT" },
      );
      return { ok: true };
    },

    /** { project, iid, body } → add an issue comment. */
    async commentIssue({ project, iid, body }): Promise<{ ok: true }> {
      const { path } = parseProjectRef(project);
      await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/issues/${iid}/notes`,
        { method: "POST", fields: { body } },
      );
      return { ok: true };
    },

    /** { project, iid, body } → add a merge-request comment. */
    async commentMergeRequest({ project, iid, body }): Promise<{ ok: true }> {
      const { path } = parseProjectRef(project);
      await gitlabApi(
        project,
        `projects/${encodeURIComponent(path)}/merge_requests/${iid}/notes`,
        { method: "POST", fields: { body } },
      );
      return { ok: true };
    },

    /** { project, title, body? } → create an issue, refresh, return iid+url. */
    async createIssue(input) {
      const { path } = parseProjectRef(input.project);
      const created = gitlabItemRowSchema.parse(
        await gitlabApi(
          input.project,
          `projects/${encodeURIComponent(path)}/issues`,
          {
            method: "POST",
            fields: { title: input.title, description: input.body ?? "" },
          },
        ),
      );
      try {
        replaceProjectRows(
          input.project,
          await fetchProjectItems(gitlabApi, input.project),
        );
        bb.realtime.publish("data-changed", {});
      } catch {
        // creation succeeded; the next scheduled sync will pick it up
      }
      return { iid: created.iid, url: created.web_url };
    },

    async uiSettings() {
      const current = await settings.get();
      return {
        promotionBranch: current.promotionBranch.trim(),
        assigneesReview: current.assigneesReview,
        reactionApprovals: current.reactionApprovals,
        allowMerge: current.allowMerge,
      };
    },

    /** { project, iid } → spawn a worker thread on an issue. */
    async startWork({ project, iid }) {
      return await spawnOnItem("issue", project, iid);
    },

    /** { project, iid } → spawn a review thread on a merge request. */
    async startReview({ project, iid }) {
      return await spawnOnItem("mr", project, iid);
    },

    /**
     * { threadId } → the merge request most relevant to a BB thread: the
     * thread's own environment MR (the branch the agent pushed) first, else an
     * MR this thread was spawned to review. Null when neither exists.
     */
    async mergeRequestForThread({ threadId }) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId !== null) {
          const result = await bb.sdk.environments.pullRequest({
            environmentId: thread.environmentId,
          });
          const match =
            result.outcome === "available"
              ? result.pullRequest.url.match(
                  /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/,
                )
              : null;
          if (match !== null) {
            const ref = `${match[1].toLowerCase()}/${match[2]}`;
            if (isProjectRef(ref)) {
              return { mergeRequest: { project: ref, iid: Number(match[3]) } };
            }
          }
        }
      } catch {
        // no environment / MR lookup failed — fall through to spawn links
      }
      const links = await listAllLinks();
      for (const [key, threadLinks] of Object.entries(links)) {
        if (!key.startsWith("mr:")) continue;
        const separator = key.lastIndexOf("!");
        if (separator < 0) continue;
        const project = key.slice("mr:".length, separator);
        const iid = Number(key.slice(separator + 1));
        if (!isProjectRef(project) || !Number.isInteger(iid)) continue;
        if (threadLinks.some((link) => link.threadId === threadId)) {
          return { mergeRequest: { project, iid } };
        }
      }
      return { mergeRequest: null };
    },

    /** () → every issue/MR → thread link, keyed "<kind>:<project>!<iid>". */
    async listLinks() {
      return { links: await listAllLinks() };
    },
  });

  // ------------------------------------------------------------------
  // Mentions: issues (# as on GitLab) and merge requests (! as on GitLab)
  // attach their details as agent context. Search reads the cache (2s time
  // box); resolve prefers a live call and falls back to the cache so a
  // network blip doesn't block the send.
  // ------------------------------------------------------------------
  function mentionItems(kind: "issue" | "mr", query: string) {
    const marker = kind === "mr" ? "!" : "#";
    return listCachedItems({ kind, query, state: "open" })
      .slice(0, 8)
      .map((item) => ({
        id: `${item.project}${marker}${item.iid}`,
        title: `${marker}${item.iid} ${item.title}`,
        subtitle: item.project,
      }));
  }

  async function mentionContext(
    kind: "issue" | "mr",
    itemId: string,
  ): Promise<{ context: string }> {
    const marker = kind === "mr" ? "!" : "#";
    const separator = itemId.lastIndexOf(marker);
    const project = separator < 0 ? "" : itemId.slice(0, separator);
    const iid = Number(itemId.slice(separator + 1));
    if (!isProjectRef(project) || !Number.isInteger(iid) || iid <= 0) {
      throw new Error(`malformed mention id "${itemId}"`);
    }
    const { path } = parseProjectRef(project);
    const noun = kind === "mr" ? "merge request" : "issue";
    const collection = kind === "mr" ? "merge_requests" : "issues";
    const command = kind === "mr" ? "mr" : "issue";
    try {
      const detail = gitlabItemRowSchema.parse(
        await gitlabApi(
          project,
          `projects/${encodeURIComponent(path)}/${collection}/${iid}`,
        ),
      );
      return {
        context: [
          `# GitLab ${noun} ${project}${marker}${iid}: ${detail.title}`,
          "",
          `State: ${detail.state} · Author: ${detail.author?.username ?? ""}`,
          `URL: ${detail.web_url}`,
          "",
          detail.description.length > 0 ? detail.description : "(no description)",
          "",
          `For full comments/diff run: glab ${command} view ${iid} -R ${project} --comments`,
        ].join("\n"),
      };
    } catch (error) {
      const cached = getCachedItem(kind, project, iid);
      if (cached === null) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      return {
        context: [
          `# GitLab ${noun} ${project}${marker}${iid}: ${cached.title}`,
          "",
          `State: ${cached.state} · Author: ${cached.author}`,
          `URL: ${cached.url}`,
          "",
          cached.body.length > 0 ? cached.body : "(no description)",
        ].join("\n"),
      };
    }
  }

  bb.ui.registerMentionProvider({
    id: "issue",
    label: "GitLab issues",
    triggers: ["@", "#"],
    search({ query }) {
      return mentionItems("issue", query);
    },
    resolve(itemId) {
      return mentionContext("issue", itemId);
    },
  });

  bb.ui.registerMentionProvider({
    id: "mr",
    label: "GitLab merge requests",
    triggers: ["@", "!"],
    search({ query }) {
      return mentionItems("mr", query);
    },
    resolve(itemId) {
      return mentionContext("mr", itemId);
    },
  });


  // ------------------------------------------------------------------
  // CLI: `bb gitlab-ui …` for agents and terminals.
  // ------------------------------------------------------------------
  const USAGE = [
    "Usage:",
    "  bb gitlab-ui projects [--json]                List tracked GitLab projects",
    "  bb gitlab-ui issues [project] [filters]       List cached issues",
    "  bb gitlab-ui mrs [project] [filters]          List cached merge requests",
    "  bb gitlab-ui sync                             Refresh the cache from GitLab now",
    "  bb gitlab-ui show <item> [--json]             Issue or MR detail with comments (live)",
    "  bb gitlab-ui comment <item> <text…>           Add a comment to an issue or MR",
    "  bb gitlab-ui pipeline [target] [options]      Pipeline status, jobs, failed-job logs",
    "  bb gitlab-ui retry [target] [options]         Retry failed jobs, or one job with --job",
    "  bb gitlab-ui run [target] [--ref <branch>]    Start a new pipeline",
    "",
    "List filters (issues, mrs):",
    "  --state open|closed|merged|all   default open; merged is MRs only",
    "  --mine                           assigned to you",
    "  --author <user|@me>  --assignee <user|@me>  --reviewer <user|@me> (mrs)",
    "  --label <name>                   repeat to require several labels",
    "  --draft                          drafts only (mrs)",
    "  --limit <n>  --json",
    "  Lists read the cache: open items plus one page of recently closed ones.",
    "",
    "Pipeline options (pipeline, retry):",
    "  --ref <branch>       latest pipeline on that branch (default: the default branch)",
    "  --pipeline <id>      a specific pipeline",
    "  --logs <n>           failed-job log lines to print, default " +
      `${DEFAULT_JOB_LOG_LINES}; 0 for none (pipeline)`,
    "  --job <id|name>      retry only this job (retry)",
    "",
    "An item is host/group/app#7 (issue), host/group/app!12 (merge request), or",
    "its web URL. Quote refs in a shell: 'host/group/app!12'.",
    "A target is an item, a project (host/group/app), or a pipeline or job URL;",
    "omitted, it is the GitLab project of the BB project the command runs in.",
  ].join("\n");

  const CLI_OUTPUT_MAX_BYTES = 900_000;

  /** Keeps stdout under the CLI transport limit, cutting the tail. */
  function clipOutput(text: string): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= CLI_OUTPUT_MAX_BYTES) return text;
    return `${bytes.subarray(0, CLI_OUTPUT_MAX_BYTES).toString("utf8")}\n… output truncated`;
  }

  function projectApiBase(project: string): string {
    return `projects/${encodeURIComponent(parseProjectRef(project).path)}`;
  }

  async function ensureGlab(): Promise<void> {
    if (glabAuthError !== null || authenticatedHosts.length === 0) {
      await checkAuth();
    }
  }

  /** A typed target, or — when omitted — the BB project the CLI runs in. */
  async function resolveCliTarget(
    raw: string | null,
    ctx: PluginCliContext,
  ): Promise<GitlabTarget> {
    await ensureGlab();
    if (raw === null) {
      const projects = await discoverProjects();
      const current =
        ctx.projectId === undefined
          ? undefined
          : projects.find((entry) => entry.bbProjectId === ctx.projectId);
      if (current === undefined) {
        throw new Error(
          "No target given, and this BB project has no GitLab remote. " +
            "Pass a project (host/group/app), an MR (host/group/app!12), or a URL.",
        );
      }
      return { kind: "project", project: current.project };
    }
    const { defaultHost } = await settings.get();
    const target = parseGitlabTarget(raw, authenticatedHosts, defaultHost);
    if (target === null) {
      throw new Error(
        `Cannot read "${raw}" as a GitLab project, issue (project#7), ` +
          "merge request (project!12), or web URL.",
      );
    }
    return target;
  }

  async function resolveCliItem(
    raw: string,
    ctx: PluginCliContext,
  ): Promise<{ kind: "issue" | "mr"; project: string; iid: number }> {
    const target = await resolveCliTarget(raw, ctx);
    if (target.kind !== "issue" && target.kind !== "mr") {
      throw new Error(
        `"${raw}" is not an issue or merge request; write it as project#7, project!12, or its URL.`,
      );
    }
    return target;
  }

  function formatDetailBlock(lines: Array<string | null>): string {
    return lines.filter((line): line is string => line !== null).join("\n");
  }

  function formatNotes(notes: readonly Note[]): string {
    if (notes.length === 0) return "--- No comments ---";
    return [
      `--- Comments (${notes.length}) ---`,
      ...notes.map((note) => `\n@${note.author} · ${note.createdAt}\n${note.body}`),
    ].join("\n");
  }

  async function cliShow(
    raw: string,
    json: boolean,
    ctx: PluginCliContext,
  ): Promise<string> {
    const item = await resolveCliItem(raw, ctx);
    const base = `${projectApiBase(item.project)}/${
      item.kind === "mr" ? "merge_requests" : "issues"
    }/${item.iid}`;
    const notesEndpoint = `${base}/notes?per_page=100&sort=asc&order_by=created_at`;
    const marker = item.kind === "mr" ? "!" : "#";
    const list = (names: readonly string[]): string =>
      names.length > 0 ? names.join(", ") : "—";

    if (item.kind === "issue") {
      const [detailRaw, notesRaw] = await Promise.all([
        gitlabApi(item.project, base),
        gitlabApi(item.project, notesEndpoint),
      ]);
      const detail = gitlabItemRowSchema.parse(detailRaw);
      const notes = toNotes(notesRaw);
      if (json) {
        return JSON.stringify(
          { ...toItem(detail, item.project, "issue"), notes },
          null,
          2,
        );
      }
      return [
        formatDetailBlock([
          `${item.project}#${item.iid}  ${detail.title}  [${detail.state}]`,
          `Author: ${detail.author?.username ?? ""} · Updated: ${detail.updated_at}`,
          `Assignees: ${list(usernames(detail.assignees))} · Labels: ${list(detail.labels)}`,
          `URL: ${detail.web_url}`,
        ]),
        detail.description.length > 0 ? detail.description : "(no description)",
        formatNotes(notes),
      ].join("\n\n");
    }

    const [detailRaw, notesRaw, approvalsRaw] = await Promise.all([
      gitlabApi(item.project, base),
      gitlabApi(item.project, notesEndpoint),
      gitlabApi(item.project, `${base}/approvals`).catch(() => undefined),
    ]);
    const detail = gitlabMergeRequestRowSchema.parse(detailRaw);
    const approvals = gitlabApprovalsSchema.parse(approvalsRaw);
    const notes = toNotes(notesRaw);
    const draft = detail.draft || detail.work_in_progress;
    const summary = {
      ...toItem(detail, item.project, "mr"),
      sourceBranch: detail.source_branch,
      targetBranch: detail.target_branch,
      reviewers: usernames(detail.reviewers),
      mergeStatus: detail.detailed_merge_status || detail.merge_status,
      hasConflicts: detail.has_conflicts,
      approvalsRequired: approvals.approvals_required,
      approvalsLeft: approvals.approvals_left,
      approvedBy: approvals.approved_by
        .map((entry) => entry.user?.username ?? "")
        .filter((name) => name.length > 0),
      pipeline:
        detail.head_pipeline == null
          ? null
          : {
              id: detail.head_pipeline.id,
              status: detail.head_pipeline.status,
              url: detail.head_pipeline.web_url,
            },
      notes,
    };
    if (json) return JSON.stringify(summary, null, 2);
    return [
      formatDetailBlock([
        `${item.project}${marker}${item.iid}  ${detail.title}  [${detail.state}${
          draft ? ", draft" : ""
        }]`,
        `Author: ${summary.author} · Created: ${detail.created_at} · Updated: ${detail.updated_at}`,
        `Branches: ${summary.sourceBranch} → ${summary.targetBranch}`,
        `Assignees: ${list(summary.assignees)} · Reviewers: ${list(summary.reviewers)} · Labels: ${list(summary.labels)}`,
        `Merge status: ${summary.mergeStatus || "unknown"}${
          summary.hasConflicts ? " · has conflicts" : ""
        } · Approvals left: ${summary.approvalsLeft}/${summary.approvalsRequired}${
          summary.approvedBy.length > 0
            ? ` (approved by ${summary.approvedBy.join(", ")})`
            : ""
        }`,
        summary.pipeline === null
          ? "Pipeline: none"
          : `Pipeline: #${summary.pipeline.id ?? "?"} ${summary.pipeline.status} ${summary.pipeline.url}`,
        `URL: ${detail.web_url}`,
      ]),
      detail.description.length > 0 ? detail.description : "(no description)",
      formatNotes(notes),
    ].join("\n\n");
  }

  async function cliComment(
    raw: string,
    body: string,
    ctx: PluginCliContext,
  ): Promise<string> {
    const item = await resolveCliItem(raw, ctx);
    const collection = item.kind === "mr" ? "merge_requests" : "issues";
    const note = z
      .looseObject({ id: z.number().int().catch(0) })
      .catch({ id: 0 })
      .parse(
        await gitlabApi(
          item.project,
          `${projectApiBase(item.project)}/${collection}/${item.iid}/notes`,
          { method: "POST", fields: { body } },
        ),
      );
    const marker = item.kind === "mr" ? "!" : "#";
    return `Commented on ${item.project}${marker}${item.iid}${
      note.id > 0 ? ` (note ${note.id})` : ""
    }.`;
  }

  type PipelineRow = z.infer<typeof gitlabPipelineRowSchema>;
  type PipelineJobRow = z.infer<typeof gitlabPipelineJobRowSchema>;

  async function getJob(project: string, id: number): Promise<PipelineJobRow> {
    return gitlabPipelineJobRowSchema.parse(
      await gitlabApi(project, `${projectApiBase(project)}/jobs/${id}`),
    );
  }

  /** The pipeline a selector points at: explicit id, MR head, job's, or latest on a ref. */
  async function resolveCliPipeline(
    selector: GitlabPipelineSelector,
    ctx: PluginCliContext,
  ): Promise<{ project: string; pipeline: PipelineRow }> {
    const target = await resolveCliTarget(selector.target, ctx);
    if (target.kind === "issue") {
      throw new Error(
        "Issues have no pipelines; pass a project, a merge request, or a pipeline URL.",
      );
    }
    const { project } = target;
    const base = projectApiBase(project);
    let pipelineId = selector.pipelineId;
    if (pipelineId === null && target.kind === "pipeline") pipelineId = target.id;
    if (pipelineId === null && target.kind === "job") {
      pipelineId = (await getJob(project, target.id)).pipeline?.id ?? null;
    }
    if (pipelineId === null && target.kind === "mr" && selector.ref === null) {
      const mr = gitlabMergeRequestRowSchema.parse(
        await gitlabApi(project, `${base}/merge_requests/${target.iid}`),
      );
      pipelineId = mr.head_pipeline?.id ?? null;
      if (pipelineId === null) {
        throw new Error(
          `${project}!${target.iid} has no pipeline yet. Start one with \`bb gitlab-ui run\`.`,
        );
      }
    }
    if (pipelineId !== null) {
      return {
        project,
        pipeline: gitlabPipelineRowSchema.parse(
          await gitlabApi(project, `${base}/pipelines/${pipelineId}`),
        ),
      };
    }
    // The pipeline list works on every GitLab version; pipelines/latest is newer.
    const ref = selector.ref ?? (await getDefaultBranch(project));
    const [latest] = z
      .array(gitlabPipelineRowSchema.nullable().catch(null))
      .catch([])
      .parse(
        await gitlabApi(
          project,
          `${base}/pipelines?ref=${encodeURIComponent(ref)}&order_by=id&sort=desc&per_page=1`,
        ),
      );
    if (latest == null) {
      throw new Error(`No pipeline on ${ref} in ${project}.`);
    }
    return { project, pipeline: latest };
  }

  async function getDefaultBranch(project: string): Promise<string> {
    const { default_branch } = z
      .looseObject({ default_branch: z.string().catch("") })
      .parse(await gitlabApi(project, projectApiBase(project)));
    if (default_branch.length === 0) {
      throw new Error(`${project} has no default branch; pass --ref.`);
    }
    return default_branch;
  }

  // -------------------------------------------------------------------
  // Pipeline core: one implementation behind both `bb gitlab-ui` and the
  // panel's rpc methods, so the write paths are exercised by either.
  // -------------------------------------------------------------------

  /** The last `lines` of a job's log. The trace is plain text, not JSON. */
  async function coreJobTrace(
    project: string,
    jobId: number,
    lines: number,
  ): Promise<string> {
    const { host } = parseProjectRef(project);
    const trace = await glab(
      ["api", "--hostname", host, `${projectApiBase(project)}/jobs/${jobId}/trace`],
      60_000,
    );
    return tailJobLog(trace, lines);
  }

  /** Retry, play (manual), or cancel one job — only if its status allows it. */
  async function coreJobAction(
    project: string,
    jobId: number,
    action: "retry" | "play" | "cancel",
  ): Promise<PipelineJobRow> {
    const current = await getJob(project, jobId);
    if (!jobActions(current.status)[action]) {
      throw new Error(
        `Job ${current.name} is ${current.status}; ${action} is not available for that status.`,
      );
    }
    return gitlabPipelineJobRowSchema.parse(
      await gitlabApi(
        project,
        `${projectApiBase(project)}/jobs/${jobId}/${action}`,
        { method: "POST" },
      ),
    );
  }

  /** Re-run a pipeline's failed and canceled jobs. */
  async function coreRetryPipeline(
    project: string,
    pipelineId: number,
  ): Promise<{ pipeline: PipelineRow; retried: PipelineJobRow[] }> {
    const jobs = await listPipelineJobs(project, pipelineId);
    const retried = retryableJobs(jobs);
    if (retried.length === 0) {
      throw new Error(
        `Pipeline #${pipelineId} has no failed or canceled jobs to retry.`,
      );
    }
    const pipeline = gitlabPipelineRowSchema.parse(
      await gitlabApi(
        project,
        `${projectApiBase(project)}/pipelines/${pipelineId}/retry`,
        { method: "POST" },
      ),
    );
    return { pipeline, retried };
  }

  async function coreCancelPipeline(
    project: string,
    pipelineId: number,
  ): Promise<PipelineRow> {
    return gitlabPipelineRowSchema.parse(
      await gitlabApi(
        project,
        `${projectApiBase(project)}/pipelines/${pipelineId}/cancel`,
        { method: "POST" },
      ),
    );
  }

  /** A new pipeline on a branch, or the merge-request pipeline of an MR. */
  async function coreRunPipeline(
    project: string,
    options: { ref?: string; mergeRequestIid?: number },
  ): Promise<{ pipeline: PipelineRow; ref: string | null }> {
    const base = projectApiBase(project);
    if (options.mergeRequestIid !== undefined) {
      return {
        pipeline: gitlabPipelineRowSchema.parse(
          await gitlabApi(
            project,
            `${base}/merge_requests/${options.mergeRequestIid}/pipelines`,
            { method: "POST" },
          ),
        ),
        ref: null,
      };
    }
    const ref = options.ref ?? (await getDefaultBranch(project));
    return {
      pipeline: gitlabPipelineRowSchema.parse(
        await gitlabApi(project, `${base}/pipeline?ref=${encodeURIComponent(ref)}`, {
          method: "POST",
        }),
      ),
      ref,
    };
  }

  async function listPipelineJobs(
    project: string,
    pipelineId: number,
  ): Promise<PipelineJobRow[]> {
    return gitlabPipelineJobListSchema
      .parse(
        await gitlabApi(
          project,
          `${projectApiBase(project)}/pipelines/${pipelineId}/jobs?per_page=100`,
        ),
      )
      .filter((job): job is PipelineJobRow => job !== null)
      .sort((left, right) => left.id - right.id);
  }

  /** Jobs whose logs `bb gitlab-ui pipeline` prints, so output stays bounded. */
  const MAX_LOGGED_JOBS = 5;

  async function cliPipeline(
    command: Extract<GitlabCliCommand, { sub: "pipeline" }>,
    ctx: PluginCliContext,
  ): Promise<string> {
    const { project, pipeline } = await resolveCliPipeline(command, ctx);
    const jobs = await listPipelineJobs(project, pipeline.id);
    const failed = jobs.filter((job) => job.status === "failed");
    const logs = new Map<number, string>();
    if (command.logs > 0) {
      await Promise.all(
        failed.slice(0, MAX_LOGGED_JOBS).map(async (job) => {
          try {
            logs.set(job.id, await coreJobTrace(project, job.id, command.logs));
          } catch (error) {
            logs.set(
              job.id,
              `(log unavailable: ${error instanceof Error ? error.message : String(error)})`,
            );
          }
        }),
      );
    }

    if (command.json) {
      return JSON.stringify(
        {
          project,
          pipeline: {
            id: pipeline.id,
            status: pipeline.status,
            ref: pipeline.ref,
            sha: pipeline.sha,
            url: pipeline.web_url,
          },
          jobs: jobs.map((job) => ({
            id: job.id,
            name: job.name,
            stage: job.stage,
            status: job.status,
            allowFailure: job.allow_failure,
            url: job.web_url,
            ...(logs.has(job.id) ? { log: logs.get(job.id) } : {}),
          })),
        },
        null,
        2,
      );
    }

    const width = (values: string[]): number =>
      Math.max(0, ...values.map((value) => value.length));
    const statusWidth = width(jobs.map((job) => job.status));
    const stageWidth = width(jobs.map((job) => job.stage));
    const sections = [
      [
        `Pipeline #${pipeline.id} ${pipeline.status} · ${pipeline.ref} @ ${pipeline.sha.slice(0, 8)}`,
        pipeline.web_url,
      ].join("\n"),
      jobs.length === 0
        ? "No jobs: GitLab created none, usually a CI config or rules error. Open the URL above."
        : jobs
            .map(
              (job) =>
                `  ${job.status.padEnd(statusWidth)}  ${job.stage.padEnd(stageWidth)}  ${job.name}${
                  job.allow_failure && job.status === "failed"
                    ? " (allowed to fail)"
                    : ""
                }  [job ${job.id}]`,
            )
            .join("\n"),
    ];
    for (const job of failed) {
      const log = logs.get(job.id);
      if (log === undefined) continue;
      sections.push(
        `── ${job.name} (job ${job.id}) · last ${command.logs} lines ──\n${
          log.length > 0 ? log : "(empty log)"
        }`,
      );
    }
    if (failed.length > MAX_LOGGED_JOBS && command.logs > 0) {
      sections.push(
        `${failed.length - MAX_LOGGED_JOBS} more failed job(s) not shown; ` +
          "read one with `bb gitlab-ui pipeline <job URL>` or glab.",
      );
    }
    return sections.join("\n\n");
  }

  async function cliRetry(
    command: Extract<GitlabCliCommand, { sub: "retry" }>,
    ctx: PluginCliContext,
  ): Promise<string> {
    const retryJob = async (project: string, job: PipelineJobRow) => {
      const action = jobActions(job.status).play ? "play" : "retry";
      const next = await coreJobAction(project, job.id, action);
      return `${action === "play" ? "Started" : "Retried"} job ${job.name} as job ${next.id} (${next.status}).\n${next.web_url}`;
    };

    // A job URL with no --job retries that job, without a pipeline lookup.
    if (command.job === null && command.target !== null) {
      const target = await resolveCliTarget(command.target, ctx);
      if (target.kind === "job" && command.pipelineId === null) {
        return retryJob(target.project, await getJob(target.project, target.id));
      }
    }

    const { project, pipeline } = await resolveCliPipeline(command, ctx);
    const jobs = await listPipelineJobs(project, pipeline.id);
    if (command.job !== null) {
      const wanted = command.job;
      const asId = parsePositiveInt(wanted);
      const job =
        jobs.find((entry) => asId !== null && entry.id === asId) ??
        jobs.find((entry) => entry.name === wanted);
      if (job === undefined) {
        throw new Error(
          `No job "${wanted}" in pipeline #${pipeline.id}. Jobs: ${
            jobs.map((entry) => entry.name).join(", ") || "none"
          }.`,
        );
      }
      return retryJob(project, job);
    }
    const retryable = retryableJobs(jobs);
    if (retryable.length === 0) {
      return (
        `Nothing to retry: pipeline #${pipeline.id} (${pipeline.status}) has no ` +
        "failed or canceled jobs. Start a fresh one with `bb gitlab-ui run`."
      );
    }
    const { pipeline: retried } = await coreRetryPipeline(project, pipeline.id);
    return [
      `Retrying ${retryable.length} job(s) in pipeline #${retried.id} (now ${retried.status}): ${retryable
        .map((job) => job.name)
        .join(", ")}`,
      retried.web_url,
    ].join("\n");
  }

  async function cliRun(
    command: Extract<GitlabCliCommand, { sub: "run" }>,
    ctx: PluginCliContext,
  ): Promise<string> {
    const target = await resolveCliTarget(command.target, ctx);
    if (target.kind === "mr") {
      if (command.ref !== null) {
        throw new Error(
          "A merge-request pipeline runs on its source branch; drop --ref, or pass the project instead.",
        );
      }
      const { pipeline } = await coreRunPipeline(target.project, {
        mergeRequestIid: target.iid,
      });
      return `Started pipeline #${pipeline.id} for ${target.project}!${target.iid} (${pipeline.status}).\n${pipeline.web_url}`;
    }
    if (target.kind !== "project") {
      throw new Error(
        "`run` takes a project or a merge request; to re-run an existing pipeline use `bb gitlab-ui retry`.",
      );
    }
    const { pipeline, ref } = await coreRunPipeline(target.project, {
      ...(command.ref === null ? {} : { ref: command.ref }),
    });
    return `Started pipeline #${pipeline.id} on ${ref} in ${target.project} (${pipeline.status}).\n${pipeline.web_url}`;
  }

  async function cliList(
    command: Extract<GitlabCliCommand, { sub: "issues" | "mrs" }>,
  ): Promise<string> {
    const kind = command.sub === "mrs" ? "mr" : "issue";
    const marker = kind === "mr" ? "!" : "#";
    const { filters } = command;
    const cached = listCachedItems({
      kind,
      project: command.project ?? undefined,
    });
    if (cached.length === 0) {
      return "Nothing cached. Run `bb gitlab-ui sync` first.";
    }

    // "@me" is per host: the glab user can differ between instances.
    const viewers = new Map<string, string>();
    const usesMe =
      filters.mine ||
      filters.author === "@me" ||
      filters.assignee === "@me" ||
      filters.reviewer === "@me";
    if (usesMe) {
      await ensureGlab();
      const hosts = new Set(
        cached.map((item) => parseProjectRef(item.project).host),
      );
      for (const host of hosts) {
        viewers.set(host, (await getViewer(host)).toLowerCase());
      }
    }
    const who = (name: string, project: string): string =>
      name === "@me"
        ? (viewers.get(parseProjectRef(project).host) ?? "")
        : name.replace(/^@/, "").toLowerCase();
    const assignee = filters.mine ? "@me" : filters.assignee;
    const wantedLabels = filters.labels.map((label) => label.toLowerCase());

    let items = cached.filter((item) => {
      if (filters.state === "open" && item.state !== "opened") return false;
      if (filters.state === "closed" && item.state !== "closed") return false;
      if (filters.state === "merged" && item.state !== "merged") return false;
      if (filters.draft && !item.draft) return false;
      if (
        filters.author !== null &&
        item.author.toLowerCase() !== who(filters.author, item.project)
      ) {
        return false;
      }
      if (
        assignee !== null &&
        !item.assignees.some(
          (name) => name.toLowerCase() === who(assignee, item.project),
        )
      ) {
        return false;
      }
      if (
        filters.reviewer !== null &&
        !item.reviewers.some(
          (name) => name.toLowerCase() === who(filters.reviewer ?? "", item.project),
        )
      ) {
        return false;
      }
      const labels = item.labels.map((label) => label.toLowerCase());
      return wantedLabels.every((label) => labels.includes(label));
    });
    if (filters.limit !== null) items = items.slice(0, filters.limit);

    if (filters.json) {
      return JSON.stringify(
        items.map(({ body: _body, ...item }) => item),
        null,
        2,
      );
    }
    if (items.length === 0) {
      return `No matching ${kind === "mr" ? "merge requests" : "issues"}.`;
    }
    return items
      .map(
        (item) =>
          `${item.project}${marker}${item.iid}\t[${
            item.draft ? "draft" : item.state
          }]\t${item.title}`,
      )
      .join("\n");
  }

  bb.cli.register({
    name: "gitlab-ui",
    summary: "Browse tracked GitLab projects, issues, merge requests, and pipelines",
    commands: [
      {
        name: "projects",
        summary: "List tracked GitLab projects",
        usage: "bb gitlab-ui projects [--json]",
      },
      {
        name: "issues",
        summary: "List cached issues, filtered by state, author, assignee, label",
        usage:
          "bb gitlab-ui issues [host/group/project] [--state open|closed|all] [--mine] " +
          "[--author <user|@me>] [--assignee <user|@me>] [--label <name>]... [--limit <n>] [--json]",
      },
      {
        name: "mrs",
        summary: "List cached merge requests, filtered by state, author, assignee, label, draft",
        usage:
          "bb gitlab-ui mrs [host/group/project] [--state open|closed|merged|all] [--mine] " +
          "[--author <user|@me>] [--assignee <user|@me>] [--reviewer <user|@me>] [--label <name>]... [--draft] [--limit <n>] [--json]",
      },
      {
        name: "sync",
        summary: "Refresh the cache from GitLab now",
        usage: "bb gitlab-ui sync",
      },
      {
        name: "show",
        summary: "Show an issue or merge request live, with its comments",
        usage: "bb gitlab-ui show <host/group/project#iid | host/group/project!iid | URL> [--json]",
      },
      {
        name: "comment",
        summary: "Add a comment to an issue or merge request",
        usage: "bb gitlab-ui comment <host/group/project#iid | host/group/project!iid | URL> <text…>",
      },
      {
        name: "pipeline",
        summary: "Show a pipeline's status and jobs, with the tail of failed-job logs",
        usage:
          "bb gitlab-ui pipeline [project | MR | pipeline/job URL] [--ref <branch> | --pipeline <id>] " +
          "[--logs <n>] [--json]",
      },
      {
        name: "retry",
        summary: "Retry a pipeline's failed jobs, or one job with --job",
        usage:
          "bb gitlab-ui retry [project | MR | pipeline/job URL] [--ref <branch> | --pipeline <id>] " +
          "[--job <id|name>]",
      },
      {
        name: "run",
        summary: "Start a new pipeline on a branch or for a merge request",
        usage: "bb gitlab-ui run [project | MR] [--ref <branch>]",
      },
    ],
    async run(argv, ctx) {
      const command = parseGitlabCliArgs(argv);
      if ("error" in command) {
        return { exitCode: 1, stderr: `${command.error}\n${USAGE}` };
      }
      try {
        let stdout: string;
        switch (command.sub) {
          case "help":
            stdout = USAGE;
            break;
          case "projects": {
            const projects = await discoverProjects(true);
            if (command.json) {
              stdout = JSON.stringify(projects, null, 2);
            } else if (projects.length === 0) {
              stdout =
                "No tracked projects. Attach a BB project whose checkout has a GitLab " +
                "origin remote, or set extraProjects.";
            } else {
              stdout = projects
                .map(
                  (entry) =>
                    `${entry.project}${
                      entry.bbProjectId !== null ? `\t(${entry.bbProjectId})` : ""
                    }`,
                )
                .join("\n");
            }
            break;
          }
          case "issues":
          case "mrs":
            stdout = await cliList(command);
            break;
          case "sync": {
            const { projects, items } = await syncAll(true);
            stdout = `Synced ${items} item(s) across ${projects} project(s).`;
            break;
          }
          case "show":
            stdout = await cliShow(command.target, command.json, ctx);
            break;
          case "comment":
            stdout = await cliComment(command.target, command.body, ctx);
            break;
          case "pipeline":
            stdout = await cliPipeline(command, ctx);
            break;
          case "retry":
            stdout = await cliRetry(command, ctx);
            break;
          case "run":
            stdout = await cliRun(command, ctx);
            break;
        }
        return { exitCode: 0, stdout: clipOutput(stdout) };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
