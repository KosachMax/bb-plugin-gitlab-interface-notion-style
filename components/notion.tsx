import * as React from "react";

import { cn } from "@/lib/utils";

// Notion's building blocks, measured from a live notion.site database (light
// and dark): 14px text, 36px table rows plus a 1px rule, 8px cell padding,
// 20px-tall tags with a 4px radius, 34px property rows with a 160px label
// column. Chrome colors come from the host theme tokens so the panel follows
// bb's palette; only the categorical tag hues are fixed, the way Notion's are.
// `[.dark_&]:` keys dark mode off bb's `dark` class rather than the OS setting.

export type NotionColor =
  | "default"
  | "gray"
  | "brown"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red";

/** Tag background + text per hue: tinted in light mode, saturated in dark. */
const TAG_CLASSES: Record<NotionColor, string> = {
  default:
    "bg-stone-500/15 text-stone-700 [.dark_&]:bg-stone-400/25 [.dark_&]:text-stone-100",
  gray: "bg-stone-500/20 text-stone-700 [.dark_&]:bg-stone-400/35 [.dark_&]:text-stone-100",
  brown:
    "bg-amber-900/15 text-amber-950 [.dark_&]:bg-amber-700/45 [.dark_&]:text-amber-50",
  orange:
    "bg-orange-500/20 text-orange-950 [.dark_&]:bg-orange-400/40 [.dark_&]:text-orange-50",
  yellow:
    "bg-yellow-500/30 text-yellow-950 [.dark_&]:bg-yellow-400/45 [.dark_&]:text-yellow-50",
  green:
    "bg-emerald-600/15 text-emerald-950 [.dark_&]:bg-emerald-400/35 [.dark_&]:text-emerald-50",
  blue: "bg-blue-600/20 text-blue-950 [.dark_&]:bg-blue-400/40 [.dark_&]:text-blue-50",
  purple:
    "bg-purple-600/15 text-purple-950 [.dark_&]:bg-purple-400/40 [.dark_&]:text-purple-50",
  pink: "bg-pink-600/15 text-pink-950 [.dark_&]:bg-pink-400/40 [.dark_&]:text-pink-50",
  red: "bg-red-600/15 text-red-950 [.dark_&]:bg-red-400/40 [.dark_&]:text-red-50",
};

/** The status-pill dot, one step stronger than the tag tint. */
const DOT_CLASSES: Record<NotionColor, string> = {
  default: "bg-stone-400 [.dark_&]:bg-stone-300",
  gray: "bg-stone-500 [.dark_&]:bg-stone-300",
  brown: "bg-amber-800 [.dark_&]:bg-amber-300",
  orange: "bg-orange-500 [.dark_&]:bg-orange-300",
  yellow: "bg-yellow-500 [.dark_&]:bg-yellow-300",
  green: "bg-emerald-600 [.dark_&]:bg-emerald-300",
  blue: "bg-blue-600 [.dark_&]:bg-blue-300",
  purple: "bg-purple-600 [.dark_&]:bg-purple-300",
  pink: "bg-pink-600 [.dark_&]:bg-pink-300",
  red: "bg-red-600 [.dark_&]:bg-red-300",
};

const HASHED_COLORS: NotionColor[] = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];

/** A stable hue per name, so a label keeps its color across rows and pages. */
export function colorForName(name: string): NotionColor {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return HASHED_COLORS[Math.abs(hash) % HASHED_COLORS.length];
}

/** A select / multi-select option; `dot` adds a leading color dot ("#rrggbb" or a hue). */
export function Tag({
  color = "default",
  dot,
  className,
  children,
  title,
}: {
  color?: NotionColor;
  dot?: string | NotionColor;
  className?: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 text-sm leading-5",
        TAG_CLASSES[color],
        className,
      )}
    >
      {dot !== undefined ? (
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full",
            !dot.startsWith("#") && DOT_CLASSES[dot as NotionColor],
          )}
          style={dot.startsWith("#") ? { backgroundColor: dot } : undefined}
        />
      ) : null}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/** A status property: a rounded pill with a leading dot. */
export function StatusPill({
  color,
  children,
  className,
  pulse = false,
  quiet = false,
}: {
  color: NotionColor;
  children: React.ReactNode;
  className?: string;
  pulse?: boolean;
  /**
   * The expected state (open, passed): a dot and plain text, no fill, so the
   * rows that need attention are the only ones with color behind them.
   */
  quiet?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full text-sm leading-5",
        quiet ? "pl-0.5 pr-1 text-foreground" : cn("pl-1.5 pr-2", TAG_CLASSES[color]),
        className,
      )}
    >
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          DOT_CLASSES[color],
          pulse && "animate-pulse",
        )}
      />
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Icons. Notion draws thin, rounded 16px glyphs in the muted text color.
// ---------------------------------------------------------------------------

