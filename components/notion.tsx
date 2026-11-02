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
        "inline-flex h-5 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 text-xs leading-5",
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
  tick: "M20 6 9 17l-5-5",
  circleCheck: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12l2.5 2.5 4.5-5",
  circleX: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15 9l-6 6M9 9l6 6",
  circleClock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2",
  circleDot: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 12h.01",
  userCheck: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM16 11l2 2 4-4",
  pen: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  refresh: "M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5",
} as const;

export type StatusTone = "ok" | "bad" | "wait" | "neutral";

const STATUS_ICON: Record<StatusTone, { path: string; className: string }> = {
  ok: { path: ICONS.circleCheck, className: "text-emerald-600 [.dark_&]:text-emerald-400" },
  bad: { path: ICONS.circleX, className: "text-red-600 [.dark_&]:text-red-400" },
  wait: { path: ICONS.circleClock, className: "text-amber-600 [.dark_&]:text-amber-400" },
  neutral: { path: ICONS.circleDot, className: "text-muted-foreground" },
};

/** A state as a line icon in a circle: check, x, clock or dot. Never a text glyph. */
export function StatusIcon({ tone, size = 16, className }: { tone: StatusTone; size?: number; className?: string }) {
  const entry = STATUS_ICON[tone];
  return <Icon path={entry.path} size={size} className={cn(entry.className, className)} />;
}

export function Icon({
  path,
  className,
  size = 16,
  strokeWidth = 1.75,
}: {
  path: string;
  className?: string;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
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

/** The one card surface: 10px radius, a faint tint and a single inset rule. */
export const CARD = "rounded-[10px] bg-foreground/[0.045] shadow-[inset_0_0_0_1px_var(--border)]";

const CALLOUT_TONE = {
  neutral: CARD,
  bad: "rounded-[10px] bg-red-500/[0.12]",
  warn: "rounded-[10px] bg-amber-500/[0.15]",
  info: "rounded-[10px] bg-[rgba(35,131,226,0.12)]",
} as const;

/**
 * A callout block: tinted card, leading emoji, text. `details` folds raw
 * output (an API error, a log tail) behind a "Details" toggle; `action` sits
 * on the right.
 */
export function Callout({
  icon,
  children,
  className,
  tone = "neutral",
  details,
  action,
}: {
  icon: string;
  children: React.ReactNode;
  className?: string;
  tone?: keyof typeof CALLOUT_TONE;
  details?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn("flex items-start gap-2.5 px-4 py-3 text-sm", CALLOUT_TONE[tone], className)}
    >
      <span className="text-base leading-6" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1 leading-6">
        {children}
        {details !== undefined && details.length > 0 ? (
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">Details</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs">{details}</pre>
          </details>
        ) : null}
      </div>
      {action !== undefined ? <div className="flex shrink-0 items-center">{action}</div> : null}
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

/** A quiet bordered button on the page background: Approve, Cancel, Retry. */
export const SecondaryButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-background px-2.5 text-sm text-foreground shadow-[inset_0_0_0_1px_var(--border)] transition-colors hover:bg-state-hover disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-state-hover",
      className,
    )}
    {...props}
  />
));
SecondaryButton.displayName = "SecondaryButton";

/** "Reset" for a filter row: red text, shown only while a filter is on. */
export const ResetButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = "button", children = "Reset", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm text-red-600 transition-colors hover:bg-red-500/10 [.dark_&]:text-red-400",
      className,
    )}
    {...props}
  >
    {children}
  </button>
));
ResetButton.displayName = "ResetButton";

/** Notion's blue primary button ("New", "Create"). */
export const PrimaryButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-blue-600 px-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-40",
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

/**
 * A filter pill: blue-tinted once it narrows anything. The pill itself is the
 * menu trigger (refs and Radix props land on the label button); an active
 * pill with `onRemove` swaps its leading icon for an × on hover or focus, a
 * sibling button, so the trigger never nests a button.
 */
export const FilterPill = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    active: boolean;
    icon?: string;
    onRemove?: () => void;
    removeLabel?: string;
  }
>(({ className, active, icon, onRemove, removeLabel = "Remove filter", type = "button", children, ...props }, ref) => {
  const removable = active && onRemove !== undefined;
  return (
    <span
      className={cn(
        "group/pill inline-flex h-7 max-w-[280px] shrink-0 items-center rounded-full text-sm leading-none transition-colors",
        active
          ? "bg-blue-600/[0.07] text-blue-700 shadow-[inset_0_0_0_1px_rgba(37,99,235,0.35)] [.dark_&]:bg-blue-400/10 [.dark_&]:text-blue-300 [.dark_&]:shadow-[inset_0_0_0_1px_rgba(96,165,250,0.4)]"
          : "text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-state-hover hover:text-foreground",
        className,
      )}
    >
      {icon !== undefined ? (
        <span className="relative ml-2 grid size-4 shrink-0 place-items-center">
          <Icon
            path={icon}
            size={14}
            className={cn(removable && "transition-opacity group-hover/pill:opacity-0 group-focus-within/pill:opacity-0")}
          />
          {removable ? (
            <button
              type="button"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={(event) => {
                event.stopPropagation();
                onRemove();
              }}
              className="absolute -inset-0.5 grid place-items-center rounded-full opacity-0 transition-opacity hover:bg-current/15 focus-visible:opacity-100 group-hover/pill:opacity-100 group-focus-within/pill:opacity-100"
            >
              <Icon path={ICONS.close} size={12} strokeWidth={2.4} />
            </button>
          ) : null}
        </span>
      ) : null}
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex h-full min-w-0 items-center gap-1 rounded-full pr-2.5 outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50",
          icon !== undefined ? "pl-1.5" : "pl-2.5",
        )}
        {...props}
      >
        <span className="min-w-0 truncate">{children}</span>
        <Icon path={ICONS.chevronDown} size={13} className="opacity-60" />
      </button>
    </span>
  );
});
FilterPill.displayName = "FilterPill";

