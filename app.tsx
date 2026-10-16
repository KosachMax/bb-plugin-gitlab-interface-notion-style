// bb-plugin-gitlab — the frontend bundle.
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/empty-state";
import {
  Avatar,
  Callout,
  ChipButton,
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
  ToggleSection,
  ViewTab,
  type NotionColor,
} from "@/components/notion";
import { cn } from "@/lib/utils";
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
  name: string;
  status: "success" | "failure" | "pending" | "neutral";
  /** GitLab's own word for it — "manual", "skipped", "canceled", … */
  rawStatus: string;
  url: string;
}

interface Discussion {
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
  /** Summed over `files` only — partial whenever filesTruncated is true. */
  additions: number;
  deletions: number;
  /** GitLab's own total, which can exceed files.length. */
  changedFiles: number;
  /** True when the merge request has more files than one diff page. */
  filesTruncated: boolean;
  labels: string[];
  assignees: string[];
  reviewers: string[];
  mergeStatus: string;
  hasConflicts: boolean;
  approvalsRequired: number;
  approvalsLeft: number;
  approvedBy: string[];
  pipeline: { status: string; url: string } | null;
  jobs: Job[];
  notes: Note[];
  discussions: Discussion[];
  files: DiffFile[];
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

const PANEL_PATH = "gitlab";

type Route =
  | { view: "issues" }
  | { view: "merge_requests" }
  | { view: "new" }
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
    (project: string, iid: number, assignees: string[]) =>
      rpc.call("setAssignees", { project, iid, assignees }),
    [rpc],
  );
  const setLabels = useCallback(
    (project: string, iid: number, labels: string[]) =>
      rpc.call("setLabels", { project, iid, labels }),
    [rpc],
  );
  return { setIssueState, setAssignees, setLabels };
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
    <StatusPill color={stateColor(state, draft)}>
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
    <StatusPill color={pipelineColor(status)} pulse={status === "running"}>
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </StatusPill>
  );
}