export const ICONS = {
  title: "M4 7V4h16v3M9 20h6M12 4v16",
  status:
    "M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83",
  user: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  tag: "M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2ZM7 7h.01",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  branch:
    "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  check: "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3",
  folder:
    "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  bolt: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
  hash: "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
  search: "M21 21l-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z",
  table: "M3 3h18v18H3zM3 9h18M3 15h18M9 3v18",
  page: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  filter: "M3 6h18M7 12h10M10 18h4",
  plus: "M12 5v14M5 12h14",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  peek: "M3 3h18v18H3zM14 3v18",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 18 6-6-6-6",
  close: "M18 6 6 18M6 6l12 12",
  pipeline: "M5 12h14M12 5l7 7-7 7",
  commit: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 12h6M15 12h6",
  comment: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
} as const;

export function Icon({
  path,
  className,
  size = 16,
}: {
  path: string;
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

/** Notion's toggle triangle: a filled caret that rotates when open. */
export function ToggleCaret({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      className={cn(
        "shrink-0 fill-current transition-transform duration-150",
        open && "rotate-90",
      )}
      aria-hidden="true"
    >
      <path d="M4 2.5v7l5-3.5z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Page parts.
// ---------------------------------------------------------------------------

/** A property's value cell. Editable values are a button with this class. */
export const PROPERTY_VALUE_CLASS =
  "flex min-h-[34px] min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1.5 py-[7px] text-left text-sm text-foreground";

/** The value cell as an edit control: the whole cell opens the editor. */
export const PROPERTY_CONTROL_CLASS = cn(
  PROPERTY_VALUE_CLASS,
  "cursor-pointer transition-colors hover:bg-state-hover data-[state=open]:bg-state-hover disabled:cursor-default",
);

/**
 * One page property: a 160px muted label column, then either `children`
 * (read-only) or `control`, an element styled with PROPERTY_CONTROL_CLASS
 * that makes the whole value cell the edit affordance, as in Notion.
 */
export function PropertyRow({
  icon,
  label,
  children,
  control,
  compact = false,
}: {
  icon: string;
  label: string;
  children?: React.ReactNode;
  control?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className="flex min-h-[34px] items-start">
      <div
        className={cn(
          "flex h-[34px] shrink-0 items-center gap-1.5 rounded-md px-1.5 text-sm text-muted-foreground",
          compact ? "w-[120px]" : "w-[160px]",
        )}
      >
        <Icon path={icon} />
        <span className="truncate">{label}</span>
      </div>
      {control ?? <div className={PROPERTY_VALUE_CLASS}>{children}</div>}
    </div>
  );
}

/** The muted placeholder Notion shows in an empty page property. */
export function EmptyValue({ children = "Empty" }: { children?: string }) {
  return <span className="text-muted-foreground/60">{children}</span>;
}

/**
 * A toggle heading block. The body mounts only while open, so a collapsed
 * section (32 diffs, say) costs nothing.
 */
export function ToggleSection({
  title,
  meta,
  defaultOpen = false,
  actions,
  children,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  defaultOpen?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section className="flex flex-col">
      <div className="group/toggle flex min-h-[34px] items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          className="-ml-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-state-hover"
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-foreground">
            <ToggleCaret open={open} />
          </span>
          <span className="shrink-0 text-lg font-semibold leading-snug text-foreground">
            {title}
          </span>
          {meta !== undefined ? (
            <span className="min-w-0 truncate pl-1 text-sm text-muted-foreground">
              {meta}
            </span>
          ) : null}
        </button>
        {actions !== undefined ? (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        ) : null}
      </div>
      {open ? <div className="pl-[26px] pt-1">{children}</div> : null}
    </section>
  );
}

/** A callout block: tinted box, leading emoji, text. */
export function Callout({
  icon,
  children,
  className,
}: {
  icon: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2.5 rounded-md bg-foreground/[0.04] px-4 py-4 text-sm",
        className,
      )}
    >
      <span className="text-xl leading-6" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1 leading-6">{children}</div>
    </div>
  );
}

/** A quiet bordered button, like Notion's OPEN / Share chips. */
export const ChipButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-background px-1.5 text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
ChipButton.displayName = "ChipButton";

/** A borderless 28px icon or text button for toolbars. */
export const GhostButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-sm text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-state-hover",
      className,
    )}
    {...props}
  />
));
GhostButton.displayName = "GhostButton";

