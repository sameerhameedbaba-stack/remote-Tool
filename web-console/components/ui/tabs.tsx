"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
  count?: number;
}

// Segmented tabs — used for view switches (Table/Cards) and right-panel sections.
export function Tabs({
  items,
  active,
  onChange,
  size = "md",
  className,
}: {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1",
        className,
      )}
    >
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md font-medium transition-colors",
              size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
              isActive
                ? "bg-surface-card text-fg shadow-elev-1"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined && (
              <span
                className={cn(
                  "ml-0.5 rounded-full px-1.5 text-[11px] tabular-nums",
                  isActive
                    ? "bg-accent-soft text-accent"
                    : "bg-surface-hover text-fg-muted",
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