/** Multi-select labels: each label keeps one hue everywhere. */
function LabelTags({ labels, max }: { labels: string[]; max?: number }) {
  if (labels.length === 0) return null;
  const shown = max === undefined ? labels : labels.slice(0, max);
  return (
    <>
      {shown.map((label) => (
        <Tag key={label} color={colorForName(label)} title={label}>
          {label}
        </Tag>
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

type FilterKey = "is" | "draft" | "assignee" | "author" | "label" | "project";

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
  author: "Author",
  label: "Label",
  project: "Project",
};

const FILTER_ICONS: Record<FilterKey, string> = {
  is: ICONS.status,
  draft: ICONS.page,
  assignee: ICONS.user,
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

function useFilterOptions(
  kind: Kind,
  items: Item[] | null,
  projects: ProjectInfo[],
): Record<FilterKey, FilterOption[]> {
  const viewer = useViewer();
  return useMemo(() => {
    const users = new Set<string>();
    const labels = new Set<string>();
    for (const item of items ?? []) {
      if (item.author.length > 0) users.add(item.author);
      for (const username of item.assignees) users.add(username);
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
      author: asPeople("author"),
      label: [
        { key: "no", value: "label", label: "No label" },
        ...[...labels]
          .sort((a, b) => a.localeCompare(b))
          .map((label) => ({
            key: "label",
            value: label,
            label,
            content: <Tag color={colorForName(label)}>{label}</Tag>,
          })),
      ],
      project: projects.map((entry) => ({
        key: "project",
        value: entry.project,
        label: shortProject(entry.project),
      })),
    };
  }, [kind, items, projects, viewer]);
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
      <DropdownMenuContent align="start" className="max-h-80 w-60 overflow-y-auto">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {title}
        </DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={`${option.key}:${option.value}`}
            checked={isSelected(option)}
            onCheckedChange={(checked) => toggle(option, checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            <span className="flex min-w-0 items-center gap-2">
              {option.content ?? <span className="truncate">{option.label}</span>}
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
      </DropdownMenuContent>
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
      <td className={CELL} title={item.assignees.join(", ")}>
        {item.assignees.length > 0 ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Person username={item.assignees[0]} />
            {item.assignees.length > 1 ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                +{item.assignees.length - 1}
              </span>
            ) : null}
          </span>
        ) : null}
      </td>
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
  const columns = showProject ? 7 : 6;

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
          showProject ? "min-w-[1060px]" : "min-w-[900px]",
        )}
      >
        <colgroup>
          <col />
          <col className="w-[76px]" />
          <col className="w-[104px]" />
          <col className="w-[170px]" />
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
  const [showFilters, setShowFilters] = useState(hasQualifiers);
  const onNew = kind === "issue" ? () => navigate({ view: "new" }) : undefined;

  return (
    <div className="flex flex-col">
      <h1 className="pb-6 pt-2 text-[40px] font-bold leading-[1.2] text-foreground">
        GitLab
      </h1>
      <div className="flex flex-wrap items-center gap-1 pb-1.5" role="tablist">
        <ViewTab
          icon={ICONS.table}
          active={kind === "issue"}
          onClick={() => navigate({ view: "issues" })}
        >
          Issues
        </ViewTab>
        <ViewTab
          icon={ICONS.branch}
          active={kind === "mr"}
          onClick={() => navigate({ view: "merge_requests" })}
        >
          Merge requests
        </ViewTab>
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

function AssigneePicker({
  project,
  assignees,
  onToggle,
}: {
  project: string;
  assignees: string[];
  onToggle: (username: string, assigned: boolean) => void;
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

  // The viewer floats to the top of the picker.
  const ordered =
    users === null
      ? null
      : [...users].sort((a, b) => Number(b === viewer) - Number(a === viewer));

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={PROPERTY_CONTROL_CLASS} aria-label="Edit assignees">
          {assignees.length === 0 ? (
            <EmptyValue />
          ) : (
            assignees.map((username) => <Person key={username} username={username} />)
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-60 overflow-y-auto">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Assignees
        </DropdownMenuLabel>
        {loadError !== null ? (
          <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>
        ) : ordered === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : ordered.length === 0 ? (
          <DropdownMenuItem disabled>No assignable users</DropdownMenuItem>
        ) : (
          ordered.map((username) => (
            <DropdownMenuCheckboxItem
              key={username}
              checked={assignees.includes(username)}
              onCheckedChange={(checked) => onToggle(username, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <Person username={username === viewer ? `${username} (me)` : username} />
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
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

  const ordered =
    available === null
      ? null
      : [...new Set([...labels, ...available])].sort((a, b) =>
          a.localeCompare(b),
        );

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={PROPERTY_CONTROL_CLASS} aria-label="Edit labels">
          {labels.length === 0 ? <EmptyValue /> : <LabelTags labels={labels} />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-60 overflow-y-auto">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Labels
        </DropdownMenuLabel>
        {loadError !== null ? (
          <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>
        ) : ordered === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : ordered.length === 0 ? (
          <DropdownMenuItem disabled>No labels in this project</DropdownMenuItem>
        ) : (
          ordered.map((label) => (
            <DropdownMenuCheckboxItem
              key={label}
              checked={labels.includes(label)}
              onCheckedChange={(checked) => onToggle(label, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <Tag color={colorForName(label)}>{label}</Tag>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
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
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The latest detail, readable synchronously by the toggles below: a
  // setState updater runs later than the call that needs its result.
  const detailRef = useRef<IssueDetail | null>(null);
  detailRef.current = detail;

  const load = useCallback(() => {
    rpc.call("getIssue", { project, iid }).then(
      (result) => {
        setDetail(result.issue);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, project, iid]);
  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);

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
              <AssigneePicker
                project={project}
                assignees={detail.assignees}
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

/** GitLab's pipeline and its jobs: a toggle that opens itself on failure. */
function PipelineSection({
  pipeline,
  jobs,
}: {
  pipeline: MergeRequestDetail["pipeline"];
  jobs: Job[];
}) {
  if (pipeline === null && jobs.length === 0) return null;
  const passing = jobs.filter((job) => job.status === "success").length;
  const failing = jobs.filter((job) => job.status === "failure").length;
  return (
    <ToggleSection
      title="Pipeline"
      defaultOpen={failing > 0}
      meta={
        jobs.length > 0
          ? `${passing}/${jobs.length} passed${failing > 0 ? ` · ${failing} failed` : ""}`
          : undefined
      }
      actions={
        pipeline !== null && pipeline.url.length > 0 ? (
          <a
            href={pipeline.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          >
            <Icon path={ICONS.external} size={14} />
            GitLab
          </a>
        ) : undefined
      }
    >
      {jobs.length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">No jobs.</p>
      ) : (
        <div className="flex flex-col">
          {jobs.map((job, index) => (
            <div
              key={`${job.name}-${index}`}
              className="group/job flex h-8 items-center gap-2 rounded-md px-1.5 text-sm transition-colors hover:bg-state-hover"
            >
              <span className="w-28 shrink-0">
                <PipelineStatus status={job.rawStatus} />
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
                {job.name}
              </span>
              {job.url.length > 0 ? (
                <a
                  href={job.url}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/job:opacity-100"
                >
                  Log ↗
                </a>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </ToggleSection>
  );
}

function approvalsText(mr: MergeRequestDetail): string {
  if (mr.approvalsRequired === 0) {
    return mr.approvedBy.length > 0
      ? `${mr.approvedBy.length} approval${mr.approvedBy.length === 1 ? "" : "s"}`
      : "Not required";
  }
  const approved = Math.max(0, mr.approvalsRequired - mr.approvalsLeft);
  return mr.approvalsLeft === 0
    ? `Approved ${approved}/${mr.approvalsRequired}`
    : `${approved}/${mr.approvalsRequired} · ${mr.approvalsLeft} left`;
}

/** An inline review thread: file/line, resolved state, its comments. */
function DiscussionBlock({ discussion }: { discussion: Discussion }) {
  return (
    <div className="flex flex-col border-l-2 border-border pl-3">
      <p className="flex min-w-0 items-center gap-2 py-1 text-sm">
        <span className="min-w-0 truncate font-mono text-[13px] text-muted-foreground">
          {discussion.path.length > 0 ? discussion.path : "General"}
          {discussion.line !== null ? `:${discussion.line}` : ""}
        </span>
        {discussion.resolved ? (
          <Tag color="green">Resolved</Tag>
        ) : (
          <Tag color="orange">Unresolved</Tag>
        )}
      </p>
      {discussion.notes.map((note, index) => (
        <CommentItem key={`${note.createdAt}-${index}`} note={note} />
      ))}
    </div>
  );
}

function DiscussionsSection({ discussions }: { discussions: Discussion[] }) {
  // Grouped by file, then in line order: reviewing reads file by file.
  const ordered = useMemo(
    () =>
      [...discussions].sort(
        (a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0),
      ),
    [discussions],
  );
  if (ordered.length === 0) return null;
  const unresolved = discussions.filter((entry) => !entry.resolved).length;
  return (
    <ToggleSection
      title="Discussions"
      defaultOpen={unresolved > 0}
      meta={`${discussions.length}${unresolved > 0 ? ` · ${unresolved} unresolved` : ""}`}
    >
      <div className="flex flex-col gap-3 py-1">
        {ordered.map((discussion, index) => (
          <DiscussionBlock key={index} discussion={discussion} />
        ))}
      </div>
    </ToggleSection>
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

function ChangesSection({ mr }: { mr: MergeRequestDetail }) {
  if (mr.files.length === 0) return null;
  return (
    <ToggleSection
      title="Changes"
      meta={
        <>
          {mr.filesTruncated
            ? `${mr.files.length} of ${mr.changedFiles} files`
            : `${mr.files.length} file${mr.files.length === 1 ? "" : "s"}`}{" "}
          <span className="font-mono text-emerald-700 [.dark_&]:text-emerald-400">
            +{mr.additions}
          </span>{" "}
          <span className="font-mono text-red-700 [.dark_&]:text-red-400">
            −{mr.deletions}
          </span>
        </>
      }
    >
      {mr.filesTruncated ? (
        <Callout icon="💡" className="mb-1 py-2.5">
          Only the first page of diffs is here.{" "}
          <a href={`${mr.url}/diffs`} target="_blank" rel="noreferrer" className="underline">
            Open the full diff in GitLab ↗
          </a>
        </Callout>
      ) : null}
      <div className="flex flex-col">
        {mr.files.map((file) => (
          <FileDiffRow key={file.path} file={file} url={mr.url} />
        ))}
      </div>
    </ToggleSection>
  );
}

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
  const [mr, setMr] = useState<MergeRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("getMergeRequest", { project, iid }).then(
      (result) => {
        setMr(result.mergeRequest);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, project, iid]);
  useEffect(() => {
    setMr(null);
    load();
  }, [load]);

  if (error !== null) return <Callout icon="⚠️">{error}</Callout>;
  if (mr === null) return <PageSkeleton />;

  const mrLinks = links[linkKey("mr", project, iid)];
  const people = (names: string[]) =>
    names.length === 0 ? (
      <EmptyValue />
    ) : (
      names.map((username) => <Person key={username} username={username} />)
    );

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
      <article
        className={cn(
          "mx-auto flex w-full flex-col",
          compact ? "pt-4" : "max-w-[708px] pt-12",
        )}
      >
        <h1
          className={cn(
            "pb-2 font-bold leading-[1.2] text-foreground",
            compact ? "text-[26px]" : "text-[40px]",
          )}
        >
          {mr.title}
        </h1>

        <div className="flex flex-col gap-0.5 py-1.5">
          <PropertyRow icon={ICONS.status} label="Status" compact={compact}>
            <StateStatus state={mr.state} draft={mr.draft} />
            {mr.hasConflicts ? <Tag color="red">Conflicts</Tag> : null}
            {mr.mergeStatus.length > 0 ? (
              <Tag color={mr.mergeStatus === "mergeable" ? "green" : "default"}>
                {mr.mergeStatus.replace(/_/g, " ")}
              </Tag>
            ) : null}
          </PropertyRow>
          <PropertyRow icon={ICONS.branch} label="Branches" compact={compact}>
            <Tag className="font-mono text-[13px]" title={mr.sourceBranch}>
              {mr.sourceBranch}
            </Tag>
            <span className="text-muted-foreground">→</span>
            <Tag className="font-mono text-[13px]" title={mr.targetBranch}>
              {mr.targetBranch}
            </Tag>
          </PropertyRow>
          <PropertyRow icon={ICONS.pipeline} label="Pipeline" compact={compact}>
            {mr.pipeline === null ? (
              <EmptyValue>No pipeline</EmptyValue>
            ) : (
              <PipelineStatus status={mr.pipeline.status} />
            )}
          </PropertyRow>
          <PropertyRow icon={ICONS.check} label="Approvals" compact={compact}>
            <span className="text-foreground">{approvalsText(mr)}</span>
            {mr.approvedBy.map((username) => (
              <Person key={username} username={username} />
            ))}
          </PropertyRow>
          <PropertyRow icon={ICONS.users} label="Reviewers" compact={compact}>
            {people(mr.reviewers)}
          </PropertyRow>
          <PropertyRow icon={ICONS.users} label="Assignee" compact={compact}>
            {people(mr.assignees)}
          </PropertyRow>
          <PropertyRow icon={ICONS.list} label="Labels" compact={compact}>
            {mr.labels.length === 0 ? <EmptyValue /> : <LabelTags labels={mr.labels} />}
          </PropertyRow>
          <PropertyRow icon={ICONS.user} label="Author" compact={compact}>
            <Person username={mr.author} />
          </PropertyRow>
          <PropertyRow icon={ICONS.clock} label="Updated" compact={compact}>
            {formatDateTime(mr.updatedAt)}
          </PropertyRow>
          {mrLinks !== undefined && mrLinks.length > 0 ? (
            <PropertyRow icon={ICONS.bolt} label="Agents" compact={compact}>
              <ThreadPills links={mrLinks} />
            </PropertyRow>
          ) : null}
        </div>

        <div className="pb-2 pt-1">
          <PageComments
            method="commentMergeRequest"
            project={project}
            iid={iid}
            notes={mr.notes}
            onPosted={load}
          />
        </div>
        <div className="flex flex-col gap-4 border-t border-border/70 pt-6">
          <PageBody16 body={mr.body} />
          <div className="flex flex-col gap-1 pt-2">
            <PipelineSection pipeline={mr.pipeline} jobs={mr.jobs} />
            <DiscussionsSection discussions={mr.discussions} />
            <ChangesSection mr={mr} />
          </div>
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
  const [selected, setSelected] = useState<{
    project: string;
    iid: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
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

const QUERY_KEY = "bb-plugin-gitlab:query";
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

function GitlabPanel({ subPath }: PluginNavPanelProps) {
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
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-3 sm:px-8 xl:px-12 2xl:px-24">
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
    id: "gitlab",
    title: "GitLab",
    icon: "GitMerge",
    path: PANEL_PATH,
    component: GitlabPanel,
    headerContent: PanelHeader,
  });
  app.slots.homepageSection({
    id: "gitlab-issues",
    title: "GitLab issues",
    component: RecentIssuesSection,
  });
  app.slots.threadPanelAction({
    id: "merge-request",
    title: "Merge request",
    icon: "GitMerge",
    component: MergeRequestPanelTab,
  });
});