/** Notion's blue primary button ("New", "Create"). */
export const PrimaryButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-blue-600 px-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-40",
      className,
    )}
    {...props}
  />
));
PrimaryButton.displayName = "PrimaryButton";

/** A view tab: pill-shaped, tinted when active. */
export function ViewTab({
  icon,
  active,
  onClick,
  children,
}: {
  icon: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-medium transition-colors",
        active
          ? "bg-foreground/[0.06] text-foreground"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      <Icon path={icon} />
      {children}
    </button>
  );
}

/** A filter pill: blue-tinted once it narrows anything. */
export const FilterPill = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }
>(({ className, active, type = "button", children, ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex h-7 max-w-[260px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-sm transition-colors",
      active
        ? "border-blue-600/35 bg-blue-600/[0.06] text-blue-700 hover:bg-blue-600/[0.12] [.dark_&]:border-blue-400/40 [.dark_&]:bg-blue-400/10 [.dark_&]:text-blue-300"
        : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
    <Icon path={ICONS.chevronDown} size={12} className="opacity-60" />
  </button>
));
FilterPill.displayName = "FilterPill";

/** One tinted background per person, so neighbors in a list are easy to tell apart. */
const AVATAR_CLASSES = [
  "bg-blue-500/25 text-blue-900 [.dark_&]:bg-blue-400/35 [.dark_&]:text-blue-50",
  "bg-emerald-500/25 text-emerald-900 [.dark_&]:bg-emerald-400/35 [.dark_&]:text-emerald-50",
  "bg-purple-500/25 text-purple-900 [.dark_&]:bg-purple-400/35 [.dark_&]:text-purple-50",
  "bg-pink-500/25 text-pink-900 [.dark_&]:bg-pink-400/35 [.dark_&]:text-pink-50",
  "bg-orange-500/25 text-orange-900 [.dark_&]:bg-orange-400/35 [.dark_&]:text-orange-50",
  "bg-yellow-500/35 text-yellow-900 [.dark_&]:bg-yellow-400/40 [.dark_&]:text-yellow-50",
  "bg-red-500/25 text-red-900 [.dark_&]:bg-red-400/35 [.dark_&]:text-red-50",
  "bg-cyan-500/25 text-cyan-900 [.dark_&]:bg-cyan-400/35 [.dark_&]:text-cyan-50",
  "bg-indigo-500/25 text-indigo-900 [.dark_&]:bg-indigo-400/35 [.dark_&]:text-indigo-50",
  "bg-amber-700/25 text-amber-950 [.dark_&]:bg-amber-500/35 [.dark_&]:text-amber-50",
  "bg-lime-600/30 text-lime-950 [.dark_&]:bg-lime-400/35 [.dark_&]:text-lime-50",
  "bg-fuchsia-500/25 text-fuchsia-900 [.dark_&]:bg-fuchsia-400/35 [.dark_&]:text-fuchsia-50",
  "bg-teal-500/25 text-teal-900 [.dark_&]:bg-teal-400/35 [.dark_&]:text-teal-50",
  "bg-slate-500/30 text-slate-900 [.dark_&]:bg-slate-400/35 [.dark_&]:text-slate-50",
];

function hashName(name: string): number {
  // FNV-1a: neighbors like "Alek.Demin" and "AlekseyGoncharov" still spread out.
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** "Maksim.Kosach" → "MK"; "info-partner" → "IP"; "dana" → "DA". */
export function initialsOf(name: string): string {
  const parts = name.split(/[._\s-]+/).filter((part) => part.length > 0);
  const letters =
    parts.length >= 2
      ? `${parts[0][0]}${parts[1][0]}`
      : (parts[0] ?? name).slice(0, 2);
  return letters.toUpperCase();
}

/** The signed-in glab user, so their own avatar can stand out. */
export const ViewerContext = React.createContext<string | null>(null);

/** Notion's round avatar; initials because GitLab avatars need auth. */
export function Avatar({
  username,
  size = 20,
  className,
}: {
  username: string;
  size?: number;
  className?: string;
}) {
  const viewer = React.useContext(ViewerContext);
  const isMe = viewer !== null && viewer.toLowerCase() === username.toLowerCase();
  return (
    <span
      title={isMe ? `${username} (you)` : username}
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none",
        AVATAR_CLASSES[hashName(username.toLowerCase()) % AVATAR_CLASSES.length],
        isMe && "ring-2 ring-blue-600 ring-offset-1 ring-offset-background [.dark_&]:ring-blue-400",
        className,
      )}
    >
      {initialsOf(username)}
    </span>
  );
}

/** A person property value: avatar plus name. */
export function Person({ username }: { username: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar username={username} />
      <span className="min-w-0 truncate">{username}</span>
    </span>
  );
}