/** A small count: tab badges, group sizes, unresolved threads. */
export function Counter({
  tone = "neutral",
  className,
  children,
}: {
  tone?: "neutral" | "bad" | "info";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-medium leading-none tabular-nums",
        tone === "bad"
          ? "bg-red-500/15 text-red-700 [.dark_&]:text-red-300"
          : tone === "info"
            ? "bg-blue-600/15 text-blue-700 [.dark_&]:text-blue-300"
            : "bg-foreground/[0.07] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The level-two tab row: views inside a section, tabs on a page. */
export function UnderlineTabs({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex items-center gap-0.5 overflow-x-auto shadow-[inset_0_-1px_0_var(--border)]", className)}>
      {children}
    </div>
  );
}

export function UnderlineTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 text-sm transition-colors after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full",
        active
          ? "font-semibold text-foreground after:bg-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon !== undefined ? <Icon path={icon} size={15} /> : null}
      {children}
    </button>
  );
}

/** A segmented switch (Week / Month / Year). */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-lg bg-foreground/[0.07] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-6 rounded-md px-2.5 text-[13px] transition-colors",
            value === option.value
              ? "bg-background text-foreground shadow-[0_0_0_1px_var(--border)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A toolbar search field: always visible, so every list has the same right edge. */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <label className="flex h-7 w-52 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors focus-within:bg-state-hover hover:bg-state-hover">
      <Icon path={ICONS.search} size={15} />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
      />
      {value.length > 0 ? (
        <button type="button" aria-label="Clear search" onClick={() => onChange("")} className="grid size-4 place-items-center rounded-full hover:bg-foreground/10">
          <Icon path={ICONS.close} size={11} strokeWidth={2.2} />
        </button>
      ) : null}
    </label>
  );
}

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

// ---------------------------------------------------------------------------
// Dialog shell, Notion-style: a rounded card with a clear head (icon, title,
// one-line lead), a body of tinted callouts and quiet option rows, and a footer
// with ghost cancel and the blue action. Title and lead differ in weight and
// colour so they never run together.
// ---------------------------------------------------------------------------

export const DIALOG_SHELL =
  "max-w-md gap-0 overflow-hidden rounded-xl border-0 p-0 shadow-[rgba(15,15,15,0.05)_0_0_0_1px,rgba(15,15,15,0.1)_0_5px_10px,rgba(15,15,15,0.2)_0_15px_40px] [.dark_&]:shadow-[rgba(255,255,255,0.094)_0_0_0_1px,rgba(0,0,0,0.3)_0_5px_10px,rgba(0,0,0,0.4)_0_15px_40px]";
export const DIALOG_HEAD = "flex-row items-start gap-3.5 space-y-0 px-6 pt-6 text-left";
export const DIALOG_ICON =
  "grid size-10 shrink-0 place-items-center rounded-lg bg-foreground/[0.07] text-xl leading-none";
export const DIALOG_TITLE = "text-[18px] font-semibold leading-snug tracking-normal text-foreground";
export const DIALOG_LEAD = "mt-1 text-sm leading-relaxed text-muted-foreground";
export const DIALOG_BODY = "flex flex-col gap-2.5 px-6 pt-5";
export const DIALOG_LIST =
  "flex flex-col rounded-lg py-1 shadow-[inset_0_0_0_1px_var(--border)]";
export const DIALOG_FOOTER = "gap-2 px-6 pb-6 pt-5 sm:space-x-0";

const DIALOG_TONE: Record<"bad" | "warn" | "info" | "neutral", string> = {
  bad: "bg-red-500/[0.12]",
  warn: "bg-amber-500/[0.15]",
  info: "bg-[rgba(35,131,226,0.12)]",
  neutral: "bg-foreground/[0.05]",
};

/** A tinted note inside a dialog: red blocks, amber checks, blue information. */
export function DialogCallout({
  tone,
  icon,
  title,
  detail,
}: {
  tone: keyof typeof DIALOG_TONE;
  icon: string;
  title: string;
  detail?: string;
}) {
  return (
    <div role="status" className={cn("flex items-start gap-3 rounded-lg px-3.5 py-3", DIALOG_TONE[tone])}>
      <span aria-hidden="true" className="pt-px text-base leading-6">
        {icon}
      </span>
      <div className="min-w-0 flex-1 text-sm leading-6">
        <div className="font-semibold text-foreground first-letter:uppercase">{title}</div>
        {detail !== undefined && detail.length > 0 ? (
          <div className="text-muted-foreground">{detail}</div>
        ) : null}
      </div>
    </div>
  );
}
