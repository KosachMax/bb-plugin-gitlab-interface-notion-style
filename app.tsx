// GitLab Interface (Notion style) — the frontend bundle.
//
// A GitLab panel shaped like a Notion database. Issues and merge requests are
// two views of one table: Notion's view tabs, a toolbar with filter pills and
// search (both editing the one persisted query string), hairline-ruled rows
// with hover-only actions, and a COUNT footer. Opening a row shows a Notion
// page: breadcrumbs, a 40px title, a property block whose value cells are the
// editors, page comments, then the description. Merge requests add Pipeline,
// Discussions, and Changes as toggle sections, the diffs rendered by
// @pierre/diffs in the host's code theme. "Send agent" / "Review with agent"
// sit wherever an issue or merge request shows up, and every spawned thread
// comes back as a ⚡ tag.
//
// Sub-navigation lives in the nav panel's subPath, so deep links are
// #/issues/<host>/<namespace/path>/<iid> and
// #/merge_requests/<host>/<namespace/path>/<iid> — parsed from the right
// (last segment is the iid, first is the host, everything between is the
// project path) so subgroups of any depth work. A threadPanelAction opens
// the same merge-request page in a thread's right panel, auto-resolved to
// that thread's merge request.
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  definePluginApp,
  Markdown,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginHomepageSectionProps,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { gitlabRpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/empty-state";
import {
  Avatar,
  Callout,
  ChipButton,
  ViewerContext,
  colorForName,
  EmptyValue,
  FilterPill,
  GhostButton,
  Icon,
  ICONS,
  Person,
  PrimaryButton,
  PROPERTY_CONTROL_CLASS,
  PropertyRow,
  StatusPill,
  Tag,
  ToggleCaret,
  ViewTab,
  type NotionColor,
} from "@/components/notion";
import {
  matchesQuery,
  NoMatches,
  SearchableMenuContent,
} from "@/components/searchable-menu";
import { cn } from "@/lib/utils";
import { mergeAllowance } from "@/lib/merge";
import {
  emojiFor,
  reviewVerdict,
  type Reaction,
} from "@/lib/review";
import {
  classifyJobStatus,
  formatDuration,
  isTerminalPipelineStatus,
  jobActions,
  mergeRequestIidFromRef,
  retryableJobs,
} from "@/lib/pipeline";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import {
  MARKER,
  matchesItemQuery,
  parseItemQuery,
  queryProject,
  queryText,
  queryTokens,
  withoutQualifiers,
  withQualifier,
  withQueryText,
  type Kind,
} from "@/lib/item-query";

// ---------------------------------------------------------------------------
// Shapes, mirroring the rpc contract in server.ts. Declared here rather than
// inferred so the panel's own reads are checked against the contract.
// ---------------------------------------------------------------------------

interface ProjectInfo {
  /** Host-qualified ref, e.g. "gitlab.com/group/subgroup/app". */
  project: string;
  host: string;
  path: string;
  bbProjectId: string | null;
}

interface Item {
  project: string;
  iid: number;
  kind: Kind;
  title: string;
  /** GitLab-native: "opened" | "closed" | "merged" | "locked". */
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

interface IssueDetail {
  project: string;
  iid: number;
  title: string;
  state: string;
  author: string;
  body: string;
  labels: string[];
  assignees: string[];
  url: string;
  updatedAt: string;
  notes: Note[];
}

interface Job {
  id: number;
  name: string;
  status: "success" | "failure" | "pending" | "neutral";
  /** GitLab's own word for it — "manual", "skipped", "canceled", … */
  rawStatus: string;
  url: string;
}

interface Discussion {
  id: string;
  /** A standalone comment rather than a thread. */
  individual: boolean;
  resolvable: boolean;
  /** "" for a thread that is not attached to a file. */
  path: string;
  line: number | null;
  resolved: boolean;
  notes: Note[];
}

interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** Raw unified diff, null when GitLab's copy is too big to inline. */
  patch: string | null;
}

interface MergeRequestDetail {
  project: string;
  iid: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  sourceBranch: string;
  targetBranch: string;
  /** GitLab's own file count; the files load when the Changes tab opens. */
  changedFiles: number;
  /** The head commit a merge from this page is pinned to. */
  headSha: string;
  /** The merge request's own settings, to prefill the merge dialog. */
  squash: boolean;
  removeSourceBranch: boolean;
  /** A merge is already queued behind the running pipeline. */
  mergeScheduled: boolean;
  labels: string[];
  assignees: string[];
  reviewers: string[];
  mergeStatus: string;
  hasConflicts: boolean;
  approvalsRequired: number;
  approvalsLeft: number;
  approvedBy: string[];
  pipeline: { id: number; status: string; url: string } | null;
  jobs: Job[];
  discussions: Discussion[];
  reactions: Reaction[];
}

interface PipelineSummary {
  id: number;
  status: string;
  ref: string;
  sha: string;
  source: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface PipelineJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  allowFailure: boolean;
  url: string;
  durationSeconds: number | null;
}

interface PipelineDetail extends PipelineSummary {
  user: string;
  durationSeconds: number | null;
  yamlErrors: string | null;
}

interface ThreadLink {
  kind: Kind;
  project: string;
  iid: number;
  threadId: string;
  createdAt: string;
}

type LinksMap = Record<string, ThreadLink[]>;

interface Status {
  glabOk: boolean;
  glabError: string | null;
  hosts: string[];
  projects: ProjectInfo[];
  lastSyncedAt: string | null;
}

/** The key `listLinks` files a spawned thread under. */
function linkKey(kind: Kind, project: string, iid: number): string {
  return `${kind}:${project}!${iid}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Panel memory. bb unmounts the panel when you switch to a thread and back,
// which used to throw away the open page, the tab, filters, and scroll. The
// last route survives reloads (localStorage); the rest lives for the session.
// ---------------------------------------------------------------------------

const ROUTE_KEY = "gitlab-ui:route";
const stickyStore = new Map<string, unknown>();

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage disabled — the panel just won't remember across reloads
  }
}

/**
 * Stale-while-revalidate for slow GitLab reads: a page shows what it last
 * loaded the instant it opens, while the fresh copy loads behind it.
 */
function cachedRead<T>(key: string): T | null {
  return (stickyStore.get(`swr:${key}`) as T | undefined) ?? null;
}

function cachedWrite<T>(key: string, value: T): void {
  stickyStore.set(`swr:${key}`, value);
}

/** State that outlives the component: same key, same value when it comes back. */
function useSticky<T>(
  key: string,
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() =>
    stickyStore.has(key) ? (stickyStore.get(key) as T) : initial,
  );
  const set = useCallback(
    (next: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        stickyStore.set(key, resolved);
        return resolved;
      }),
    [key],
  );
  return [value, set];
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** The trailing segment of a project ref — enough to identify it in a row. */
function shortProject(project: string): string {
  const parts = project.split("/");
  return parts[parts.length - 1] ?? project;
}

// ---------------------------------------------------------------------------
// Sub-routing — the navPanel owns /plugins/gitlab/gitlab/*, so sub-navigation
// lives in the route's subPath: "issues", "merge_requests", "new",
// "issues/<host>/<namespace/path>/<iid>". Deep-linkable, and browser
// back/forward walks panel history.
// ---------------------------------------------------------------------------

const PANEL_PATH = "gitlab-ui";

type Route =
  | { view: "issues" }
  | { view: "merge_requests" }
  | { view: "new" }
  | { view: "pipelines" }
  | { view: "branches" }
  | { view: "pipeline"; project: string; id: number }
  | { view: "issue"; project: string; iid: number }
  | { view: "merge_request"; project: string; iid: number };

/**
 * `[host, ...namespace, iid]` → a project ref plus its iid. Parsed from the
 * right because a GitLab namespace has any number of segments.
 */
function parseItemPath(
  parts: string[],
): { project: string; iid: number } | null {
  if (parts.length < 3) return null;
  const iid = Number(parts[parts.length - 1]);
  if (!Number.isInteger(iid) || iid <= 0) return null;
  return { project: parts.slice(0, -1).join("/"), iid };
}

function parseSubPath(subPath: string): Route {
  const parts = subPath.split("/").filter((part) => part.length > 0);
  if (parts[0] === "merge_requests") {
    const item = parseItemPath(parts.slice(1));
    return item === null
      ? { view: "merge_requests" }
      : { view: "merge_request", project: item.project, iid: item.iid };
  }
  if (parts[0] === "new") return { view: "new" };
  if (parts[0] === "branches") return { view: "branches" };
  if (parts[0] === "pipelines") {
    const item = parseItemPath(parts.slice(1));
    return item === null
      ? { view: "pipelines" }
      : { view: "pipeline", project: item.project, id: item.iid };
  }
  if (parts[0] === "issues") {
    const item = parseItemPath(parts.slice(1));
    return item === null
      ? { view: "issues" }
      : { view: "issue", project: item.project, iid: item.iid };
  }
  return { view: "issues" };
}

function routeToSubPath(route: Route): string {
  switch (route.view) {
    case "issues":
      return "issues";
    case "merge_requests":
      return "merge_requests";
    case "new":
      return "new";
    case "pipelines":
      return "pipelines";
    case "branches":
      return "branches";
    case "pipeline":
      return `pipelines/${route.project}/${route.id}`;
    case "issue":
      return `issues/${route.project}/${route.iid}`;
    case "merge_request":
      return `merge_requests/${route.project}/${route.iid}`;
  }
}

function useSubPathRoute(subPath: string): [Route, (route: Route) => void] {
  const bbNavigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const navigate = useCallback(
    (next: Route) => {
      bbNavigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(next) });
    },
    [bbNavigate],
  );
  return [route, navigate];
}

// ---------------------------------------------------------------------------
// Data hooks.
// ---------------------------------------------------------------------------

interface ItemQuery {
  kind: Kind;
  /** null = every tracked project. */
  project?: string | null;
  state?: "open" | "closed";
}

/**
 * Cached items for one kind. The list view filters what comes back with the
 * panel's own query grammar; the coarse `project`/`state` arguments exist for
 * the surfaces that only ever want one slice (homepage, merge-request picker).
 */
function useItems({ kind, project = null, state }: ItemQuery): {
  items: Item[] | null;
  error: string | null;
  reload: () => void;
} {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [result, setResult] = useState<{
    items: Item[] | null;
    error: string | null;
  }>({ items: null, error: null });
  const reload = useCallback(() => {
    rpc
      .call("listItems", {
        kind,
        ...(project === null ? {} : { project }),
        ...(state === undefined ? {} : { state }),
      })
      .then(
        (value) => setResult({ items: value.items, error: null }),
        (error: unknown) =>
          setResult({ items: null, error: errorText(error) }),
      );
  }, [rpc, kind, project, state]);
  useEffect(() => {
    reload();
  }, [reload]);
  useRealtime("data-changed", reload);
  return { ...result, reload };
}

function useStatus(): Status | null {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const reload = useCallback(() => {
    rpc.call("status").then(
      (value) => setStatus(value),
      () => {},
    );
  }, [rpc]);
  useEffect(() => {
    reload();
  }, [reload]);
  useRealtime("data-changed", reload);
  return status;
}

function useLinks(): LinksMap {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [links, setLinks] = useState<LinksMap>({});
  const reload = useCallback(() => {
    rpc.call("listLinks").then(
      (value) => setLinks(value.links),
      () => {},
    );
  }, [rpc]);
  useEffect(() => {
    reload();
  }, [reload]);
  useRealtime("links-changed", reload);
  return links;
}

function useSpawn(): {
  spawn: (kind: Kind, project: string, iid: number) => void;
  spawningKey: string | null;
} {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const navigate = useBbNavigate();
  const [spawningKey, setSpawningKey] = useState<string | null>(null);
  const spawn = useCallback(
    (kind: Kind, project: string, iid: number) => {
      setSpawningKey(linkKey(kind, project, iid));
      rpc
        .call(kind === "mr" ? "startReview" : "startWork", { project, iid })
        .then((result) => navigate.toThread(result.threadId))
        .catch((error: unknown) => toast.error(errorText(error)))
        .finally(() => setSpawningKey(null));
    },
    [rpc, navigate],
  );
  return { spawn, spawningKey };
}

/** The glab viewer's username, cached at module level — one fetch per load. */
let viewerUsername: string | null = null;

function useViewer(): string | null {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [username, setUsername] = useState<string | null>(viewerUsername);
  useEffect(() => {
    if (viewerUsername !== null) return;
    rpc.call("viewer").then(
      (result) => {
        viewerUsername = result.username;
        setUsername(result.username);
      },
      () => {},
    );
  }, [rpc]);
  return username;
}

function useItemMutations() {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const setIssueState = useCallback(
    (project: string, iid: number, state: "open" | "closed") =>
      rpc
        .call("setIssueState", { project, iid, state })
        .then(() =>
          toast.success(
            state === "closed" ? `#${iid} closed` : `#${iid} reopened`,
          ),
        ),
    [rpc],
  );
  const setAssignees = useCallback(
    (project: string, iid: number, assignees: string[], kind: Kind = "issue") =>
      rpc.call("setAssignees", { project, iid, assignees, kind }),
    [rpc],
  );
  const setReviewers = useCallback(
    (project: string, iid: number, reviewers: string[]) =>
      rpc.call("setReviewers", { project, iid, reviewers }),
    [rpc],
  );
  const setLabels = useCallback(
    (project: string, iid: number, labels: string[], kind: Kind = "issue") =>
      rpc.call("setLabels", { project, iid, labels, kind }),
    [rpc],
  );
  return { setIssueState, setAssignees, setReviewers, setLabels };
}

// ---------------------------------------------------------------------------
// Shared bits, in Notion's vocabulary (see components/notion.tsx).
// ---------------------------------------------------------------------------

/** GitLab state → a Notion status color. Draft wins only while still open. */
function stateColor(state: string, draft = false): NotionColor {
  if (state === "opened") return draft ? "default" : "green";
  if (state === "merged") return "purple";
  if (state === "locked") return "gray";
  return "red";
}

function stateLabel(state: string, draft = false): string {
  if (state === "opened") return draft ? "Draft" : "Open";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function StateStatus({ state, draft }: { state: string; draft?: boolean }) {
  return (
    <StatusPill
      color={stateColor(state, draft)}
      // Open is the expected state; only the exceptions get a fill.
      quiet={state === "opened" && !draft}
    >
      {stateLabel(state, draft)}
    </StatusPill>
  );
}

/** A GitLab pipeline or job status → a Notion status color. */
function pipelineColor(status: string): NotionColor {
  switch (status) {
    case "success":
      return "green";
    case "failed":
      return "red";
    case "running":
      return "blue";
    case "pending":
    case "created":
    case "preparing":
    case "scheduled":
    case "waiting_for_resource":
      return "yellow";
    case "manual":
      return "purple";
    default:
      // canceled, skipped, and whatever GitLab adds later
      return "gray";
  }
}

function PipelineStatus({ status }: { status: string }) {
  const label = status.length > 0 ? status.replace(/_/g, " ") : "unknown";
  return (
    <StatusPill
      color={pipelineColor(status)}
      pulse={status === "running"}
      // Passing is the expected state; a failure should be the loud one.
      quiet={status === "success"}
    >
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </StatusPill>
  );
}

// GitLab's own label colors, shared by every surface. They load with the
// per-project directory; until then a label falls back to a stable hue.
const labelColorStore = {
  colors: {} as Record<string, string>,
  version: 0,
  listeners: new Set<() => void>(),
};

function mergeLabelColors(colors: Record<string, string>) {
  let changed = false;
  for (const [name, hex] of Object.entries(colors)) {
    if (labelColorStore.colors[name] !== hex) {
      labelColorStore.colors[name] = hex;
      changed = true;
    }
  }
  if (!changed) return;
  labelColorStore.version += 1;
  for (const listener of labelColorStore.listeners) listener();
}

function useLabelColors(): Record<string, string> {
  useSyncExternalStore(
    (listener) => {
      labelColorStore.listeners.add(listener);
      return () => labelColorStore.listeners.delete(listener);
    },
    () => labelColorStore.version,
  );
  return labelColorStore.colors;
}

/**
 * A label is a quiet gray tag with a dot in the label's own GitLab color:
 * recognizable, and a row of labels no longer reads as a rainbow.
 */
function LabelTag({ label }: { label: string }) {
  const colors = useLabelColors();
  return (
    <Tag dot={colors[label] ?? colorForName(label)} title={label}>
      {label}
    </Tag>
  );
}

/** Multi-select labels. */
function LabelTags({ labels, max }: { labels: string[]; max?: number }) {
  if (labels.length === 0) return null;
  const shown = max === undefined ? labels : labels.slice(0, max);
  return (
    <>
      {shown.map((label) => (
        <LabelTag key={label} label={label} />
      ))}
      {max !== undefined && labels.length > max ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          +{labels.length - max}
        </span>
      ) : null}
    </>
  );
}

function ThreadPills({ links }: { links: ThreadLink[] | undefined }) {
  const navigate = useBbNavigate();
  if (links === undefined || links.length === 0) return null;
  return (
    <>
      {links.map((link, index) => (
        <button
          key={link.threadId}
          type="button"
          title={`Open BB thread ${link.threadId}`}
          onClick={(event) => {
            event.stopPropagation();
            navigate.toThread(link.threadId);
          }}
          className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded bg-yellow-500/30 px-1.5 text-sm leading-5 text-yellow-950 transition-opacity hover:opacity-80 [.dark_&]:bg-yellow-400/45 [.dark_&]:text-yellow-50"
        >
          ⚡ agent{links.length > 1 ? ` ${index + 1}` : ""}
        </button>
      ))}
    </>
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-3 pt-14">
      <Skeleton className="h-10 w-3/4" />
      <div className="flex flex-col gap-2 pt-4">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-48" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-6 h-32 w-full" />
    </div>
  );
}

