import * as React from "react";

import { DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * A dropdown menu body with a search field on top, for lists that can run to
 * hundreds of people or labels. The field filters by substring, stays pinned
 * while the list scrolls, and takes typing even after the pointer has moved
 * over an item (Radix moves focus to the hovered item; printable keys are
 * routed back into the field).
 *
 * `children` is called with the lowercased query and returns the filtered
 * items, so each picker keeps its own item type and ordering.
 */
export function SearchableMenuContent({
  title,
  placeholder = "Search…",
  align = "start",
  className,
  children,
}: {
  title?: string;
  placeholder?: string;
  align?: "start" | "center" | "end";
  className?: string;
  children: (query: string) => React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const focusFirstItem = (from: HTMLElement) => {
    const menu = from.closest('[role="menu"]');
    menu
      ?.querySelector<HTMLElement>('[role^="menuitem"]:not([data-disabled])')
      ?.focus();
  };

  return (
    <DropdownMenuContent
      align={align}
      className={cn("flex max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] w-64 flex-col overflow-hidden p-0", className)}
      onKeyDown={(event) => {
        // A key typed while an item has focus belongs in the search field.
        const target = event.target as HTMLElement;
        if (
          target !== inputRef.current &&
          event.key.length === 1 &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          event.key !== " "
        ) {
          event.preventDefault();
          setQuery((prev) => prev + event.key);
          inputRef.current?.focus();
        }
      }}
    >
      {title !== undefined ? (
        <div className="px-3 pb-0.5 pt-2 text-xs text-muted-foreground">
          {title}
        </div>
      ) : null}
      <div className="border-b border-border px-2 py-1.5">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") return; // closes the menu
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusFirstItem(event.currentTarget);
              return;
            }
            // Keep Radix's own typeahead and arrow handling out of the field.
            event.stopPropagation();
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="h-7 w-full rounded-md bg-foreground/[0.05] px-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {children(query.trim().toLowerCase())}
      </div>
    </DropdownMenuContent>
  );
}

/** "No matches" row for a filtered list that came up empty. */
export function NoMatches({ query }: { query: string }) {
  return (
    <div className="px-2 py-3 text-center text-sm text-muted-foreground">
      {query.length > 0 ? `No matches for “${query}”` : "Nothing here yet"}
    </div>
  );
}

/** Case-insensitive substring match used by every searchable list. */
export function matchesQuery(query: string, ...fields: string[]): boolean {
  return (
    query.length === 0 ||
    fields.some((field) => field.toLowerCase().includes(query))
  );
}