/** A Notion page comment: avatar, name, time, body (long ones fold). */
function CommentItem({ note }: { note: Note }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = bodyRef.current;
    if (element !== null) setOverflows(element.scrollHeight > element.clientHeight + 4);
  }, [note.body]);
  return (
    <div className="flex items-start gap-2 py-1.5">
      <Avatar username={note.author} size={24} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-sm">
          <span className="font-medium text-foreground">{note.author}</span>
          <span
            className="text-xs text-muted-foreground"
            title={formatDateTime(note.createdAt)}
          >
            {relativeTime(note.createdAt)}
          </span>
        </p>
        <div
          ref={bodyRef}
          className={cn(!expanded && "max-h-[7.5rem] overflow-hidden")}
        >
          <Markdown content={note.body} className="text-sm leading-relaxed" />
        </div>
        {overflows || expanded ? (
          <button
            type="button"
            className="mt-0.5 rounded px-1 text-sm text-muted-foreground transition-colors -ml-1 hover:bg-state-hover hover:text-foreground"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Comments past this many fold behind "N more comments", newest kept. */
const VISIBLE_COMMENTS = 3;

/**
 * Page comments, where Notion keeps them: between the properties and the
 * body. A one-line "Add a comment…" that grows; ⌘/Ctrl+Enter posts.
 */
function PageComments({
  method,
  project,
  iid,
  notes,
  onPosted,
}: {
  method: "commentIssue" | "commentMergeRequest";
  project: string;
  iid: number;
  notes: Note[];
  onPosted: () => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const viewer = useViewer();
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const post = useCallback(() => {
    if (body.trim().length === 0 || posting) return;
    setPosting(true);
    rpc
      .call(method, { project, iid, body })
      .then(() => {
        setBody("");
        onPosted();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPosting(false));
  }, [rpc, method, project, iid, body, posting, onPosted]);
  const ready = body.trim().length > 0;
  const [showAll, setShowAll] = useState(false);
  const hidden = showAll ? 0 : Math.max(0, notes.length - VISIBLE_COMMENTS);
  return (
    <div className="flex flex-col gap-1">
      {hidden > 0 ? (
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 self-start rounded-md px-1 text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          onClick={() => setShowAll(true)}
        >
          <Icon path={ICONS.comment} size={14} />
          {hidden} more comment{hidden === 1 ? "" : "s"}
        </button>
      ) : null}
      {notes.length > 0 ? (
        <div className="flex flex-col">
          {notes.slice(hidden).map((note, index) => (
            <CommentItem key={`${note.createdAt}-${hidden + index}`} note={note} />
          ))}
        </div>
      ) : null}
      <div className="flex items-start gap-2 py-1.5">
        <Avatar username={viewer ?? "me"} size={24} className="mt-0.5" />
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              post();
            }
          }}
          placeholder="Add a comment…"
          aria-label="New comment"
          rows={ready ? 3 : 1}
          className="min-h-6 flex-1 resize-none border-none bg-transparent px-0 py-0.5 text-sm leading-5 shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
        />
        {ready ? (
          <PrimaryButton
            className="h-6 px-2 text-xs"
            disabled={posting}
            onClick={post}
            title="Post comment (⌘/Ctrl+Enter)"
          >
            {posting ? "Posting…" : "Comment"}
          </PrimaryButton>
        ) : null}
      </div>
    </div>
  );
}

/** Notion's top bar on a page: breadcrumbs left, page actions right. */
function PageTopBar({
  crumbs,
  actions,
}: {
  crumbs: Array<{ label: string; title?: string; onClick?: () => void }>;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center gap-0.5 text-sm">
      {crumbs.map((crumb, index) => (
        <span key={index} className="flex min-w-0 items-center gap-0.5">
          {index > 0 ? (
            <span className="px-0.5 text-muted-foreground/50">/</span>
          ) : null}
          {crumb.onClick !== undefined ? (
            <button
              type="button"
              onClick={crumb.onClick}
              title={crumb.title}
              className="min-w-0 truncate rounded-md px-1.5 py-0.5 text-foreground/80 transition-colors hover:bg-state-hover hover:text-foreground"
            >
              {crumb.label}
            </button>
          ) : (
            <span
              title={crumb.title}
              className="min-w-0 truncate px-1.5 py-0.5 text-foreground"
            >
              {crumb.label}
            </span>
          )}
        </span>
      ))}
      <span className="flex-1" />
      {actions}
    </div>
  );
}

/** "⋯" page menu: open on GitLab, copy link. */
function PageMoreMenu({ url }: { url: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <GhostButton aria-label="More page actions" className="w-7 justify-center px-0">
          <Icon path={ICONS.more} />
        </GhostButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => window.open(url, "_blank")}>
          Open in GitLab ↗
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            navigator.clipboard.writeText(url).then(
              () => toast.success("Link copied"),
              () => toast.error("Could not copy the link"),
            );
          }}
        >
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The page's body text, at Notion's 16px reading size. */
function PageBody16({ body }: { body: string }) {
  return body.length > 0 ? (
    <Markdown
      content={body}
      className="text-base leading-normal [&_h1]:mt-8 [&_h1]:text-[1.875em] [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:text-[1.5em] [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:text-[1.25em] [&_h3]:font-semibold [&_h4]:text-[1em] [&_h4]:font-semibold"
    />
  ) : (
    <p className="text-base text-muted-foreground/50">No description.</p>
  );
}

// ---------------------------------------------------------------------------
// The database view: view tabs, a toolbar (filter, search, New), filter
// pills, and a Notion table. Pills and search both edit the one query string
// through lib/item-query, so the filter persists exactly as it always has.
// ---------------------------------------------------------------------------

type FilterKey =
  | "is"
  | "draft"
  | "assignee"
  | "reviewer"
  | "author"
  | "label"
  | "project";

interface FilterOption {
  /** The qualifier this option writes, e.g. `["is", "open"]`. */
  key: string;
  value: string;
  label: string;
  /** How the option draws in the menu; defaults to its label. */
  content?: React.ReactNode;
}

const FILTER_TITLES: Record<FilterKey, string> = {
  is: "Status",
  draft: "Draft",
  assignee: "Assignee",
  reviewer: "Reviewer",
  author: "Author",
  label: "Label",
  project: "Project",
};

const FILTER_ICONS: Record<FilterKey, string> = {
  is: ICONS.status,
  draft: ICONS.page,
  assignee: ICONS.user,
  reviewer: ICONS.users,
  author: ICONS.user,
  label: ICONS.list,
  project: ICONS.folder,
};

/** Which query tokens belong to a pill. `no:` rides with its property. */
function tokenBelongsTo(filter: FilterKey, key: string, value: string): boolean {
  const word = value.toLowerCase();
  switch (filter) {
    case "is":
      return key === "is" && word !== "draft";
    case "draft":
      return key === "is" && word === "draft";
    case "assignee":
      return key === "assignee" || (key === "no" && word === "assignee");
    case "reviewer":
      return key === "reviewer" || (key === "no" && word === "reviewer");
    case "label":
      return key === "label" || (key === "no" && word === "label");
    default:
      return key === filter;
  }
}

/** The state words a pill offers, in GitLab's own order. */
const STATE_OPTIONS: Record<Kind, Array<{ value: string; state: string }>> = {
  issue: [
    { value: "open", state: "opened" },
    { value: "closed", state: "closed" },
  ],
  mr: [
    { value: "open", state: "opened" },
    { value: "merged", state: "merged" },
    { value: "closed", state: "closed" },
    { value: "locked", state: "locked" },
  ],
};

/** Per-project people and labels from GitLab, fetched once and shared. */
const directoryCache = new Map<
  string,
  Promise<{ people: string[]; labels: string[] }>
>();

/**
 * Everyone and every label the given projects know, not just the ones on the
 * loaded rows: a filter that offers five names because five people appear in
 * the cache is useless on an instance with hundreds of members. Label colors
 * go to the shared store as a side effect.
 */
function useDirectory(
  projectRefs: string[],
  options: { people?: boolean } = {},
): { people: string[]; labels: string[] } {
  const wantPeople = options.people ?? true;
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [directory, setDirectory] = useState<{ people: string[]; labels: string[] }>({
    people: [],
    labels: [],
  });
  const key = `${wantPeople ? "p" : "-"}:${projectRefs.join("|")}`;
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      projectRefs.map((project) => {
        // A directory that included people also satisfies one that did not.
        const cacheKey = `${wantPeople ? "p" : "-"}:${project}`;
        let pending = directoryCache.get(`p:${project}`) ?? directoryCache.get(cacheKey);
        if (pending === undefined) {
          // Labels give every tag its GitLab color, so pages always want
          // them; the member list is only for filters and pickers.
          pending = Promise.all([
            wantPeople
              ? rpc.call("assignableUsers", { project })
              : Promise.resolve({ users: [] as string[] }),
            rpc.call("projectLabels", { project }),
          ]).then(([users, projectLabels]) => {
            mergeLabelColors(projectLabels.colors);
            return { people: users.users, labels: projectLabels.labels };
          });
          // A failed fetch must not be cached as an empty answer forever.
          pending.catch(() => directoryCache.delete(cacheKey));
          directoryCache.set(cacheKey, pending);
        }
        return pending.catch(() => ({ people: [] as string[], labels: [] as string[] }));
      }),
    ).then((all) => {
      if (cancelled) return;
      setDirectory({
        people: [...new Set(all.flatMap((entry) => entry.people))],
        labels: [...new Set(all.flatMap((entry) => entry.labels))],
      });
    });
    return () => {
      cancelled = true;
    };
    // `key` stands for the list's identity.
  }, [rpc, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return directory;
}

function useFilterOptions(
  kind: Kind,
  items: Item[] | null,
  projects: ProjectInfo[],
): Record<FilterKey, FilterOption[]> {
  const viewer = useViewer();
  const directory = useDirectory(projects.map((entry) => entry.project));
  return useMemo(() => {
    const users = new Set<string>(directory.people);
    const labels = new Set<string>(directory.labels);
    for (const item of items ?? []) {
      if (item.author.length > 0) users.add(item.author);
      for (const username of item.assignees) users.add(username);
      for (const username of item.reviewers) users.add(username);
      for (const label of item.labels) labels.add(label);
    }
    const people = [...users]
      .filter((username) => username !== viewer)
      .sort((a, b) => a.localeCompare(b));
    const me: FilterOption[] =
      viewer === null
        ? []
        : [
            {
              key: "",
              value: "@me",
              label: "Me",
              content: <Person username={`${viewer} (me)`} />,
            },
          ];
    const asPeople = (key: string): FilterOption[] => [
      ...me.map((option) => ({ ...option, key })),
      ...people.map((username) => ({
        key,
        value: username,
        label: username,
        content: <Person username={username} />,
      })),
    ];
    return {
      is: STATE_OPTIONS[kind].map((option) => ({
        key: "is",
        value: option.value,
        label: stateLabel(option.state),
        content: <StateStatus state={option.state} />,
      })),
      draft: [{ key: "is", value: "draft", label: "Draft only" }],
      assignee: [
        { key: "no", value: "assignee", label: "No assignee" },
        ...asPeople("assignee"),
      ],
      reviewer: [
        { key: "no", value: "reviewer", label: "No reviewer" },
        ...asPeople("reviewer"),
      ],
      author: asPeople("author"),
      label: [
        { key: "no", value: "label", label: "No label" },
        ...[...labels]
          .sort((a, b) => a.localeCompare(b))
          .map((label) => ({
            key: "label",
            value: label,
            label,
            content: <LabelTag label={label} />,
          })),
      ],
      project: projects.map((entry) => ({
        key: "project",
        value: entry.project,
        label: shortProject(entry.project),
      })),
    };
  }, [kind, items, projects, viewer, directory]);
}

function FilterPillMenu({
  filter,
  query,
  onQuery,
  options,
  defaultOpen,
  onClosed,
}: {
  filter: FilterKey;
  query: string;
  onQuery: (query: string) => void;
  options: FilterOption[];
  defaultOpen: boolean;
  onClosed: () => void;
}) {
  const tokens = queryTokens(query).filter((token) =>
    tokenBelongsTo(filter, token.key, token.value),
  );
  const selected = new Set(
    tokens.map((token) => `${token.key}:${token.value.toLowerCase()}`),
  );
  const isSelected = (option: FilterOption) =>
    selected.has(`${option.key}:${option.value.toLowerCase()}`);
  const chosen = options.filter(isSelected);
  // A value typed by hand that no option lists (an old username, say).
  const extra = tokens.filter(
    (token) =>
      !options.some(
        (option) =>
          option.key === token.key &&
          option.value.toLowerCase() === token.value.toLowerCase(),
      ),
  );
  const summary = [
    ...chosen.map((option) => option.label),
    ...extra.map((token) => token.value),
  ];
  const toggle = (option: FilterOption, on: boolean) => {
    onQuery(
      on
        ? withQualifier(query, option.key, option.value)
        : withoutQualifiers(
            query,
            (key, value) =>
              key === option.key &&
              value.toLowerCase() === option.value.toLowerCase(),
          ),
    );
  };
  const title = FILTER_TITLES[filter];
  return (
    <DropdownMenu
      defaultOpen={defaultOpen}
      onOpenChange={(open) => {
        if (!open) onClosed();
      }}
    >
      <DropdownMenuTrigger asChild>
        <FilterPill active={summary.length > 0}>
          <Icon path={FILTER_ICONS[filter]} size={14} />
          <span className="min-w-0 truncate">
            {filter === "draft"
              ? "Draft only"
              : summary.length > 0
                ? `${title}: ${summary.join(", ")}`
                : title}
          </span>
        </FilterPill>
      </DropdownMenuTrigger>
      <SearchableMenuContent
        title={title}
        placeholder={`Search ${title.toLowerCase()}…`}
        className={options.length > 8 ? "w-72" : undefined}
      >
        {(needle) => {
          // The chosen ones stay on top; the rest keep their order.
          const visible = options
            .filter((option) => matchesQuery(needle, option.label, option.value))
            .sort((a, b) => Number(isSelected(b)) - Number(isSelected(a)));
          return (
            <>
              {visible.length === 0 ? <NoMatches query={needle} /> : null}
              {visible.map((option) => (
                <DropdownMenuCheckboxItem
                  key={`${option.key}:${option.value}`}
                  checked={isSelected(option)}
                  onCheckedChange={(checked) => toggle(option, checked === true)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {option.content ?? (
                      <span className="truncate">{option.label}</span>
                    )}
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-muted-foreground"
                onSelect={() =>
                  onQuery(
                    withoutQualifiers(query, (key, value) =>
                      tokenBelongsTo(filter, key, value),
                    ),
                  )
                }
              >
                Delete filter
              </DropdownMenuItem>
            </>
          );
        }}
      </SearchableMenuContent>
    </DropdownMenu>
  );
}

function FilterBar({
  kind,
  items,
  projects,
  query,
  onQuery,
}: {
  kind: Kind;
  items: Item[] | null;
  projects: ProjectInfo[];
  query: string;
  onQuery: (query: string) => void;
}) {
  const options = useFilterOptions(kind, items, projects);
  // A pill added from "+ Filter" shows (and opens) before it has a value.
  const [pending, setPending] = useState<FilterKey | null>(null);
  const available: FilterKey[] = [
    "is",
    ...(kind === "mr" ? (["draft"] as const) : []),
    "assignee",
    ...(kind === "mr" ? (["reviewer"] as const) : []),
    "author",
    "label",
    ...(projects.length > 1 ? (["project"] as const) : []),
  ];
  const tokens = queryTokens(query);
  const shown = available.filter(
    (filter) =>
      filter === pending ||
      tokens.some((token) => tokenBelongsTo(filter, token.key, token.value)),
  );
  const addable = available.filter((filter) => !shown.includes(filter));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((filter) =>
        filter === "draft" ? (
          <FilterPill
            key={filter}
            active
            onClick={() =>
              onQuery(
                withoutQualifiers(query, (key, value) =>
                  tokenBelongsTo("draft", key, value),
                ),
              )
            }
            title="Remove the draft filter"
          >
            <Icon path={FILTER_ICONS.draft} size={14} />
            Draft only
          </FilterPill>
        ) : (
          <FilterPillMenu
            key={filter}
            filter={filter}
            query={query}
            onQuery={onQuery}
            options={options[filter]}
            defaultOpen={filter === pending}
            onClosed={() => setPending(null)}
          />
        ),
      )}
      {addable.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <GhostButton className="h-7 rounded-full px-2">
              <Icon path={ICONS.plus} size={14} />
              Filter
            </GhostButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {addable.map((filter) => (
              <DropdownMenuItem
                key={filter}
                onSelect={() => {
                  if (filter === "draft") {
                    onQuery(withQualifier(query, "is", "draft"));
                  } else {
                    setPending(filter);
                  }
                }}
              >
                <Icon path={FILTER_ICONS[filter]} className="text-muted-foreground" />
                {filter === "draft" ? "Draft only" : FILTER_TITLES[filter]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {shown.length > 0 ? (
        <GhostButton
          className="h-7 px-2 text-sm"
          onClick={() => {
            setPending(null);
            // Back to the default view (open items), keeping the search text.
            onQuery(withQueryText(DEFAULT_QUERY, queryText(query)));
          }}
        >
          Reset
        </GhostButton>
      ) : null}
    </div>
  );
}

/** Notion's toolbar search: an icon that opens into an inline field. */
function SearchBox({
  query,
  onQuery,
}: {
  query: string;
  onQuery: (query: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const text = queryText(query);
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(text.length > 0);
  const value = draft ?? text;
  if (!open && text.length === 0) {
    return (
      <GhostButton
        aria-label="Search"
        className="w-7 justify-center px-0"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        <Icon path={ICONS.search} />
      </GhostButton>
    );
  }
  return (
    <span className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground">
      <Icon path={ICONS.search} />
      <input
        ref={inputRef}
        autoFocus
        value={value}
        onChange={(event) => {
          setDraft(event.target.value);
          onQuery(withQueryText(query, event.target.value));
        }}
        onBlur={() => {
          setDraft(null);
          if (queryText(query).length === 0) setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(null);
            onQuery(withQueryText(query, ""));
            setOpen(false);
          }
        }}
        placeholder="Type to search…"
        aria-label="Search"
        spellCheck={false}
        className="w-44 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
      />
      {value.length > 0 ? (
        <button
          type="button"
          aria-label="Clear search"
          className="rounded text-muted-foreground hover:text-foreground"
          onMouseDown={(event) => {
            event.preventDefault();
            setDraft(null);
            onQuery(withQueryText(query, ""));
          }}
        >
          <Icon path={ICONS.close} size={14} />
        </button>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The table. Fixed column widths with hairline cell rules, a title column
// that grows, hover-only row actions, and a COUNT footer under the title.
// Narrow panels scroll the table sideways, as Notion does.
// ---------------------------------------------------------------------------

const CELL = "h-9 border-r border-border/70 px-2 align-middle last:border-r-0";

function HeaderCell({
  icon,
  children,
  className,
}: {
  icon: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "h-9 px-2 text-left align-middle text-sm font-normal text-muted-foreground",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon path={icon} />
        <span className="truncate">{children}</span>
      </span>
    </th>
  );
}

function RowMenu({ item }: { item: Item }) {
  const viewer = useViewer();
  const { setIssueState, setAssignees } = useItemMutations();
  const assignedToMe = viewer !== null && item.assignees.includes(viewer);
  const ref = `${MARKER[item.kind]}${item.iid}`;

  const toggleSelfAssign = () => {
    if (viewer === null) return;
    const next = assignedToMe
      ? item.assignees.filter((username) => username !== viewer)
      : [...item.assignees, viewer];
    setAssignees(item.project, item.iid, next)
      .then(() =>
        toast.success(
          assignedToMe ? `Unassigned from ${ref}` : `Assigned to ${ref}`,
        ),
      )
      .catch((error: unknown) => toast.error(errorText(error)));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ChipButton
          aria-label={`More actions for ${ref}`}
          className="w-6 justify-center px-0"
          onClick={(event) => event.stopPropagation()}
        >
          <Icon path={ICONS.more} size={14} />
        </ChipButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {item.kind === "issue" && viewer !== null ? (
          <DropdownMenuItem onSelect={toggleSelfAssign}>
            {assignedToMe ? "Unassign me" : "Assign to me"}
          </DropdownMenuItem>
        ) : null}
        {item.kind === "issue" ? (
          <DropdownMenuItem
            onSelect={() =>
              setIssueState(
                item.project,
                item.iid,
                item.state === "opened" ? "closed" : "open",
              ).catch((error: unknown) => toast.error(errorText(error)))
            }
          >
            {item.state === "opened" ? "Close issue" : "Reopen issue"}
          </DropdownMenuItem>
        ) : null}
        {item.kind === "issue" ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={() => window.open(item.url, "_blank")}>
          Open in GitLab ↗
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            navigator.clipboard.writeText(item.url).then(
              () => toast.success("Link copied"),
              () => toast.error("Could not copy the link"),
            );
          }}
        >
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Inline state control for issues; merge requests change state on GitLab. */
function StatusCell({ item }: { item: Item }) {
  const { setIssueState } = useItemMutations();
  const [pending, setPending] = useState(false);
  if (item.kind === "mr") {
    return <StateStatus state={item.state} draft={item.draft} />;
  }
  const change = (next: "open" | "closed") => {
    if ((item.state === "opened") === (next === "open")) return;
    setPending(true);
    setIssueState(item.project, item.iid, next)
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPending(false));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={pending}>
        <button
          type="button"
          className="rounded-full transition-opacity hover:opacity-80 disabled:opacity-50"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Change issue #${item.iid} state, currently ${stateLabel(item.state)}`}
          aria-busy={pending}
        >
          <StateStatus state={item.state} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => change("open")}>
          <StateStatus state="opened" />
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => change("closed")}>
          <StateStatus state="closed" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Up to one name and a "+N", the way a Notion person cell fits a narrow column. */
function PeopleCell({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={names.join(", ")}>
      <Person username={names[0]} />
      {names.length > 1 ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          +{names.length - 1}
        </span>
      ) : null}
    </span>
  );
}

function ItemRow({
  item,
  links,
  showProject,
  onOpen,
}: {
  item: Item;
  links: ThreadLink[] | undefined;
  showProject: boolean;
  onOpen: () => void;
}) {
  const { spawn, spawningKey } = useSpawn();
  const busy = spawningKey === linkKey(item.kind, item.project, item.iid);
  return (
    <tr
      className="group cursor-pointer border-b border-border/70 outline-none focus-visible:bg-state-hover"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) onOpen();
      }}
    >
      <td className={cn(CELL, "relative")}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-medium text-foreground">
            {item.title}
          </span>
          <ThreadPills links={links} />
        </span>
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 bg-background pl-1 pr-1.5 opacity-0 shadow-[-12px_0_8px_-4px_var(--background)] group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100">
          <ChipButton
            disabled={spawningKey !== null}
            title={item.kind === "issue" ? "Send agent" : "Review with agent"}
            aria-label={
              item.kind === "issue"
                ? `Send agent to issue #${item.iid}`
                : `Review merge request !${item.iid} with an agent`
            }
            className="w-6 justify-center px-0 text-sm"
            onClick={(event) => {
              event.stopPropagation();
              spawn(item.kind, item.project, item.iid);
            }}
          >
            {busy ? "…" : "⚡"}
          </ChipButton>
          <ChipButton
            aria-label={`Open ${MARKER[item.kind]}${item.iid}`}
            className="gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-[0.06em]"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            <Icon path={ICONS.peek} size={13} />
            Open
          </ChipButton>
          <RowMenu item={item} />
        </span>
      </td>
      <td className={cn(CELL, "text-muted-foreground")}>
        {MARKER[item.kind]}
        {item.iid}
      </td>
      <td className={CELL}>
        <StatusCell item={item} />
      </td>
      <td className={CELL}>
        <PeopleCell names={item.assignees} />
      </td>
      {item.kind === "mr" ? (
        <td className={CELL}>
          <PeopleCell names={item.reviewers} />
        </td>
      ) : null}
      <td className={CELL}>
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <LabelTags labels={item.labels} max={3} />
        </span>
      </td>
      {showProject ? (
        <td className={cn(CELL, "truncate")} title={item.project}>
          {shortProject(item.project)}
        </td>
      ) : null}
      <td
        className={cn(CELL, "whitespace-nowrap text-foreground")}
        title={formatDateTime(item.updatedAt)}
      >
        {relativeTime(item.updatedAt)}
      </td>
    </tr>
  );
}

function ItemsTable({
  kind,
  items,
  error,
  hasFilter,
  showProject,
  onOpenItem,
  onNew,
}: {
  kind: Kind;
  items: Item[] | null;
  error: string | null;
  hasFilter: boolean;
  showProject: boolean;
  onOpenItem: (project: string, iid: number) => void;
  onNew?: () => void;
}) {
  const links = useLinks();
  const noun = kind === "mr" ? "merge requests" : "issues";
  const columns = 6 + (showProject ? 1 : 0) + (kind === "mr" ? 1 : 0);

  let rows: React.ReactNode;
  if (error !== null) {
    rows = (
      <tr>
        <td colSpan={columns} className="py-4">
          <Callout icon="⚠️">{error}</Callout>
        </td>
      </tr>
    );
  } else if (items === null) {
    rows = [0, 1, 2, 3, 4].map((row) => (
      <tr key={row} className="border-b border-border/70">
        {Array.from({ length: columns }, (_, cell) => (
          <td key={cell} className={CELL}>
            <Skeleton className={cell === 0 ? "h-3.5 w-3/4" : "h-3.5 w-2/3"} />
          </td>
        ))}
      </tr>
    ));
  } else if (items.length === 0) {
    rows = (
      <tr className="border-b border-border/70">
        <td colSpan={columns} className="h-9 px-2 text-sm text-muted-foreground">
          {hasFilter ? `No ${noun} match these filters.` : `No ${noun} yet.`}
        </td>
      </tr>
    );
  } else {
    rows = items.map((item) => (
      <ItemRow
        key={linkKey(item.kind, item.project, item.iid)}
        item={item}
        links={links[linkKey(kind, item.project, item.iid)]}
        showProject={showProject}
        onOpen={() => onOpenItem(item.project, item.iid)}
      />
    ));
  }

  return (
    <div className="overflow-x-auto">
      <table
        className={cn(
          "w-full table-fixed border-collapse text-sm",
          columns >= 8 ? "min-w-[1240px]" : columns === 7 ? "min-w-[1080px]" : "min-w-[900px]",
        )}
      >
        <colgroup>
          <col />
          <col className="w-[76px]" />
          <col className="w-[104px]" />
          <col className="w-[170px]" />
          {kind === "mr" ? <col className="w-[170px]" /> : null}
          <col className="w-[200px]" />
          {showProject ? <col className="w-[150px]" /> : null}
          <col className="w-[96px]" />
        </colgroup>
        <thead>
          <tr className="border-b border-border/70">
            <HeaderCell icon={ICONS.title}>Name</HeaderCell>
            <HeaderCell icon={ICONS.hash}>ID</HeaderCell>
            <HeaderCell icon={ICONS.status}>Status</HeaderCell>
            <HeaderCell icon={ICONS.users}>Assignee</HeaderCell>
            {kind === "mr" ? (
              <HeaderCell icon={ICONS.users}>Reviewer</HeaderCell>
            ) : null}
            <HeaderCell icon={ICONS.list}>Labels</HeaderCell>
            {showProject ? (
              <HeaderCell icon={ICONS.folder}>Project</HeaderCell>
            ) : null}
            <HeaderCell icon={ICONS.clock}>Updated</HeaderCell>
          </tr>
        </thead>
        <tbody>
          {rows}
          {onNew !== undefined ? (
            <tr
              className="cursor-pointer border-b border-border/70 text-muted-foreground transition-colors hover:bg-state-hover"
              onClick={onNew}
            >
              <td colSpan={columns} className="h-9 px-2">
                <span className="flex items-center gap-1.5">
                  <Icon path={ICONS.plus} />
                  New issue
                </span>
              </td>
            </tr>
          ) : null}
        </tbody>
        {items !== null && items.length > 0 ? (
          <tfoot>
            <tr>
              <td className="h-9 px-2 text-right">
                <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                  Count
                </span>
                <span className="ml-1.5 text-sm text-foreground">
                  {items.length}
                </span>
              </td>
              <td colSpan={columns - 1} />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/** One database: title, view tabs, toolbar, filters, table. */
function DatabaseView({
  route,
  navigate,
  projects,
  query,
  onQuery,
}: {
  route: Route;
  navigate: (route: Route) => void;
  projects: ProjectInfo[];
  query: string;
  onQuery: (query: string) => void;
}) {
  const kind: Kind = route.view === "merge_requests" ? "mr" : "issue";
  const { items, error } = useItems({ kind });
  // Loads GitLab's label colors (and warms the filter menus) for every project.
  useDirectory(projects.map((entry) => entry.project), { people: false });
  const viewer = useViewer();
  const parsed = useMemo(() => parseItemQuery(query), [query]);
  const filtered = useMemo(
    () =>
      items === null
        ? null
        : items.filter((item) => matchesItemQuery(item, parsed, viewer)),
    [items, parsed, viewer],
  );
  const hasQualifiers = queryTokens(query).some((token) => token.key !== "");
  // The funnel shows and hides the pill row; it starts shown when filtering.
  const [showFilters, setShowFilters] = useSticky(
    `filters-open:${kind}`,
    hasQualifiers,
  );
  const onNew = kind === "issue" ? () => navigate({ view: "new" }) : undefined;

  return (
    <div className="flex flex-col">
      <h1 className="pb-6 pt-2 text-[40px] font-bold leading-[1.2] text-foreground">
        GitLab
      </h1>
      <div className="flex flex-wrap items-center gap-1 pb-1.5" role="tablist">
        <DatabaseTabs
          active={kind === "mr" ? "merge_requests" : "issues"}
          navigate={navigate}
        />
        <span className="flex-1" />
        <GhostButton
          aria-label="Filter"
          aria-pressed={showFilters}
          className={cn(
            "w-7 justify-center px-0",
            hasQualifiers && "text-blue-600 [.dark_&]:text-blue-400",
          )}
          onClick={() => setShowFilters((prev) => !prev)}
        >
          <Icon path={ICONS.filter} />
        </GhostButton>
        <SearchBox query={query} onQuery={onQuery} />
        {onNew !== undefined ? (
          <PrimaryButton className="ml-1" onClick={onNew}>
            New
          </PrimaryButton>
        ) : null}
      </div>
      {showFilters ? (
        <div className="pb-2">
          <FilterBar
            kind={kind}
            items={items}
            projects={projects}
            query={query}
            onQuery={onQuery}
          />
        </div>
      ) : null}
      <ItemsTable
        kind={kind}
        items={filtered}
        error={error}
        hasFilter={query.trim().length > 0}
        showProject={projects.length > 1}
        onOpenItem={(project, iid) =>
          navigate(
            kind === "mr"
              ? { view: "merge_request", project, iid }
              : { view: "issue", project, iid },
          )
        }
        onNew={onNew}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diffs. The host's code theme lives on <html> as data attributes plus the
// `dark` class, so the panel mirrors it into @pierre/diffs and follows a live
// theme switch instead of freezing whatever was set at mount.
// ---------------------------------------------------------------------------

interface CodeTheme {
  dark: string;
  light: string;
}

let hostCodeTheme: CodeTheme | null = null;
const hostCodeThemeListeners = new Set<() => void>();
let hostCodeThemeObserver: MutationObserver | null = null;

function getHostCodeTheme(): CodeTheme {
  hostCodeTheme ??= {
    dark: document.documentElement.dataset.bbCodeThemeDark ?? "pierre-dark",
    light: document.documentElement.dataset.bbCodeThemeLight ?? "pierre-light",
  };
  return hostCodeTheme;
}

/** One observer for the whole panel, however many diffs are mounted. */
function subscribeHostCodeTheme(onStoreChange: () => void): () => void {
  hostCodeThemeListeners.add(onStoreChange);
  hostCodeThemeObserver ??= new MutationObserver(() => {
    const current = getHostCodeTheme();
    const next: CodeTheme = {
      dark: document.documentElement.dataset.bbCodeThemeDark ?? "pierre-dark",
      light: document.documentElement.dataset.bbCodeThemeLight ?? "pierre-light",
    };
    if (next.dark === current.dark && next.light === current.light) return;
    hostCodeTheme = next;
    for (const listener of hostCodeThemeListeners) listener();
  });
  hostCodeThemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-bb-code-theme-dark", "data-bb-code-theme-light"],
  });
  return () => {
    hostCodeThemeListeners.delete(onStoreChange);
  };
}

function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/**
 * GitLab hands out bare hunks, so a `diff --git` header is synthesized for the
 * parser. A patch it can't parse still gets shown as text rather than nothing.
 */
function DiffPatch({ path, patch }: { path: string; patch: string }) {
  const dark = useIsDarkTheme();
  const codeTheme = useSyncExternalStore(
    subscribeHostCodeTheme,
    getHostCodeTheme,
    getHostCodeTheme,
  );
  const fileDiff = useMemo(() => {
    const normalized = patch.replace(/\r\n/g, "\n").trimEnd();
    if (normalized.length === 0) return null;
    const text = normalized.startsWith("diff --git")
      ? `${normalized}\n`
      : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${normalized}\n`;
    try {
      return parsePatchFiles(text)[0]?.files[0] ?? null;
    } catch {
      return null;
    }
  }, [path, patch]);
  const options = useMemo(
    () =>
      ({
        diffStyle: "unified",
        overflow: "scroll",
        disableFileHeader: true,
        themeType: dark ? "dark" : "light",
        theme: codeTheme,
      }) as const,
    [codeTheme, dark],
  );
  if (fileDiff === null) {
    return (
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5 text-foreground/80">
        {patch}
      </pre>
    );
  }
  return <FileDiff fileDiff={fileDiff} options={options} />;
}

// ---------------------------------------------------------------------------
// Property editors. The whole value cell is the trigger, as in Notion.
// ---------------------------------------------------------------------------

/** Edit a list of people (assignees or reviewers) in place, with search. */
function PeoplePicker({
  project,
  title,
  people,
  onToggle,
  stack = false,
  renderPerson,
}: {
  project: string;
  title: string;
  people: string[];
  onToggle: (username: string, assigned: boolean) => void;
  /** One person per line, for a narrow rail. */
  stack?: boolean;
  /** How a chosen person draws in the trigger; defaults to avatar and name. */
  renderPerson?: (username: string) => React.ReactNode;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const viewer = useViewer();
  const [users, setUsers] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (users !== null) return;
    rpc.call("assignableUsers", { project }).then(
      (result) => setUsers(result.users),
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [rpc, project, users]);

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            PROPERTY_CONTROL_CLASS,
            stack && "flex-col items-start gap-y-1 px-1.5",
          )}
          aria-label={`Edit ${title.toLowerCase()}`}
        >
          {people.length === 0 ? (
            <EmptyValue />
          ) : (
            people.map((username) => (
              <Fragment key={username}>
                {renderPerson !== undefined ? (
                  renderPerson(username)
                ) : (
                  <Person username={username} />
                )}
              </Fragment>
            ))
          )}
        </button>
      </DropdownMenuTrigger>
      <SearchableMenuContent title={title} placeholder="Search people…">
        {(needle) => {
          if (loadError !== null) {
            return <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>;
          }
          if (users === null) {
            return <DropdownMenuItem disabled>Loading…</DropdownMenuItem>;
          }
          // Whoever is already on the item stays listed, member or not; the
          // viewer and the chosen float to the top.
          const everyone = [...new Set([...people, ...users])];
          const rank = (name: string) =>
            Number(people.includes(name)) * 2 + Number(name === viewer);
          const visible = everyone
            .filter((name) => matchesQuery(needle, name))
            .sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
          if (visible.length === 0) return <NoMatches query={needle} />;
          return visible.map((username) => (
            <DropdownMenuCheckboxItem
              key={username}
              checked={people.includes(username)}
              onCheckedChange={(checked) => onToggle(username, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <Person username={username === viewer ? `${username} (me)` : username} />
            </DropdownMenuCheckboxItem>
          ));
        }}
      </SearchableMenuContent>
    </DropdownMenu>
  );
}

function LabelPicker({
  project,
  labels,
  onToggle,
}: {
  project: string;
  labels: string[];
  onToggle: (label: string, enabled: boolean) => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [available, setAvailable] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (available !== null) return;
    rpc.call("projectLabels", { project }).then(
      (result) => setAvailable(result.labels),
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [rpc, project, available]);

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={PROPERTY_CONTROL_CLASS} aria-label="Edit labels">
          {labels.length === 0 ? <EmptyValue /> : <LabelTags labels={labels} />}
        </button>
      </DropdownMenuTrigger>
      <SearchableMenuContent title="Labels" placeholder="Search labels…">
        {(needle) => {
          if (loadError !== null) {
            return <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>;
          }
          if (available === null) {
            return <DropdownMenuItem disabled>Loading…</DropdownMenuItem>;
          }
          const visible = [...new Set([...labels, ...available])]
            .filter((label) => matchesQuery(needle, label))
            .sort(
              (a, b) =>
                Number(labels.includes(b)) - Number(labels.includes(a)) ||
                a.localeCompare(b),
            );
          if (visible.length === 0) return <NoMatches query={needle} />;
          return visible.map((label) => (
            <DropdownMenuCheckboxItem
              key={label}
              checked={labels.includes(label)}
              onCheckedChange={(checked) => onToggle(label, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <LabelTag label={label} />
            </DropdownMenuCheckboxItem>
          ));
        }}
      </SearchableMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Issue page.
// ---------------------------------------------------------------------------

/** Adds or removes one entry, keeping order and dropping duplicates. */
function toggled(list: string[], entry: string, on: boolean): string[] {
  return on
    ? [...new Set([...list, entry])]
    : list.filter((existing) => existing !== entry);
}

function IssueDetailView({
  project,
  iid,
  onBack,
}: {
  project: string;
  iid: number;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const links = useLinks();
  const { spawn, spawningKey } = useSpawn();
  const { setIssueState, setAssignees, setLabels } = useItemMutations();
  useDirectory([project], { people: false });
  const issueKey = `issue:${project}#${iid}`;
  const [detail, setDetail] = useState<IssueDetail | null>(() =>
    cachedRead<IssueDetail>(issueKey),
  );
  const [error, setError] = useState<string | null>(null);
  // The latest detail, readable synchronously by the toggles below: a
  // setState updater runs later than the call that needs its result.
  const detailRef = useRef<IssueDetail | null>(null);
  detailRef.current = detail;

  const load = useCallback(() => {
    rpc.call("getIssue", { project, iid }).then(
      (result) => {
        cachedWrite(issueKey, result.issue);
        setDetail(result.issue);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, project, iid, issueKey]);
  useEffect(() => {
    setDetail(cachedRead<IssueDetail>(issueKey));
    load();
  }, [load, issueKey]);

  const changeState = useCallback(
    (next: "open" | "closed") => {
      setDetail((prev) =>
        prev === null
          ? prev
          : { ...prev, state: next === "closed" ? "closed" : "opened" },
      );
      setIssueState(project, iid, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setIssueState, project, iid, load],
  );

  const toggleAssignee = useCallback(
    (username: string, assigned: boolean) => {
      const current = detailRef.current;
      if (current === null) return;
      const next = toggled(current.assignees, username, assigned);
      detailRef.current = { ...current, assignees: next };
      setDetail(detailRef.current);
      setAssignees(project, iid, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setAssignees, project, iid, load],
  );

  const toggleLabel = useCallback(
    (label: string, enabled: boolean) => {
      const current = detailRef.current;
      if (current === null) return;
      const next = toggled(current.labels, label, enabled);
      detailRef.current = { ...current, labels: next };
      setDetail(detailRef.current);
      setLabels(project, iid, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setLabels, project, iid, load],
  );

  if (error !== null) return <Callout icon="⚠️">{error}</Callout>;
  if (detail === null) return <PageSkeleton />;

  const issueLinks = links[linkKey("issue", project, iid)];
  return (
    <div className="flex flex-col">
      <PageTopBar
        crumbs={[
          { label: "Issues", onClick: onBack },
          { label: shortProject(project), title: project },
          { label: `#${iid}` },
        ]}
        actions={
          <>
            <GhostButton
              disabled={spawningKey !== null}
              onClick={() => spawn("issue", project, iid)}
            >
              {spawningKey !== null ? "Starting…" : "⚡ Send agent"}
            </GhostButton>
            <PageMoreMenu url={detail.url} />
          </>
        }
      />
      <article className="mx-auto w-full max-w-[708px] pt-12">
        <h1 className="pb-2 text-[40px] font-bold leading-[1.2] text-foreground">
          {detail.title}
        </h1>

        <div className="flex flex-col gap-0.5 py-1.5">
          <PropertyRow
            icon={ICONS.status}
            label="Status"
            control={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={PROPERTY_CONTROL_CLASS} aria-label="State">
                    <StateStatus state={detail.state} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => changeState("open")}>
                    <StateStatus state="opened" />
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => changeState("closed")}>
                    <StateStatus state="closed" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
          <PropertyRow
            icon={ICONS.users}
            label="Assignee"
            control={
              <PeoplePicker
                project={project}
                title="Assignees"
                people={detail.assignees}
                onToggle={toggleAssignee}
              />
            }
          />
          <PropertyRow
            icon={ICONS.list}
            label="Labels"
            control={
              <LabelPicker
                project={project}
                labels={detail.labels}
                onToggle={toggleLabel}
              />
            }
          />
          <PropertyRow icon={ICONS.user} label="Author">
            <Person username={detail.author} />
          </PropertyRow>
          <PropertyRow icon={ICONS.folder} label="Project">
            <span title={project}>{project}</span>
          </PropertyRow>
          <PropertyRow icon={ICONS.clock} label="Updated">
            <span title={formatDateTime(detail.updatedAt)}>
              {formatDateTime(detail.updatedAt)}
            </span>
          </PropertyRow>
          {issueLinks !== undefined && issueLinks.length > 0 ? (
            <PropertyRow icon={ICONS.bolt} label="Agents">
              <ThreadPills links={issueLinks} />
            </PropertyRow>
          ) : null}
        </div>

        <div className="pb-2 pt-1">
          <PageComments
            method="commentIssue"
            project={project}
            iid={iid}
            notes={detail.notes}
            onPosted={load}
          />
        </div>
        <div className="border-t border-border/70 pt-6">
          <PageBody16 body={detail.body} />
        </div>
      </article>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Merge-request page — the issue page's shape, plus pipeline, approvals,
// discussions, and diffs as toggle sections. One component serves the nav
// panel and the thread side panel (`compact`).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pipelines. The rules for which button applies to which status live in
// lib/pipeline, shared with the server, so a button is enabled exactly when
// the server will accept the action.
// ---------------------------------------------------------------------------

/** Re-run `tick` every `ms` while `active`, only when the panel is visible. */
function usePolling(active: boolean, tick: () => void, ms = 8000) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") tick();
    }, ms);
    return () => clearInterval(timer);
  }, [active, tick, ms]);
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function useOpenPipeline(): (project: string, id: number) => void {
  const bbNavigate = useBbNavigate();
  return useCallback(
    (project: string, id: number) =>
      bbNavigate.toPluginPanel(PANEL_PATH, {
        subPath: routeToSubPath({ view: "pipeline", project, id }),
      }),
    [bbNavigate],
  );
}

/**
 * Write actions on a project's pipelines. Each one toasts the outcome and
 * calls `onChanged` right away and again a moment later, because GitLab
 * reports the new job state a beat after it accepts the request.
 */
function usePipelineActions(project: string, onChanged: () => void) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, success: string, call: () => Promise<unknown>) => {
      setBusy(key);
      try {
        await call();
        toast.success(success);
        onChanged();
        setTimeout(onChanged, 1500);
      } catch (error) {
        toast.error(errorText(error));
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );
  return {
    busy,
    retryPipeline: (id: number) =>
      run(`pipeline-${id}`, "Retrying the failed jobs", () =>
        rpc.call("retryPipeline", { project, id }),
      ),
    cancelPipeline: (id: number) =>
      run(`pipeline-${id}`, "Cancelling the pipeline", () =>
        rpc.call("cancelPipeline", { project, id }),
      ),
    jobAction: (jobId: number, action: "retry" | "play" | "cancel") =>
      run(
        `job-${jobId}`,
        action === "play"
          ? "Job started"
          : action === "retry"
            ? "Job retried"
            : "Job cancelled",
        () => rpc.call("runJob", { project, jobId, action }),
      ),
  };
}

/** The tail of one job's log, with a way to read further back. */
function JobLog({
  project,
  jobId,
  lines: initialLines = 60,
}: {
  project: string;
  jobId: number;
  lines?: number;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [lines, setLines] = useState(initialLines);
  const [result, setResult] = useState<
    { log: string; truncated: boolean } | { error: string } | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    rpc.call("getJobLog", { project, jobId, lines }).then(
      (value) => !cancelled && setResult(value),
      (error: unknown) => !cancelled && setResult({ error: errorText(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, project, jobId, lines]);
  const logRef = useRef<HTMLPreElement>(null);
  // The reason a job failed is at the end of its log, so start there.
  useEffect(() => {
    const element = logRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [result]);
  if (result === null) return <Skeleton className="my-1 ml-7 h-24 w-[calc(100%-1.75rem)]" />;
  if ("error" in result) {
    return <Callout icon="⚠️" className="my-1 ml-7">{result.error}</Callout>;
  }
  return (
    <div className="my-1 ml-7 flex flex-col gap-1">
      <pre ref={logRef} className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-foreground/[0.04] px-3 py-2 font-mono text-[12px] leading-[1.45] text-foreground">
        {result.log.length > 0 ? result.log : "(empty log)"}
      </pre>
      {lines < 2000 ? (
        <button
          type="button"
          className="self-start rounded-md px-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          onClick={() => setLines((prev) => Math.min(2000, prev * 4))}
        >
          Show earlier lines
        </button>
      ) : null}
    </div>
  );
}

interface JobLike {
  id: number;
  name: string;
  /** GitLab's own word: failed, success, manual, … */
  status: string;
  stage?: string;
  url: string;
  durationSeconds?: number | null;
  allowFailure?: boolean;
}

function JobRow({
  project,
  job,
  defaultOpen,
  actions,
}: {
  project: string;
  job: JobLike;
  defaultOpen: boolean;
  actions: ReturnType<typeof usePipelineActions>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const allowed = jobActions(job.status);
  const busy = actions.busy === `job-${job.id}`;
  const canAct = job.id > 0;
  return (
    <div className="group/job flex flex-col">
      <div className="flex h-9 items-center gap-2 rounded-md px-1 transition-colors hover:bg-state-hover">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide log" : "Show log"}
          disabled={!canAct}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
          onClick={() => setOpen((prev) => !prev)}
        >
          <ToggleCaret open={open} />
        </button>
        <span className="w-[116px] shrink-0">
          <PipelineStatus status={job.status} />
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground"
          title={job.name}
        >
          {job.name}
          {job.allowFailure === true && job.status === "failed" ? (
            <span className="pl-2 font-sans text-xs text-muted-foreground">
              allowed to fail
            </span>
          ) : null}
        </span>
        {job.stage !== undefined && job.stage.length > 0 ? (
          <Tag className="hidden sm:inline-flex">{job.stage}</Tag>
        ) : null}
        <span className="hidden w-14 shrink-0 text-right text-xs text-muted-foreground sm:block">
          {formatDuration(job.durationSeconds)}
        </span>
        <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-focus-within/job:opacity-100 group-hover/job:opacity-100">
          {canAct && allowed.retry ? (
            <ChipButton disabled={busy} onClick={() => actions.jobAction(job.id, "retry")}>
              Retry
            </ChipButton>
          ) : null}
          {canAct && allowed.play ? (
            <ChipButton disabled={busy} onClick={() => actions.jobAction(job.id, "play")}>
              Play
            </ChipButton>
          ) : null}
          {canAct && allowed.cancel ? (
            <ChipButton disabled={busy} onClick={() => actions.jobAction(job.id, "cancel")}>
              Cancel
            </ChipButton>
          ) : null}
          {job.url.length > 0 ? (
            <a
              href={job.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${job.name} in GitLab`}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
            >
              <Icon path={ICONS.external} size={14} />
            </a>
          ) : null}
        </span>
      </div>
      {open && canAct ? <JobLog project={project} jobId={job.id} /> : null}
    </div>
  );
}

function JobList({
  project,
  jobs,
  actions,
}: {
  project: string;
  jobs: JobLike[];
  actions: ReturnType<typeof usePipelineActions>;
}) {
  // Failed jobs show their log up front, a few at most: the reason a
  // pipeline is red is the thing someone opened this page to find.
  const autoOpen = new Set(
    jobs.filter((job) => job.status === "failed").slice(0, 3).map((job) => job.id),
  );
  return (
    <div className="flex flex-col">
      {jobs.map((job) => (
        <JobRow
          key={job.id > 0 ? job.id : job.name}
          project={project}
          job={job}
          defaultOpen={autoOpen.has(job.id)}
          actions={actions}
        />
      ))}
    </div>
  );
}

/** Starts a pipeline on a branch or tag, or the merge-request pipeline. */
function RunPipelineDialog({
  project,
  defaultRef,
  mergeRequestIid,
  open,
  onOpenChange,
}: {
  project: string;
  defaultRef: string;
  mergeRequestIid?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const openPipeline = useOpenPipeline();
  const [ref, setRef] = useState(defaultRef);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (open) setRef(defaultRef);
  }, [open, defaultRef]);
  const start = () => {
    if (starting) return;
    setStarting(true);
    const refValue = ref.trim();
    rpc
      .call("runPipeline", {
        project,
        ...(mergeRequestIid !== undefined
          ? { mergeRequestIid }
          : refValue.length > 0
            ? { ref: refValue }
            : {}),
      })
      .then((started) => {
        toast.success(`Pipeline #${started.id} started`);
        onOpenChange(false);
        openPipeline(project, started.id);
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setStarting(false));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Run pipeline</DialogTitle>
          <DialogDescription>
            {mergeRequestIid !== undefined
              ? `Starts the merge-request pipeline for !${mergeRequestIid}.`
              : `Starts a new pipeline in ${shortProject(project)}.`}
          </DialogDescription>
        </DialogHeader>
        {mergeRequestIid === undefined ? (
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">Branch or tag</span>
            <input
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") start();
              }}
              placeholder={defaultRef.length > 0 ? defaultRef : "default branch"}
              autoFocus
              spellCheck={false}
              className="h-8 rounded-md border border-border bg-transparent px-2.5 font-mono text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
        ) : null}
        <DialogFooter>
          <GhostButton onClick={() => onOpenChange(false)}>Cancel</GhostButton>
          <PrimaryButton disabled={starting} onClick={start}>
            {starting ? "Starting…" : "Run pipeline"}
          </PrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The pipeline page.
// ---------------------------------------------------------------------------

function PipelineDetailView({
  project,
  id,
  onBack,
}: {
  project: string;
  id: number;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const bbNavigate = useBbNavigate();
  type PipelineData = {
    pipeline: PipelineDetail;
    jobs: PipelineJob[];
    mergeRequestIid: number | null;
  };
  const pipelineKey = `pipeline:${project}#${id}`;
  const [data, setData] = useState<PipelineData | null>(() =>
    cachedRead<PipelineData>(pipelineKey),
  );
  const [error, setError] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);

  const load = useCallback(() => {
    rpc.call("getPipeline", { project, id }).then(
      (value) => {
        cachedWrite(pipelineKey, value);
        setData(value);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, project, id, pipelineKey]);
  useEffect(() => {
    setData(cachedRead<PipelineData>(pipelineKey));
    load();
  }, [load, pipelineKey]);
  // GitLab pushes nothing to the panel, so a live pipeline is polled.
  usePolling(data !== null && !isTerminalPipelineStatus(data.pipeline.status), load);
  const actions = usePipelineActions(project, load);

  if (error !== null) return <Callout icon="⚠️">{error}</Callout>;
  if (data === null) return <PageSkeleton />;
  const { pipeline, jobs, mergeRequestIid } = data;
  const canRetry = retryableJobs(jobs).length > 0;
  const canCancel = !isTerminalPipelineStatus(pipeline.status);
  const busy = actions.busy === `pipeline-${pipeline.id}`;

  return (
    <div className="flex flex-col">
      <PageTopBar
        crumbs={[
          { label: "Pipelines", onClick: onBack },
          { label: shortProject(project), title: project },
          { label: `#${pipeline.id}` },
        ]}
        actions={
          <>
            {canRetry ? (
              <GhostButton disabled={busy} onClick={() => actions.retryPipeline(pipeline.id)}>
                Retry failed
              </GhostButton>
            ) : null}
            {canCancel ? (
              <GhostButton disabled={busy} onClick={() => actions.cancelPipeline(pipeline.id)}>
                Cancel
              </GhostButton>
            ) : null}
            <PrimaryButton onClick={() => setRunOpen(true)}>Run again</PrimaryButton>
            <PageMoreMenu url={pipeline.url} />
          </>
        }
      />
      <article className="mx-auto w-full max-w-[708px] pt-12">
        <h1 className="pb-2 text-[40px] font-bold leading-[1.2] text-foreground">
          Pipeline #{pipeline.id}
        </h1>
        <div className="flex flex-col gap-0.5 py-1.5">
          <PropertyRow icon={ICONS.status} label="Status">
            <PipelineStatus status={pipeline.status} />
          </PropertyRow>
          <PropertyRow icon={ICONS.branch} label="Ref">
            {mergeRequestIid !== null ? (
              <button
                type="button"
                className="inline-flex"
                title={`Open merge request !${mergeRequestIid}`}
                onClick={() =>
                  bbNavigate.toPluginPanel(PANEL_PATH, {
                    subPath: routeToSubPath({
                      view: "merge_request",
                      project,
                      iid: mergeRequestIid,
                    }),
                  })
                }
              >
                <Tag className="cursor-pointer font-mono text-[13px]">
                  !{mergeRequestIid}
                </Tag>
              </button>
            ) : (
              <Tag className="font-mono text-[13px]" title={pipeline.ref}>
                {pipeline.ref}
              </Tag>
            )}
          </PropertyRow>
          <PropertyRow icon={ICONS.hash} label="Commit">
            <span className="font-mono text-[13px]" title={pipeline.sha}>
              {shortSha(pipeline.sha)}
            </span>
          </PropertyRow>
          <PropertyRow icon={ICONS.bolt} label="Source">
            {pipeline.source.replace(/_/g, " ") || <EmptyValue />}
          </PropertyRow>
          {pipeline.user.length > 0 ? (
            <PropertyRow icon={ICONS.user} label="Triggered by">
              <Person username={pipeline.user} />
            </PropertyRow>
          ) : null}
          <PropertyRow icon={ICONS.clock} label="Duration">
            {pipeline.durationSeconds !== null ? (
              formatDuration(pipeline.durationSeconds)
            ) : (
              <EmptyValue />
            )}
          </PropertyRow>
          <PropertyRow icon={ICONS.clock} label="Created">
            {formatDateTime(pipeline.createdAt)}
          </PropertyRow>
        </div>

        <div className="flex flex-col gap-2 border-t border-border/70 pt-6">
          {pipeline.yamlErrors !== null && pipeline.yamlErrors.length > 0 ? (
            <Callout icon="⚠️">
              <p className="font-medium text-foreground">The CI configuration is invalid</p>
              <p className="whitespace-pre-wrap font-mono text-[13px] text-muted-foreground">
                {pipeline.yamlErrors}
              </p>
            </Callout>
          ) : null}
          {jobs.length === 0 ? (
            <Callout icon="💡">
              GitLab created no jobs for this pipeline, which usually means a CI
              configuration or rules error.{" "}
              <a href={pipeline.url} target="_blank" rel="noreferrer" className="underline">
                Open it in GitLab ↗
              </a>
            </Callout>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-foreground">
                Jobs{" "}
                <span className="pl-1 text-sm font-normal text-muted-foreground">
                  {jobs.filter((job) => job.status === "success").length}/{jobs.length} passed
                </span>
              </h2>
              <JobList project={project} jobs={jobs} actions={actions} />
            </>
          )}
        </div>
      </article>
      <RunPipelineDialog
        project={project}
        defaultRef={mergeRequestIid === null ? pipeline.ref : ""}
        {...(mergeRequestIid === null ? {} : { mergeRequestIid })}
        open={runOpen}
        onOpenChange={setRunOpen}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The pipelines database view.
// ---------------------------------------------------------------------------

function PipelinesView({
  navigate,
  projects,
}: {
  navigate: (route: Route) => void;
  projects: ProjectInfo[];
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const openPipeline = useOpenPipeline();
  // The tracked projects arrive after the first render, so the choice is
  // only remembered once the user makes it.
  const [picked, setProject] = useSticky<string | null>("pipelines:project", null);
  const project = picked ?? projects[0]?.project ?? "";
  const [status, setStatus] = useSticky<string | null>("pipelines:status", null);
  const [search, setSearch] = useSticky("pipelines:search", "");
  const [runOpen, setRunOpen] = useState(false);
  type PipelineList = { pipelines: PipelineSummary[]; defaultBranch: string };
  const listKey = `pipelines:${project}`;
  const [data, setData] = useState<PipelineList | null>(() =>
    cachedRead<PipelineList>(listKey),
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (project.length === 0) return;
    rpc.call("listPipelines", { project, limit: 50 }).then(
      (value) => {
        cachedWrite(listKey, value);
        setData(value);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, project, listKey]);
  useEffect(() => {
    setData(cachedRead<PipelineList>(listKey));
    load();
  }, [load, listKey]);
  usePolling(
    data?.pipelines.some((entry) => !isTerminalPipelineStatus(entry.status)) === true,
    load,
    10000,
  );

  const statuses = useMemo(
    () => [...new Set((data?.pipelines ?? []).map((entry) => entry.status))].sort(),
    [data],
  );
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data?.pipelines ?? []).filter(
      (entry) =>
        (status === null || entry.status === status) &&
        (needle.length === 0 ||
          `#${entry.id} ${entry.ref} ${entry.sha}`.toLowerCase().includes(needle)),
    );
  }, [data, status, search]);

  return (
    <div className="flex flex-col">
      <h1 className="pb-6 pt-2 text-[40px] font-bold leading-[1.2] text-foreground">
        GitLab
      </h1>
      <div className="flex flex-wrap items-center gap-1 pb-1.5" role="tablist">
        <DatabaseTabs active="pipelines" navigate={navigate} />
        <span className="flex-1" />
        <span className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground">
          <Icon path={ICONS.search} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search ref or commit…"
            aria-label="Search pipelines"
            spellCheck={false}
            className="w-44 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          />
        </span>
        <PrimaryButton className="ml-1" onClick={() => setRunOpen(true)}>
          Run pipeline
        </PrimaryButton>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FilterPill active={status !== null}>
              <Icon path={ICONS.status} size={14} />
              {status === null ? "Status" : `Status: ${status.replace(/_/g, " ")}`}
            </FilterPill>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Status
            </DropdownMenuLabel>
            {statuses.map((entry) => (
              <DropdownMenuCheckboxItem
                key={entry}
                checked={status === entry}
                onCheckedChange={(checked) => setStatus(checked === true ? entry : null)}
                onSelect={(event) => event.preventDefault()}
              >
                <PipelineStatus status={entry} />
              </DropdownMenuCheckboxItem>
            ))}
            {statuses.length === 0 ? (
              <DropdownMenuItem disabled>No pipelines yet</DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        {projects.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterPill active>
                <Icon path={ICONS.folder} size={14} />
                {shortProject(project)}
              </FilterPill>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              {projects.map((entry) => (
                <DropdownMenuItem
                  key={entry.project}
                  onSelect={() => setProject(entry.project)}
                >
                  {entry.project}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {status !== null ? (
          <GhostButton className="h-7 px-2" onClick={() => setStatus(null)}>
            Reset
          </GhostButton>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[170px]" />
            <col className="w-[130px]" />
            <col />
            <col className="w-[130px]" />
            <col className="w-[100px]" />
            <col className="w-[96px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border/70">
              <HeaderCell icon={ICONS.title}>Pipeline</HeaderCell>
              <HeaderCell icon={ICONS.status}>Status</HeaderCell>
              <HeaderCell icon={ICONS.branch}>Ref</HeaderCell>
              <HeaderCell icon={ICONS.bolt}>Source</HeaderCell>
              <HeaderCell icon={ICONS.hash}>Commit</HeaderCell>
              <HeaderCell icon={ICONS.clock}>Updated</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {error !== null ? (
              <tr>
                <td colSpan={6} className="py-4">
                  <Callout icon="⚠️">{error}</Callout>
                </td>
              </tr>
            ) : data === null ? (
              [0, 1, 2, 3, 4].map((row) => (
                <tr key={row} className="border-b border-border/70">
                  {Array.from({ length: 6 }, (_, cell) => (
                    <td key={cell} className={CELL}>
                      <Skeleton className="h-3.5 w-2/3" />
                    </td>
                  ))}
                </tr>
              ))
            ) : shown.length === 0 ? (
              <tr className="border-b border-border/70">
                <td colSpan={6} className="h-9 px-2 text-sm text-muted-foreground">
                  {data.pipelines.length === 0
                    ? "No pipelines yet."
                    : "No pipelines match these filters."}
                </td>
              </tr>
            ) : (
              shown.map((entry) => {
                const mrIid = mergeRequestIidFromRef(entry.ref);
                const open = () => openPipeline(project, entry.id);
                return (
                  <tr
                    key={entry.id}
                    tabIndex={0}
                    className="group cursor-pointer border-b border-border/70 outline-none focus-visible:bg-state-hover"
                    onClick={open}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") open();
                    }}
                  >
                    <td className={cn(CELL, "font-medium text-foreground")}>
                      #{entry.id}
                    </td>
                    <td className={CELL}>
                      <PipelineStatus status={entry.status} />
                    </td>
                    <td className={CELL}>
                      <Tag
                        className="max-w-full font-mono text-[13px]"
                        title={entry.ref}
                      >
                        {mrIid !== null ? `!${mrIid}` : entry.ref}
                      </Tag>
                    </td>
                    <td className={cn(CELL, "truncate text-muted-foreground")}>
                      {entry.source.replace(/_/g, " ")}
                    </td>
                    <td className={cn(CELL, "font-mono text-[13px]")} title={entry.sha}>
                      {shortSha(entry.sha)}
                    </td>
                    <td
                      className={cn(CELL, "whitespace-nowrap")}
                      title={formatDateTime(entry.updatedAt)}
                    >
                      {relativeTime(entry.updatedAt)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {data !== null && shown.length > 0 ? (
            <tfoot>
              <tr>
                <td className="h-9 px-2 text-right">
                  <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                    Count
                  </span>
                  <span className="ml-1.5 text-sm text-foreground">{shown.length}</span>
                </td>
                <td colSpan={5} />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      <RunPipelineDialog
        project={project}
        defaultRef={data?.defaultBranch ?? ""}
        open={runOpen}
        onOpenChange={setRunOpen}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Branches: one row per branch with the three things people ask about it —
// who touched it last, does it have a merge request, is CI green.
// ---------------------------------------------------------------------------

interface BranchRow {
  name: string;
  isDefault: boolean;
  protected: boolean;
  merged: boolean;
  url: string;
  commit: {
    sha: string;
    title: string;
    author: string;
    date: string;
    url: string;
  } | null;
  mergeRequest: { iid: number; title: string; draft: boolean } | null;
  pipeline: { id: number; status: string } | null;
}

type BranchFilter = "all" | "with-mr" | "no-mr" | "stale" | "merged";

const STALE_DAYS = 30;

function daysSince(iso: string): number {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? 0 : (Date.now() - then) / 86_400_000;
}

/** GitLab's "new merge request" page for a branch, from the branch's own URL. */
function newMergeRequestUrl(branch: BranchRow): string | null {
  const marker = "/-/tree/";
  const at = branch.url.indexOf(marker);
  if (at < 0) return null;
  return `${branch.url.slice(0, at)}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch.name)}`;
}

function BranchesView({
  navigate,
  projects,
}: {
  navigate: (route: Route) => void;
  projects: ProjectInfo[];
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const bbNavigate = useBbNavigate();
  const openPipeline = useOpenPipeline();
  const [picked, setProject] = useSticky<string | null>("branches:project", null);
  const project = picked ?? projects[0]?.project ?? "";
  const [search, setSearch] = useSticky("branches:search", "");
  const [serverSearch, setServerSearch] = useState(search);
  const [filter, setFilter] = useSticky<BranchFilter>("branches:filter", "all");
  const [runFor, setRunFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useDirectory(project.length > 0 ? [project] : [], { people: false });
  const branchesKey = `branches:${project}:${serverSearch.trim()}`;
  const [branches, setBranches] = useState<BranchRow[] | null>(() =>
    cachedRead<BranchRow[]>(branchesKey),
  );

  // The search box asks GitLab, so a repository with thousands of branches
  // is still searchable; the filters below only narrow what came back.
  useEffect(() => {
    const timer = setTimeout(() => setServerSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(() => {
    if (project.length === 0) return;
    rpc
      .call("listBranches", {
        project,
        limit: 100,
        ...(serverSearch.trim().length > 0 ? { search: serverSearch.trim() } : {}),
      })
      .then(
        (value) => {
          cachedWrite(branchesKey, value.branches);
          setBranches(value.branches);
          setError(null);
        },
        (err: unknown) => setError(errorText(err)),
      );
  }, [rpc, project, serverSearch, branchesKey]);
  useEffect(() => {
    setBranches(cachedRead<BranchRow[]>(branchesKey));
    load();
  }, [load, branchesKey]);

  const defaultBranch = branches?.find((entry) => entry.isDefault)?.name ?? "";
  const shown = useMemo(() => {
    const rows = (branches ?? []).filter((entry) => {
      switch (filter) {
        case "with-mr":
          return entry.mergeRequest !== null;
        case "no-mr":
          return entry.mergeRequest === null && !entry.isDefault;
        case "stale":
          return (
            !entry.isDefault &&
            entry.commit !== null &&
            daysSince(entry.commit.date) > STALE_DAYS
          );
        case "merged":
          return entry.merged && !entry.isDefault;
        default:
          return true;
      }
    });
    // The default branch first, then newest activity.
    return rows.sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        Date.parse(b.commit?.date ?? "") - Date.parse(a.commit?.date ?? "") ||
        a.name.localeCompare(b.name),
    );
  }, [branches, filter]);

  const filters: Array<{ id: BranchFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "with-mr", label: "With open MR" },
    { id: "no-mr", label: "No MR" },
    { id: "stale", label: `Stale > ${STALE_DAYS}d` },
    { id: "merged", label: "Merged" },
  ];

  return (
    <div className="flex flex-col">
      <h1 className="pb-6 pt-2 text-[40px] font-bold leading-[1.2] text-foreground">
        GitLab
      </h1>
      <div className="flex flex-wrap items-center gap-1 pb-1.5" role="tablist">
        <DatabaseTabs active="branches" navigate={navigate} />
        <span className="flex-1" />
        <span className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground">
          <Icon path={ICONS.search} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search branches…"
            aria-label="Search branches"
            spellCheck={false}
            className="w-44 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
          />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pb-2">
        {filters.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
            className={cn(
              "inline-flex h-7 items-center rounded-full border px-2.5 text-sm transition-colors",
              filter === entry.id
                ? "border-transparent bg-foreground/[0.08] font-medium text-foreground"
                : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
        {projects.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterPill active>
                <Icon path={ICONS.folder} size={14} />
                {shortProject(project)}
              </FilterPill>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              {projects.map((entry) => (
                <DropdownMenuItem key={entry.project} onSelect={() => setProject(entry.project)}>
                  {entry.project}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[240px]" />
            <col />
            <col className="w-[170px]" />
            <col className="w-[100px]" />
            <col className="w-[84px]" />
            <col className="w-[110px]" />
            <col className="w-[196px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border/70">
              <HeaderCell icon={ICONS.branch}>Branch</HeaderCell>
              <HeaderCell icon={ICONS.title}>Last commit</HeaderCell>
              <HeaderCell icon={ICONS.user}>Author</HeaderCell>
              <HeaderCell icon={ICONS.clock}>Updated</HeaderCell>
              <HeaderCell icon={ICONS.pipeline}>MR</HeaderCell>
              <HeaderCell icon={ICONS.status}>Pipeline</HeaderCell>
              <HeaderCell
                icon={ICONS.bolt}
                className="sticky right-0 bg-background shadow-[-12px_0_8px_-4px_var(--background)]"
              >
                Actions
              </HeaderCell>
            </tr>
          </thead>
          <tbody>
            {error !== null ? (
              <tr>
                <td colSpan={7} className="py-4">
                  <Callout icon="⚠️">{error}</Callout>
                </td>
              </tr>
            ) : branches === null ? (
              [0, 1, 2, 3, 4].map((row) => (
                <tr key={row} className="border-b border-border/70">
                  {Array.from({ length: 7 }, (_, cell) => (
                    <td key={cell} className={CELL}>
                      <Skeleton className="h-3.5 w-2/3" />
                    </td>
                  ))}
                </tr>
              ))
            ) : shown.length === 0 ? (
              <tr className="border-b border-border/70">
                <td colSpan={7} className="h-9 px-2 text-sm text-muted-foreground">
                  No branches match.
                </td>
              </tr>
            ) : (
              shown.map((branch) => {
                const createUrl = newMergeRequestUrl(branch);
                const openMr = () =>
                  branch.mergeRequest !== null &&
                  bbNavigate.toPluginPanel(PANEL_PATH, {
                    subPath: routeToSubPath({
                      view: "merge_request",
                      project,
                      iid: branch.mergeRequest.iid,
                    }),
                  });
                return (
                  <tr key={branch.name} className="group border-b border-border/70">
                    <td className={CELL}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          className="min-w-0 truncate font-mono text-[13px] font-medium text-foreground"
                          title={branch.name}
                        >
                          {branch.name}
                        </span>
                        {branch.isDefault ? <Tag>default</Tag> : null}
                        {branch.protected && !branch.isDefault ? <Tag>protected</Tag> : null}
                        {branch.merged && !branch.isDefault ? <Tag>merged</Tag> : null}
                      </span>
                    </td>
                    <td className={cn(CELL, "truncate")} title={branch.commit?.title}>
                      {branch.commit?.title}
                    </td>
                    <td className={CELL}>
                      {branch.commit !== null && branch.commit.author.length > 0 ? (
                        <Person username={branch.commit.author} />
                      ) : null}
                    </td>
                    <td
                      className={cn(CELL, "whitespace-nowrap")}
                      title={branch.commit !== null ? formatDateTime(branch.commit.date) : undefined}
                    >
                      {branch.commit !== null ? relativeTime(branch.commit.date) : ""}
                    </td>
                    <td className={CELL}>
                      {branch.mergeRequest !== null ? (
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-state-hover"
                          title={branch.mergeRequest.title}
                          onClick={openMr}
                        >
                          <span className="font-medium text-foreground">!{branch.mergeRequest.iid}</span>
                          {branch.mergeRequest.draft ? <Tag>draft</Tag> : null}
                        </button>
                      ) : null}
                    </td>
                    <td className={CELL}>
                      {branch.pipeline !== null ? (
                        <button
                          type="button"
                          className="rounded-full transition-opacity hover:opacity-80"
                          title={`Pipeline #${branch.pipeline.id}`}
                          onClick={() => openPipeline(project, branch.pipeline?.id ?? 0)}
                        >
                          <PipelineStatus status={branch.pipeline.status} />
                        </button>
                      ) : null}
                    </td>
                    <td className={cn(CELL, "sticky right-0 bg-background shadow-[-12px_0_8px_-4px_var(--background)]")}>
                      <span className="flex items-center gap-1.5">
                        {branch.mergeRequest !== null ? (
                          <ChipButton onClick={openMr}>Open MR</ChipButton>
                        ) : !branch.isDefault && createUrl !== null ? (
                          <ChipButton onClick={() => window.open(createUrl, "_blank")}>
                            Create MR ↗
                          </ChipButton>
                        ) : null}
                        <ChipButton onClick={() => setRunFor(branch.name)}>Run pipeline</ChipButton>
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {branches !== null && shown.length > 0 ? (
            <tfoot>
              <tr>
                <td className="h-9 px-2 text-right">
                  <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
                    Count
                  </span>
                  <span className="ml-1.5 text-sm text-foreground">{shown.length}</span>
                  {branches.length >= 100 ? (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      (first 100; search to narrow)
                    </span>
                  ) : null}
                </td>
                <td colSpan={6} />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      <RunPipelineDialog
        project={project}
        defaultRef={runFor ?? defaultBranch}
        open={runFor !== null}
        onOpenChange={(open) => {
          if (!open) setRunFor(null);
        }}
      />
    </div>
  );
}

/** Issues / Merge requests / Pipelines: the database's view tabs. */
function DatabaseTabs({
  active,
  navigate,
}: {
  active: "issues" | "merge_requests" | "pipelines" | "branches";
  navigate: (route: Route) => void;
}) {
  return (
    <>
      <ViewTab
        icon={ICONS.table}
        active={active === "issues"}
        onClick={() => navigate({ view: "issues" })}
      >
        Issues
      </ViewTab>
      <ViewTab
        icon={ICONS.branch}
        active={active === "merge_requests"}
        onClick={() => navigate({ view: "merge_requests" })}
      >
        Merge requests
      </ViewTab>
      <ViewTab
        icon={ICONS.pipeline}
        active={active === "pipelines"}
        onClick={() => navigate({ view: "pipelines" })}
      >
        Pipelines
      </ViewTab>
      <ViewTab
        icon={ICONS.commit}
        active={active === "branches"}
        onClick={() => navigate({ view: "branches" })}
      >
        Branches
      </ViewTab>
    </>
  );
}

/**
 * A discussion: an inline review thread, a general thread, or a standalone
 * comment. Each can be answered in place, which posts into the same GitLab
 * thread instead of starting a new top-level comment, and a thread can be
 * resolved or reopened.
 */
function ThreadCard({
  project,
  iid,
  discussion,
  onChanged,
}: {
  project: string;
  iid: number;
  discussion: Discussion;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const ready = body.trim().length > 0;

  const refresh = () => {
    onChanged();
    // GitLab lists the new note a moment after it accepts it.
    setTimeout(onChanged, 1200);
  };
  const reply = () => {
    if (!ready || posting) return;
    setPosting(true);
    rpc
      .call("replyToDiscussion", { project, iid, discussionId: discussion.id, body })
      .then(() => {
        setBody("");
        setReplying(false);
        toast.success("Reply posted");
        refresh();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPosting(false));
  };
  const toggleResolved = () => {
    setResolving(true);
    rpc
      .call("setDiscussionResolved", {
        project,
        iid,
        discussionId: discussion.id,
        resolved: !discussion.resolved,
      })
      .then(() => {
        toast.success(discussion.resolved ? "Thread reopened" : "Thread resolved");
        refresh();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setResolving(false));
  };

  const place =
    discussion.path.length > 0
      ? `${discussion.path}${discussion.line !== null ? `:${discussion.line}` : ""}`
      : null;
  return (
    <div
      className={cn(
        "flex flex-col",
        !discussion.individual && "border-l-2 border-border pl-3",
      )}
    >
      {place !== null || discussion.resolvable ? (
        <p className="flex min-w-0 items-center gap-2 py-1 text-sm">
          {place !== null ? (
            <span className="min-w-0 truncate font-mono text-[13px] text-muted-foreground" title={place}>
              {place}
            </span>
          ) : null}
          {discussion.resolvable ? (
            discussion.resolved ? (
              <Tag color="green">Resolved</Tag>
            ) : (
              <Tag color="orange">Unresolved</Tag>
            )
          ) : null}
        </p>
      ) : null}
      {discussion.notes.map((note, index) => (
        <CommentItem key={`${note.createdAt}-${index}`} note={note} />
      ))}
      <div className="flex items-start gap-2 pb-1 pt-1">
        {replying ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Textarea
              value={body}
              autoFocus
              rows={3}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  reply();
                }
                if (event.key === "Escape" && body.length === 0) setReplying(false);
              }}
              placeholder="Reply…"
              aria-label="Reply to this thread"
              className="min-h-[72px] resize-y border-border bg-transparent px-2.5 py-1.5 text-sm shadow-none focus-visible:ring-1"
            />
            <div className="flex items-center gap-1.5">
              <PrimaryButton disabled={!ready || posting} onClick={reply} title="Reply (⌘/Ctrl+Enter)">
                {posting ? "Posting…" : "Reply"}
              </PrimaryButton>
              <GhostButton
                onClick={() => {
                  setReplying(false);
                  setBody("");
                }}
              >
                Cancel
              </GhostButton>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className={cn(
              "h-8 min-w-0 flex-1 rounded-md border border-border px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-state-hover",
              discussion.individual && "max-w-[200px]",
            )}
          >
            Reply…
          </button>
        )}
        {discussion.resolvable && !replying ? (
          <GhostButton
            className="h-8 border border-border"
            disabled={resolving}
            onClick={toggleResolved}
          >
            {discussion.resolved ? "Reopen thread" : "Resolve thread"}
          </GhostButton>
        ) : null}
      </div>
    </div>
  );
}

/** One changed file: a nested toggle whose body is the diff. */
function FileDiffRow({ file, url }: { file: DiffFile; url: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-1 text-left transition-colors hover:bg-state-hover"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <ToggleCaret open={open} />
        </span>
        <Icon path={ICONS.file} size={14} className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground" title={file.path}>
          {file.path}
        </span>
        {file.status !== "modified" ? (
          <Tag
            color={
              file.status === "added"
                ? "green"
                : file.status === "deleted"
                  ? "red"
                  : "blue"
            }
          >
            {file.status}
          </Tag>
        ) : null}
        <span className="shrink-0 font-mono text-xs text-emerald-700 [.dark_&]:text-emerald-400">
          +{file.additions}
        </span>
        <span className="shrink-0 font-mono text-xs text-red-700 [.dark_&]:text-red-400">
          −{file.deletions}
        </span>
      </button>
      {open ? (
        <div className="my-1 ml-6 overflow-hidden rounded-md border border-border/70">
          {file.patch !== null ? (
            <DiffPatch path={file.path} patch={file.patch} />
          ) : (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              Too large to show here —{" "}
              <a href={`${url}/diffs`} target="_blank" rel="noreferrer" className="underline">
                open in GitLab ↗
              </a>
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The merge request's changed files, one nested toggle each. The diffs are the
 * heaviest thing GitLab sends, so they load when this tab opens, and a copy
 * from the last visit shows at once while the fresh one loads.
 */
function ChangesList({ project, iid, mr }: { project: string; iid: number; mr: MergeRequestDetail }) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  type Files = {
    files: DiffFile[];
    additions: number;
    deletions: number;
    truncated: boolean;
  };
  // Keyed by updatedAt, so a pushed commit never shows the old diff as current.
  const key = `mr-files:${project}!${iid}:${mr.updatedAt}`;
  const [data, setData] = useState<Files | null>(() => cachedRead<Files>(key));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(cachedRead<Files>(key));
    if (cachedRead<Files>(key) !== null) return;
    rpc.call("getMergeRequestFiles", { project, iid }).then(
      (value) => {
        if (cancelled) return;
        cachedWrite(key, value);
        setData(value);
        setError(null);
      },
      (err: unknown) => !cancelled && setError(errorText(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, project, iid, key]);

  if (error !== null) return <Callout icon="⚠️">{error}</Callout>;
  if (data === null) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4].map((row) => (
          <Skeleton key={row} className="h-7 w-full" />
        ))}
      </div>
    );
  }
  if (data.files.length === 0) {
    return <p className="text-sm text-muted-foreground">No changed files.</p>;
  }
  return (
    <section className="flex flex-col gap-1">
      <p className="pb-1 text-sm text-muted-foreground">
        {data.truncated
          ? `${data.files.length} of ${mr.changedFiles} files`
          : `${data.files.length} file${data.files.length === 1 ? "" : "s"}`}{" "}
        <span className="font-mono text-emerald-700 [.dark_&]:text-emerald-400">
          +{data.additions}
        </span>{" "}
        <span className="font-mono text-red-700 [.dark_&]:text-red-400">
          −{data.deletions}
        </span>
      </p>
      {data.truncated ? (
        <Callout icon="💡" className="mb-1 py-2.5">
          Only the first page of diffs is here.{" "}
          <a href={`${mr.url}/diffs`} target="_blank" rel="noreferrer" className="underline">
            Open the full diff in GitLab ↗
          </a>
        </Callout>
      ) : null}
      {data.files.map((file) => (
        <FileDiffRow key={file.path} file={file} url={mr.url} />
      ))}
    </section>
  );
}

/** A merge request's whole pipeline: status, jobs, retry/play, logs. */
function PipelineTab({
  project,
  pipeline,
  jobs,
  actions,
}: {
  project: string;
  pipeline: MergeRequestDetail["pipeline"];
  jobs: Job[];
  actions: ReturnType<typeof usePipelineActions>;
}) {
  const openPipeline = useOpenPipeline();
  if (pipeline === null && jobs.length === 0) {
    return <p className="text-sm text-muted-foreground">This merge request has no pipeline yet.</p>;
  }
  const passing = jobs.filter((job) => job.status === "success").length;
  const pipelineId = pipeline?.id ?? 0;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {pipeline !== null ? <PipelineStatus status={pipeline.status} /> : null}
        {jobs.length > 0 ? (
          <span className="text-sm text-muted-foreground">
            {passing}/{jobs.length} passed
          </span>
        ) : null}
        <span className="flex-1" />
        {pipelineId > 0 ? (
          <GhostButton onClick={() => openPipeline(project, pipelineId)}>
            Open pipeline #{pipelineId}
            <Icon path={ICONS.chevronRight} size={14} />
          </GhostButton>
        ) : null}
      </div>
      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No jobs.</p>
      ) : (
        <JobList
          project={project}
          actions={actions}
          jobs={jobs.map((job) => ({
            id: job.id,
            name: job.name,
            status: job.rawStatus,
            url: job.url,
          }))}
        />
      )}
    </section>
  );
}

/** Folds long content behind "Show more" once it passes `maxHeight` pixels. */
function Clamp({
  children,
  maxHeight = 152,
}: {
  children: React.ReactNode;
  maxHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element !== null) setOverflows(element.scrollHeight > maxHeight + 8);
  });
  return (
    <div>
      <div
        ref={ref}
        style={expanded ? undefined : { maxHeight }}
        className={cn(!expanded && "overflow-hidden")}
      >
        {children}
      </div>
      {overflows || expanded ? (
        <button
          type="button"
          className="mt-1 rounded px-1 text-sm text-muted-foreground transition-colors -ml-1 hover:bg-state-hover hover:text-foreground"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

type Tone = "ok" | "bad" | "wait" | "neutral";

/** What a merge request is waiting on, in the order a reviewer cares. */
interface Readiness {
  pipeline: { tone: Tone; label: string; caption: string };
  review: { tone: Tone; label: string; caption: string };
  discussions: { tone: Tone; label: string; caption: string };
  conflicts: { tone: Tone; label: string; caption: string };
  blockers: string[];
}

function readinessOf(mr: MergeRequestDetail): Readiness {
  const failedJobs = mr.jobs.filter((job) => job.status === "failure").length;
  const status = mr.pipeline?.status ?? "";
  const pipeline: Readiness["pipeline"] =
    mr.pipeline === null
      ? { tone: "neutral", label: "None", caption: "Pipeline" }
      : status === "success"
        ? { tone: "ok", label: "Passed", caption: `Pipeline · ${mr.jobs.length} jobs` }
        : status === "failed"
          ? {
              tone: "bad",
              label: "Failed",
              caption: `Pipeline · ${failedJobs} of ${mr.jobs.length} jobs`,
            }
          : isTerminalPipelineStatus(status)
            ? { tone: "neutral", label: status.replace(/_/g, " "), caption: "Pipeline" }
            : { tone: "wait", label: "Running", caption: "Pipeline" };

  // Review: the Approve button and 👍-style reactions count together, because
  // some teams approve with a reaction rather than the button.
  const verdict = reviewVerdict({
    author: mr.author,
    approvedBy: mr.approvedBy,
    reactions: mr.reactions,
  });
  const missing = mr.approvalsLeft;
  const ruleOpen = mr.approvalsRequired > 0 && missing > 0;
  const waitingOn = mr.reviewers
    .filter((name) => !verdict.approvers.some((entry) => entry.username.toLowerCase() === name.toLowerCase()))
    .join(", ");
  const review: Readiness["review"] =
    verdict.state === "rejected"
      ? {
          tone: "bad",
          label: "Changes requested",
          caption: `Review · 👎 ${verdict.rejectors.join(", ")}`,
        }
      : verdict.state === "approved"
        ? {
            tone: ruleOpen ? "wait" : "ok",
            label: `${verdict.approvers.length} approved`,
            caption: ruleOpen
              ? `Review · GitLab needs ${missing} more`
              : "Review",
          }
        : {
            tone: "wait",
            label: "Not reviewed",
            caption: waitingOn.length > 0 ? `Review · waiting for ${waitingOn}` : "Review",
          };

  const threads = mr.discussions.filter((entry) => entry.resolvable);
  const unresolved = threads.filter((entry) => !entry.resolved).length;
  const discussions: Readiness["discussions"] =
    threads.length === 0
      ? { tone: "neutral", label: "No threads", caption: "Discussions" }
      : unresolved === 0
        ? { tone: "ok", label: "All resolved", caption: `Discussions · ${threads.length}` }
        : { tone: "wait", label: `${unresolved} unresolved`, caption: "Discussions" };

  const mergeable = mr.mergeStatus === "mergeable";
  const conflicts: Readiness["conflicts"] = mr.state !== "opened"
    ? // Merged and closed requests have nothing left to wait on.
      { tone: "neutral", label: mr.state, caption: "State" }
    : mr.hasConflicts
    ? { tone: "bad", label: "Conflicts", caption: "Merge" }
    : mergeable
      ? { tone: "ok", label: "None", caption: "Conflicts" }
      : {
          tone: mr.mergeStatus.length === 0 ? "neutral" : "wait",
          label: mr.mergeStatus.length === 0 ? "Unknown" : mr.mergeStatus.replace(/_/g, " "),
          caption: "Merge status",
        };

  const blockers: string[] = [];
  if (mr.state !== "opened") return { pipeline, review, discussions, conflicts, blockers };
  if (mr.draft) blockers.push("still a draft");
  if (pipeline.tone === "bad") blockers.push("pipeline failed");
  else if (pipeline.tone === "wait") blockers.push("pipeline still running");
  if (verdict.state === "rejected") blockers.push("changes requested");
  else if (verdict.state === "pending") blockers.push("not reviewed");
  if (ruleOpen) blockers.push(`GitLab needs ${missing} more approval${missing === 1 ? "" : "s"}`);
  if (discussions.tone === "wait") blockers.push(`${unresolved} thread${unresolved === 1 ? "" : "s"} open`);
  if (conflicts.tone === "bad") blockers.push("has conflicts");
  else if (conflicts.tone === "wait") blockers.push(`merge status: ${conflicts.label}`);
  return { pipeline, review, discussions, conflicts, blockers };
}

/** Color only where something needs a person: red blocks, amber waits. */
const TONE_CLASSES: Record<Tone, string> = {
  ok: "border-border",
  neutral: "border-border",
  wait: "border-amber-500/50 bg-amber-500/[0.07]",
  bad: "border-red-500/50 bg-red-500/[0.07]",
};

const TONE_GLYPHS: Record<Tone, { glyph: string; className: string }> = {
  ok: { glyph: "✓", className: "text-emerald-700 [.dark_&]:text-emerald-400" },
  neutral: { glyph: "–", className: "text-muted-foreground" },
  wait: { glyph: "◐", className: "text-amber-700 [.dark_&]:text-amber-400" },
  bad: { glyph: "✕", className: "text-red-700 [.dark_&]:text-red-400" },
};

function ReadinessCell({
  tone,
  caption,
  label,
  onClick,
}: {
  tone: Tone;
  caption: string;
  label: string;
  onClick: () => void;
}) {
  const glyph = TONE_GLYPHS[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-state-hover",
        TONE_CLASSES[tone],
      )}
    >
      <span className="truncate text-xs text-muted-foreground">{caption}</span>
      <span className="flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
        <span aria-hidden="true" className={cn("font-bold", glyph.className)}>
          {glyph.glyph}
        </span>
        <span className="truncate first-letter:uppercase">{label}</span>
      </span>
    </button>
  );
}

/** The failing job and the end of its log, on the page where people look. */
function BlockerCard({
  project,
  job,
  actions,
}: {
  project: string;
  job: Job;
  actions: ReturnType<typeof usePipelineActions>;
}) {
  const busy = actions.busy === `job-${job.id}`;
  return (
    <div className="overflow-hidden rounded-lg border border-red-500/40">
      <div className="flex min-h-9 items-center gap-2 bg-red-500/[0.07] px-3 py-1.5">
        <PipelineStatus status={job.rawStatus} />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold" title={job.name}>
          {job.name}
        </span>
        {job.id > 0 && jobActions(job.rawStatus).retry ? (
          <ChipButton disabled={busy} onClick={() => actions.jobAction(job.id, "retry")}>
            Retry
          </ChipButton>
        ) : null}
        {job.url.length > 0 ? (
          <a
            href={job.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            GitLab ↗
          </a>
        ) : null}
      </div>
      {job.id > 0 ? (
        <div className="-ml-7 pr-3">
          <JobLog project={project} jobId={job.id} lines={14} />
        </div>
      ) : null}
    </div>
  );
}

function ApprovalBadge({ via }: { via: "approval" | "reaction" | null }) {
  return via !== null ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-700 [.dark_&]:text-emerald-400">
      <span aria-hidden="true" className="font-bold">{via === "reaction" ? "👍" : "✓"}</span>
      Approved
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-amber-700 [.dark_&]:text-amber-400">
      <span aria-hidden="true">◐</span>
      Pending
    </span>
  );
}

/**
 * Who has reviewed, right under the title: formal approvals, thumbs-up
 * approvals, and anyone who objected, plus reviewers still to answer.
 */
function ReviewLine({ mr }: { mr: MergeRequestDetail }) {
  const verdict = reviewVerdict({
    author: mr.author,
    approvedBy: mr.approvedBy,
    reactions: mr.reactions,
  });
  const answered = new Set(
    [...verdict.approvers.map((entry) => entry.username), ...verdict.rejectors].map(
      (name) => name.toLowerCase(),
    ),
  );
  const pending = mr.reviewers.filter((name) => !answered.has(name.toLowerCase()));
  const chip = (username: string, mark: string, title: string, tone: string) => (
    <span
      key={`${username}-${mark}`}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border border-border py-0.5 pl-0.5 pr-2 text-sm"
    >
      <Avatar username={username} size={20} />
      <span className="max-w-[160px] truncate">{username}</span>
      <span aria-hidden="true" className={cn("font-bold", tone)}>{mark}</span>
    </span>
  );
  const nobody =
    verdict.approvers.length === 0 && verdict.rejectors.length === 0 && pending.length === 0;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pb-3">
      <span className="text-sm text-muted-foreground">Review</span>
      {verdict.approvers.map((entry) =>
        chip(
          entry.username,
          entry.via === "reaction" ? "👍" : "✓",
          entry.via === "reaction" ? "Approved with a 👍 reaction" : "Approved",
          "text-emerald-700 [.dark_&]:text-emerald-400",
        ),
      )}
      {verdict.rejectors.map((username) =>
        chip(username, "👎", "Reacted with 👎", "text-red-700 [.dark_&]:text-red-400"),
      )}
      {pending.map((username) =>
        chip(username, "◐", "Review requested, no answer yet", "text-amber-700 [.dark_&]:text-amber-400"),
      )}
      {nobody ? (
        <span className="text-sm text-muted-foreground">No reviewers assigned yet</span>
      ) : null}
      <span className="flex-1" />
      {mr.reactions.map((reaction) => (
        <span
          key={reaction.name}
          title={`${reaction.name}: ${reaction.users.join(", ")}`}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-sm"
        >
          <span aria-hidden="true">{emojiFor(reaction.name)}</span>
          {reaction.users.length}
        </span>
      ))}
    </div>
  );
}

function RailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <h4 className="px-1.5 text-xs font-normal text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

/**
 * Confirms a merge. The page's own readiness is shown first; whatever
 * is still open has to be acknowledged, because GitLab will only refuse what
 * it enforces (a required pipeline, a required approval) and not a review that
 * has not happened yet. The merge is pinned to the commit shown here.
 */
function MergeDialog({
  project,
  iid,
  mr,
  blockers,
  pipelineRunning,
  open,
  onOpenChange,
  onMerged,
}: {
  project: string;
  iid: number;
  mr: MergeRequestDetail;
  blockers: string[];
  pipelineRunning: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged: () => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [squash, setSquash] = useState(mr.squash);
  const [removeBranch, setRemoveBranch] = useState(mr.removeSourceBranch);
  const [whenGreen, setWhenGreen] = useState(pipelineRunning);
  const [acknowledged, setAcknowledged] = useState(false);
  const [merging, setMerging] = useState(false);
  useEffect(() => {
    if (!open) return;
    setSquash(mr.squash);
    setRemoveBranch(mr.removeSourceBranch);
    setWhenGreen(pipelineRunning);
    setAcknowledged(false);
  }, [open, mr.squash, mr.removeSourceBranch, pipelineRunning]);

  // GitLab still working out mergeability is not a reason to stop; a pipeline
  // that will gate the merge is covered by "merge when the pipeline succeeds".
  const open_ = blockers.filter(
    (entry) =>
      !entry.startsWith("merge status: checking") &&
      !(whenGreen && pipelineRunning && entry === "pipeline still running"),
  );
  const needsAcknowledgement = open_.length > 0;
  const canConfirm = !merging && (!needsAcknowledgement || acknowledged);

  const confirm = () => {
    if (!canConfirm) return;
    setMerging(true);
    rpc
      .call("mergeMergeRequest", {
        project,
        iid,
        sha: mr.headSha,
        squash,
        removeSourceBranch: removeBranch,
        whenPipelineSucceeds: whenGreen && pipelineRunning,
      })
      .then((result) => {
        toast.success(
          result.scheduled
            ? `!${iid} will merge when the pipeline succeeds`
            : `!${iid} merged into ${mr.targetBranch}`,
        );
        onOpenChange(false);
        onMerged();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setMerging(false));
  };

  const checkbox = (
    id: string,
    checked: boolean,
    onChange: (value: boolean) => void,
    label: string,
    hint?: string,
  ) => (
    <label key={id} className="flex cursor-pointer items-start gap-2.5 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-blue-600"
      />
      <span className="flex flex-col">
        <span className="text-foreground">{label}</span>
        {hint !== undefined ? (
          <span className="text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge !{iid} into {mr.targetBranch}?</DialogTitle>
          <DialogDescription>
            {mr.title}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
            <Tag className="font-mono text-[13px]">{mr.sourceBranch}</Tag>
            <span>→</span>
            <Tag className="font-mono text-[13px]">{mr.targetBranch}</Tag>
            <span>at commit</span>
            <span className="font-mono text-[13px] text-foreground">{mr.headSha.slice(0, 8)}</span>
          </p>
          {needsAcknowledgement ? (
            <Callout icon="⚠️" className="py-3">
              <p className="font-medium text-foreground">Not everything is green</p>
              <ul className="list-disc pl-5 text-muted-foreground">
                {open_.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
              <div className="pt-2">
                {checkbox("ack", acknowledged, setAcknowledged, "Merge anyway")}
              </div>
            </Callout>
          ) : null}
          <div className="flex flex-col gap-2.5">
            {pipelineRunning
              ? checkbox(
                  "when",
                  whenGreen,
                  setWhenGreen,
                  "Merge when the pipeline succeeds",
                  "GitLab merges it for you once the running pipeline passes.",
                )
              : null}
            {checkbox("squash", squash, setSquash, "Squash commits")}
            {checkbox("remove", removeBranch, setRemoveBranch, "Delete the source branch")}
          </div>
        </div>
        <DialogFooter>
          <GhostButton onClick={() => onOpenChange(false)}>Cancel</GhostButton>
          <PrimaryButton disabled={!canConfirm} onClick={confirm}>
            {merging ? "Merging…" : whenGreen && pipelineRunning ? "Merge when green" : "Merge"}
          </PrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type MrTab = "overview" | "changes" | "pipeline" | "discussion";

function MergeRequestDetailView({
  project,
  iid,
  onBack,
  backLabel = "Merge requests",
  compact = false,
}: {
  project: string;
  iid: number;
  onBack?: () => void;
  backLabel?: string;
  compact?: boolean;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const links = useLinks();
  const { spawn, spawningKey } = useSpawn();
  const mrKey = `mr:${project}!${iid}`;
  // The page draws from the merge request alone; the pipeline's jobs follow a
  // moment later (they need the pipeline id from the first answer).
  type MrCore = Omit<MergeRequestDetail, "jobs">;
  const [mrState, setMr] = useState<MrCore | null>(() => cachedRead<MrCore>(mrKey));
  const jobsKey = `${mrKey}:jobs`;
  const [jobsState, setJobs] = useState<Job[] | null>(() => cachedRead<Job[]>(jobsKey));
  const [error, setError] = useState<string | null>(null);
  const tabKey = `mr-tab:${project}!${iid}`;
  const rememberedTab = (): MrTab => {
    const known = stickyStore.get(tabKey) ?? readStored(tabKey);
    return known === "changes" || known === "pipeline" || known === "discussion"
      ? known
      : "overview";
  };
  const [tab, setTabState] = useState<MrTab>(rememberedTab);
  const setTab = useCallback(
    (next: MrTab) => {
      stickyStore.set(tabKey, next);
      writeStored(tabKey, next);
      setTabState(next);
    },
    [tabKey],
  );
  useDirectory([project], { people: false });

  const load = useCallback(() => {
    rpc.call("getMergeRequest", { project, iid }).then(
      (result) => {
        cachedWrite(mrKey, result.mergeRequest);
        setMr(result.mergeRequest);
        setError(null);
        const pipelineId = result.mergeRequest.pipeline?.id ?? 0;
        if (pipelineId === 0) {
          setJobs([]);
          return;
        }
        rpc.call("getPipelineJobs", { project, id: pipelineId }).then(
          (jobsResult) => {
            const next: Job[] = jobsResult.jobs.map((job) => ({
              id: job.id,
              name: job.name,
              status: classifyJobStatus(job.status),
              rawStatus: job.status,
              url: job.url,
            }));
            cachedWrite(jobsKey, next);
            setJobs(next);
          },
          () => setJobs((prev) => prev ?? []),
        );
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, project, iid, mrKey, jobsKey]);
  useEffect(() => {
    setMr(cachedRead<MrCore>(mrKey));
    setJobs(cachedRead<Job[]>(jobsKey));
    // A different merge request opens on the tab it was last left on.
    setTabState(rememberedTab());
    load();
  }, [load, tabKey, jobsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // A running pipeline changes without anything telling the panel.
  usePolling(
    mrState !== null &&
      mrState.pipeline !== null &&
      !isTerminalPipelineStatus(mrState.pipeline.status),
    load,
    10000,
  );
  const { setAssignees, setReviewers, setLabels } = useItemMutations();
  const actions = usePipelineActions(project, load);
  const [mergeOpen, setMergeOpen] = useState(false);
  // Read synchronously by the toggles: a setState updater runs too late to
  // build the payload from (see the issue page).
  const mrRef = useRef<MrCore | null>(null);
  mrRef.current = mrState;
  const togglePerson = useCallback(
    (field: "assignees" | "reviewers", username: string, on: boolean) => {
      const current = mrRef.current;
      if (current === null) return;
      const next = toggled(current[field], username, on);
      mrRef.current = { ...current, [field]: next };
      setMr(mrRef.current);
      const call =
        field === "assignees"
          ? setAssignees(project, iid, next, "mr")
          : setReviewers(project, iid, next);
      call.catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setAssignees, setReviewers, project, iid, load],
  );
  const toggleLabel = useCallback(
    (label: string, on: boolean) => {
      const current = mrRef.current;
      if (current === null) return;
      const next = toggled(current.labels, label, on);
      mrRef.current = { ...current, labels: next };
      setMr(mrRef.current);
      setLabels(project, iid, next, "mr").catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setLabels, project, iid, load],
  );

  if (error !== null) return <Callout icon="⚠️">{error}</Callout>;
  if (mrState === null) return <PageSkeleton />;

  const mrLinks = links[linkKey("mr", project, iid)];
  const mr: MergeRequestDetail = { ...mrState, jobs: jobsState ?? [] };
  const readiness = readinessOf(mr);
  const failedJobs = mr.jobs.filter((job) => job.status === "failure");
  const unresolved = mr.discussions.filter((entry) => entry.resolvable && !entry.resolved);
  const pipelineId = mr.pipeline?.id ?? 0;
  const canRetry =
    pipelineId > 0 &&
    retryableJobs(mr.jobs.map((job) => ({ status: job.rawStatus }))).length > 0;
  const verdict = reviewVerdict({
    author: mr.author,
    approvedBy: mr.approvedBy,
    reactions: mr.reactions,
  });
  const approvedVia = new Map(
    verdict.approvers.map((entry) => [entry.username.toLowerCase(), entry.via] as const),
  );

  const tabs: Array<{ id: MrTab; label: string; badge?: { text: string; bad: boolean } }> = [
    { id: "overview", label: "Overview" },
    {
      id: "changes",
      label: "Changes",
      badge: { text: String(mr.changedFiles), bad: false },
    },
    {
      id: "pipeline",
      label: "Pipeline",
      ...(failedJobs.length > 0
        ? { badge: { text: `${failedJobs.length} failed`, bad: true } }
        : {}),
    },
    {
      id: "discussion",
      label: "Discussion",
      ...(unresolved.length > 0
        ? { badge: { text: `${unresolved.length} open`, bad: true } }
        : {}),
    },
  ];

  return (
    <div className="flex flex-col">
      <PageTopBar
        crumbs={[
          ...(onBack !== undefined ? [{ label: backLabel, onClick: onBack }] : []),
          ...(compact ? [] : [{ label: shortProject(project), title: project }]),
          { label: `!${iid}` },
        ]}
        actions={
          <>
            <GhostButton
              disabled={spawningKey !== null}
              onClick={() => spawn("mr", project, iid)}
            >
              {spawningKey !== null ? "Starting…" : compact ? "⚡ Review" : "⚡ Review with agent"}
            </GhostButton>
            <PageMoreMenu url={mr.url} />
          </>
        }
      />
      <article className={cn("@container mx-auto w-full pb-8", compact ? "pt-3" : "max-w-[960px] pt-8")}>
        <h1
          className={cn(
            "pb-2 font-bold leading-[1.2] text-foreground",
            compact ? "text-[24px]" : "text-[32px]",
          )}
        >
          {mr.title}
        </h1>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 pb-4 text-sm text-muted-foreground">
          <StateStatus state={mr.state} draft={mr.draft} />
          <Person username={mr.author} />
          <span>wants to merge</span>
          <Tag className="font-mono text-[13px]" title={mr.sourceBranch}>{mr.sourceBranch}</Tag>
          <span>into</span>
          <Tag className="font-mono text-[13px]" title={mr.targetBranch}>{mr.targetBranch}</Tag>
          <span aria-hidden="true">·</span>
          <span title={formatDateTime(mr.updatedAt)}>updated {relativeTime(mr.updatedAt)}</span>
        </div>

        <div className="grid grid-cols-2 gap-2 pb-2 @[640px]:grid-cols-4">
          <ReadinessCell {...readiness.review} onClick={() => setTab("overview")} />
          <ReadinessCell {...readiness.pipeline} onClick={() => setTab("pipeline")} />
          <ReadinessCell {...readiness.discussions} onClick={() => setTab("discussion")} />
          <ReadinessCell {...readiness.conflicts} onClick={() => setTab("overview")} />
        </div>
        <ReviewLine mr={mr} />
        <div className="flex flex-wrap items-center gap-2 pb-4 pt-0">
          {mr.state !== "opened" ? (
            <span className="text-sm text-muted-foreground">
              This merge request is {mr.state}.
            </span>
          ) : readiness.blockers.length === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 [.dark_&]:text-emerald-400">
              <span aria-hidden="true" className="font-bold">✓</span>
              Ready to merge
            </span>
          ) : readiness.conflicts.tone === "wait" && readiness.blockers.length === 1 ? (
            // GitLab is still working out mergeability; that is not a blocker yet.
            <span className="text-sm text-muted-foreground">Checking merge status…</span>
          ) : (
            <span className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Blocked:</span>{" "}
              {readiness.blockers.join(" · ")}
            </span>
          )}
          <span className="flex-1" />
          {canRetry ? (
            <GhostButton
              disabled={actions.busy === `pipeline-${pipelineId}`}
              onClick={() => actions.retryPipeline(pipelineId)}
            >
              Retry failed jobs
            </GhostButton>
          ) : null}
          {mr.state === "opened" ? (
            mr.mergeScheduled ? (
              <span className="text-sm text-muted-foreground">
                Merge scheduled: waiting for the pipeline
              </span>
            ) : (
              <PrimaryButton
                disabled={!mergeAllowance(mr).allowed}
                title={mergeAllowance(mr).reason ?? "Merge this merge request"}
                className={
                  readiness.blockers.length > 0 && mergeAllowance(mr).allowed
                    ? "border border-border bg-transparent text-foreground hover:bg-state-hover"
                    : undefined
                }
                onClick={() => setMergeOpen(true)}
              >
                {readiness.blockers.length > 0 ? "Merge…" : "Merge"}
              </PrimaryButton>
            )
          ) : null}
          <a
            href={mr.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          >
            <Icon path={ICONS.external} size={14} />
            Open in GitLab
          </a>
        </div>

        <MergeDialog
          project={project}
          iid={iid}
          mr={mr}
          blockers={readiness.blockers}
          pipelineRunning={readiness.pipeline.tone === "wait"}
          open={mergeOpen}
          onOpenChange={setMergeOpen}
          onMerged={() => {
            load();
            setTimeout(load, 1500);
          }}
        />
        <div className="mb-4 flex gap-0.5 overflow-x-auto border-b border-border/70" role="tablist">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={cn(
                "-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 pb-2 pt-1.5 text-sm transition-colors",
                tab === entry.id
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.label}
              {entry.badge !== undefined ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[11.5px] font-medium leading-[18px]",
                    entry.badge.bad
                      ? "bg-red-500/15 text-red-800 [.dark_&]:text-red-300"
                      : "bg-foreground/[0.08] text-muted-foreground",
                  )}
                >
                  {entry.badge.text}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-8 @[640px]:grid-cols-[minmax(0,1fr)_240px]">
          <div className="flex min-w-0 flex-col gap-5">
            {tab === "overview" ? (
              <>
                {failedJobs.slice(0, 2).map((job) => (
                  <BlockerCard key={job.id > 0 ? job.id : job.name} project={project} job={job} actions={actions} />
                ))}
                {failedJobs.length > 2 ? (
                  <button
                    type="button"
                    className="self-start text-sm text-muted-foreground underline underline-offset-4"
                    onClick={() => setTab("pipeline")}
                  >
                    {failedJobs.length - 2} more failed jobs
                  </button>
                ) : null}
                <section className="flex flex-col gap-1.5">
                  <h2 className="text-base font-semibold text-foreground">Description</h2>
                  <Clamp>
                    <PageBody16 body={mr.body} />
                  </Clamp>
                </section>
                {unresolved.length > 0 ? (
                  <section className="flex flex-col gap-2">
                    <h2 className="text-base font-semibold text-foreground">
                      Unresolved{" "}
                      <span className="rounded-full bg-red-500/15 px-1.5 text-[11.5px] font-medium text-red-800 [.dark_&]:text-red-300">
                        {unresolved.length}
                      </span>
                    </h2>
                    <div className="flex flex-col gap-3">
                      {unresolved.slice(0, 5).map((discussion) => (
                        <ThreadCard
                          key={discussion.id}
                          project={project}
                          iid={iid}
                          discussion={discussion}
                          onChanged={load}
                        />
                      ))}
                    </div>
                    {unresolved.length > 5 ? (
                      <button
                        type="button"
                        className="self-start text-sm text-muted-foreground underline underline-offset-4"
                        onClick={() => setTab("discussion")}
                      >
                        {unresolved.length - 5} more threads
                      </button>
                    ) : null}
                  </section>
                ) : null}
              </>
            ) : null}

            {tab === "changes" ? <ChangesList project={project} iid={iid} mr={mr} /> : null}

            {tab === "pipeline" ? (
              <PipelineTab
                project={project}
                pipeline={mr.pipeline}
                jobs={mr.jobs}
                actions={actions}
              />
            ) : null}

            {tab === "discussion" ? (
              <>
                {mr.discussions.length > 0 ? (
                  <div className="flex flex-col gap-4">
                    {/* Open threads first; everything else keeps GitLab's order. */}
                    {[...mr.discussions]
                      .sort(
                        (a, b) =>
                          Number(b.resolvable && !b.resolved) -
                          Number(a.resolvable && !a.resolved),
                      )
                      .map((discussion) => (
                        <ThreadCard
                          key={discussion.id}
                          project={project}
                          iid={iid}
                          discussion={discussion}
                          onChanged={load}
                        />
                      ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No comments yet.</p>
                )}
                <PageComments
                  method="commentMergeRequest"
                  project={project}
                  iid={iid}
                  notes={[]}
                  onPosted={load}
                />
              </>
            ) : null}
          </div>

          <aside className="flex flex-col gap-4" aria-label="Details">
            <RailSection title="Reviewers">
              <PeoplePicker
                project={project}
                title="Reviewers"
                people={mr.reviewers}
                stack
                renderPerson={(username) => (
                  <span className="flex min-w-0 items-center gap-2">
                    <Person username={username} />
                    <ApprovalBadge via={approvedVia.get(username.toLowerCase()) ?? null} />
                  </span>
                )}
                onToggle={(username, on) => togglePerson("reviewers", username, on)}
              />
            </RailSection>
            <RailSection title="Assignee">
              <PeoplePicker
                project={project}
                title="Assignees"
                people={mr.assignees}
                stack
                onToggle={(username, on) => togglePerson("assignees", username, on)}
              />
            </RailSection>
            <RailSection title="Labels">
              <LabelPicker project={project} labels={mr.labels} onToggle={toggleLabel} />
            </RailSection>
            {mrLinks !== undefined && mrLinks.length > 0 ? (
              <RailSection title="Agents">
                <div className="flex flex-wrap gap-1.5 px-1.5">
                  <ThreadPills links={mrLinks} />
                </div>
              </RailSection>
            ) : null}
            <RailSection title="Created">
              <span className="px-1.5 text-sm text-foreground">{formatDateTime(mr.createdAt)}</span>
            </RailSection>
          </aside>
        </div>
      </article>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The thread side panel (threadPanelAction): auto-resolve the thread's own
// merge request (its environment branch's, else the one it was spawned to
// review) and show the compact page; fall back to a picker over open ones.
// ---------------------------------------------------------------------------

/** Notion's list view: page icon, title, properties on the right. */
function ListRow({
  title,
  onOpen,
  children,
}: {
  title: string;
  onOpen: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
      className="group flex h-9 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm transition-colors hover:bg-state-hover"
    >
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {title}
      </span>
      {children}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2 py-1">
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-5/6" />
      <Skeleton className="h-5 w-2/3" />
    </div>
  );
}

function MergeRequestPickerList({
  onPick,
}: {
  onPick: (project: string, iid: number) => void;
}) {
  const { items, error } = useItems({ kind: "mr", state: "open" });
  if (error !== null) return <Callout icon="⚠️">{error}</Callout>;
  if (items === null) return <ListSkeleton />;
  if (items.length === 0) {
    return (
      <EmptyState message="No open merge requests in the tracked projects." />
    );
  }
  return (
    <div className="flex flex-col">
      {items.map((item) => (
        <ListRow
          key={linkKey("mr", item.project, item.iid)}
          title={item.title}
          onOpen={() => onPick(item.project, item.iid)}
        >
          <span className="shrink-0 text-muted-foreground">!{item.iid}</span>
          <StateStatus state={item.state} draft={item.draft} />
        </ListRow>
      ))}
    </div>
  );
}

function MergeRequestPanelTab({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [resolved, setResolved] = useState(false);
  const [selected, setSelected] = useSticky<{
    project: string;
    iid: number;
  } | null>(`thread-mr:${threadId}`, null);

  useEffect(() => {
    let cancelled = false;
    // A merge request picked by hand stays picked when the panel reopens.
    if (selected !== null) {
      setResolved(true);
      return;
    }
    rpc.call("mergeRequestForThread", { threadId }).then(
      (result) => {
        if (cancelled) return;
        if (result.mergeRequest !== null) setSelected(result.mergeRequest);
        setResolved(true);
      },
      () => {
        if (!cancelled) setResolved(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  if (!resolved) return <PageSkeleton />;
  if (selected === null) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          No merge request is linked to this thread yet. Pick one:
        </p>
        <MergeRequestPickerList
          onPick={(project, iid) => setSelected({ project, iid })}
        />
      </div>
    );
  }
  return (
    <MergeRequestDetailView
      project={selected.project}
      iid={selected.iid}
      compact
      backLabel="All merge requests"
      onBack={() => setSelected(null)}
    />
  );
}

// ---------------------------------------------------------------------------
// New issue: an empty Notion page.
// ---------------------------------------------------------------------------

function NewIssueForm({
  projects,
  defaultProject,
  onCreated,
  onCancel,
}: {
  projects: ProjectInfo[];
  defaultProject: string | null;
  onCreated: (project: string, iid: number | null) => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const [project, setProject] = useState(
    defaultProject ?? projects[0]?.project ?? "",
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [creating, setCreating] = useState(false);
  const ready = !creating && title.trim().length > 0 && project.length > 0;

  const create = useCallback(() => {
    if (!ready) return;
    setCreating(true);
    rpc
      .call("createIssue", { project, title, body })
      .then((result) => {
        toast.success("Issue created");
        onCreated(project, result.iid);
      })
      .catch((err: unknown) => toast.error(errorText(err)))
      .finally(() => setCreating(false));
  }, [rpc, ready, project, title, body, onCreated]);

  const submitOnModEnter = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      create();
    }
  };

  return (
    <div className="flex flex-col">
      <PageTopBar
        crumbs={[{ label: "Issues", onClick: onCancel }, { label: "New issue" }]}
        actions={
          <>
            <GhostButton onClick={onCancel}>Cancel</GhostButton>
            <PrimaryButton disabled={!ready} onClick={create} title="Create (⌘/Ctrl+Enter)">
              {creating ? "Creating…" : "Create"}
            </PrimaryButton>
          </>
        }
      />
      <article className="mx-auto w-full max-w-[708px] pt-12">
        <input
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={submitOnModEnter}
          placeholder="Untitled"
          aria-label="Issue title"
          autoFocus
          className="w-full border-none bg-transparent pb-2 text-[40px] font-bold leading-[1.2] text-foreground placeholder:text-muted-foreground/30 focus:outline-none"
        />
        <div className="flex flex-col gap-0.5 py-1.5">
          <PropertyRow
            icon={ICONS.folder}
            label="Project"
            control={
              <Select value={project} onValueChange={setProject}>
                <SelectTrigger
                  className={cn(
                    PROPERTY_CONTROL_CLASS,
                    "h-auto w-auto justify-start border-none bg-transparent shadow-none focus:ring-0 [&>svg]:hidden",
                  )}
                  aria-label="Project"
                >
                  <SelectValue placeholder="Empty" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((entry) => (
                    <SelectItem key={entry.project} value={entry.project}>
                      {entry.project}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </div>
        <div className="mt-2 border-t border-border/70 pt-6">
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={submitOnModEnter}
            placeholder="Write a description in Markdown…"
            aria-label="Issue description"
            rows={12}
            className="resize-none border-none bg-transparent px-0 py-0 text-base leading-normal shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
          />
        </div>
      </article>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel: header content, the glab banner, routed body.
// ---------------------------------------------------------------------------

function PanelHeader() {
  const rpc = useRpc<typeof gitlabRpcContract>();
  const status = useStatus();
  const [syncing, setSyncing] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    setSyncing(true);
    setFailed(false);
    rpc
      .call("refresh")
      .catch(() => setFailed(true))
      .finally(() => setSyncing(false));
  }, [rpc]);
  return (
    <>
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {failed
          ? "Sync failed — check `glab auth status`"
          : status === null
            ? "Loading…"
            : status.glabOk
              ? `${status.projects.length} project${status.projects.length === 1 ? "" : "s"} · synced ${
                  status.lastSyncedAt !== null
                    ? relativeTime(status.lastSyncedAt)
                    : "never"
                }`
              : "GitLab CLI not authenticated"}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="size-7 gap-1.5 px-0 text-xs text-muted-foreground hover:text-foreground sm:h-7 sm:w-auto sm:px-2.5"
        disabled={syncing}
        onClick={refresh}
        aria-label={syncing ? "Syncing GitLab data" : "Refresh GitLab data"}
      >
        <RefreshIcon className={syncing ? "animate-spin" : undefined} />
        <span className="hidden sm:inline">
          {syncing ? "Syncing…" : "Sync"}
        </span>
      </Button>
    </>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 0 0-15.2-6.5L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 15.2 6.5L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

const QUERY_KEY = "gitlab-ui:query";
const DEFAULT_QUERY = "is:open ";

/** Shown whenever `glab` is missing or logged out. */
function StatusBanner({ error }: { error: string | null }) {
  return (
    <Callout icon="⚠️" className="mb-6">
      <p className="font-medium text-foreground">
        The GitLab CLI is not available or not authenticated
      </p>
      <p className="text-muted-foreground">
        Install glab from gitlab.com/gitlab-org/cli, run{" "}
        <code className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[13px] text-foreground">
          glab auth login
        </code>
        , then reload the plugin. Cached items stay readable; edits fail until
        then.
      </p>
      {error !== null && error.length > 0 ? (
        <p className="whitespace-pre-wrap pt-1 font-mono text-xs text-red-700 [.dark_&]:text-red-400">
          {error}
        </p>
      ) : null}
    </Callout>
  );
}

function GitlabRoutedBody({
  route,
  navigate,
  status,
  query,
  onQuery,
}: {
  route: Route;
  navigate: (route: Route) => void;
  status: Status | null;
  query: string;
  onQuery: (query: string) => void;
}) {
  const projects = status?.projects ?? [];
  if (status !== null && status.projects.length === 0) {
    return (
      <Callout icon="💡">
        No GitLab projects tracked yet. Create a BB project whose checkout has a
        GitLab origin remote, or add projects with the extraProjects plugin
        setting.
      </Callout>
    );
  }
  if (route.view === "issue") {
    return (
      <IssueDetailView
        project={route.project}
        iid={route.iid}
        onBack={() => navigate({ view: "issues" })}
      />
    );
  }
  if (route.view === "merge_request") {
    return (
      <MergeRequestDetailView
        project={route.project}
        iid={route.iid}
        onBack={() => navigate({ view: "merge_requests" })}
      />
    );
  }
  if (route.view === "pipeline") {
    return (
      <PipelineDetailView
        project={route.project}
        id={route.id}
        onBack={() => navigate({ view: "pipelines" })}
      />
    );
  }
  if (route.view === "pipelines") {
    return <PipelinesView navigate={navigate} projects={projects} />;
  }
  if (route.view === "branches") {
    return <BranchesView navigate={navigate} projects={projects} />;
  }
  if (route.view === "new") {
    return (
      <NewIssueForm
        projects={projects}
        defaultProject={queryProject(
          parseItemQuery(query),
          projects.map((entry) => entry.project),
        )}
        onCreated={(project, iid) =>
          navigate(
            iid !== null
              ? { view: "issue", project, iid }
              : { view: "issues" },
          )
        }
        onCancel={() => navigate({ view: "issues" })}
      />
    );
  }
  return (
    <DatabaseView
      route={route}
      navigate={navigate}
      projects={projects}
      query={query}
      onQuery={onQuery}
    />
  );
}

/** Gives every avatar below it the signed-in user, so "you" gets a ring. */
function ViewerScope({ children }: { children: React.ReactNode }) {
  const viewer = useViewer();
  return <ViewerContext.Provider value={viewer}>{children}</ViewerContext.Provider>;
}

function GitlabPanel({ subPath }: PluginNavPanelProps) {
  const bbNavigate = useBbNavigate();
  // Opening the panel with no target lands where you left it.
  const restoreTo = subPath === "" ? readStored(ROUTE_KEY) : null;
  useEffect(() => {
    if (restoreTo !== null && restoreTo !== "") {
      bbNavigate.toPluginPanel(PANEL_PATH, { subPath: restoreTo });
    }
    // Only on first render of this mount.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (subPath !== "") writeStored(ROUTE_KEY, subPath);
  }, [subPath]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollKey = `scroll:${subPath}`;
  // Remember where each page was scrolled to, and return there once its
  // content has loaded (a list is empty on the first frame).
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const wanted = Number(stickyStore.get(scrollKey) ?? 0);
    if (wanted > 0) {
      const timers = [60, 250, 700, 1500].map((delay) =>
        setTimeout(() => {
          if (element.scrollTop < wanted) element.scrollTop = wanted;
        }, delay),
      );
      return () => timers.forEach(clearTimeout);
    }
  }, [scrollKey]);
  const [route, navigate] = useSubPathRoute(subPath);
  const status = useStatus();
  const [query, setQueryState] = useState(() => {
    try {
      return window.localStorage.getItem(QUERY_KEY) ?? DEFAULT_QUERY;
    } catch {
      return DEFAULT_QUERY;
    }
  });
  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    try {
      window.localStorage.setItem(QUERY_KEY, next);
    } catch {
      // private mode / storage disabled — the filter just won't persist
    }
  }, []);
  return (
    <ViewerScope>
    <div
      ref={scrollRef}
      onScroll={(event) => stickyStore.set(scrollKey, event.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-3 sm:px-8 xl:px-12 2xl:px-24"
    >
      {status !== null && !status.glabOk ? (
        <StatusBanner error={status.glabError} />
      ) : null}
      <GitlabRoutedBody
        route={route}
        navigate={navigate}
        status={status}
        query={query}
        onQuery={setQuery}
      />
    </div>
    </ViewerScope>
  );
}

// ---------------------------------------------------------------------------
// Homepage section: the newest open issues as a Notion list, scoped to the
// project in view when that project has a GitLab remote.
// ---------------------------------------------------------------------------

const HOMEPAGE_ROWS = 5;

function RecentIssuesSection({ projectId }: PluginHomepageSectionProps) {
  const navigate = useBbNavigate();
  const status = useStatus();
  const { spawn, spawningKey } = useSpawn();
  // A homepage project with no GitLab remote (and the no-project case) shows
  // every tracked project's issues rather than an accidental match on null.
  const scoped =
    projectId === null
      ? null
      : (status?.projects.find((entry) => entry.bbProjectId === projectId)
          ?.project ?? null);
  const { items, error } = useItems({
    kind: "issue",
    project: scoped,
    state: "open",
  });
  useDirectory(
    items === null ? [] : [...new Set(items.slice(0, HOMEPAGE_ROWS).map((item) => item.project))],
    { people: false },
  );

  if (error !== null) return <Callout icon="⚠️">{error}</Callout>;
  if (items === null) return <ListSkeleton />;
  if (items.length === 0) {
    return <EmptyState message="No open GitLab issues." className="py-6" />;
  }
  return (
    <div className="flex flex-col">
      {items.slice(0, HOMEPAGE_ROWS).map((item) => (
        <ListRow
          key={linkKey("issue", item.project, item.iid)}
          title={item.title}
          onOpen={() =>
            navigate.toPluginPanel(PANEL_PATH, {
              subPath: routeToSubPath({
                view: "issue",
                project: item.project,
                iid: item.iid,
              }),
            })
          }
        >
          <span className="shrink-0 text-muted-foreground">#{item.iid}</span>
          <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
            <LabelTags labels={item.labels} max={2} />
          </span>
          <ChipButton
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            disabled={spawningKey !== null}
            aria-label={`Send agent to issue #${item.iid}`}
            onClick={(event) => {
              event.stopPropagation();
              spawn("issue", item.project, item.iid);
            }}
          >
            {spawningKey === linkKey("issue", item.project, item.iid)
              ? "…"
              : "⚡ AGENT"}
          </ChipButton>
        </ListRow>
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "gitlab-ui",
    title: "GitLab",
    icon: "GitMerge",
    path: PANEL_PATH,
    component: GitlabPanel,
    headerContent: PanelHeader,
  });
  app.slots.homepageSection({
    id: "gitlab-ui-issues",
    title: "GitLab issues",
    component: (props: PluginHomepageSectionProps) => (
      <ViewerScope>
        <RecentIssuesSection {...props} />
      </ViewerScope>
    ),
  });
  app.slots.threadPanelAction({
    id: "merge-request",
    title: "Merge request",
    icon: "GitMerge",
    component: (props: PluginThreadPanelProps) => (
      <ViewerScope>
        <MergeRequestPanelTab {...props} />
      </ViewerScope>
    ),
  });
});
